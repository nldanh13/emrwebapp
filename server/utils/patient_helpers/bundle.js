'use strict';

const { doneKey } = require('../validation');
const { getNurseByShift } = require('../nurse_config');
const { buildTimeline } = require('./timeline');
const { buildPreview } = require('./preview');
const { fingerprintRecords, getDoneInfo, normalizeDoneState } = require('../done_state');

function collectMedicationCategory(records, key) {
  return (Array.isArray(records) ? records : [])
    .flatMap(x => (x.thuoc && Array.isArray(x.thuoc[key])) ? x.thuoc[key] : []);
}

function collectExtraMedicationCategories(records, knownKeys = new Set()) {
  const out = {};
  for (const rec of (Array.isArray(records) ? records : [])) {
    const thuoc = rec?.thuoc || {};
    for (const [key, list] of Object.entries(thuoc)) {
      if (knownKeys.has(key) || !Array.isArray(list) || !list.length) continue;
      if (!out[key]) out[key] = [];
      out[key].push(...list);
    }
  }
  return out;
}

function collectRecordList(records, key) {
  return (Array.isArray(records) ? records : [])
    .flatMap(x => Array.isArray(x?.[key]) ? x[key] : []);
}

function normText(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .toLowerCase();
}

function hasTargetProcedure(records) {
  const rows = Array.isArray(records) ? records : [];
  for (const r of rows) {
    const ck = r?.chi_dinh_khac || {};
    if (Array.isArray(ck.thay_bang_cat_chi) && ck.thay_bang_cat_chi.length) return true;
    const dvkt = Array.isArray(r?.chi_dinh_dvkt) ? r.chi_dinh_dvkt : [];
    for (const item of dvkt) {
      const text = normText(item?.ten || item?.name || item);
      if (/(thay bang|cat chi|cat chi vet mo|thay bang vet mo)/.test(text)) return true;
    }
  }
  return false;
}

function warningCount(records) {
  return collectRecordList(records, 'processing_warnings').length + collectRecordList(records, 'unparsed_orders').length;
}

function collectVtytPlan(records) {
  const itemsByKey = new Map();
  const warnings = [];
  let source = '';
  for (const rec of (Array.isArray(records) ? records : [])) {
    const v = rec?.vtyt && typeof rec.vtyt === 'object' ? rec.vtyt : null;
    if (!v) continue;
    if (v.source && !source) source = String(v.source);
    if (Array.isArray(v.warnings)) warnings.push(...v.warnings.filter(Boolean));
    for (const item of (Array.isArray(v.items) ? v.items : [])) {
      if (!item) continue;
      const key = String(item.key || item.code || item.name || item.searchKeyword || '').trim();
      if (!key) continue;
      const prev = itemsByKey.get(key) || { ...item, required_quantity: 0, reasons: [] };
      const qty = Number(item.required_quantity ?? item.qty ?? item.so_luong ?? 0);
      if (Number.isFinite(qty) && qty > 0) prev.required_quantity = Number(prev.required_quantity || 0) + qty;
      for (const reason of (Array.isArray(item.reasons) ? item.reasons : [])) {
        if (reason && !prev.reasons.includes(reason)) prev.reasons.push(reason);
      }
      itemsByKey.set(key, prev);
    }
  }
  return {
    items: [...itemsByKey.values()].sort((a, b) => String(a.name || a.searchKeyword || '').localeCompare(String(b.name || b.searchKeyword || ''), 'vi')),
    warnings: [...new Set(warnings.map(String))],
    source: source || 'none',
  };
}

function taskDoneInfo(doneStates = {}, key, hash, taskName) {
  const state = doneStates && doneStates[taskName] ? doneStates[taskName] : normalizeDoneState({});
  return getDoneInfo(state, key, hash);
}

// ── Build patient day bundle ───────────────────────────────────────────────────

function buildPatientDayBundle(records, patientId, date, nurseSchedule, doneStates = {}) {
  const rows = Array.isArray(records) ? records : [];
  const r    = rows[0] || {};

  const knownMedicationKeys = new Set(['dich_truyen', 'thuoc_tiem', 'thuoc_uong', 'thuoc_tra', 'khac']);
  const allDichTruyen = collectMedicationCategory(rows, 'dich_truyen');
  const allThuocTiem  = collectMedicationCategory(rows, 'thuoc_tiem');
  const allThuocUong  = collectMedicationCategory(rows, 'thuoc_uong');
  const allThuocTra   = collectMedicationCategory(rows, 'thuoc_tra');
  const allKhac       = collectMedicationCategory(rows, 'khac');
  const extraThuoc    = collectExtraMedicationCategories(rows, knownMedicationKeys);
  const rawOrderEvents = collectRecordList(rows, 'raw_order_events');
  const unparsedOrders = collectRecordList(rows, 'unparsed_orders');
  const processingWarnings = collectRecordList(rows, 'processing_warnings');
  const hasInfusion   = allDichTruyen.length > 0;
  const hasProcedure  = hasTargetProcedure(rows);

  const doneK = doneKey(patientId, date);
  const hashes = {
    care: fingerprintRecords(rows, 'care'),
    infusions: fingerprintRecords(rows, 'infusions'),
    procedures: fingerprintRecords(rows, 'procedures'),
    vtyt: fingerprintRecords(rows, 'vtyt'),
  };

  const careInfo = taskDoneInfo(doneStates, doneK, hashes.care, 'care');
  // care: fallback bare ma_bn giữ tương thích ngược với care_done.json cũ (trước v2.1), nhưng không dùng fallback nếu key theo ngày đã stale.
  const careBareInfo = taskDoneInfo(doneStates, patientId, hashes.care, 'care');
  const care_done = careInfo.done || (!careInfo.stale && careBareInfo.done);
  const care_stale = careInfo.stale || careBareInfo.stale;

  const infusInfo = taskDoneInfo(doneStates, doneK, hashes.infusions, 'infusions');
  const infus_done = hasInfusion && infusInfo.done;
  const infus_stale = hasInfusion && infusInfo.stale;

  const procInfo = taskDoneInfo(doneStates, doneK, hashes.procedures, 'procedures');
  const proc_done = hasProcedure && procInfo.done;
  const proc_stale = hasProcedure && procInfo.stale;

  const vtytInfo = taskDoneInfo(doneStates, doneK, hashes.vtyt, 'vtyt');

  const dtWithNurse = allDichTruyen.map(d => ({
    ...d,
    dieu_duong: getNurseByShift(d.tg_bat_dau || d.gio_dung || '', nurseSchedule),
  }));

  const preview = buildPreview(r, dtWithNurse, nurseSchedule);
  const careRequired = Array.isArray(preview.care) && preview.care.length > 0;
  const warnCount = warningCount(rows);
  const vtytPlan = collectVtytPlan(rows);

  const doneEnough = (!careRequired || care_done) && (!hasInfusion || infus_done) && (!hasProcedure || proc_done);
  const staleAny = care_stale || infus_stale || proc_stale;
  const status = staleAny || warnCount > 0 ? 'amber'
    : doneEnough ? 'green'
      : (care_done || infus_done || proc_done) ? 'amber' : 'gray';

  const dieu_duong_cs = getNurseByShift(date ? `08:00 ${date}` : '', nurseSchedule);
  const admissionTime = r.thoi_gian_vao_khoa || r.tg_vao || r.thoi_gian_vao || r.admission_time || '';
  const departmentName = r.ten_khoa_dieu_tri || r.khoa_dieu_tri || r.khoa_chuyen_den || r.department_name || r.department || '';
  const wardHistory = Array.isArray(r.lich_su_khoa_dieu_tri) ? r.lich_su_khoa_dieu_tri
    : Array.isArray(r.khoa_dieu_tri_history) ? r.khoa_dieu_tri_history
      : Array.isArray(r.ward_admissions) ? r.ward_admissions : [];

  return {
    date,
    bac_si:           r.bac_si           || '',
    xu_tri:           r.xu_tri           || '',
    tg_vao:           admissionTime,
    thoi_gian_vao_khoa: admissionTime,
    khoa_chuyen_den:  departmentName,
    khoa_dieu_tri:    departmentName,
    ten_khoa_dieu_tri: departmentName,
    lich_su_khoa_dieu_tri: wardHistory,
    chan_doan:        r.chan_doan         || '',
    care_mode:        r.care_mode        || '',
    ngay_ra_vien:     r.ngay_ra_vien     || '',
    gio_ra_vien:      r.gio_ra_vien      || '',
    ngay_ra_vien_date:r.ngay_ra_vien_date|| '',
    ra_vien_hom_nay:  Boolean(r.ra_vien_hom_nay),
    care_special_events: r.care_special_events || [],
    surgery_out:      Boolean(r.surgery_out),
    surgery_out_time: r.surgery_out_time || '',
    surgery_out_reason: r.surgery_out_reason || '',
    has_infusion:     hasInfusion,
    has_procedure:    hasProcedure,
    care_required:    careRequired,
    care_done,
    care_stale,
    infus_done,
    infus_stale,
    procedure_done:   proc_done,
    procedure_stale:  proc_stale,
    vtyt_done:        vtytInfo.done,
    vtyt_stale:       vtytInfo.stale,
    task_hashes:      hashes,
    done_key:         doneK,
    warning_count:    warnCount,
    status,
    timeline: buildTimeline(allDichTruyen, allThuocTiem, allThuocUong, allThuocTra, rows),
    preview,
    raw_order_events: rawOrderEvents,
    unparsed_orders: unparsedOrders,
    processing_warnings: processingWarnings,
    vtyt: vtytPlan,
    // Giữ toàn bộ nhóm thuốc để tab Báo cáo không bị mất TMC/TB/TDD/Khác.
    thuoc:    {
      ...extraThuoc,
      dich_truyen: dtWithNurse,
      thuoc_tiem: allThuocTiem,
      thuoc_uong: allThuocUong,
      thuoc_tra: allThuocTra,
      khac: allKhac,
    },
    ncs:      { ...(r.nhap_cham_soc || {}), dieu_duong: dieu_duong_cs },
    cs_extra: r.chi_dinh_khac || {},
  };
}

module.exports = { collectMedicationCategory, collectExtraMedicationCategories, collectRecordList, hasTargetProcedure, buildPatientDayBundle };
