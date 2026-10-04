'use strict';

// Hằng số, đường dẫn kho/nghiên cứu và tiện ích nền của Kho nghiên cứu.

const { DEFAULT_SENSITIVE_COLUMNS } = require('./export_utils');
const { strictLocalDate } = require('./date_utils');
const path = require('path');
const { RESEARCH_STORE_DIR } = require('../constants');
const { ensureDir } = require('../utils/file');
const fs = require('fs');

const MAX_CSV_BYTES = 50 * 1024 * 1024;

const MAX_TABLE_ROWS = 20000;

const ARCHIVE_ID = 'du_lieu_goc';

const ARCHIVE_LABEL = 'Kho dữ liệu gốc';

const TABLES = {
  cohort: { label: 'Danh sách yêu cầu', file: 'cohort.csv', root: 'study' },
  crf: { label: 'Phiếu nhập tay', file: 'crf_data.csv', root: 'study' },
  initial_list: { label: 'Dữ liệu ban đầu', file: 'du_lieu_ban_dau.csv', root: 'run' },
  research_source: { label: 'Nguồn chuẩn', file: 'research_source.csv', root: 'run' },
  deep_source: { label: 'Dữ liệu gốc đã lấy sâu', file: 'du_lieu_goc.csv', root: 'run' },
  patient_extra: { label: 'Thông tin khác', file: 'thong_tin_benh_nhan_bo_sung.csv', root: 'run' },
  patients: { label: 'Mẫu nghiên cứu raw', file: 'mau_nghien_cuu.csv', root: 'run' },
  patient_master: { label: 'BN chuẩn hóa', file: 'patients.csv', root: 'run', normalized: true },
  encounters: { label: 'Đợt điều trị', file: 'encounters.csv', root: 'run', normalized: true },
  diagnoses: { label: 'Chẩn đoán', file: 'diagnoses.csv', root: 'run', normalized: true },
  lab_results: { label: 'XN chuẩn hóa', file: 'lab_results.csv', root: 'run', normalized: true },
  imaging_results: { label: 'CĐHA chuẩn hóa', file: 'imaging_results.csv', root: 'run', normalized: true },
  surgery_results: { label: 'Phẫu thuật/TT', file: 'surgery_results.csv', root: 'run', normalized: true },
  medication_orders: { label: 'Y lệnh thuốc', file: 'medication_orders.csv', root: 'run', normalized: true },
  medication_day_summary: { label: 'Thuốc theo ngày', file: 'medication_day_summary.csv', root: 'run', normalized: true },
  clinical_notes: { label: 'Diễn biến/Y lệnh', file: 'clinical_notes.csv', root: 'run', normalized: true },
  patient_day: { label: 'Patient-day', file: 'patient_day.csv', root: 'run', normalized: true },
  analysis_ready: { label: 'Bảng phân tích', file: 'analysis_ready.csv', root: 'run', normalized: true },
  analysis_selected: { label: 'Bảng biến đã chọn', file: 'analysis_selected.csv', root: 'run', normalized: true },
  analysis_final: { label: 'Dataset cuối', file: 'analysis_final.csv', root: 'run', normalized: true },
  analysis_ready_encoded: { label: 'Bảng phân tích encoded', file: 'encoded/analysis_ready_encoded.csv', root: 'run', normalized: true, encoded: true },
  analysis_selected_encoded: { label: 'Bảng biến đã chọn encoded', file: 'encoded/analysis_selected_encoded.csv', root: 'run', normalized: true, encoded: true },
  lab_results_encoded: { label: 'XN encoded', file: 'encoded/lab_results_encoded.csv', root: 'run', normalized: true, encoded: true },
  lab_dictionary: { label: 'Dict XN', file: 'encoded/lab_dictionary.csv', root: 'run', normalized: true, encoded: true },
  imaging_results_encoded: { label: 'CĐHA encoded', file: 'encoded/imaging_results_encoded.csv', root: 'run', normalized: true, encoded: true },
  imaging_dictionary: { label: 'Dict CĐHA', file: 'encoded/imaging_dictionary.csv', root: 'run', normalized: true, encoded: true },
  medication_orders_encoded: { label: 'Y lệnh encoded', file: 'encoded/medication_orders_encoded.csv', root: 'run', normalized: true, encoded: true },
  drug_dictionary: { label: 'Dict thuốc', file: 'encoded/drug_dictionary.csv', root: 'run', normalized: true, encoded: true },
  route_dictionary: { label: 'Dict đường dùng', file: 'encoded/route_dictionary.csv', root: 'run', normalized: true, encoded: true },
  diagnoses_encoded: { label: 'Chẩn đoán encoded', file: 'encoded/diagnoses_encoded.csv', root: 'run', normalized: true, encoded: true },
  diagnosis_dictionary: { label: 'Dict chẩn đoán', file: 'encoded/diagnosis_dictionary.csv', root: 'run', normalized: true, encoded: true },
  surgery_results_encoded: { label: 'PT/TT encoded', file: 'encoded/surgery_results_encoded.csv', root: 'run', normalized: true, encoded: true },
  procedure_dictionary: { label: 'Dict PT/TT', file: 'encoded/procedure_dictionary.csv', root: 'run', normalized: true, encoded: true },
  anesthesia_dictionary: { label: 'Dict vô cảm', file: 'encoded/anesthesia_dictionary.csv', root: 'run', normalized: true, encoded: true },
  extract_status: { label: 'Tiến độ lấy dữ liệu', file: 'extract_status.csv', root: 'run', normalized: true },
  // Bảng raw giữ lại để đối chiếu khi cần.
  hchanh_profile: { label: 'Raw HC nền', file: 'hchanh_profile.csv', root: 'run' },
  hchanh_discharge: { label: 'Raw HC ra viện', file: 'hchanh_discharge.csv', root: 'run' },
  hchanh_surgery: { label: 'Raw HC phẫu thuật', file: 'hchanh_surgery.csv', root: 'run' },
  hchanh_order_history: { label: 'Raw HC y lệnh', file: 'hchanh_order_history.csv', root: 'run' },
  xn: { label: 'Raw XN', file: 'lich_su_xn.csv', root: 'run' },
  cdha: { label: 'Raw CĐHA', file: 'lich_su_cdha.csv', root: 'run' },
  errors: { label: 'Lỗi', file: 'errors.csv', root: 'run' },
};

const EXPORT_SENSITIVE_COLUMNS = DEFAULT_SENSITIVE_COLUMNS;

function nowIso() {
  return new Date().toISOString();
}

function todayDateInput() {
  // Dùng ngày local của máy chạy server, không dùng ISO UTC để tránh lệch ngày.
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function dateOnlyMs(value) {
  const s = String(value || '').trim();
  const m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (!m) return NaN;
  const d = strictLocalDate(Number(m[1]), Number(m[2]), Number(m[3]));
  return d ? d.getTime() : NaN;
}

function removeVietnameseMarks(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D');
}

function normalizedKey(value) {
  return removeVietnameseMarks(value).toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function slugify(value, fallback = 'nghien_cuu') {
  const raw = removeVietnameseMarks(value)
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 80);
  return raw || fallback;
}

function cleanStudyId(value) {
  const id = slugify(value, 'nghien_cuu');
  if (!/^[a-z0-9][a-z0-9_-]{0,79}$/.test(id)) throw new Error('Mã nghiên cứu không hợp lệ.');
  return id;
}

function studyDir(studyId) {
  return path.join(RESEARCH_STORE_DIR, cleanStudyId(studyId));
}

function studyMetaPath(studyId) {
  return path.join(studyDir(studyId), 'study.json');
}

function cohortPath(studyId) {
  return path.join(studyDir(studyId), 'cohort.csv');
}

function runsDir(studyId) {
  return path.join(studyDir(studyId), 'runs');
}

function archiveDir() {
  return path.join(RESEARCH_STORE_DIR, ARCHIVE_ID);
}

function archiveMetaPath() {
  return path.join(archiveDir(), 'archive.json');
}

function archiveSourcePath() {
  return path.join(archiveDir(), 'source.csv');
}

function archiveRunsDir() {
  return path.join(archiveDir(), 'runs');
}

function ensureResearchStore() {
  ensureDir(RESEARCH_STORE_DIR);
}

function ensureArchiveStore() {
  ensureResearchStore();
  ensureDir(archiveDir());
}

function uniqueStudyId(name) {
  ensureResearchStore();
  const base = cleanStudyId(name || 'nghien_cuu');
  let id = base;
  let i = 2;
  while (fs.existsSync(studyDir(id))) {
    id = `${base}_${i}`;
    i += 1;
  }
  return id;
}

module.exports = {
  MAX_CSV_BYTES,
  MAX_TABLE_ROWS,
  ARCHIVE_ID,
  ARCHIVE_LABEL,
  TABLES,
  EXPORT_SENSITIVE_COLUMNS,
  nowIso,
  todayDateInput,
  dateOnlyMs,
  removeVietnameseMarks,
  normalizedKey,
  slugify,
  cleanStudyId,
  studyDir,
  studyMetaPath,
  cohortPath,
  runsDir,
  archiveDir,
  archiveMetaPath,
  archiveSourcePath,
  archiveRunsDir,
  ensureResearchStore,
  ensureArchiveStore,
  uniqueStudyId,
};
