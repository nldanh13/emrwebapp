'use strict';

// Lấy dữ liệu cho nghiên cứu thẳng từ Kho dữ liệu gốc, không mở EMR.
// Mẫu của nghiên cứu được chọn từ kho, nên XN/CĐHA, hồ sơ, ra viện, phẫu thuật, y lệnh của các lượt
// này đã có sẵn trong kho. Tạo một đợt chạy (run) cho nghiên cứu gồm:
//   - du_lieu_ban_dau.csv = danh sách mẫu của nghiên cứu (Mã NC của nghiên cứu);
//   - các file dữ liệu thô của kho, chỉ giữ dòng của người bệnh/lượt đã chọn, Mã NC đổi sang mã của
//     nghiên cứu;
//   - trạng thái "đã lấy" từng phần (progress) theo kho: phần kho đã lấy xong thì không bị đòi lấy lại;
//     phần kho còn thiếu để trống, Thu thập tự động sẽ chỉ lấy phần đó từ EMR.
// Sau đó chuẩn hóa như một đợt chạy bình thường (bảng chuẩn, analysis_selected theo biến đã chọn).

const fs = require('fs');
const path = require('path');
const { ensureDir, writeJsonAtomic } = require('../utils/file');
const { readCsvTable, writeCsv, patientCode, getCell } = require('./table_io');
const { nowIso, runsDir, cohortPath, archiveRunsDir } = require('./store_paths');
const { normalizedIdentity, isoDate, isoDateTime } = require('./encounter_context');

// File thô của kho được chép (lọc) sang nghiên cứu. du_lieu_ban_dau / research_source tạo lại từ
// danh sách mẫu của nghiên cứu.
const RAW_FILES = [
  'du_lieu_goc.csv',
  'thong_tin_benh_nhan_bo_sung.csv',
  'hchanh_profile.csv',
  'hchanh_discharge.csv',
  'hchanh_surgery.csv',
  'hchanh_order_history.csv',
  'lich_su_xn.csv',
  'lich_su_cdha.csv',
];

const RESEARCH_CODE_COLUMNS = ['Mã NC', 'Ma NC', 'research_code'];
const HCHANH_FILES = ['profile', 'discharge', 'surgery', 'order_history'];
const GOT = new Set(['done', 'empty']);

function nowStamp() {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

// Thời điểm của một dòng thô (ngày chỉ định, ngày y lệnh, giờ vào…). Ghép lượt theo Mã BN + thời gian,
// không theo mã nội trú/điều trị/vào viện (quy ước khóa nguồn: chỉ Mã BN — encounter_context.js).
const ROW_TIME_COLUMNS = [
  'TG chỉ định', 'TG chi dinh', 'Thời gian chỉ định', 'Thoi gian chi dinh', 'Ngày chỉ định', 'Ngay chi dinh',
  'Thời gian', 'Thoi gian', 'Ngày y lệnh', 'Ngay y lenh', 'Ngày', 'Ngay', 'ngay', 'date',
  'Ngày phẫu thuật', 'Ngay phau thuat', 'Ngày mổ', 'Ngay mo',
  'T/G vào', 'TG vao', 'Ngày vào viện', 'Ngay vao vien', 'Ngày ra viện', 'Ngay ra vien',
  'order_datetime', 'order_date', 'lab_datetime', 'lab_date', 'note_datetime', 'note_date',
];

function rowDay(row) {
  for (const c of ROW_TIME_COLUMNS) {
    const v = row?.[c];
    if (v == null || String(v).trim() === '') continue;
    const d = isoDate(isoDateTime(v) || v);
    if (d) return d;
  }
  return '';
}

function encounterWindow(enc) {
  const from = isoDate(isoDateTime(enc?.admission_date) || enc?.admission_date);
  const to = isoDate(isoDateTime(enc?.discharge_date) || enc?.discharge_date);
  return from ? { from, to: to || '9999-12-31' } : null;
}

const inWindow = (day, w) => Boolean(day && w && day >= w.from && day <= w.to);

// Bộ lọc dòng thô của kho cho danh sách mẫu, theo Mã BN + thời gian. Dòng có ngày: rơi vào khoảng
// vào–ra viện của lượt đã chọn thì giữ (gắn Mã NC của nghiên cứu); rơi vào lượt khác của cùng người
// bệnh thì bỏ; không rơi vào lượt nào thì giữ khi người bệnh chỉ có một lượt được chọn (để chuẩn hóa
// xếp tiếp theo thời gian). Dòng không có ngày: giữ nếu là người bệnh trong mẫu.
// links: [{ research_code, patient_code, encounter_id }]; encounterRows: bảng lượt điều trị của kho.
function buildCohortIndex(cohortRows, links = [], encounterRows = []) {
  const encById = new Map(encounterRows.map(e => [String(e.encounter_id || '').trim(), e]));
  const visitsByPatient = new Map(); // Mã BN -> [{ code, window }]
  for (const [i, row] of cohortRows.entries()) {
    const pc = normalizedIdentity(patientCode(row));
    if (!pc) continue;
    const enc = encById.get(String(links[i]?.encounter_id || '').trim());
    if (!visitsByPatient.has(pc)) visitsByPatient.set(pc, []);
    visitsByPatient.get(pc).push({ code: getCell(row, RESEARCH_CODE_COLUMNS), window: enc ? encounterWindow(enc) : null });
  }
  const otherWindows = new Map(); // Mã BN -> khoảng thời gian các lượt KHÔNG thuộc mẫu
  const selectedEids = new Set(links.map(l => String(l?.encounter_id || '').trim()).filter(Boolean));
  for (const enc of encounterRows) {
    const pc = normalizedIdentity(patientCode(enc));
    if (!visitsByPatient.has(pc) || selectedEids.has(String(enc.encounter_id || '').trim())) continue;
    const w = encounterWindow(enc);
    if (!w) continue;
    if (!otherWindows.has(pc)) otherWindows.set(pc, []);
    otherWindows.get(pc).push(w);
  }
  return {
    // Mã NC của nghiên cứu cho dòng thô; '' nếu thuộc người bệnh nhưng chưa rõ lượt; null nếu bỏ.
    codeFor(row) {
      const pc = normalizedIdentity(patientCode(row));
      const visits = visitsByPatient.get(pc);
      if (!visits) return null;
      const day = rowDay(row);
      if (day) {
        const hit = visits.find(v => inWindow(day, v.window));
        if (hit) return hit.code;
        if ((otherWindows.get(pc) || []).some(w => inWindow(day, w))) return null;
      }
      return visits.length === 1 ? visits[0].code : '';
    },
  };
}

function copyFilteredRaw(archiveRunDir, runDir, index) {
  const counts = {};
  for (const file of RAW_FILES) {
    const src = path.join(archiveRunDir, file);
    if (!fs.existsSync(src)) continue;
    const table = readCsvTable(src, Number.MAX_SAFE_INTEGER);
    const codeColumn = (table.columns || []).find(c => RESEARCH_CODE_COLUMNS.includes(c));
    const rows = [];
    for (const row of table.rows || []) {
      const code = index.codeFor(row);
      if (code === null) continue;
      rows.push(codeColumn ? { ...row, [codeColumn]: code } : row);
    }
    writeCsv(path.join(runDir, file), table.columns || [], rows);
    counts[file] = rows.length;
  }
  return counts;
}

// Trạng thái từng phần theo kho (extract_status của kho, theo mã lượt): chỉ mang sang phần kho đã
// lấy xong ('done'/'empty'); phần còn thiếu/lỗi để trống cho Thu thập tự động lấy từ EMR.
// Ghi theo đúng định dạng worker ghi (để cả bảng chuẩn hóa lẫn sổ "Thu thập tự động" đều nhận):
// XN/CĐHA có số dòng + dấu đã lưu từng tab; hành chánh có Mã BN + ngày vào viện để ghép lượt.
function buildProgressFromArchive(archiveRunDir, links, encounterRows = []) {
  const encById = new Map(encounterRows.map(e => [String(e.encounter_id || '').trim(), e]));
  const status = readCsvTable(path.join(archiveRunDir, 'extract_status.csv'), Number.MAX_SAFE_INTEGER).rows || [];
  const byEid = new Map(status.map(r => [String(r.encounter_id || '').trim(), r]));
  const at = nowIso();
  const progress = {};
  const hchanh = {};
  const orders = {};
  let carried = 0;
  for (const link of links) {
    const st = byEid.get(String(link.encounter_id || '').trim());
    if (!st || !link.encounter_id) continue;
    const enc = encById.get(String(link.encounter_id).trim()) || {};
    const admission = String(enc.admission_date || '').trim();
    const noitru = String(enc.emr_noitru_id || '').trim();
    const base = {
      encounter_id: link.encounter_id, research_code: link.research_code, ma_bn: link.patient_code,
      'Mã BN': link.patient_code, 'Mã NC': link.research_code,
      ...(noitru ? { 'Mã nội trú': noitru } : {}),
      ...(admission ? { admission_date: admission, 'Ngày vào viện': admission } : {}),
      source: 'archive', updated_at: at,
    };
    // Kho có thể đã có dữ liệu mà trạng thái chưa ghi "đã lấy" (vd. lúc chuẩn hóa lấy bổ sung từ Kho
    // người bệnh): có dòng XN/CĐHA hoặc y lệnh của lượt thì coi phần đó đã có, khỏi mở EMR lấy lại.
    const labs = Number(st.lab_count || 0);
    const imaging = Number(st.imaging_count || 0);
    const meds = Number(st.medication_count || 0);
    const xnDone = (st.popup_status === 'done' && GOT.has(st.xn_status) && GOT.has(st.cdha_status)) || labs > 0 || imaging > 0;
    if (xnDone) {
      const xn = GOT.has(st.xn_status) ? st.xn_status : (labs > 0 ? 'done' : 'empty');
      const cdha = GOT.has(st.cdha_status) ? st.cdha_status : (imaging > 0 ? 'done' : 'empty');
      progress[link.encounter_id] = {
        ...base, popup: 'done', xn, cdha, status: 'done', committed: true,
        tab_saved: { xn: true, cdha: true }, tab_at: { xn: at, cdha: at },
        counts: { xn: labs, cdha: imaging },
      };
    }
    for (const file of HCHANH_FILES) {
      let value = String(st[`${file}_status`] || '').trim();
      if (!GOT.has(value) && file === 'order_history' && meds > 0) value = 'done';
      if (!GOT.has(value)) continue;
      const target = file === 'order_history' ? orders : hchanh;
      const rows = file === 'order_history' ? meds : 0;
      target[`${link.encounter_id}#${file}`] = { ...base, files: [file], status: 'done', rows: { [file]: rows }, finished_at: at, ...(value === 'empty' ? { empty: true } : {}) };
    }
    carried += 1;
  }
  return { progress, hchanh, orders, carried };
}

// Tạo đợt chạy của nghiên cứu từ kho. Không chuẩn hóa (người gọi xếp hàng chuẩn hóa).
function seedStudyRunFromArchive(study, { runId = '' } = {}) {
  const fail = (message, status = 400) => { const err = new Error(message); err.status = status; throw err; };
  if (!study?.id) fail('Không tìm thấy nghiên cứu.', 404);
  const cohortFile = cohortPath(study.id);
  if (!fs.existsSync(cohortFile)) fail('Nghiên cứu chưa có danh sách mẫu.');
  const archiveRunId = study.cohort_source === 'archive' ? String(study.cohort_source_run_id || '') : '';
  if (!archiveRunId) fail('Nghiên cứu không chọn mẫu từ kho nên không lấy dữ liệu từ kho được. Dùng Thu thập dữ liệu (mở EMR).');
  const archiveRunDir = path.join(archiveRunsDir(), archiveRunId);
  if (!fs.existsSync(archiveRunDir)) fail('Không còn đợt dữ liệu của kho mà nghiên cứu đã chọn mẫu.');

  const cohort = readCsvTable(cohortFile, Number.MAX_SAFE_INTEGER);
  const cohortRows = cohort.rows || [];
  if (!cohortRows.length) fail('Nghiên cứu chưa có mẫu.');
  // Mã NC của nghiên cứu ↔ lượt điều trị trong kho (cùng cách ghép khi Lưu thành nghiên cứu).
  const { archiveEncounterLinker } = require('./normalize');
  const linkEncounter = archiveEncounterLinker(archiveRunDir);
  const links = cohortRows.map(row => ({
    research_code: getCell(row, RESEARCH_CODE_COLUMNS),
    patient_code: patientCode(row),
    encounter_id: linkEncounter(row).encounter_id || '',
  }));

  const id = runId || nowStamp();
  const runDir = path.join(runsDir(study.id), id);
  if (fs.existsSync(path.join(runDir, 'manifest.json'))) fail('Đợt chạy đã tồn tại.', 409);
  ensureDir(runDir);

  writeCsv(path.join(runDir, 'du_lieu_ban_dau.csv'), cohort.columns || [], cohortRows);
  const encounterRows = readCsvTable(path.join(archiveRunDir, 'encounters.csv'), Number.MAX_SAFE_INTEGER).rows || [];
  const index = buildCohortIndex(cohortRows, links, encounterRows);
  const rawCounts = copyFilteredRaw(archiveRunDir, runDir, index);
  const { progress, hchanh, orders, carried } = buildProgressFromArchive(archiveRunDir, links, encounterRows);
  writeJsonAtomic(path.join(runDir, 'progress.json'), progress);
  writeJsonAtomic(path.join(runDir, 'hchanh_auto_progress.json'), hchanh);
  writeJsonAtomic(path.join(runDir, 'order_history_auto_progress.json'), orders);
  writeJsonAtomic(path.join(runDir, 'manifest.json'), {
    run_id: id,
    created_at: nowIso(),
    patients_count: cohortRows.length,
    source: 'archive',
    source_archive_run_id: archiveRunId,
    raw_rows_from_archive: rawCounts,
    progress_from_archive: carried,
  });
  return { run_id: id, run_dir: runDir, archive_run_id: archiveRunId, samples: cohortRows.length, linked: carried, raw_rows: rawCounts };
}

module.exports = { seedStudyRunFromArchive, buildCohortIndex, buildProgressFromArchive };
