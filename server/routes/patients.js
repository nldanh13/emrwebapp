// server/routes/patients.js — /api/get-patients, /api/run-input-care, /api/run-input-infusions

'use strict';

const router = require('express').Router();
const fs     = require('fs');
const path   = require('path');

const { getRuntimePaths, ensureSessionAssets }            = require('../services/session');
const { runWorker, runScript, fmtPyError }                 = require('../services/python_runner');
const { enqueueHeavy, registerCancel, unregisterCancel }   = require('../services/task_queue');
const { readJsonSafe, safeUnlink, ensureDir, writeJsonAtomic, safeFilePart } = require('../utils/file');
const { readDoneState, markDoneKeys, fingerprintRecords, baseDoneKey, hashValue } = require('../utils/done_state');
const { parseDmy, normalizeDmy }                           = require('../utils/validation');
const { readConfig }                                       = require('../utils/nurse_config');
const { ROOT_DIR, ALLOW_INPUT_WITHOUT_PRECHECK }             = require('../constants');
const { hasRole }                                            = require('../services/authz');
const {
  buildPatientDayBundle,
  normalizeInputTargets,
  patientIdOfTarget,
} = require('../utils/patient_helpers');
const { appendActivity }                                   = require('../services/activity_logger');
const { postprocessOrders }                                 = require('../services/order_pipeline');
const { getFeature }                                        = require('../services/feature_registry');
const {
  readProgress,
  beginTask,
  finishTask,
  failRunningTask,
  markRunningTaskStatus,
  progressForPatient,
} = require('../services/task_progress');
const {
  issueInputPrecheckToken,
  validateAndConsumeInputPrecheckToken,
  taskNameFromTargets,
} = require('../services/input_precheck_tokens');

// ── GET /api/get-patients ────────────────────────────────────────────────────


function roomFromRow(row) {
  return String(
    row?.so_phong || row?.room || row?.Vi_Tri || row?.phong_giuong ||
    row?.['Phòng'] || row?.['Phòng/Giường'] || row?.['Vị trí'] || row?.vi_tri || ''
  ).trim();
}

function buildCurrentRoomIndex(ctx) {
  const out = new Map();
  const sortedRows = readJsonSafe(ctx.SORTED_PATH, []);
  for (const row of (Array.isArray(sortedRows) ? sortedRows : [])) {
    const id = rowPatientId(row);
    const room = roomFromRow(row);
    if (id && room) out.set(id, room);
  }
  return out;
}

function enrichRowsWithCurrentRooms(rows, ctx) {
  if (!Array.isArray(rows) || !rows.length) return rows;
  const roomById = buildCurrentRoomIndex(ctx);
  if (!roomById.size) return rows;
  return rows.map(row => {
    // Dòng patient-day đã có phòng thì đó là phòng của đúng ngày. Không ghi
    // đè bằng phòng hiện tại từ SORTED_PATH, nếu không lọc theo phòng có thể
    // nhập nhầm ngày lịch sử sau khi BN chuyển phòng.
    if (roomFromRow(row)) return row;
    const id = rowPatientId(row);
    const room = id ? roomById.get(id) : '';
    if (!room) return row;
    return {
      ...row,
      so_phong: room,
      room,
      Vi_Tri: room,
      vi_tri: room,
      phong_giuong: room,
      'Phòng': room,
      'Vị trí': room,
    };
  });
}


function extractDmyForCompare(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  const m = text.match(/(\d{1,2})[-/](\d{1,2})[-/](\d{2,4})/);
  if (!m) return '';
  const yyyy = Number(m[3].length === 2 ? `20${m[3]}` : m[3]);
  return normalizeDmy(`${m[1]}/${m[2]}/${yyyy}`);
}

function latestWardAdmissionStamp(row) {
  if (!row || typeof row !== 'object') return 0;
  const values = [];
  for (const key of ['thoi_gian_vao_khoa', 'tg_vao', 'thoi_gian_vao', 'admission_time', 'T/G vào', 'Thời gian vào khoa']) {
    if (row[key]) values.push(row[key]);
  }
  for (const key of ['lich_su_khoa_dieu_tri', 'khoa_dieu_tri_history', 'ward_admissions']) {
    const list = Array.isArray(row[key]) ? row[key] : [];
    for (const item of list) {
      if (!item || typeof item !== 'object') continue;
      for (const subKey of ['thoi_gian_vao_khoa', 'tg_vao', 'ngay_vao', 'time', 'at', 'Ngày vào']) {
        if (item[subKey]) values.push(item[subKey]);
      }
    }
  }
  return values.reduce((max, value) => Math.max(max, parseDmy(extractDmyForCompare(value))), 0);
}

function hasDischargeText(value) {
  const text = String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .toLowerCase();
  return /\b(?:ra|xuat)\s*vien\b/.test(text);
}

function clearDischargeFields(row, reason = '') {
  if (!row || typeof row !== 'object') return row;
  for (const key of ['ngay_ra_vien', 'gio_ra_vien', 'ngay_ra_vien_date', 'Ngày ra viện', 'Giờ ra viện', 'NgayRaVien', 'discharge_date', 'discharge_time']) {
    if (Object.prototype.hasOwnProperty.call(row, key)) row[key] = '';
  }
  row.ra_vien_hom_nay = false;
  for (const key of ['xu_tri', 'Xử trí', 'XuTri', 'Hướng xử trí', 'disposition']) {
    if (hasDischargeText(row[key])) row[key] = '';
  }
  if (row.care_mode === 'discharge_day') row.care_mode = '';
  if (Array.isArray(row.care_special_events)) {
    row.care_special_events = row.care_special_events.filter(ev => !(ev && ev.type === 'discharge'));
  }
  if (reason) {
    const warnings = Array.isArray(row.processing_warnings) ? row.processing_warnings : [];
    const msg = `Đã bỏ mốc ra viện cũ: ${reason}`;
    if (!warnings.includes(msg)) warnings.push(msg);
    row.processing_warnings = warnings;
  }
  return row;
}

function sanitizeStaleDischargeRow(row) {
  if (!row || typeof row !== 'object') return row;
  const dischargeStamp = parseDmy(extractDmyForCompare(row.ngay_ra_vien_date || row.ngay_ra_vien || row['Ngày ra viện'] || row.discharge_date));
  if (!dischargeStamp) return row;
  const admissionStamp = latestWardAdmissionStamp(row);
  if (admissionStamp && dischargeStamp < admissionStamp) {
    clearDischargeFields(row, 'ngày ra viện cũ hơn mốc vào khoa hiện tại');
  }
  return row;
}

function sanitizeStaleDischargeRows(rows) {
  return Array.isArray(rows) ? rows.map(row => sanitizeStaleDischargeRow(row)) : rows;
}


function isoToDmy(value) {
  const text = String(value || '').trim();
  const m = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : text;
}

function rowsFromClassifiedDays(ctx) {
  const payload = readJsonSafe(ctx.CLASSIFIED_DAYS_PATH, null);
  const days = payload && typeof payload === 'object' && payload.patient_days && typeof payload.patient_days === 'object'
    ? payload.patient_days
    : null;
  if (!days) return [];
  const patientsPayload = readJsonSafe(ctx.PATIENTS_PATH, null);
  const patients = patientsPayload && typeof patientsPayload === 'object' && patientsPayload.patients && typeof patientsPayload.patients === 'object'
    ? patientsPayload.patients
    : {};
  const board = readJsonSafe(ctx.BOARD_STATE_PATH, null) || {};
  const rooms = board && typeof board === 'object' && board.room_assignments && typeof board.room_assignments === 'object'
    ? board.room_assignments
    : {};
  return Object.values(days).filter(day => day && typeof day === 'object').map(day => {
    const pid = String(day.patient_id || day.ma_bn || '').trim();
    const meta = patients[pid] || {};
    const date = day.display_date || isoToDmy(day.work_date);
    const medication = day.medications && typeof day.medications === 'object' ? day.medications : {};
    return {
      ma_bn: pid,
      ho_ten: meta.name || meta.ho_ten || day.patientName || '',
      ngay_lam: date,
      encounter_key: day.encounter_key || meta.encounter_key || '',
      tg_vao: meta.admission_time || meta.ward_admission_time || '',
      thoi_gian_vao_khoa: meta.ward_admission_time || meta.admission_time || '',
      khoa_chuyen_den: meta.department_name || meta.department || '',
      khoa_dieu_tri: meta.department_name || meta.department || '',
      ten_khoa_dieu_tri: meta.department_name || meta.department || '',
      chan_doan: meta.diagnosis || '',
      bac_si: meta.doctor || '',
      xu_tri: meta.disposition || '',
      so_phong: rooms[pid] || meta.room || '',
      room: rooms[pid] || meta.room || '',
      Vi_Tri: rooms[pid] || meta.room || '',
      tuoi: meta.age || '',
      gioi_tinh: meta.sex || '',
      doi_tuong: meta.object_type || '',
      ngay_ra_vien: meta.discharge_date || '',
      gio_ra_vien: meta.discharge_time || '',
      nhap_cham_soc: day.care || {},
      thuoc: medication,
      chi_dinh_dvkt: Array.isArray(day.procedures) ? day.procedures : [],
      chi_dinh_khac: day.other_orders || {},
      vtyt: day.supplies || { items: [], warnings: [], source: 'runtime_v2' },
      processing_warnings: Array.isArray(day.warnings) ? day.warnings : [],
      _source: 'runtime_v2.classified_days',
    };
  });
}

router.get('/get-patients', (req, res) => {
  const ctx       = getRuntimePaths(req);
  let processed = sanitizeStaleDischargeRows(enrichRowsWithCurrentRooms(readJsonSafe(ctx.PROCESSED_PATH, []), ctx));
  let usingRuntimeV2 = false;
  if (!processed.length) {
    processed = sanitizeStaleDischargeRows(enrichRowsWithCurrentRooms(rowsFromClassifiedDays(ctx), ctx));
    usingRuntimeV2 = processed.length > 0;
  }
  if (!processed.length) return res.json([]);

  const doneStates = {
    care:       readDoneState(ctx.CARE_DONE_PATH),
    infusions:  readDoneState(ctx.INFUSIONS_DONE_PATH),
    procedures: readDoneState(ctx.PROCEDURES_DONE_PATH),
    vtyt:       readDoneState(ctx.VTYT_DONE_PATH || path.join(ctx.dir, 'vtyt_done.json')),
  };
  const progress  = readProgress(ctx.TASK_PROGRESS_PATH);

  const nurseSchedule = (() => {
    try { return readConfig(req).ten_dieu_duong || {}; } catch (_) { return {}; }
  })();

  const byPatient = new Map();
  for (const row of processed) {
    const id = String(row?.ma_bn || '').trim();
    if (!id) continue;
    if (!byPatient.has(id)) byPatient.set(id, []);
    byPatient.get(id).push(row);
  }

  const result = [];
  for (const [id, records] of byPatient) {
    const recordsSorted = [...records].sort((a, b) => parseDmy(b.ngay_lam) - parseDmy(a.ngay_lam));
    const latest        = recordsSorted[0] || {};

    const dates = [...new Set(recordsSorted.map(x => String(x?.ngay_lam || '').trim()).filter(Boolean))]
      .sort((a, b) => parseDmy(b) - parseDmy(a));

    const dayMap = {};
    for (const date of dates) {
      const dayRecords = recordsSorted.filter(x => String(x?.ngay_lam || '').trim() === date);
      dayMap[date] = buildPatientDayBundle(dayRecords, id, date, nurseSchedule, doneStates);
    }

    const activeDate = dates[0] || (latest.ngay_lam || '');
    const active     = dayMap[activeDate] || buildPatientDayBundle([latest], id, activeDate, nurseSchedule, doneStates);

    const totalDates     = dates.length || 1;
    const careDates      = dates.filter(d => dayMap[d]?.care_required !== false);
    const careDoneCount  = careDates.filter(d => dayMap[d]?.care_done).length;
    const careStaleCount = careDates.filter(d => dayMap[d]?.care_stale).length;
    const infusionDates  = dates.filter(d => dayMap[d]?.has_infusion);
    const infusDoneCount = infusionDates.filter(d => dayMap[d]?.infus_done).length;
    const infusStaleCount= infusionDates.filter(d => dayMap[d]?.infus_stale).length;
    const procedureDates = dates.filter(d => dayMap[d]?.has_procedure);
    const procedureDoneCount = procedureDates.filter(d => dayMap[d]?.procedure_done).length;
    const procedureStaleCount= procedureDates.filter(d => dayMap[d]?.procedure_stale).length;
    const warningCount   = dates.reduce((sum, d) => sum + Number(dayMap[d]?.warning_count || 0), 0);
    const care_done      = careDates.length > 0 && careDoneCount === careDates.length;
    const has_infusion   = infusionDates.length > 0;
    const infus_done     = has_infusion && infusDoneCount === infusionDates.length;
    const has_procedure  = procedureDates.length > 0;
    const procedure_done = has_procedure && procedureDoneCount === procedureDates.length;
    const staleAny       = careStaleCount || infusStaleCount || procedureStaleCount;
    const status         = staleAny || warningCount > 0 ? 'amber'
      : (care_done && (!has_infusion || infus_done) && (!has_procedure || procedure_done)) ? 'green'
      : (careDoneCount > 0 || infusDoneCount > 0 || procedureDoneCount > 0) ? 'amber' : 'gray';
    const admissionTime = active.thoi_gian_vao_khoa || active.tg_vao || latest.thoi_gian_vao_khoa || latest.tg_vao || latest.thoi_gian_vao || '';
    const departmentName = active.ten_khoa_dieu_tri || active.khoa_dieu_tri || active.khoa_chuyen_den || latest.ten_khoa_dieu_tri || latest.khoa_dieu_tri || latest.khoa_chuyen_den || '';
    const wardHistory = Array.isArray(active.lich_su_khoa_dieu_tri) ? active.lich_su_khoa_dieu_tri
      : Array.isArray(latest.lich_su_khoa_dieu_tri) ? latest.lich_su_khoa_dieu_tri
        : [];

    const roomValue = String(
      active.so_phong || active.room || active.Vi_Tri || active.phong_giuong ||
      latest.so_phong || latest.room || latest.Vi_Tri || latest.phong_giuong || ''
    ).trim();
    const ageValue = active.tuoi || active.age || active['Tuổi'] || latest.tuoi || latest.age || latest['Tuổi'] || '';
    const genderValue = active.gioi_tinh || active.gender || active['Giới tính'] || latest.gioi_tinh || latest.gender || latest['Giới tính'] || '';
    const objectValue = active.doi_tuong || active.doi_tuong_bn || active['Đối tượng'] || latest.doi_tuong || latest.doi_tuong_bn || latest['Đối tượng'] || '';
    const bhytValue = active.so_the_bhyt || active.ma_the_bhyt || active.bhyt || active['Số thẻ BHYT'] || latest.so_the_bhyt || latest.ma_the_bhyt || latest.bhyt || latest['Số thẻ BHYT'] || '';
    const bhytExpiry = active.han_the_bhyt || active.han_bhyt || active['Hạn thẻ BHYT'] || latest.han_the_bhyt || latest.han_bhyt || latest['Hạn thẻ BHYT'] || '';

    result.push({
      ma_bn:               id,
      ho_ten:              active.ho_ten              || latest.ho_ten              || latest['Họ tên'] || '',
      so_phong:            roomValue,
      room:                roomValue,
      Vi_Tri:              roomValue,
      phong_giuong:        roomValue,
      tuoi:                ageValue,
      age:                 ageValue,
      gioi_tinh:           genderValue,
      gender:              genderValue,
      doi_tuong:           objectValue,
      doi_tuong_bn:        objectValue,
      bhyt:                bhytValue,
      so_the_bhyt:         bhytValue,
      ma_the_bhyt:         active.ma_the_bhyt || latest.ma_the_bhyt || bhytValue,
      han_the_bhyt:        bhytExpiry,
      han_bhyt:            bhytExpiry,
      bac_si:              active.bac_si              || latest.bac_si              || '',
      xu_tri:              active.xu_tri              || latest.xu_tri              || '',
      tg_vao:              admissionTime,
      thoi_gian_vao_khoa:  admissionTime,
      khoa_chuyen_den:     departmentName,
      khoa_dieu_tri:       departmentName,
      ten_khoa_dieu_tri:   departmentName,
      lich_su_khoa_dieu_tri: wardHistory,
      chan_doan:           active.chan_doan            || latest.chan_doan           || '',
      care_mode:           active.care_mode           || latest.care_mode           || '',
      surgery_out:         Boolean(active.surgery_out || latest.surgery_out),
      surgery_out_time:    active.surgery_out_time    || latest.surgery_out_time    || '',
      surgery_out_reason:  active.surgery_out_reason  || latest.surgery_out_reason  || '',
      care_special_events: Array.isArray(active.care_special_events) ? active.care_special_events : (latest.care_special_events || []),
      ngay_ra_vien:        active.ngay_ra_vien        || latest.ngay_ra_vien        || '',
      gio_ra_vien:         active.gio_ra_vien         || latest.gio_ra_vien         || '',
      ngay_ra_vien_date:   active.ngay_ra_vien_date   || latest.ngay_ra_vien_date   || '',
      ra_vien_hom_nay:     Boolean(active.ra_vien_hom_nay || latest.ra_vien_hom_nay),
      ngay_lam:            activeDate,
      available_dates:     dates,
      total_dates:         totalDates,
      care_done_count:     careDoneCount,
      care_total_dates:     careDates.length,
      care_stale_count:    careStaleCount,
      infusion_total_dates: infusionDates.length,
      infus_done_count:    infusDoneCount,
      infus_stale_count:   infusStaleCount,
      procedure_total_dates: procedureDates.length,
      procedure_done_count: procedureDoneCount,
      procedure_stale_count: procedureStaleCount,
      care_done,
      infus_done,
      procedure_done,
      has_infusion,
      has_infusion_any:    has_infusion,
      has_procedure,
      warning_count:       warningCount,
      status,
      data_source: usingRuntimeV2 ? 'runtime_v2.classified_days' : 'legacy.processed',
      day_map:   dayMap,
      timeline:  active.timeline,
      preview:   active.preview,
      thuoc:     active.thuoc,
      ncs:       active.ncs,
      cs_extra:  active.cs_extra,
      input_progress: progressForPatient(progress, id),
    });
  }

  return res.json(result);
});

// ── Shared helper: chạy script nhập EMR ──────────────────────────────────────


// ── Manual pre-check trước khi nhập: đọc lại Y lệnh CHỈ các BN/ngày sắp nhập ──

function rowPatientId(row) {
  return String(
    row?.ma_bn || row?.['Mã BN'] || row?.['Mã YT'] || row?.ma_yt || row?.MaBN || row?.Ma_BN || row?.mabn || row?.id || ''
  ).trim();
}

function rowWorkDate(row) {
  return String(row?.ngay_lam || row?.ngay_y_lenh || row?.ngay || row?.date || '').trim();
}

function dmyStamp(s) {
  return parseDmy(String(s || '').trim());
}

function dateRangeFromTargets(targetMap) {
  const dates = [];
  for (const dateSet of targetMap.values()) {
    for (const d of dateSet) if (dmyStamp(d)) dates.push(d);
  }
  if (!dates.length) return { from: '', to: '' };
  dates.sort((a, b) => dmyStamp(a) - dmyStamp(b));
  return { from: dates[0], to: dates[dates.length - 1] };
}

function targetMapFromTargets(targets) {
  const out = new Map();
  const ids = Array.isArray(targets?.patientIds) ? targets.patientIds : [];
  const patientDates = targets?.patientDates && typeof targets.patientDates === 'object' ? targets.patientDates : {};
  const selectedDates = Array.isArray(targets?.selectedDates) ? targets.selectedDates : [];
  for (const rawId of ids) {
    const id = String(rawId || '').trim();
    if (!id) continue;
    const dates = Array.isArray(patientDates[id]) && patientDates[id].length
      ? patientDates[id]
      : selectedDates;
    const cleanDates = [...new Set(dates.map(d => String(d || '').trim()).filter(Boolean))];
    if (!cleanDates.length) continue;
    out.set(id, new Set(cleanDates));
  }
  return out;
}

function keyForRow(row) {
  const id = rowPatientId(row);
  const date = rowWorkDate(row);
  return id && date ? `${id}::${date}` : '';
}

function targetKeySetFromMap(targetMap) {
  const out = new Set();
  for (const [id, dates] of targetMap.entries()) {
    for (const date of dates) out.add(`${id}::${date}`);
  }
  return out;
}

function rawOrderPayload(row) {
  const r = row || {};
  const admissionTime = r.thoi_gian_vao_khoa || r.tg_vao || r['T/G vào'] || r.thoi_gian_vao || r.admission_time || '';
  const departmentName = r.ten_khoa_dieu_tri || r.khoa_dieu_tri || r.khoa_chuyen_den || r['Tên khoa điều trị'] || r['Khoa điều trị'] || r['Khoa chuyển đến'] || r.department_name || r.department || '';
  const wardHistory = Array.isArray(r.lich_su_khoa_dieu_tri) ? r.lich_su_khoa_dieu_tri
    : Array.isArray(r.khoa_dieu_tri_history) ? r.khoa_dieu_tri_history
      : Array.isArray(r.ward_admissions) ? r.ward_admissions : [];
  return {
    ma_bn: rowPatientId(r),
    ngay_lam: rowWorkDate(r),
    ho_ten: r.ho_ten || r['Họ tên'] || '',
    bac_si: r.bac_si || r['Bác sĩ'] || '',
    chan_doan: r.chan_doan || r['Chẩn đoán'] || '',
    tg_vao: admissionTime,
    thoi_gian_vao_khoa: admissionTime,
    khoa_chuyen_den: departmentName,
    khoa_dieu_tri: departmentName,
    ten_khoa_dieu_tri: departmentName,
    lich_su_khoa_dieu_tri: wardHistory,
    xu_tri: r.xu_tri || r['Xử trí'] || r.status || r.trang_thai || '',
    ngay_ra_vien: r.ngay_ra_vien || r['Ngày ra viện'] || '',
    gio_ra_vien: r.gio_ra_vien || r['Giờ ra viện'] || '',
    y_lenh: r.nhap_cham_soc?.y_lenh || r['Y lệnh'] || r.y_lenh || '',
    dien_bien: r.nhap_cham_soc?.dien_bien || r['Diễn biến'] || r.dien_bien || '',
  };
}

function groupRawHashes(rows, targetKeys) {
  const groups = new Map();
  for (const row of (Array.isArray(rows) ? rows : [])) {
    const key = keyForRow(row);
    if (!key || (targetKeys && !targetKeys.has(key))) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(rawOrderPayload(row));
  }
  const out = new Map();
  for (const [key, vals] of groups.entries()) {
    vals.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
    out.set(key, hashValue(vals));
  }
  return out;
}

function latestOrderTimeFromRows(rows) {
  let latest = '';
  const pick = (text) => {
    for (const m of String(text || '').matchAll(/(?:^|\n)\s*(\d{1,2}:\d{2})\s*\|/g)) {
      const t = m[1].padStart(5, '0');
      if (!latest || t > latest) latest = t;
    }
  };
  for (const r of (Array.isArray(rows) ? rows : [])) {
    pick(r?.['Y lệnh'] || r?.y_lenh || r?.nhap_cham_soc?.y_lenh || '');
    pick(r?.['Diễn biến'] || r?.dien_bien || r?.nhap_cham_soc?.dien_bien || '');
  }
  return latest;
}

function normalizePrecheckText(value) {
  return String(value || '')
    .replace(/\r/g, '\n')
    .replace(/[ 	]+/g, ' ')
    .replace(/ /g, ' ')
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .join('\n');
}

function countPrecheckLines(value) {
  const text = normalizePrecheckText(value);
  return text ? text.split('\n').length : 0;
}

function joinPrecheckField(payloads, field) {
  return (Array.isArray(payloads) ? payloads : [])
    .map(item => normalizePrecheckText(item?.[field] || ''))
    .filter(Boolean)
    .join('\n---\n');
}

function summarizePrecheckChanges(oldRowsForKey, freshRowsForKey) {
  const oldPayloads = (Array.isArray(oldRowsForKey) ? oldRowsForKey : []).map(rawOrderPayload);
  const newPayloads = (Array.isArray(freshRowsForKey) ? freshRowsForKey : []).map(rawOrderPayload);
  const changes = [];

  if (!oldPayloads.length && newPayloads.length) {
    changes.push('Có dữ liệu mới chưa có trong lần xử lý trước');
  }

  const textFields = [
    ['y_lenh', 'Y lệnh'],
    ['dien_bien', 'Diễn biến'],
  ];
  for (const [field, label] of textFields) {
    const oldText = joinPrecheckField(oldPayloads, field);
    const newText = joinPrecheckField(newPayloads, field);
    if (oldText !== newText) {
      const oldCount = countPrecheckLines(oldText);
      const newCount = countPrecheckLines(newText);
      changes.push(`${label} thay đổi (${oldCount} → ${newCount} dòng)`);
    }
  }

  const simpleFields = [
    ['chan_doan', 'Chẩn đoán'],
    ['xu_tri', 'Xử trí/trạng thái'],
    ['ngay_ra_vien', 'Ngày ra viện'],
    ['gio_ra_vien', 'Giờ ra viện'],
    ['bac_si', 'Bác sĩ'],
    ['thoi_gian_vao_khoa', 'Thời gian vào khoa'],
    ['ten_khoa_dieu_tri', 'Khoa điều trị'],
  ];
  const oldMain = oldPayloads[0] || {};
  const newMain = newPayloads[0] || {};
  for (const [field, label] of simpleFields) {
    const oldVal = normalizePrecheckText(oldMain[field] || '');
    const newVal = normalizePrecheckText(newMain[field] || '');
    if (oldVal !== newVal) changes.push(`${label} thay đổi`);
  }

  return [...new Set(changes)].slice(0, 6);
}

function findSourceRowsForTargets(ctx, targetMap, body = {}) {
  const sources = [
    readJsonSafe(ctx.SORTED_PATH, []),
    readJsonSafe(ctx.RAW_PATH, []),
    readJsonSafe(ctx.PROCESSED_PATH, []),
    readJsonSafe(ctx.FINAL_PATH, []),
  ];
  const out = [];
  const seen = new Set();
  for (const id of targetMap.keys()) {
    let row = null;
    for (const src of sources) {
      if (!Array.isArray(src)) continue;
      row = src.find(r => rowPatientId(r) === id);
      if (row) break;
    }
    if (!row) {
      row = {
        ma_bn: id,
        'Mã BN': id,
        ho_ten: body.ho_ten || body.name || '',
        'Họ tên': body.ho_ten || body.name || '',
      };
    }
    if (!seen.has(id)) {
      seen.add(id);
      out.push(row);
    }
  }
  return out;
}

function mergeFreshRawRows(oldRows, freshRows, targetKeys) {
  const kept = (Array.isArray(oldRows) ? oldRows : []).filter(row => !targetKeys.has(keyForRow(row)));
  const fresh = (Array.isArray(freshRows) ? freshRows : []).filter(row => targetKeys.has(keyForRow(row)));
  return [...kept, ...fresh];
}

function snapshotRuntimeFile(filePath) {
  try {
    if (!filePath || !fs.existsSync(filePath)) return { exists: false, data: null };
    return { exists: true, data: fs.readFileSync(filePath) };
  } catch {
    return { exists: false, data: null };
  }
}

function restoreRuntimeFile(filePath, snapshot) {
  if (!filePath || !snapshot) return;
  if (!snapshot.exists) { safeUnlink(filePath); return; }
  ensureDir(path.dirname(filePath));
  const tmp = `${filePath}.restore-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, snapshot.data, { mode: 0o600 });
  safeUnlink(filePath);
  fs.renameSync(tmp, filePath);
}

async function precheckInputChanges(req, ctx, targets) {
  const targetMap = targetMapFromTargets(targets);
  const targetKeys = targetKeySetFromMap(targetMap);
  const precheckTaskName = taskNameFromTargets(targets);
  if (precheckTaskName === 'input_care') {
    console.log(`[CARE 1/4] Bắt đầu tiền kiểm y lệnh cho ${targetKeys.size} BN/ngày.`);
  } else if (precheckTaskName === 'input_infusions') {
    console.log(`[INFUSION 1/4] Bắt đầu tiền kiểm y lệnh cho ${targetKeys.size} BN/ngày.`);
  }
  if (!targetKeys.size) {
    return { status: 'ok', checked_count: 0, message: 'Không có BN/ngày cần kiểm tra.' };
  }

  const sourceRows = findSourceRowsForTargets(ctx, targetMap, req.body || {});
  if (!sourceRows.length) {
    return { status: 'error', message: 'Không tìm được dòng người bệnh để kiểm tra lại y lệnh.' };
  }

  ensureSessionAssets(ctx.dir, ROOT_DIR);
  const stamp = `${Date.now()}_${safeFilePart((targets.taskType || 'input').slice(0, 30))}`;
  const checkInputPath = path.join(ctx.dir, `precheck_input_${stamp}.json`);
  const checkOutPath = path.join(ctx.dir, `precheck_ylenh_${stamp}.json`);
  const { from, to } = dateRangeFromTargets(targetMap);

  try {
    writeJsonAtomic(checkInputPath, sourceRows);
    const args = ['--input', checkInputPath, '--out', checkOutPath];
    if (from) args.push('--from', from);
    if (to) args.push('--to', to);

    let result;
    try {
      if (precheckTaskName === 'input_care') {
        console.log(`[CARE 1/4] Đang đọc lại y lệnh EMR trong khoảng ${from || '?'} → ${to || '?'}.`);
      } else if (precheckTaskName === 'input_infusions') {
        console.log(`[INFUSION 1/4] Đang đọc lại y lệnh EMR trong khoảng ${from || '?'} → ${to || '?'}.`);
      }
      result = await runWorker('details', args, {
        onSpawn: killFn => registerCancel(ctx.sid, killFn),
        runtimeDir: ctx.dir,
      });
    } finally {
      unregisterCancel(ctx.sid);
    }

    if (result.spawnError)      return { status: 'error', message: 'Không khởi động được Python kiểm tra y lệnh: ' + result.spawnError };
    if (result.killedByTimeout) return { status: 'error', message: 'Timeout khi kiểm tra thay đổi trước khi nhập.' };
    if (result.code !== 0)      return { status: 'error', message: fmtPyError('Python lỗi khi kiểm tra thay đổi trước khi nhập.', result) };

    if (precheckTaskName === 'input_care') {
      console.log('[CARE 1/4] Python tiền kiểm đã kết thúc; đang đọc và đối chiếu kết quả.');
    } else if (precheckTaskName === 'input_infusions') {
      console.log('[INFUSION 1/4] Python tiền kiểm đã kết thúc; đang đọc và đối chiếu kết quả.');
    }
    const freshRows = readJsonSafe(checkOutPath, []);
    if (!Array.isArray(freshRows) || !freshRows.length) {
      return { status: 'error', message: 'Không lấy được dữ liệu mới để kiểm tra y lệnh. Chưa nhập để tránh sai.' };
    }

    const oldRows = readJsonSafe(ctx.FINAL_PATH, []);
    const oldHashes = groupRawHashes(oldRows, targetKeys);
    const newHashes = groupRawHashes(freshRows, targetKeys);

    const missing = [...targetKeys].filter(k => !newHashes.has(k));
    if (missing.length) {
      return {
        status: 'error',
        message: 'Không kiểm tra được một số BN/ngày nên chưa nhập: ' + missing.slice(0, 8).join(', ') + (missing.length > 8 ? '…' : ''),
        missing,
      };
    }

    const checkedAt = new Date().toISOString();
    const changed = [];
    for (const key of targetKeys) {
      const oldHash = oldHashes.get(key) || '';
      const newHash = newHashes.get(key) || '';
      if (oldHash !== newHash) {
        const [ma_bn, ngay_lam] = key.split('::');
        const oldForKey = oldRows.filter(r => keyForRow(r) === key);
        const freshForKey = freshRows.filter(r => keyForRow(r) === key);
        const oldLatest = latestOrderTimeFromRows(oldForKey);
        const newLatest = latestOrderTimeFromRows(freshForKey);
        const changes = summarizePrecheckChanges(oldForKey, freshForKey);
        changed.push({
          key,
          ma_bn,
          ngay_lam,
          last_order_time: newLatest,
          old_last_order_time: oldLatest,
          changed_at: newLatest || oldLatest || '',
          changes,
          reason: changes.length ? changes.join('; ') : (oldHash ? 'Y lệnh/diễn biến/tình trạng đã thay đổi' : 'Có dữ liệu mới chưa có trong lần xử lý trước'),
        });
      }
    }

    if (!changed.length) {
      if (precheckTaskName === 'input_care') {
        console.log(`[CARE 2/4] Tiền kiểm xong: ${targetKeys.size} BN/ngày không có thay đổi.`);
      } else if (precheckTaskName === 'input_infusions') {
        console.log(`[INFUSION 2/4] Tiền kiểm xong: ${targetKeys.size} BN/ngày không có thay đổi.`);
      }
      return {
        status: 'ok',
        checked_at: checkedAt,
        checked_count: targetKeys.size,
        message: `Đã kiểm tra ${targetKeys.size} BN/ngày: chưa thấy y lệnh mới.`,
      };
    }

    // Có thay đổi: phân loại là một module riêng. Nếu module này tắt/lỗi thì không phát token nhập,
    // đồng thời giữ nguyên bộ dữ liệu chính để tránh trạng thái raw mới nhưng classified cũ.
    const classifyFeature = getFeature('orders.classify');
    if (classifyFeature?.enabled === false) {
      return {
        status: 'changed',
        allow_input: false,
        checked_at: checkedAt,
        changed_count: changed.length,
        checked_count: targetKeys.size,
        changed,
        classification: { status: 'skipped', reason: 'feature-disabled' },
        message: `Có ${changed.length} BN/ngày có dữ liệu mới nhưng module phân loại đang tắt. Chưa cập nhật dữ liệu chính và chưa cho phép nhập.`,
      };
    }

    const finalSnapshot = snapshotRuntimeFile(ctx.FINAL_PATH);
    const processedSnapshot = snapshotRuntimeFile(ctx.PROCESSED_PATH);
    writeJsonAtomic(ctx.FINAL_PATH, mergeFreshRawRows(oldRows, freshRows, targetKeys));
    let classification;
    try {
      if (precheckTaskName === 'input_care') {
        console.log(`[CARE 2/4] Phát hiện ${changed.length} BN/ngày có thay đổi; đang tự cập nhật và phân loại lại.`);
      } else if (precheckTaskName === 'input_infusions') {
        console.log(`[INFUSION 2/4] Phát hiện ${changed.length} BN/ngày có thay đổi; đang tự cập nhật và phân loại lại.`);
      }
      classification = await postprocessOrders(ctx, { reason: 'input_precheck_changed' });
      if (precheckTaskName === 'input_care') {
        console.log('[CARE 2/4] Đã cập nhật và phân loại dữ liệu mới thành công.');
      } else if (precheckTaskName === 'input_infusions') {
        console.log('[INFUSION 2/4] Đã cập nhật và phân loại dữ liệu mới thành công.');
      }
    } catch (err) {
      restoreRuntimeFile(ctx.FINAL_PATH, finalSnapshot);
      restoreRuntimeFile(ctx.PROCESSED_PATH, processedSnapshot);
      return {
        status: 'changed',
        allow_input: false,
        checked_at: checkedAt,
        changed_count: changed.length,
        checked_count: targetKeys.size,
        changed,
        classification: { status: 'failed', code: err.code || 'ORDER_POSTPROCESS_FAILED', message: String(err.message || err).slice(0, 1000) },
        message: `Có ${changed.length} BN/ngày có dữ liệu mới nhưng phân loại thất bại. Đã khôi phục dữ liệu trước đó và chưa cho phép nhập.`,
      };
    }

    const namesById = new Map(sourceRows.map(r => [rowPatientId(r), r.ho_ten || r['Họ tên'] || rowPatientId(r)]));
    const label = changed.slice(0, 6).map(x => {
      const name = namesById.get(x.ma_bn) || x.ma_bn;
      return `${name} ${x.ngay_lam}${x.last_order_time ? ` (${x.last_order_time})` : ''}`;
    }).join('; ');
    return {
      status: 'changed',
      allow_input: true,
      checked_at: checkedAt,
      updated_at: new Date().toISOString(),
      changed_count: changed.length,
      checked_count: targetKeys.size,
      changed,
      classification,
      message: `Có ${changed.length} BN/ngày có y lệnh/diễn biến mới. Đã tự cập nhật và phân loại thành công. ${label ? `Đã cập nhật: ${label}${changed.length > 6 ? '…' : ''}` : ''}`,
    };
  } finally {
    safeUnlink(checkInputPath);
    safeUnlink(checkOutPath);
  }
}



function isHchanhDirectVtytTargets(rawTargets = {}, taskName = '') {
  const raw = rawTargets && typeof rawTargets === 'object' ? rawTargets : {};
  const task = String(taskName || raw.taskName || raw.taskType || '').toLowerCase();
  return Boolean(
    (task.includes('vtyt') || task.includes('input_vtyt')) &&
    (raw.hchanhDirectVtyt || raw.hchanh_direct_vtyt || raw.allowMissingProcessed || raw.source === 'hchanh')
  );
}

function syntheticHchanhVtytRows(targets = {}) {
  const patientIds = Array.isArray(targets.patientIds) ? targets.patientIds : [];
  const patientDates = targets.patientDates && typeof targets.patientDates === 'object' ? targets.patientDates : {};
  const selectedDates = Array.isArray(targets.selectedDates) ? targets.selectedDates : [];
  const rows = [];
  for (const rawId of patientIds) {
    const id = String(rawId || '').trim();
    if (!id) continue;
    const dates = Array.isArray(patientDates[id]) && patientDates[id].length ? patientDates[id] : selectedDates;
    for (const rawDate of dates) {
      const ngay = String(rawDate || '').trim();
      if (!ngay) continue;
      rows.push({
        ma_bn: id,
        id,
        ho_ten: String(targets.ho_ten || targets.name || '').trim(),
        'Họ tên': String(targets.ho_ten || targets.name || '').trim(),
        so_phong: String(targets.phong || targets.room || '').trim(),
        Vi_Tri: String(targets.phong || targets.room || '').trim(),
        ngay_lam: ngay,
        thuoc: { dich_truyen: [], thuoc_tiem: [], thuoc_khac: [] },
        _source: 'hchanh_direct_vtyt',
      });
    }
  }
  return rows;
}

function resultKeyHashes(processedRows, taskType) {
  const byBaseKey = new Map();
  for (const row of (Array.isArray(processedRows) ? processedRows : [])) {
    const id = String(row?.ma_bn || row?.id || '').trim();
    const date = String(row?.ngay_lam || '').trim();
    if (!id || !date) continue;
    const key = `${id}::${date}`;
    if (!byBaseKey.has(key)) byBaseKey.set(key, []);
    byBaseKey.get(key).push(row);
  }
  const out = {};
  const kind = taskType === 'input_infusions' ? 'infusions'
    : taskType === 'input_procedures' ? 'procedures'
      : taskType === 'input_vtyt' ? 'vtyt'
        : 'care';
  for (const [key, rows] of byBaseKey.entries()) {
    out[key] = fingerprintRecords(rows, kind);
  }
  return out;
}


function skippedCountFromResult(pyResult) {
  const skipped = pyResult && pyResult.skipped && typeof pyResult.skipped === 'object' && !Array.isArray(pyResult.skipped)
    ? pyResult.skipped
    : {};
  if (skipped.reason) return 1;
  return Object.keys(skipped).filter(k => k !== 'patient_count').length;
}

function skippedReasonFromResult(pyResult) {
  const skipped = pyResult && pyResult.skipped && typeof pyResult.skipped === 'object' && !Array.isArray(pyResult.skipped)
    ? pyResult.skipped
    : {};
  if (skipped.reason) return String(skipped.reason);
  const entries = Object.entries(skipped).filter(([k]) => k !== 'patient_count');
  if (!entries.length) return '';
  const preview = entries.slice(0, 5).map(([k, v]) => `${k}: ${v}`).join('; ');
  return `Đã bỏ qua hợp lệ ${entries.length} BN/ngày: ${preview}${entries.length > 5 ? '…' : ''}`;
}

function isUnifiedDirectEmrSync(targets = {}, taskName = '') {
  const direct = Boolean(targets.directEmrSync || targets.direct_emr_sync);
  if (!direct) return false;

  const task = String(taskName || targets.taskName || targets.taskType || '').toLowerCase();
  if (task === 'input_care') return Boolean(targets.unifiedCare || targets.unified_care);
  if (task === 'input_infusions') return Boolean(targets.unifiedInfusions || targets.unified_infusions);
  if (task === 'input_procedures') return Boolean(targets.unifiedProcedures || targets.unified_procedures);
  return false;
}

function cleanTargetIdList(values) {
  const out = [];
  const seen = new Set();
  for (const item of (Array.isArray(values) ? values : [])) {
    const id = patientIdOfTarget(item);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

function createInputScopeAudit(ctx, rawTargets, targets, taskName) {
  try {
    ensureDir(ctx.LOGS_DIR);
    const requestedIds = cleanTargetIdList(rawTargets?.patientIds);
    const finalIds = cleanTargetIdList(targets?.patientIds);
    const finalSet = new Set(finalIds);
    const excludedIds = cleanTargetIdList(rawTargets?.excludedPatientIds || rawTargets?.excluded_patient_ids);
    const normalizedOutIds = requestedIds.filter(id => !finalSet.has(id));
    const audit = {
      schema_version: 1,
      task: String(taskName || ''),
      session_id: ctx.sid || 'default',
      started_at: new Date().toISOString(),
      status: 'started',
      input_mode: String(rawTargets?.inputMode || rawTargets?.input_mode || ''),
      target_rooms: Array.isArray(targets?.targetRooms) ? targets.targetRooms : [],
      selected_dates: Array.isArray(targets?.selectedDates) ? targets.selectedDates : [],
      requested_patient_ids: requestedIds,
      excluded_patient_ids: excludedIds,
      normalized_out_patient_ids: normalizedOutIds,
      target_patient_ids: finalIds,
      patient_dates: targets?.patientDates && typeof targets.patientDates === 'object' ? targets.patientDates : {},
      counts: {
        requested: requestedIds.length,
        excluded: excludedIds.length,
        normalized_out: normalizedOutIds.length,
        target: finalIds.length,
      },
    };
    const auditPath = path.join(
      ctx.LOGS_DIR,
      `input_scope_${safeFilePart(taskName || 'input')}_${Date.now()}.json`,
    );
    writeJsonAtomic(auditPath, audit);
    appendActivity(ctx, {
      kind: 'workflow.input.scope',
      task: taskName,
      patient_count: finalIds.length,
      excluded_count: excludedIds.length,
      normalized_out_count: normalizedOutIds.length,
      target_rooms: audit.target_rooms.join(','),
    });
    return auditPath;
  } catch (err) {
    console.warn('[INPUT_AUDIT] Không ghi được audit phạm vi:', String(err.message || err));
    return '';
  }
}

function updateInputScopeAudit(auditPath, patch = {}) {
  if (!auditPath) return;
  try {
    const current = readJsonSafe(auditPath, {}) || {};
    writeJsonAtomic(auditPath, {
      ...current,
      ...patch,
      finished_at: patch.finished_at || new Date().toISOString(),
    });
  } catch (err) {
    console.warn('[INPUT_AUDIT] Không cập nhật được audit:', String(err.message || err));
  }
}

async function runInputTask(req, res, ctx, { scriptName, taskName, targetsFilePrefix, doneStatePath, resultFileName, emptyPatientMsg }) {
  ensureDir(ctx.dir);

  const rawBody = req.body || {};
  const allowHchanhDirect = isHchanhDirectVtytTargets(rawBody, taskName || scriptName);
  let processedPathForWorker = ctx.PROCESSED_PATH;
  let processedRows = [];

  if (fs.existsSync(ctx.PROCESSED_PATH)) {
    processedRows = sanitizeStaleDischargeRows(enrichRowsWithCurrentRooms(readJsonSafe(ctx.PROCESSED_PATH, []), ctx));
  } else if (allowHchanhDirect) {
    processedRows = syntheticHchanhVtytRows(rawBody);
    if (!processedRows.length) {
      return res.status(400).json({ status: 'error', message: emptyPatientMsg });
    }
    processedPathForWorker = path.join(ctx.dir, `hchanh_direct_vtyt_processed_${Date.now()}.json`);
    try {
      writeJsonAtomic(processedPathForWorker, processedRows);
    } catch {
      return res.status(500).json({ status: 'error', message: 'Không tạo được dữ liệu tạm để nhập VTYT từ Hành chánh.' });
    }
  } else {
    return res.status(400).json({ status: 'error', message: "Chưa có file phân loại. Hãy chạy 'Xử Lý' trước." });
  }

  const targets       = normalizeInputTargets(rawBody, processedRows);
  const auditPath = createInputScopeAudit(ctx, rawBody, targets, taskName || scriptName);
  if (!targets.patientIds.length) {
    updateInputScopeAudit(auditPath, { status: 'rejected', error: emptyPatientMsg });
    return res.status(400).json({ status: 'error', message: emptyPatientMsg });
  }

  const directEmrSync = isUnifiedDirectEmrSync(targets, taskName || scriptName);
  const serverAuthorizedBypass = ALLOW_INPUT_WITHOUT_PRECHECK && hasRole(req.auth, 'supervisor');
  if (!serverAuthorizedBypass) {
    if ((taskName || scriptName) === 'input_care') {
      console.log('[CARE 3/4] Đã nhận yêu cầu nhập chăm sóc; đang xác nhận token tiền kiểm.');
    } else if ((taskName || scriptName) === 'input_infusions') {
      console.log('[INFUSION 3/4] Đã nhận yêu cầu nhập dịch truyền; đang xác nhận token tiền kiểm.');
    }
    const tokenCheck = validateAndConsumeInputPrecheckToken(ctx, taskName || scriptName, targets);
    if (!tokenCheck.ok) {
      updateInputScopeAudit(auditPath, { status: 'needs_precheck', error: tokenCheck.message });
      return res.status(tokenCheck.status || 428).json({ status: 'needs_precheck', message: tokenCheck.message });
    }
  } else {
    appendActivity(ctx, { kind: 'workflow.precheck.server_bypass', actor: req.auth, task: taskName || scriptName });
  }
  if (directEmrSync) {
    appendActivity(ctx, {
      kind: 'workflow.input.direct_emr_sync',
      task: taskName || scriptName,
      patient_count: targets.patientIds.length,
    });
  }

  const workerTargets = { ...targets };
  delete workerTargets.precheck_token;
  delete workerTargets.precheckToken;
  // Metadata chỉ dùng cho xác nhận/audit, không cần chuyển cho worker Selenium.
  delete workerTargets.patientSummaries;
  delete workerTargets.excludedPatients;
  delete workerTargets.excludedPatientIds;
  delete workerTargets.inputMode;

  if (processedPathForWorker === ctx.PROCESSED_PATH) {
    const sanitizedPath = path.join(path.dirname(ctx.PROCESSED_PATH), `${targetsFilePrefix}_processed_sanitized_${Date.now()}.json`);
    try {
      writeJsonAtomic(sanitizedPath, processedRows);
      processedPathForWorker = sanitizedPath;
    } catch (err) {
      updateInputScopeAudit(auditPath, { status: 'failed', error: 'Không tạo được dữ liệu tạm đã chuẩn hoá trước khi nhập.' });
      return res.status(500).json({ status: 'error', message: 'Không tạo được dữ liệu tạm đã chuẩn hoá trước khi nhập.' });
    }
  }

  const targetsPath = path.join(ctx.dir, `${targetsFilePrefix}_${Date.now()}.json`);
  // Python tính result_path từ dirname(PROCESSED_PATH) = ctx.dir/data/
  // nên phải đọc ở đúng chỗ Python ghi, không phải ctx.dir gốc.
  const resultDir   = path.dirname(processedPathForWorker);
  const resultPath  = path.join(resultDir, resultFileName);
  const hashByKey   = resultKeyHashes(processedRows, taskName || scriptName);

  // Xoá result file cũ để tránh đọc nhầm kết quả lần trước
  safeUnlink(resultPath);

  try {
    writeJsonAtomic(targetsPath, workerTargets);
    beginTask(ctx.TASK_PROGRESS_PATH, taskName || scriptName, workerTargets);
  } catch {
    updateInputScopeAudit(auditPath, { status: 'failed', error: 'Không ghi được file targets.' });
    return res.status(500).json({ status: 'error', message: 'Không ghi được file targets.' });
  }

  try {
    ensureSessionAssets(ctx.dir, ROOT_DIR);
    await enqueueHeavy(ctx.sid, async () => {
      let result;
      try {
        if ((taskName || scriptName) === 'input_care') {
          console.log(`[CARE 3/4] Khởi động input_care.py cho ${targets.patientIds.length} người bệnh.`);
        } else if ((taskName || scriptName) === 'input_infusions') {
          console.log(`[INFUSION 3/4] Khởi động input_infusions.py cho ${targets.patientIds.length} người bệnh.`);
        }
        result = await runScript(scriptName, [processedPathForWorker, targetsPath], {
          onSpawn: killFn => registerCancel(ctx.sid, killFn),
          runtimeDir: ctx.dir,
        });
      } finally {
        unregisterCancel(ctx.sid);
        safeUnlink(targetsPath);
        if (processedPathForWorker !== ctx.PROCESSED_PATH) safeUnlink(processedPathForWorker);
      }

      if ((taskName || scriptName) === 'input_care') {
        console.log(`[CARE 4/4] input_care.py kết thúc: exit=${result.code}, timeout=${Boolean(result.killedByTimeout)}, spawnError=${Boolean(result.spawnError)}.`);
      } else if ((taskName || scriptName) === 'input_infusions') {
        console.log(`[INFUSION 4/4] input_infusions.py kết thúc: exit=${result.code}, timeout=${Boolean(result.killedByTimeout)}, spawnError=${Boolean(result.spawnError)}.`);
      }

      if (result.spawnError) {
        updateInputScopeAudit(auditPath, { status: 'failed', error: `Không khởi động được Python: ${result.spawnError}` });
        return res.status(500).json({ status: 'error', message: `Không khởi động được Python: ${result.spawnError}` });
      }
      if (result.killedByTimeout) {
        updateInputScopeAudit(auditPath, { status: 'failed', error: `Timeout (${scriptName})` });
        return res.status(504).json({ status: 'error', message: `Timeout (${scriptName})` });
      }

      if (result.code === 0 || result.code === 2) {
        // code=0: tất cả thành công; code=2: partial (một số BN lỗi, kết quả trong result file)
        const pyResult = readJsonSafe(resultPath, null);
        safeUnlink(resultPath);

        // SAFETY: Python phải tạo result file mới được mark done.
        // Nếu không có file → script kết thúc sớm/crash trước khi ghi kết quả
        // → không biết BN nào thực sự đã nhập → không mark bất kỳ cái gì.
        if (!pyResult || !Array.isArray(pyResult.succeeded)) {
          console.error(`[INPUT][${ctx.sid}] ${scriptName} exit ${result.code} nhưng không có result file hợp lệ.`);
          failRunningTask(ctx.TASK_PROGRESS_PATH, taskName || scriptName, 'Script không tạo được file kết quả hợp lệ');
          updateInputScopeAudit(auditPath, { status: 'failed', error: 'Script không tạo được file kết quả hợp lệ' });
          return res.status(500).json({
            status:  'error',
            message: `Script ${scriptName} không tạo được file kết quả. `
                   + 'Dữ liệu có thể CHƯA được nhập vào EMR — kiểm tra log server trước khi thử lại.',
          });
        }

        // Chỉ mark done những key Python xác nhận succeeded (không dùng "tất cả trừ failed")
        const succeededKeys = new Set(pyResult.succeeded);
        const failedKeys    = new Set(pyResult.failed ? Object.keys(pyResult.failed) : []);
        finishTask(ctx.TASK_PROGRESS_PATH, taskName || scriptName, pyResult, failedKeys.size ? 'failed' : 'done');

        try {
          let doneKeysToStore = [...succeededKeys];
          if ((taskName || scriptName) === 'input_procedures') {
            const failedBases = new Set([...failedKeys].map(k => baseDoneKey(k)));
            const baseOk = new Set();
            for (const k of succeededKeys) {
              const bk = baseDoneKey(k);
              if (!failedBases.has(bk)) baseOk.add(bk);
            }
            doneKeysToStore = [...new Set([...doneKeysToStore, ...baseOk])];
          }
          markDoneKeys(doneStatePath, doneKeysToStore, hashByKey, { task: taskName || scriptName });
        } catch (err) {
          console.error('[INPUT] Không ghi được done-state:', err.message);
        }

        // Không có dữ liệu phù hợp để nhập không phải lỗi hệ thống.
        if (succeededKeys.size === 0 && failedKeys.size === 0) {
          const skippedReason = skippedReasonFromResult(pyResult);
          if (skippedReason) {
            markRunningTaskStatus(ctx.TASK_PROGRESS_PATH, taskName || scriptName, 'skipped', skippedReason);
            updateInputScopeAudit(auditPath, {
              status: 'skipped',
              result: { succeeded_count: 0, failed_count: 0, skipped_count: skippedCountFromResult(pyResult) },
              skipped: pyResult.skipped || {},
            });
            return res.json({
              status:          'skipped',
              message:         skippedReason,
              succeeded_count: 0,
              skipped_count:   skippedCountFromResult(pyResult),
              skipped:         pyResult.skipped,
            });
          }

          markRunningTaskStatus(ctx.TASK_PROGRESS_PATH, taskName || scriptName, 'failed', 'Script hoàn thành nhưng không có BN nào được nhập');
          updateInputScopeAudit(auditPath, { status: 'failed', error: 'Script hoàn thành nhưng không có BN nào được nhập' });
          return res.status(500).json({
            status:  'error',
            message: `Script hoàn thành nhưng không có BN nào được nhập. `
                   + 'Kiểm tra lại dữ liệu đầu vào và log server.',
          });
        }

        if (failedKeys.size > 0) {
          const failList = [...failedKeys].map(k => `${k}: ${pyResult.failed[k]}`).join('; ');
          appendActivity(ctx, {
            kind: 'workflow.input.partial',
            task: taskName || scriptName,
            succeeded_count: succeededKeys.size,
            failed_count: failedKeys.size,
          });
          updateInputScopeAudit(auditPath, {
            status: 'partial',
            result: {
              succeeded_count: succeededKeys.size,
              failed_count: failedKeys.size,
              skipped_count: skippedCountFromResult(pyResult),
            },
            succeeded_keys: [...succeededKeys],
            failed: pyResult.failed || {},
            skipped: pyResult.skipped || {},
          });
          return res.status(207).json({
            status:          'partial',
            message:         `Nhập xong nhưng ${failedKeys.size} BN/ngày thất bại: ${failList}`,
            succeeded_count: succeededKeys.size,
            failed:          pyResult.failed,
            skipped_count:   skippedCountFromResult(pyResult),
            skipped:         pyResult.skipped || {},
          });
        }

        appendActivity(ctx, {
          kind: 'workflow.input.success',
          task: taskName || scriptName,
          succeeded_count: succeededKeys.size,
        });
        updateInputScopeAudit(auditPath, {
          status: 'ok',
          result: {
            succeeded_count: succeededKeys.size,
            failed_count: 0,
            skipped_count: skippedCountFromResult(pyResult),
          },
          succeeded_keys: [...succeededKeys],
          skipped: pyResult.skipped || {},
        });
        return res.json({
          status:  'ok',
          message: `Thành công! Đã nhập ${succeededKeys.size} BN/ngày.` + (skippedCountFromResult(pyResult) ? ` Bỏ qua hợp lệ ${skippedCountFromResult(pyResult)} BN/ngày.` : ''),
          skipped_count: skippedCountFromResult(pyResult),
          skipped: pyResult.skipped || {},
        });
      }

      const pythonError = fmtPyError('Python lỗi khi nhập EMR.', result);
      failRunningTask(ctx.TASK_PROGRESS_PATH, taskName || scriptName, pythonError);
      updateInputScopeAudit(auditPath, { status: 'failed', error: pythonError });
      return res.status(500).json({ status: 'error', message: pythonError });
    });
  } catch (err) {
    safeUnlink(targetsPath);
    if (processedPathForWorker !== ctx.PROCESSED_PATH) safeUnlink(processedPathForWorker);
    failRunningTask(ctx.TASK_PROGRESS_PATH, taskName || scriptName, String(err.message || err));
    updateInputScopeAudit(auditPath, { status: 'failed', error: String(err.message || err) });
    if (!res.headersSent) res.status(500).json({ status: 'error', message: String(err.message || err) });
  }
}


// ── POST /api/check-input-changes ────────────────────────────────────────────
// Kiểm tra thủ công trước khi nhập. Endpoint này chỉ đọc/đối chiếu và cấp token;
// tuyệt đối không chạy worker ghi EMR.
router.post('/check-input-changes', async (req, res) => {
  const ctx = getRuntimePaths(req);
  const rawBody = req.body || {};

  if (!fs.existsSync(ctx.PROCESSED_PATH)) {
    return res.status(400).json({ status: 'error', message: "Chưa có file phân loại. Hãy chạy 'Xử Lý' trước." });
  }
  const processedRows = sanitizeStaleDischargeRows(enrichRowsWithCurrentRooms(readJsonSafe(ctx.PROCESSED_PATH, []), ctx));
  const targets = normalizeInputTargets(rawBody, processedRows);
  if (!targets.patientIds.length) {
    return res.status(400).json({ status: 'error', message: 'Không có BN/ngày cần kiểm tra.' });
  }

  // QUAN TRỌNG:
  // Chỉ tiền kiểm chạy trong queue này. Không gọi runInputTask() từ bên trong
  // enqueueHeavy(), vì runInputTask() tự enqueue thêm một heavy task cùng SID.
  // Nested queue cùng session sẽ chờ lẫn nhau và gây deadlock.
  let result;
  try {
    result = await enqueueHeavy(ctx.sid, async () => precheckInputChanges(req, ctx, targets));
  } catch (err) {
    if (!res.headersSent) {
      return res.status(500).json({ status: 'error', message: String(err.message || err) });
    }
    return;
  }

  // Tới đây task tiền kiểm đã RA KHỎI queue. Chỉ trả kết quả + token về UI;
  // worker ghi EMR chỉ được chạy ở endpoint /run-input-* sau xác nhận người dùng.
  try {
    if (result.status === 'ok') {
      const resolvedTask = taskNameFromTargets(targets);
      const precheck = issueInputPrecheckToken(
        ctx,
        resolvedTask,
        targets,
        { checked_count: result.checked_count || 0 },
      );
      appendActivity(ctx, {
        kind: 'workflow.precheck.ok',
        task: resolvedTask,
        checked_count: result.checked_count || 0,
      });

      // Tiền kiểm tuyệt đối không được tự chạy worker nhập EMR.
      // Frontend phải nhận token, hiển thị xác nhận phạm vi, rồi mới gọi
      // /run-input-care hoặc /run-input-infusions bằng token một lần.
      return res.json({ ...result, ...precheck });
    }

    if (result.status === 'changed') {
      const resolvedTask = taskNameFromTargets(targets);
      const cannotContinue = result.allow_input === false;
    const canContinue = !cannotContinue;
      const precheck = canContinue
        ? issueInputPrecheckToken(
            ctx,
            resolvedTask,
            targets,
            { checked_count: result.checked_count || 0 },
          )
        : {};

      appendActivity(ctx, {
        kind: 'workflow.precheck.changed',
        task: resolvedTask,
        checked_count: result.checked_count || 0,
        changed_count: result.changed_count || 0,
        allow_input: canContinue,
        classification_status: result.classification?.status || '',
      });

      if (canContinue) {
        // Giữ status=changed để UI biết dữ liệu vừa được cập nhật, nhưng chỉ
        // cấp token. Không tự nhập EMR trong endpoint tiền kiểm.
        return res.json({
          ...result,
          precheck_status: 'changed',
          changes_detected: true,
          auto_refreshed: true,
          message: `Đã tự cập nhật ${result.changed_count || 0} BN/ngày có thay đổi và phân loại lại.`,
          ...precheck,
        });
      }

      return res.status(409).json({ ...result, ...precheck });
    }

    return res.status(500).json(result);
  } catch (err) {
    if (!res.headersSent) {
      return res.status(500).json({ status: 'error', message: String(err.message || err) });
    }
  }
});


// ── POST /api/run-input-infusions ────────────────────────────────────────────

router.post('/run-input-infusions', async (req, res) => {
  const ctx = getRuntimePaths(req);
  await runInputTask(req, res, ctx, {
    scriptName:       'input_infusions.py',
    taskName:         'input_infusions',
    targetsFilePrefix:'input_targets_infus',
    doneStatePath:    ctx.INFUSIONS_DONE_PATH,
    resultFileName:   'input_infusions_result.json',
    emptyPatientMsg:  'Không xác định được mã bệnh nhân để nhập dịch truyền.',
  });
});


// ── POST /api/run-input-procedures ───────────────────────────────────────────

router.post('/run-input-procedures', async (req, res) => {
  const ctx = getRuntimePaths(req);
  const proceduresDonePath = ctx.PROCEDURES_DONE_PATH || path.join(ctx.dir, 'procedures_done.json');
  await runInputTask(req, res, ctx, {
    scriptName:       'input_procedures.py',
    taskName:         'input_procedures',
    targetsFilePrefix:'input_targets_procedures',
    doneStatePath:    proceduresDonePath,
    resultFileName:   'input_procedures_result.json',
    emptyPatientMsg:  'Không xác định được mã bệnh nhân để nhập thủ thuật.',
  });
});



// ── POST /api/preview-input-vtyt ────────────────────────────────────────────
// Quét popup Nhập thuốc/VTYT để xem trước thuốc, VTYT và cảnh báo; chưa nhập EMR.
router.post('/preview-input-vtyt', async (req, res) => {
  const ctx = getRuntimePaths(req);
  ensureDir(ctx.dir);

  const rawBody = req.body || {};
  const allowHchanhDirect = isHchanhDirectVtytTargets(rawBody, 'input_vtyt');
  let processedPathForWorker = ctx.PROCESSED_PATH;
  let processedRows = [];

  if (fs.existsSync(ctx.PROCESSED_PATH)) {
    processedRows = sanitizeStaleDischargeRows(enrichRowsWithCurrentRooms(readJsonSafe(ctx.PROCESSED_PATH, []), ctx));
  } else if (allowHchanhDirect) {
    processedRows = syntheticHchanhVtytRows(rawBody);
    if (!processedRows.length) {
      return res.status(400).json({ status: 'error', message: 'Không xác định được mã bệnh nhân để quét VTYT.' });
    }
    processedPathForWorker = path.join(ctx.dir, `hchanh_preview_vtyt_processed_${Date.now()}.json`);
    try { writeJsonAtomic(processedPathForWorker, processedRows); }
    catch { return res.status(500).json({ status: 'error', message: 'Không tạo được dữ liệu tạm để quét VTYT.' }); }
  } else {
    return res.status(400).json({ status: 'error', message: "Chưa có file phân loại. Hãy chạy 'Xử Lý' trước hoặc dùng từ tab Hành chánh." });
  }

  const targets = normalizeInputTargets(rawBody, processedRows);
  if (!targets.patientIds.length) {
    return res.status(400).json({ status: 'error', message: 'Không có BN/ngày cần quét VTYT.' });
  }

  const workerTargets = { ...targets, source: rawBody.source || targets.source || 'hchanh', hchanhDirectVtyt: true };
  const targetsPath = path.join(ctx.dir, `preview_targets_vtyt_${Date.now()}.json`);
  const resultDir = path.dirname(processedPathForWorker);
  const resultPath = path.join(resultDir, 'input_vtyt_result.json');
  safeUnlink(resultPath);

  try {
    writeJsonAtomic(targetsPath, workerTargets);
    beginTask(ctx.TASK_PROGRESS_PATH, 'preview_input_vtyt', workerTargets);
  } catch {
    return res.status(500).json({ status: 'error', message: 'Không ghi được file targets quét VTYT.' });
  }

  try {
    ensureSessionAssets(ctx.dir, ROOT_DIR);
    await enqueueHeavy(ctx.sid, async () => {
      let result;
      try {
        result = await runScript('input_vtyt.py', [processedPathForWorker, targetsPath, '--plan-only'], {
          onSpawn: killFn => registerCancel(ctx.sid, killFn),
          runtimeDir: ctx.dir,
        });
      } finally {
        unregisterCancel(ctx.sid);
        safeUnlink(targetsPath);
        if (processedPathForWorker !== ctx.PROCESSED_PATH) safeUnlink(processedPathForWorker);
      }

      if (result.spawnError)      return res.status(500).json({ status: 'error', message: `Không khởi động được Python: ${result.spawnError}` });
      if (result.killedByTimeout) return res.status(504).json({ status: 'error', message: 'Timeout khi quét thuốc/VTYT.' });

      const pyResult = readJsonSafe(resultPath, null);
      safeUnlink(resultPath);
      if (!pyResult || !Array.isArray(pyResult.plan)) {
        failRunningTask(ctx.TASK_PROGRESS_PATH, 'preview_input_vtyt', 'Script không tạo được file preview VTYT hợp lệ');
        return res.status(500).json({ status: 'error', message: 'Script không tạo được dữ liệu xem trước VTYT hợp lệ.' });
      }

      const failed = pyResult.failed || {};
      const failedCount = Object.keys(failed).length;
      const planCount = Array.isArray(pyResult.plan) ? pyResult.plan.length : 0;
      finishTask(ctx.TASK_PROGRESS_PATH, 'preview_input_vtyt', pyResult, new Set(Object.keys(failed)));
      appendActivity(ctx, { kind: 'workflow.vtyt.preview', actor: req.auth, task: 'input_vtyt', plan_count: planCount, failed_count: failedCount });
      const precheck = failedCount === 0
        ? issueInputPrecheckToken(ctx, 'input_vtyt', targets, { checked_count: planCount })
        : {};
      return res.status(failedCount ? 207 : 200).json({
        status: failedCount ? 'partial' : 'ok',
        message: failedCount ? `Quét xong nhưng ${failedCount} BN/ngày lỗi; chưa cấp quyền nhập.` : `Đã quét ${planCount} BN/ngày thuốc/VTYT để xem trước và cấp xác nhận nhập một lần.`,
        plan: pyResult.plan || [],
        full_plan: pyResult.full_plan || pyResult.plan || [],
        succeeded: pyResult.succeeded || [],
        failed,
        mode: pyResult.mode || 'hchanh_vtyt_preview',
        ...precheck,
      });
    });
  } catch (err) {
    safeUnlink(targetsPath);
    if (processedPathForWorker !== ctx.PROCESSED_PATH) safeUnlink(processedPathForWorker);
    failRunningTask(ctx.TASK_PROGRESS_PATH, 'preview_input_vtyt', String(err.message || err));
    if (!res.headersSent) res.status(500).json({ status: 'error', message: String(err.message || err) });
  }
});

// ── POST /api/run-input-vtyt ────────────────────────────────────────────────

router.post('/run-input-vtyt', async (req, res) => {
  const ctx = getRuntimePaths(req);
  const vtytDonePath = ctx.VTYT_DONE_PATH || path.join(ctx.dir, 'vtyt_done.json');
  await runInputTask(req, res, ctx, {
    scriptName:       'input_vtyt.py',
    taskName:         'input_vtyt',
    targetsFilePrefix:'input_targets_vtyt',
    doneStatePath:    vtytDonePath,
    resultFileName:   'input_vtyt_result.json',
    emptyPatientMsg:  'Không xác định được mã bệnh nhân để nhập VTYT.',
  });
});

// ── POST /api/run-input-care ─────────────────────────────────────────────────

router.post('/run-input-care', async (req, res) => {
  const ctx = getRuntimePaths(req);
  await runInputTask(req, res, ctx, {
    scriptName:       'input_care.py',
    taskName:         'input_care',
    targetsFilePrefix:'input_targets_care',
    doneStatePath:    ctx.CARE_DONE_PATH,
    resultFileName:   'input_care_result.json',
    emptyPatientMsg:  'Không xác định được mã bệnh nhân để nhập chăm sóc.',
  });
});

module.exports = router;
