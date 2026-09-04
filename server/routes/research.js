// server/routes/research.js — Dữ liệu nghiên cứu tách riêng khỏi runtime/session dashboard

'use strict';

const router = require('express').Router();
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { ROOT_DIR, RESEARCH_STORE_DIR, ALLOW_IDENTIFIED_RESEARCH_EXPORT } = require('../constants');
const { ensureDir, writeFileAtomic, writeJsonAtomic, readJsonSafe, nowFileStamp, safeFilePart } = require('../utils/file');
const { csvEscape, rowsToCsv } = require('../utils/csv');
const { runPython, runScript, fmtPyError } = require('../services/python_runner');
const { getRuntimePaths } = require('../services/session');
const { hasRole } = require('../services/authz');
const { enqueueHeavy, registerCancel, unregisterCancel, isCancelRequested } = require('../services/task_queue');
const variableSelection = require('../research/variable_selection');
const { sanitizeCustomFields, evaluateCustomFields } = require('../research/analysis_config');
const { firstSurgeryByEncounter, surgeryForMedicationContext } = require('../research/encounter_linkage');
const { strictLocalDate } = require('../research/date_utils');
const { DEFAULT_SENSITIVE_COLUMNS, redactCsvTable } = require('../research/export_utils');
const { databaseInfo, syncResearchDatabase, queryResearchDatabase } = require('../research/sqlite_store');
const {
  read_index: readHchanhIndex,
  read_patient_all: readHchanhPatientAll,
} = require('../hchanh_data_contract');

const SCRIPT_PATH = path.join(ROOT_DIR, 'research', 'nghien_cuu_1', 'lay_lich_su_xn_cdha.py');
const MAX_CSV_BYTES = 50 * 1024 * 1024;
const MAX_TABLE_ROWS = 20000;
const ARCHIVE_ID = 'du_lieu_goc';
const ARCHIVE_LABEL = 'Kho dữ liệu gốc';

const TABLES = {
  cohort: { label: 'Danh sách yêu cầu', file: 'cohort.csv', root: 'study' },
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

const DATABASE_TABLE_NAME_OVERRIDES = {
  cohort: 'cohort',
  initial_list: 'raw_initial_list',
  research_source: 'raw_research_source',
  deep_source: 'raw_deep_source',
  patient_extra: 'raw_patient_extra',
  patients: 'raw_patients',
  patient_master: 'patients',
  hchanh_profile: 'raw_hchanh_profile',
  hchanh_discharge: 'raw_hchanh_discharge',
  hchanh_surgery: 'raw_hchanh_surgery',
  hchanh_order_history: 'raw_hchanh_order_history',
  xn: 'raw_lab_results',
  cdha: 'raw_imaging_results',
  errors: 'extraction_errors',
  analysis_ready_encoded: 'encoded_analysis_ready',
  analysis_selected_encoded: 'encoded_analysis_selected',
  lab_results_encoded: 'encoded_lab_results',
  imaging_results_encoded: 'encoded_imaging_results',
  medication_orders_encoded: 'encoded_medication_orders',
  diagnoses_encoded: 'encoded_diagnoses',
  surgery_results_encoded: 'encoded_surgery_results',
};

function datasetDirFromRunDir(runDir) {
  return path.dirname(path.dirname(path.resolve(runDir)));
}

function datasetIdentityFromRunDir(runDir) {
  const datasetDir = datasetDirFromRunDir(runDir);
  const datasetId = path.basename(datasetDir);
  return {
    datasetDir,
    datasetId,
    datasetType: datasetId === ARCHIVE_ID ? 'archive' : 'study',
  };
}

function databaseTableSpecsForRun(runDir) {
  const dir = path.resolve(runDir);
  const { datasetDir } = datasetIdentityFromRunDir(dir);
  return Object.entries(TABLES).map(([key, spec]) => {
    const filePath = spec.root === 'study'
      ? path.join(datasetDir, spec.file)
      : path.join(dir, spec.file);
    return {
      table_name: DATABASE_TABLE_NAME_OVERRIDES[key] || key,
      source_file: spec.file,
      file_path: filePath,
    };
  });
}

function syncDatabaseForRun(runDir, {
  runId = '',
  inputSignature = '',
  force = false,
} = {}) {
  const dir = path.resolve(runDir);
  const identity = datasetIdentityFromRunDir(dir);
  return syncResearchDatabase({
    ...identity,
    runId: runId || path.basename(dir),
    inputSignature,
    normalizedSchemaVersion: NORMALIZED_SCHEMA_VERSION,
    tables: databaseTableSpecsForRun(dir),
    force,
  });
}

function publicDatabaseInfo(info = {}) {
  const tables = Array.isArray(info.tables) ? info.tables : [];
  return {
    exists: Boolean(info.exists),
    database_file: info.database_file || 'research.sqlite3',
    dataset_id: info.dataset_id || '',
    dataset_type: info.dataset_type || '',
    run_id: info.run_id || '',
    size_bytes: Number(info.size_bytes || 0),
    updated_at: info.updated_at || info.loaded_at || '',
    cached: Boolean(info.cached),
    tables: tables.map(item => ({
      table_name: item.table_name,
      row_count: Number(item.row_count || 0),
      column_count: Number(item.column_count || 0),
    })),
  };
}

function forceSyncDatabaseAfterDerivedOutput(runDir) {
  const dir = path.resolve(runDir);
  const manifest = readJsonSafe(path.join(dir, 'manifest.json'), {}) || {};
  const info = syncDatabaseForRun(dir, {
    runId: path.basename(dir),
    inputSignature: String(manifest.normalized_input_signature || ''),
    force: true,
  });
  return publicDatabaseInfo(info);
}


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

function parseCsv(text, { maxRows = MAX_TABLE_ROWS } = {}) {
  const source = String(text || '').replace(/^\ufeff/, '');
  const rows = [];
  let row = [];
  let cell = '';
  let inQuotes = false;

  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i];
    const next = source[i + 1];
    if (inQuotes) {
      if (ch === '"' && next === '"') {
        cell += '"';
        i += 1;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        cell += ch;
      }
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      row.push(cell);
      cell = '';
    } else if (ch === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
      if (rows.length > maxRows + 1) break;
    } else if (ch === '\r') {
      // bỏ qua, xử lý ở \n
    } else {
      cell += ch;
    }
  }
  if (cell || row.length) {
    row.push(cell);
    rows.push(row);
  }

  while (rows.length && rows[rows.length - 1].every(v => String(v || '').trim() === '')) rows.pop();
  if (!rows.length) return { columns: [], rows: [], count: 0, limited: false };
  const columns = rows[0].map((v, idx) => String(v || `Cột ${idx + 1}`).trim() || `Cột ${idx + 1}`);
  const body = rows.slice(1, maxRows + 1).filter(r => r.some(v => String(v || '').trim() !== ''));
  const objects = body.map(values => {
    const obj = {};
    columns.forEach((col, i) => { obj[col] = String(values[i] ?? '').trim(); });
    return obj;
  });
  return { columns, rows: objects, count: Math.max(0, rows.length - 1), limited: rows.length - 1 > maxRows };
}

function writeCsv(filePath, columns, rows) {
  writeFileAtomic(filePath, `\ufeff${rowsToCsv(columns, rows)}`, 'utf-8');
}

const CSV_TABLE_CACHE = new Map();
const CSV_CACHE_MAX_ENTRIES = 48;

function _csvCacheKey(filePath, maxRows) {
  try {
    const stat = fs.statSync(filePath);
    return `${path.resolve(filePath)}|${stat.size}|${Math.floor(stat.mtimeMs)}|${maxRows}`;
  } catch (_) {
    return '';
  }
}

function _trimCsvCache() {
  if (CSV_TABLE_CACHE.size <= CSV_CACHE_MAX_ENTRIES) return;
  const extra = CSV_TABLE_CACHE.size - CSV_CACHE_MAX_ENTRIES;
  for (const key of [...CSV_TABLE_CACHE.keys()].slice(0, extra)) CSV_TABLE_CACHE.delete(key);
}

function readCsvTable(filePath, maxRows = MAX_TABLE_ROWS) {
  if (!fs.existsSync(filePath)) return { columns: [], rows: [], count: 0, limited: false, exists: false };
  const cacheKey = _csvCacheKey(filePath, maxRows);
  if (cacheKey && CSV_TABLE_CACHE.has(cacheKey)) return CSV_TABLE_CACHE.get(cacheKey);

  const text = fs.readFileSync(filePath, 'utf-8');
  const result = { ...parseCsv(text, { maxRows }), exists: true };
  if (cacheKey) {
    // Xóa cache cũ của cùng file khi file đã thay đổi.
    const prefix = `${path.resolve(filePath)}|`;
    for (const key of CSV_TABLE_CACHE.keys()) {
      if (key !== cacheKey && key.startsWith(prefix)) CSV_TABLE_CACHE.delete(key);
    }
    CSV_TABLE_CACHE.set(cacheKey, result);
    _trimCsvCache();
  }
  return result;
}

function safeDownloadName(value, fallback = 'research_export') {
  const cleaned = String(value || fallback).normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9_.-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 120);
  return cleaned || fallback;
}

function researchResponseShouldRedact(req) {
  const requestedIdentified = String(req.query?.identified || '') === '1'
    || String(req.query.redact || '').toLowerCase() === '0'
    || String(req.query.redact || '').toLowerCase() === 'false';
  if (!requestedIdentified) return true;
  if (!ALLOW_IDENTIFIED_RESEARCH_EXPORT) {
    const err = new Error('Xuất dữ liệu nghiên cứu có định danh đang bị khóa. Chỉ bật EMR_ALLOW_IDENTIFIED_RESEARCH_EXPORT sau khi có phê duyệt và kiểm soát truy cập.');
    err.status = 403;
    throw err;
  }
  if (!hasRole(req.auth, 'supervisor')) {
    const err = new Error('Chỉ supervisor/admin được xuất dữ liệu nghiên cứu có định danh.');
    err.status = 403;
    throw err;
  }
  return false;
}

function sendCsvFile(res, filePath, filenameBase, { redact = true } = {}) {
  if (!filePath || !fs.existsSync(filePath)) {
    return res.status(404).json({ status: 'error', message: 'Bảng chưa có file CSV để xuất.' });
  }
  const filename = `${safeDownloadName(filenameBase)}.csv`;
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"; filename*=UTF-8''${encodeURIComponent(filename)}`);
  const table = readCsvTable(filePath, Number.MAX_SAFE_INTEGER);
  const exportTable = redact
    ? redactCsvTable(table.columns, table.rows, EXPORT_SENSITIVE_COLUMNS)
    : table;
  return res.send(`\ufeff${rowsToCsv(exportTable.columns, exportTable.rows)}`);
}



// ── Research simplified workspace helpers ──────────────────────────────────
function cell(row, keys, fallback = '') {
  for (const key of keys) {
    const v = row?.[key];
    if (v != null && String(v).trim() !== '') return String(v).trim();
  }
  return fallback;
}

function foldSearchText(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/đ/g, 'd')
    .replace(/\s+/g, ' ')
    .trim();
}

function rowSearchText(row, keys = null) {
  const vals = keys ? keys.map(k => row?.[k]) : Object.values(row || {});
  return foldSearchText(vals.map(v => String(v || '')).join(' '));
}

function normalizeQuery(q) {
  return foldSearchText(q);
}

function sortByDateLike(rows, keys) {
  return [...(rows || [])].sort((a, b) => {
    const av = cell(a, keys);
    const bv = cell(b, keys);
    return String(av).localeCompare(String(bv));
  });
}

function safeReadRunTable(runDir, filename) {
  return readCsvTable(path.join(runDir, filename), Number.MAX_SAFE_INTEGER).rows || [];
}

function normalizedPersonName(row) {
  return foldSearchText(cell(row, ['patient_name', 'Họ tên', 'Ho ten', 'name']));
}

function normalizedPersonSex(row) {
  return foldSearchText(cell(row, ['sex', 'Giới', 'GT']));
}

function normalizedPersonBirthYear(row) {
  const birthYear = cell(row, ['birth_year', 'Năm sinh']);
  if (/^\d{4}$/.test(birthYear)) return birthYear;
  const birthDate = cell(row, ['birth_date', 'Ngày sinh']);
  const m = String(birthDate || '').match(/(\d{4})|(?:\d{1,2})[-/](?:\d{1,2})[-/](\d{4})/);
  return m ? (m[1] || m[2] || '') : '';
}

function normalizedPersonAge(row) {
  const age = cell(row, ['age', 'Tuổi']);
  const m = String(age || '').match(/\d{1,3}/);
  return m ? m[0] : '';
}

function personIdentitySignatures(row) {
  const name = normalizedPersonName(row);
  const sex = normalizedPersonSex(row);
  if (!name || !sex) return [];
  const out = [];
  const birthYear = normalizedPersonBirthYear(row);
  const age = normalizedPersonAge(row);
  if (birthYear) out.push(`name_sex_birth:${name}|${sex}|${birthYear}`);
  // HIS nội trú có thể cấp mã BN mới cho lần nhập viện sau, nhưng tuổi/năm sinh có khi chỉ đủ ở một lượt.
  // Vì vậy dùng thêm chữ ký họ tên + giới + tuổi để gộp lịch sử, nhưng vẫn trả cảnh báo nếu có nhiều mã BN.
  if (age) out.push(`name_sex_age:${name}|${sex}|${age}`);
  return [...new Set(out)];
}

function normalizeIdentityRow(row) {
  return {
    patient_code: cell(row, ['patient_code', 'Mã BN']),
    research_code: cell(row, ['first_research_code', 'research_code', 'Mã NC']),
    patient_name: cell(row, ['patient_name', 'Họ tên']),
    sex: cell(row, ['sex', 'Giới', 'GT']),
    age: cell(row, ['age', 'Tuổi']),
    birth_year: cell(row, ['birth_year', 'Năm sinh']),
    birth_date: cell(row, ['birth_date', 'Ngày sinh']),
    source_row: row,
  };
}

function uniqueBy(rows, keyFn) {
  const seen = new Set();
  const out = [];
  for (const row of rows || []) {
    const key = keyFn(row);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(row);
  }
  return out;
}


function queryPatientHistoryEventTables(runDir, {
  patientCodes = [],
  researchCodes = [],
  encounterIds = [],
} = {}) {
  try {
    const datasetDir = datasetDirFromRunDir(runDir);
    const info = databaseInfo(datasetDir);
    if (!info?.exists) return null;
    // DB chứa snapshot của một run. Không dùng DB cũ cho run mới.
    if (String(info.run_id || '') !== String(path.basename(runDir) || '')) return null;

    const whereAny = {
      patient_code: [...new Set(patientCodes)].filter(Boolean),
      research_code: [...new Set(researchCodes)].filter(Boolean),
      encounter_id: [...new Set(encounterIds)].filter(Boolean),
    };
    const specs = [
      ['labs', 'lab_results', 5000],
      ['imaging', 'imaging_results', 2000],
      ['medications', 'medication_orders', 3000],
      ['surgeries', 'surgery_results', 500],
    ].map(([name, table, limit]) => ({ name, table, where_any: whereAny, limit }));

    const payload = queryResearchDatabase({ datasetDir, queries: specs, timeoutMs: 20000 });
    if (!payload || payload.status !== 'ok') return null;
    const results = payload.results || {};
    return {
      labs: results.labs?.rows || [],
      imaging: results.imaging?.rows || [],
      medications: results.medications?.rows || [],
      surgeries: results.surgeries?.rows || [],
      source: 'sqlite',
    };
  } catch (err) {
    console.warn('[RESEARCH][PATIENT_HISTORY] SQLite fallback:', err.message);
    return null;
  }
}

const PATIENT_LOOKUP_INDEX_CACHE = new Map();
const PATIENT_LOOKUP_MAX_MATCHES = 30;

function patientLookupInputSignature(runDir) {
  const names = ['patients.csv', 'encounters.csv', 'analysis_ready.csv', 'hchanh_profile.csv'];
  return names.map(name => {
    try {
      const st = fs.statSync(path.join(runDir, name));
      return `${name}:${st.size}:${Math.floor(st.mtimeMs)}`;
    } catch (_) { return `${name}:missing`; }
  }).join('|');
}

function getPatientLookupIndex(runDir) {
  const key = path.resolve(runDir);
  const signature = patientLookupInputSignature(runDir);
  const cached = PATIENT_LOOKUP_INDEX_CACHE.get(key);
  if (cached?.signature === signature) return cached;

  const patients = safeReadRunTable(runDir, 'patients.csv');
  const encounters = safeReadRunTable(runDir, 'encounters.csv');
  const analysis = safeReadRunTable(runDir, 'analysis_ready.csv');
  const hProfile = safeReadRunTable(runDir, 'hchanh_profile.csv');

  const patientKeys = ['patient_code', 'patient_name', 'first_research_code', 'phone_number', 'citizen_id', 'insurance_card'];
  const encKeys = ['research_code', 'patient_code', 'emr_admission_id', 'emr_treatment_id', 'diagnosis_raw', 'admission_diagnosis', 'discharge_diagnosis', 'room_bed'];
  const profileKeys = ['Mã NC', 'Mã BN', 'Họ tên', 'Số CMND', 'Điện thoại', 'Số thẻ', 'Chẩn đoán'];

  const patientSearch = patients.map(row => ({ row, search: rowSearchText(row, patientKeys) }));
  const encounterSearch = encounters.map(row => ({ row, search: rowSearchText(row, encKeys) }));
  const profileSearch = hProfile.map(row => ({ row, search: rowSearchText(row, profileKeys) }));

  const patientByCode = new Map(patients.map(r => [cell(r, ['patient_code', 'Mã BN']), r]).filter(([k]) => k));
  const encounterCountByCode = new Map();
  const researchCodesByPatient = new Map();
  for (const e of encounters) {
    const pc = cell(e, ['patient_code', 'Mã BN']);
    const rc = cell(e, ['research_code', 'Mã NC']);
    if (pc) encounterCountByCode.set(pc, (encounterCountByCode.get(pc) || 0) + 1);
    if (pc && rc) {
      if (!researchCodesByPatient.has(pc)) researchCodesByPatient.set(pc, new Set());
      researchCodesByPatient.get(pc).add(rc);
    }
  }
  const identityRows = [];
  for (const row of patients) identityRows.push(normalizeIdentityRow(row));
  for (const row of hProfile) identityRows.push(normalizeIdentityRow(row));
  for (const row of analysis) identityRows.push(normalizeIdentityRow(row));
  for (const row of encounters) identityRows.push(normalizeIdentityRow(row));

  const rowsByCode = new Map();
  const codesBySignature = new Map();
  for (const row of identityRows) {
    if (!row.patient_code) continue;
    if (!rowsByCode.has(row.patient_code)) rowsByCode.set(row.patient_code, []);
    rowsByCode.get(row.patient_code).push(row);
    for (const sig of personIdentitySignatures(row)) {
      if (!codesBySignature.has(sig)) codesBySignature.set(sig, new Set());
      codesBySignature.get(sig).add(row.patient_code);
    }
  }

  const index = {
    signature, patients, encounters, analysis, hProfile,
    patientSearch, encounterSearch, profileSearch,
    patientByCode, rowsByCode, codesBySignature,
    encounterCountByCode, researchCodesByPatient,
  };
  PATIENT_LOOKUP_INDEX_CACHE.set(key, index);
  // Không giữ index của run cũ vô hạn.
  if (PATIENT_LOOKUP_INDEX_CACHE.size > 8) {
    for (const oldKey of [...PATIENT_LOOKUP_INDEX_CACHE.keys()].slice(0, PATIENT_LOOKUP_INDEX_CACHE.size - 8)) {
      PATIENT_LOOKUP_INDEX_CACHE.delete(oldKey);
    }
  }
  return index;
}

function buildPatientHistory(runDir, query) {
  const startedAt = Date.now();
  if (!runDir || !fs.existsSync(runDir)) {
    const err = new Error('Chưa có kho dữ liệu để tra cứu.');
    err.status = 400;
    throw err;
  }
  const q = normalizeQuery(query);
  if (!q) return { query: '', matches: [], patients: [], total_matches: 0 };

  const lookup = getPatientLookupIndex(runDir);
  const {
    patients, encounters, analysis, hProfile,
    patientSearch, encounterSearch, profileSearch,
    patientByCode, rowsByCode, codesBySignature,
    encounterCountByCode, researchCodesByPatient,
  } = lookup;

  const candidateCodes = new Set();
  const candidateResearch = new Set();
  const matchRows = [];
  for (const item of patientSearch) {
    if (item.search.includes(q)) {
      const row = item.row;
      const pc = cell(row, ['patient_code', 'Mã BN']);
      const rc = cell(row, ['first_research_code', 'research_code', 'Mã NC']);
      if (pc) candidateCodes.add(pc);
      if (rc) candidateResearch.add(rc);
      matchRows.push({ type: 'patient', patient_code: pc, research_code: rc, patient_name: cell(row, ['patient_name', 'Họ tên']) });
    }
  }
  for (const item of encounterSearch) {
    if (item.search.includes(q)) {
      const row = item.row;
      const pc = cell(row, ['patient_code', 'Mã BN']);
      const rc = cell(row, ['research_code', 'Mã NC']);
      if (pc) candidateCodes.add(pc);
      if (rc) candidateResearch.add(rc);
      matchRows.push({ type: 'encounter', patient_code: pc, research_code: rc, patient_name: '' });
    }
  }
  for (const item of profileSearch) {
    if (item.search.includes(q)) {
      const row = item.row;
      const pc = cell(row, ['Mã BN', 'patient_code']);
      const rc = cell(row, ['Mã NC', 'research_code']);
      if (pc) candidateCodes.add(pc);
      if (rc) candidateResearch.add(rc);
      matchRows.push({ type: 'profile', patient_code: pc, research_code: rc, patient_name: cell(row, ['Họ tên', 'patient_name']) });
    }
  }

  for (const rc of candidateResearch) {
    for (const e of encounters) {
      if (cell(e, ['research_code']) === rc && cell(e, ['patient_code'])) candidateCodes.add(cell(e, ['patient_code']));
    }
    for (const p of patients) {
      if (cell(p, ['first_research_code', 'research_code', 'Mã NC']) === rc && cell(p, ['patient_code', 'Mã BN'])) candidateCodes.add(cell(p, ['patient_code', 'Mã BN']));
    }
  }
  if (!candidateCodes.size) return { query, matches: [], patients: [], total_matches: 0 };

  // Tra cứu 2 bước:
  // - Từ khóa rộng (tên/chẩn đoán) chỉ trả danh sách ứng viên nhẹ.
  // - Chỉ khi người dùng chọn đúng mã BN/mã NC mới tải XN/CĐHA/thuốc/PT.
  const exactPatientCodes = new Set();
  for (const code of candidateCodes) {
    if (normalizeQuery(code) === q) exactPatientCodes.add(code);
    for (const rc of researchCodesByPatient.get(code) || []) {
      if (normalizeQuery(rc) === q) exactPatientCodes.add(code);
    }
    const p = patientByCode.get(code) || {};
    const directRc = cell(p, ['first_research_code', 'research_code', 'Mã NC']);
    const directName = cell(p, ['patient_name', 'Họ tên']);
    if (directRc && normalizeQuery(directRc) === q) exactPatientCodes.add(code);
    if (directName && normalizeQuery(directName) === q) {
      // Chỉ tự mở khi tên chính xác xác định duy nhất một mã.
      const sameName = [...candidateCodes].filter(other => {
        const op = patientByCode.get(other) || {};
        return normalizeQuery(cell(op, ['patient_name', 'Họ tên'])) === q;
      });
      if (sameName.length === 1) exactPatientCodes.add(code);
    }
  }

  if (!exactPatientCodes.size && candidateCodes.size > 1) {
    const candidates = [...candidateCodes]
      .slice(0, PATIENT_LOOKUP_MAX_MATCHES)
      .map(code => {
        const p = patientByCode.get(code)
          || (rowsByCode.get(code) || [])[0]?.source_row
          || {};
        const rcs = [...(researchCodesByPatient.get(code) || [])].sort();
        const firstRc = cell(p, ['first_research_code', 'research_code', 'Mã NC']) || rcs[0] || '';
        return {
          patient_code: code,
          research_code: firstRc,
          patient_name: cell(p, ['patient_name', 'Họ tên']),
          sex: cell(p, ['sex', 'Giới', 'GT']),
          age: cell(p, ['age', 'Tuổi']),
          encounter_count: Number(encounterCountByCode.get(code) || 0),
        };
      })
      .sort((a, b) =>
        String(a.patient_name || '').localeCompare(String(b.patient_name || ''), 'vi')
        || String(a.patient_code || '').localeCompare(String(b.patient_code || ''))
      );

    return {
      query,
      matches: matchRows.slice(0, 50),
      candidates,
      patients: [],
      total_matches: candidateCodes.size,
      selection_required: true,
      data_source: 'index',
      elapsed_ms: Date.now() - startedAt,
      truncated: candidateCodes.size > PATIENT_LOOKUP_MAX_MATCHES,
      matched_before_limit: candidateCodes.size,
    };
  }

  if (exactPatientCodes.size) {
    candidateCodes.clear();
    for (const code of exactPatientCodes) candidateCodes.add(code);
  }

  const matchedBeforeLimit = candidateCodes.size;
  let truncated = false;
  if (candidateCodes.size > PATIENT_LOOKUP_MAX_MATCHES) {
    const keep = [...candidateCodes].slice(0, PATIENT_LOOKUP_MAX_MATCHES);
    candidateCodes.clear();
    keep.forEach(code => candidateCodes.add(code));
    truncated = true;
  }


  // Mở rộng mã BN: nếu HIS cấp mã BN khác cho các lần nhập viện nhưng họ tên/giới/tuổi hoặc năm sinh khớp,
  // tra cứu một mã vẫn phải hiện đủ toàn bộ lịch sử điều trị của người bệnh đó.
  const expandedCodes = new Set(candidateCodes);
  let changed = true;
  while (changed) {
    changed = false;
    for (const code of [...expandedCodes]) {
      for (const row of rowsByCode.get(code) || []) {
        for (const sig of personIdentitySignatures(row)) {
          for (const other of codesBySignature.get(sig) || []) {
            if (!expandedCodes.has(other)) {
              expandedCodes.add(other);
              changed = true;
            }
          }
        }
      }
    }
  }

  // Gom các mã BN có chữ ký định danh giống nhau thành một hồ sơ hiển thị.
  const parent = new Map([...expandedCodes].map(code => [code, code]));
  const find = code => {
    let p = parent.get(code) || code;
    while (parent.get(p) && parent.get(p) !== p) p = parent.get(p);
    parent.set(code, p);
    return p;
  };
  const union = (a, b) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(rb, ra);
  };
  for (const codes of codesBySignature.values()) {
    const list = [...codes].filter(code => expandedCodes.has(code));
    for (let i = 1; i < list.length; i += 1) union(list[0], list[i]);
  }
  const groupsByRoot = new Map();
  for (const code of expandedCodes) {
    const root = find(code);
    if (!groupsByRoot.has(root)) groupsByRoot.set(root, new Set());
    groupsByRoot.get(root).add(code);
  }

  const historyResearchCodes = new Set(candidateResearch);
  const historyEncounterIds = new Set();
  for (const e of encounters) {
    const pc = cell(e, ['patient_code', 'Mã BN']);
    if (!expandedCodes.has(pc)) continue;
    const rc = cell(e, ['research_code', 'Mã NC']);
    const eid = cell(e, ['encounter_id']);
    if (rc) historyResearchCodes.add(rc);
    if (eid) historyEncounterIds.add(eid);
  }
  for (const p of patients) {
    const pc = cell(p, ['patient_code', 'Mã BN']);
    if (!expandedCodes.has(pc)) continue;
    const rc = cell(p, ['first_research_code', 'research_code', 'Mã NC']);
    if (rc) historyResearchCodes.add(rc);
  }
  for (const row of hProfile) {
    const pc = cell(row, ['Mã BN', 'patient_code']);
    if (!expandedCodes.has(pc)) continue;
    const rc = cell(row, ['Mã NC', 'research_code']);
    if (rc) historyResearchCodes.add(rc);
  }

  const sqliteTables = queryPatientHistoryEventTables(runDir, {
    // patient_code là cột đã được index trong các bảng chuẩn hóa.
    // Chỉ dùng các khóa khác làm fallback khi thực sự không có mã BN.
    patientCodes: [...expandedCodes],
    researchCodes: expandedCodes.size ? [] : [...historyResearchCodes],
    encounterIds: expandedCodes.size ? [] : [...historyEncounterIds],
  });
  const tables = sqliteTables || {
    labs: safeReadRunTable(runDir, 'lab_results.csv'),
    imaging: safeReadRunTable(runDir, 'imaging_results.csv'),
    medications: safeReadRunTable(runDir, 'medication_orders.csv'),
    surgeries: safeReadRunTable(runDir, 'surgery_results.csv'),
    source: 'csv',
  };

  const outPatients = [];
  for (const groupSet of groupsByRoot.values()) {
    const groupCodes = [...groupSet].sort();
    const representative = groupCodes
      .map(code => patientByCode.get(code))
      .find(row => cell(row, ['birth_year']) || cell(row, ['birth_date']) || cell(row, ['address']))
      || patientByCode.get(groupCodes[0])
      || (rowsByCode.get(groupCodes[0]) || [])[0]?.source_row
      || {};

    const groupResearch = new Set();
    for (const code of groupCodes) {
      const p = patientByCode.get(code);
      const rc = cell(p, ['first_research_code', 'research_code', 'Mã NC']);
      if (rc) groupResearch.add(rc);
    }
    for (const e of encounters) {
      const pc = cell(e, ['patient_code']);
      const rc = cell(e, ['research_code']);
      if (groupSet.has(pc) && rc) groupResearch.add(rc);
    }
    for (const row of hProfile) {
      const pc = cell(row, ['Mã BN', 'patient_code']);
      const rc = cell(row, ['Mã NC', 'research_code']);
      if (groupSet.has(pc) && rc) groupResearch.add(rc);
    }

    const rawEncRows = encounters.filter(e => groupSet.has(cell(e, ['patient_code'])) || groupResearch.has(cell(e, ['research_code'])));
    const encRows = uniqueBy(rawEncRows, e => cell(e, ['encounter_id']) || `${cell(e, ['research_code'])}|${cell(e, ['patient_code'])}|${cell(e, ['admission_date'])}|${cell(e, ['discharge_date'])}`);

    const encounterList = sortByDateLike(encRows, ['admission_date', 'Ngày vào viện']).map(enc => {
      const encounterId = cell(enc, ['encounter_id']);
      const rc = cell(enc, ['research_code']);
      const encPatientCode = cell(enc, ['patient_code']);
      const belongs = row => {
        const eid = cell(row, ['encounter_id']);
        const rcode = cell(row, ['research_code', 'Mã NC']);
        const pc = cell(row, ['patient_code', 'Mã BN']);
        if (encounterId && eid === encounterId) return true;
        if (rc && rcode === rc) return true;
        // Fallback chỉ dùng khi bảng không có encounter_id/research_code. Không dùng mã BN của cả nhóm,
        // tránh đưa dữ liệu của đợt này sang đợt khác khi một người có nhiều mã BN/lần nhập viện.
        return !eid && !rcode && pc && pc === encPatientCode;
      };
      const labs = sortByDateLike(tables.labs.filter(belongs), ['lab_datetime', 'lab_date']).slice(0, 250);
      const imaging = sortByDateLike(tables.imaging.filter(belongs), ['ordered_at', 'order_date']).slice(0, 100);
      const meds = sortByDateLike(tables.medications.filter(belongs), ['order_datetime', 'order_date']).slice(0, 250);
      const surgeries = sortByDateLike(tables.surgeries.filter(belongs), ['surgery_datetime', 'surgery_date']).slice(0, 60);
      const ar = analysis.find(r => (rc && cell(r, ['research_code']) === rc) || (!rc && cell(r, ['patient_code']) === encPatientCode)) || {};
      return {
        encounter_id: encounterId,
        research_code: rc,
        patient_code: encPatientCode,
        admission_date: cell(enc, ['admission_date', 'Ngày vào viện']),
        discharge_date: cell(enc, ['discharge_date', 'Ngày ra viện']),
        department: cell(enc, ['department', 'Khoa']),
        room_bed: cell(enc, ['room_bed', 'Phòng/Giường']),
        diagnosis_raw: cell(enc, ['diagnosis_raw', 'admission_diagnosis', 'discharge_diagnosis']) || cell(ar, ['diagnosis_raw']),
        surgery_date: cell(enc, ['surgery_date']) || cell(ar, ['surgery_date']),
        discharge_status: cell(enc, ['discharge_status']),
        treatment_duration: cell(enc, ['treatment_duration', 'hospital_stay_days']) || cell(ar, ['hospital_stay_days']),
        counts: { labs: labs.length, imaging: imaging.length, medications: meds.length, surgeries: surgeries.length },
        labs,
        imaging,
        medications: meds,
        surgeries,
      };
    });

    outPatients.push({
      patient_code: groupCodes[0],
      patient_codes: groupCodes,
      patient_name: cell(representative, ['patient_name', 'Họ tên']) || cell((rowsByCode.get(groupCodes[0]) || [])[0] || {}, ['patient_name']),
      sex: cell(representative, ['sex', 'Giới']),
      age: cell(representative, ['age', 'Tuổi']),
      birth_year: cell(representative, ['birth_year']) || normalizedPersonBirthYear(representative),
      first_research_code: [...groupResearch].sort()[0] || '',
      encounter_count: encounterList.length,
      possible_same_patient_codes: groupCodes.length > 1,
      merge_reason: groupCodes.length > 1 ? 'Các mã BN có cùng họ tên, giới và tuổi/năm sinh nên được gộp để xem toàn bộ lịch sử điều trị.' : '',
      encounters: encounterList,
    });
  }

  outPatients.sort((a, b) => String(a.patient_name || '').localeCompare(String(b.patient_name || '')) || String(a.patient_code || '').localeCompare(String(b.patient_code || '')));
  return {
    query,
    matches: matchRows.slice(0, 50),
    patients: outPatients,
    total_matches: outPatients.length,
    data_source: tables.source || 'csv',
    elapsed_ms: Date.now() - startedAt,
    truncated,
    matched_before_limit: matchedBeforeLimit,
  };
}

function inferVariableType(name, rows) {
  const n = String(name || '').toLowerCase();
  const sample = rows.map(r => String(r?.[name] || '').trim()).filter(Boolean).slice(0, 200);
  if (/date|ngày|datetime|time|thời gian|_at$/.test(n)) return 'date';
  if (/age|tuổi|day|days|giờ|hours|num|value|result_num|count|số|tổng/.test(n)) return 'number';
  let numeric = 0;
  for (const v of sample) if (/^-?\d+(?:[.,]\d+)?$/.test(v)) numeric += 1;
  if (sample.length && numeric / sample.length > 0.8) return 'number';
  const distinct = new Set(sample.map(v => v.toLowerCase()));
  if (distinct.size <= 20) return 'category';
  return 'text';
}


function makeVirtualVariableId(prefix, value) {
  const hash = stableHash(String(value || '')).slice(0, 10);
  return `${prefix}.${hash}`;
}
function shortSamples(values, max = 8) {
  const map = new Map();
  for (const v of values) {
    const textValue = String(v || '').trim();
    if (!textValue) continue;
    map.set(textValue, (map.get(textValue) || 0) + 1);
    if (map.size >= max) break;
  }
  return [...map.entries()].map(([value, count]) => ({ value, count }));
}
function buildVirtualVariablesForTable(def, rows) {
  const variables = [];
  const total = rows.length || 0;
  const add = (item) => variables.push({
    rows: total,
    nonempty: item.nonempty || 0,
    fill_rate: total ? Math.round(((item.nonempty || 0) / total) * 100) : 0,
    distinct_count: item.distinct_count || 0,
    sample_values: item.sample_values || [],
    table: def.key,
    table_label: def.label,
    virtual: true,
    ...item,
  });

  if (def.key === 'lab_results') {
    const byTest = new Map();
    for (const row of rows) {
      const norm = getCell(row, ['test_name_norm', 'Tên XN chuẩn', 'Tên xét nghiệm chuẩn hóa']) || normalizeLabName(getCell(row, ['test_name_raw', 'Tên XN', 'Tên xét nghiệm']));
      const raw = getCell(row, ['test_name_raw', 'Tên XN', 'Tên xét nghiệm']) || norm;
      if (!norm && !raw) continue;
      const key = norm || normalizeToken(raw);
      const bucket = byTest.get(key) || { raw, norm: key, group: getCell(row, ['lab_group', 'Nhóm xét nghiệm']), unit: getCell(row, ['unit', 'Đơn vị']), count: 0, values: [] };
      bucket.count += 1;
      const val = getCell(row, ['result_num', 'Kết quả số']) || getCell(row, ['result_raw', 'Kết quả']);
      if (val) bucket.values.push(`${val}${bucket.unit ? ` ${bucket.unit}` : ''}`);
      if (!bucket.raw && raw) bucket.raw = raw;
      if (!bucket.group) bucket.group = getCell(row, ['lab_group', 'Nhóm xét nghiệm']);
      if (!bucket.unit) bucket.unit = getCell(row, ['unit', 'Đơn vị']);
      byTest.set(key, bucket);
    }
    for (const b of [...byTest.values()].sort((a, b) => b.count - a.count).slice(0, 240)) {
      add({
        id: makeVirtualVariableId('lab_item', `${b.norm}|${b.unit}`),
        name: `lab:${b.norm}`,
        label: `${b.raw || b.norm}${b.unit ? ` (${b.unit})` : ''}`,
        type: 'number',
        nonempty: b.count,
        distinct_count: new Set(b.values.map(v => String(v).toLowerCase())).size,
        sample_values: shortSamples(b.values),
        operators: ['=', '!=', '>', '>=', '<', '<=', 'between', 'not_empty'],
        virtual_kind: 'lab_test',
        source_filter: { test_name_norm: b.norm, unit: b.unit || '' },
        source_note: 'Biến dẫn xuất từ lab_results: lọc theo tên xét nghiệm rồi dùng result_num/result_raw.',
      });
    }
  }

  if (def.key === 'imaging_results') {
    const byModality = new Map();
    for (const row of rows) {
      const modality = getCell(row, ['modality', 'Loại']) || 'Khác';
      const bucket = byModality.get(modality) || { modality, count: 0, samples: [] };
      bucket.count += 1;
      bucket.samples.push(getCell(row, ['service_name_raw', 'Dịch vụ']) || getCell(row, ['conclusion_text', 'Kết luận']));
      byModality.set(modality, bucket);
    }
    for (const b of [...byModality.values()].sort((a, b) => b.count - a.count)) {
      add({
        id: makeVirtualVariableId('imaging_modality', b.modality),
        name: `imaging:${b.modality}`,
        label: `Có ${b.modality}`,
        type: 'category',
        nonempty: b.count,
        distinct_count: 2,
        sample_values: shortSamples(b.samples),
        operators: ['=', 'not_empty'],
        virtual_kind: 'imaging_modality',
        source_filter: { modality: b.modality },
        source_note: 'Biến dẫn xuất từ imaging_results: có/không có loại CĐHA này trong đợt điều trị.',
      });
    }
  }

  if (def.key === 'medication_orders') {
    const byDrugGroup = new Map();
    const byDrug = new Map();
    for (const row of rows) {
      const groupText = getCell(row, ['drug_group_guess', 'Nhóm thuốc dự đoán']);
      for (const group of String(groupText || '').split(/[;,]/).map(x => x.trim()).filter(Boolean)) {
        const bucket = byDrugGroup.get(group) || { value: group, count: 0, samples: [] };
        bucket.count += 1;
        bucket.samples.push(getCell(row, ['drug_name_raw', 'Tên thuốc']) || getCell(row, ['drug_name_norm']));
        byDrugGroup.set(group, bucket);
      }
      const drug = getCell(row, ['active_ingredient', 'drug_name_norm', 'drug_name_raw']);
      if (drug) {
        const key = normalizeToken(drug);
        const bucket = byDrug.get(key) || { value: drug, count: 0, samples: [] };
        bucket.count += 1;
        bucket.samples.push(getCell(row, ['dose_raw', 'Liều dùng']) || getCell(row, ['route_raw', 'Đường dùng']));
        byDrug.set(key, bucket);
      }
    }
    for (const b of [...byDrugGroup.values()].sort((a, b) => b.count - a.count).slice(0, 80)) {
      add({ id: makeVirtualVariableId('drug_group', b.value), name: `drug_group:${b.value}`, label: `Dùng nhóm thuốc: ${b.value}`, type: 'category', nonempty: b.count, distinct_count: 2, sample_values: shortSamples(b.samples), operators: ['=', 'not_empty'], virtual_kind: 'drug_group', source_filter: { drug_group_guess: b.value } });
    }
    for (const b of [...byDrug.values()].sort((a, b) => b.count - a.count).slice(0, 120)) {
      add({ id: makeVirtualVariableId('drug_item', b.value), name: `drug:${b.value}`, label: `Dùng thuốc: ${b.value}`, type: 'category', nonempty: b.count, distinct_count: 2, sample_values: shortSamples(b.samples), operators: ['=', 'not_empty'], virtual_kind: 'drug_item', source_filter: { drug_name_norm: normalizeToken(b.value) } });
    }
  }

  if (def.key === 'surgery_results') {
    const byProcedure = new Map();
    for (const row of rows) {
      const method = getCell(row, ['surgery_method', 'Phương pháp']) || getCell(row, ['surgery_name', 'Tên phẫu thuật']);
      if (!method) continue;
      const key = normalizeToken(method);
      const bucket = byProcedure.get(key) || { value: method, count: 0, samples: [] };
      bucket.count += 1;
      bucket.samples.push(getCell(row, ['anesthesia_method', 'Vô cảm']) || getCell(row, ['surgery_date', 'Ngày mổ']));
      byProcedure.set(key, bucket);
    }
    for (const b of [...byProcedure.values()].sort((a, b) => b.count - a.count).slice(0, 120)) {
      add({ id: makeVirtualVariableId('procedure_item', b.value), name: `procedure:${b.value}`, label: `Phẫu thuật/TT: ${b.value}`, type: 'category', nonempty: b.count, distinct_count: 2, sample_values: shortSamples(b.samples), operators: ['=', 'contains', 'not_empty'], virtual_kind: 'procedure_item', source_filter: { surgery_method: b.value } });
    }
  }

  return variables;
}

function buildVariableCatalog(runDir) {
  if (!runDir || !fs.existsSync(runDir)) {
    const err = new Error('Chưa có kho dữ liệu để lập danh mục biến.');
    err.status = 400;
    throw err;
  }
  const defs = [
    { key: 'analysis_ready', label: 'Bảng tổng quát', file: 'analysis_ready.csv', purpose: 'Biến tổng hợp theo từng đợt điều trị, phù hợp để nghiên cứu viên chọn biến và điều kiện.' },
    { key: 'patients', label: 'Người bệnh', file: 'patients.csv', purpose: 'Thông tin nền người bệnh.' },
    { key: 'encounters', label: 'Đợt điều trị', file: 'encounters.csv', purpose: 'Mỗi lần nhập viện/điều trị là một dòng.' },
    { key: 'lab_results', label: 'Xét nghiệm', file: 'lab_results.csv', purpose: 'Dữ liệu dài, mỗi kết quả xét nghiệm là một dòng.' },
    { key: 'imaging_results', label: 'CĐHA', file: 'imaging_results.csv', purpose: 'Chẩn đoán hình ảnh.' },
    { key: 'medication_orders', label: 'Thuốc/y lệnh', file: 'medication_orders.csv', purpose: 'Thuốc, đường dùng, liều, thời điểm.' },
    { key: 'diagnoses', label: 'Chẩn đoán', file: 'diagnoses.csv', purpose: 'ICD/chẩn đoán theo đợt điều trị.' },
    { key: 'surgery_results', label: 'Phẫu thuật/thủ thuật', file: 'surgery_results.csv', purpose: 'Tên phẫu thuật, ngày mổ, vô cảm.' },
  ];
  const groups = [];
  for (const def of defs) {
    const table = readCsvTable(path.join(runDir, def.file), Number.MAX_SAFE_INTEGER);
    const rows = table.rows || [];
    const variables = (table.columns || []).map(col => {
      let nonempty = 0;
      const values = new Map();
      for (const row of rows) {
        const v = String(row?.[col] || '').trim();
        if (!v) continue;
        nonempty += 1;
        if (values.size <= 30) values.set(v, (values.get(v) || 0) + 1);
      }
      const type = inferVariableType(col, rows);
      const distinct_count = new Set(rows.map(r => String(r?.[col] || '').trim()).filter(Boolean).map(v => v.toLowerCase())).size;
      const operators = type === 'number' ? ['=', '!=', '>', '>=', '<', '<=', 'between', 'not_empty']
        : type === 'date' ? ['between', '>=', '<=', '=', 'not_empty']
        : ['contains', '=', '!=', 'in', 'not_empty', 'empty'];
      return {
        id: `${def.key}.${col}`,
        table: def.key,
        table_label: def.label,
        name: col,
        label: col,
        type,
        rows: rows.length,
        nonempty,
        fill_rate: rows.length ? Math.round((nonempty / rows.length) * 100) : 0,
        distinct_count,
        sample_values: [...values.entries()].slice(0, 10).map(([value, count]) => ({ value, count })),
        operators,
      };
    });
    const virtualVariables = buildVirtualVariablesForTable(def, rows);
    groups.push({ ...def, rows: rows.length, variables: [...variables, ...virtualVariables] });
  }
  return { run_id: path.basename(runDir), groups, generated_at: nowIso() };
}

function countCsvRows(filePath) {
  if (!fs.existsSync(filePath)) return 0;
  try {
    return Number(readCsvTable(filePath, Number.MAX_SAFE_INTEGER).count || 0);
  } catch (_) {
    return 0;
  }
}

function getCell(row, names) {
  if (!row) return '';
  const byKey = new Map(Object.keys(row).map(key => [normalizedKey(key), row[key]]));
  for (const name of names) {
    const v = byKey.get(normalizedKey(name));
    if (String(v || '').trim()) return String(v || '').trim();
  }
  return '';
}

function patientCode(row) {
  return getCell(row, [
    'Mã BN', 'Ma BN', 'MABN', 'Mã bệnh nhân', 'Ma benh nhan',
    'patient_code', 'patientCode', 'code', 'ma_bn', 'maBN', 'Mã YT', 'Ma YT',
  ]);
}

function parseDateCell(value) {
  const s = String(value || '').trim();
  if (!s) return null;
  let m = s.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (m) return strictLocalDate(Number(m[3]), Number(m[2]), Number(m[1]));
  m = s.match(/(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return strictLocalDate(Number(m[1]), Number(m[2]), Number(m[3]));
  return null;
}

function parseDateTimeCell(value) {
  const s = String(value || '').trim();
  if (!s) return null;

  // Các bảng EMR thường ghi: "08:38 02/06/2026".
  let m = s.match(/(\d{1,2}):(\d{2})\s+(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (m) return strictLocalDate(Number(m[5]), Number(m[4]), Number(m[3]), Number(m[1]), Number(m[2]));

  // Một số file có thể ghi: "02/06/2026 08:38".
  m = s.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2})/);
  if (m) return strictLocalDate(Number(m[3]), Number(m[2]), Number(m[1]), Number(m[4]), Number(m[5]));

  // ISO/local: "2026-06-02 08:38" hoặc "2026-06-02T08:38".
  m = s.match(/(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T]+(\d{1,2}):(\d{2}))?/);
  if (m) return strictLocalDate(Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4] || 0), Number(m[5] || 0));

  return parseDateCell(s);
}

function sortRowsForTable(tableKey, rows) {
  const sortable = new Set(['initial_list', 'deep_source', 'patients', 'cohort']);
  if (!sortable.has(String(tableKey || ''))) return rows;
  if (!Array.isArray(rows) || rows.length < 2) return rows;

  const candidates = [
    'T/G vào', 'TG vào', 'Tg vào', 'Thời gian vào', 'Thoi gian vao',
    'Ngày vào viện', 'Ngay vao vien', 'Ngày nhập viện', 'Ngay nhap vien',
    'admission_time', 'admission_datetime', 'admission_date',
  ];

  return [...rows].sort((a, b) => {
    const da = parseDateTimeCell(getCell(a, candidates));
    const db = parseDateTimeCell(getCell(b, candidates));
    const ta = da ? da.getTime() : -Infinity;
    const tb = db ? db.getTime() : -Infinity;
    if (tb !== ta) return tb - ta;
    const ca = patientCode(a);
    const cb = patientCode(b);
    if (cb !== ca) return String(cb).localeCompare(String(ca));
    return String(getCell(a, ['Họ tên', 'Ho ten', 'patient_name'])).localeCompare(String(getCell(b, ['Họ tên', 'Ho ten', 'patient_name'])));
  });
}

function parseDateFilter(value, endOfDay = false) {
  const s = String(value || '').trim();
  if (!s) return null;
  const d = parseDateCell(s);
  if (!d) return null;
  if (endOfDay) d.setHours(23, 59, 59, 999);
  return d;
}

function rowPassesDateFilter(row, filters = {}) {
  const admission = parseDateCell(getCell(row, ['Ngày vào viện', 'Ngay vao vien', 'Ngày nhập viện', 'Ngay nhap vien', 'T/G vào', 'TG vao']));
  const discharge = parseDateCell(getCell(row, ['Ngày ra viện', 'Ngay ra vien', 'Ngày xuất viện', 'Ngay xuat vien', 'T/G ra', 'TG ra']));
  const admitFrom = parseDateFilter(filters.admitFrom);
  const admitTo = parseDateFilter(filters.admitTo, true);
  const dischargeFrom = parseDateFilter(filters.dischargeFrom);
  const dischargeTo = parseDateFilter(filters.dischargeTo, true);

  if (admitFrom && (!admission || admission < admitFrom)) return false;
  if (admitTo && (!admission || admission > admitTo)) return false;
  if (dischargeFrom && (!discharge || discharge < dischargeFrom)) return false;
  if (dischargeTo && (!discharge || discharge > dischargeTo)) return false;
  return true;
}

function listRunsForDir(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter(e => e.isDirectory())
    .map(e => {
      const runDir = path.join(dir, e.name);
      const manifest = readJsonSafe(path.join(runDir, 'manifest.json'), {});
      const stat = fs.statSync(runDir);
      // Chỉ normalized_outputs là map số lượng. manifest.outputs của worker cũ có thể
      // chứa TÊN FILE (vd. du_lieu_ban_dau.csv), tuyệt đối không đưa filename lên UI như count.
      const outputs = {};
      for (const [key, value] of Object.entries(manifest.normalized_outputs || {})) {
        const n = Number(value);
        if (Number.isFinite(n)) outputs[key] = n;
      }
      // Các bảng raw chưa có trong normalized_outputs: đếm qua cache theo mtime.
      // Vì readCsvTable đã cache, lần sau không đọc/parse lại file nếu không đổi.
      for (const key of ['initial_list', 'deep_source', 'errors']) {
        if (outputs[key] != null) continue;
        const table = TABLES[key];
        if (table?.root === 'run') outputs[key] = countCsvRows(path.join(runDir, table.file));
      }
      const progress = readJsonSafe(path.join(runDir, 'progress.json'), {});
      const totalPatients = Number(manifest.patients_count || 0);
      const progressPatients = Object.entries(progress || {}).filter(([k]) => !k.startsWith('__')).map(([, v]) => v);
      const donePatients = progressPatients.filter(item => item && (item.committed === true || item.status === 'done')).length;
      const doneByTabs = progressPatients.filter(item => item && item.popup === 'done' && item.xn === 'done' && item.cdha === 'done').length;
      return {
        id: e.name,
        created_at: manifest.created_at || new Date(stat.mtimeMs).toISOString(),
        updated_at: manifest.updated_at || new Date(stat.mtimeMs).toISOString(),
        from_date: manifest.from_date || '',
        to_date: manifest.to_date || '',
        patients_count: totalPatients,
        done_patients: donePatients || doneByTabs,
        outputs,
        source: manifest.source || '',
        source_run_id: manifest.source_run_id || '',
      };
    })
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
}


function latestRunIdFast(dir) {
  if (!fs.existsSync(dir)) return '';
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter(e => e.isDirectory())
    .map(e => {
      const runDir = path.join(dir, e.name);
      const manifest = readJsonSafe(path.join(runDir, 'manifest.json'), {}) || {};
      let mtime = 0;
      try { mtime = fs.statSync(runDir).mtimeMs || 0; } catch (_) {}
      return { id: e.name, created_at: manifest.created_at || new Date(mtime).toISOString(), mtime };
    })
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)) || b.mtime - a.mtime)[0]?.id || '';
}

function resolveArchiveRunIdFast(requested = 'latest') {
  const req = String(requested || 'latest');
  if (req && req !== 'latest') return safeFilePart(req);
  return latestRunIdFast(archiveRunsDir());
}

function resolveStudyRunIdFast(studyId, requested = 'latest') {
  const req = String(requested || 'latest');
  if (req && req !== 'latest') return safeFilePart(req);
  return latestRunIdFast(runsDir(studyId));
}

function readArchiveProgressMeta(runId = '') {
  ensureArchiveStore();
  const meta = readJsonSafe(archiveMetaPath(), {}) || {};
  const sourceCount = countCsvRows(archiveSourcePath());
  const rid = runId || resolveArchiveRunIdFast('latest');
  const manifest = rid ? readJsonSafe(path.join(archiveRunsDir(), rid, 'manifest.json'), {}) || {} : {};
  return {
    id: ARCHIVE_ID,
    name: meta.name || ARCHIVE_LABEL,
    source_count: sourceCount || Number(manifest.normalized_outputs?.initial_list || manifest.patients_count || 0),
    latest_run: rid ? { id: rid, patients_count: Number(manifest.patients_count || 0), outputs: manifest.outputs || {} } : null,
  };
}

function readStudyProgressMeta(studyId, runId = '') {
  const id = cleanStudyId(studyId);
  const meta = readJsonSafe(studyMetaPath(id), null);
  if (!meta || typeof meta !== 'object') return null;
  const rid = runId || resolveStudyRunIdFast(id, 'latest');
  const manifest = rid ? readJsonSafe(path.join(runsDir(id), rid, 'manifest.json'), {}) || {} : {};
  return {
    ...meta,
    id,
    cohort_count: countCsvRows(cohortPath(id)),
    latest_run: rid ? { id: rid, patients_count: Number(manifest.patients_count || 0), outputs: manifest.outputs || {} } : null,
  };
}

function listRuns(studyId) {
  return listRunsForDir(runsDir(studyId));
}

function readStudy(studyId) {
  const id = cleanStudyId(studyId);
  const meta = readJsonSafe(studyMetaPath(id), null);
  if (!meta || typeof meta !== 'object') return null;
  const runs = listRuns(id);
  const cohort = countCsvRows(cohortPath(id));
  return {
    ...meta,
    id,
    cohort_count: cohort,
    has_cohort: fs.existsSync(cohortPath(id)),
    runs,
    latest_run: runs[0] || null,
  };
}

function listStudies() {
  ensureResearchStore();
  return fs.readdirSync(RESEARCH_STORE_DIR, { withFileTypes: true })
    .filter(e => e.isDirectory())
    .filter(e => e.name !== ARCHIVE_ID)
    .map(e => readStudy(e.name))
    .filter(Boolean)
    .sort((a, b) => String(b.updated_at || b.created_at).localeCompare(String(a.updated_at || a.created_at)));
}

function updateStudy(studyId, patch) {
  const current = readJsonSafe(studyMetaPath(studyId), {});
  const next = { ...current, ...patch, id: studyId, updated_at: nowIso() };
  writeJsonAtomic(studyMetaPath(studyId), next);
  return readStudy(studyId);
}

function resolveRunId(studyId, requested) {
  if (requested && requested !== 'latest') return safeFilePart(requested);
  const runs = listRuns(studyId);
  return runs[0]?.id || '';
}

function tablePathFor(studyId, tableKey, runId = 'latest') {
  const table = TABLES[tableKey] || TABLES.patients;
  if (table.root === 'study') return cohortPath(studyId);
  const rid = resolveRunId(studyId, runId);
  if (!rid) return '';
  return path.join(runsDir(studyId), rid, table.file);
}

function listArchiveRuns() {
  return listRunsForDir(archiveRunsDir());
}

function readArchive() {
  ensureArchiveStore();
  const meta = readJsonSafe(archiveMetaPath(), {});
  const runs = listArchiveRuns();
  const latest = runs[0] || null;
  const sourceCount = countCsvRows(archiveSourcePath()) || Number(latest?.outputs?.initial_list || latest?.outputs?.patients || 0);
  // Đọc fatal_alert.json từ run mới nhất nếu có
  let fatalAlert = null;
  if (latest?.id) {
    const alertPath = path.join(archiveRunsDir(), latest.id, 'fatal_alert.json');
    fatalAlert = readJsonSafe(alertPath, null);
  }
  // Đọc thống kê lỗi theo mức độ từ errors.csv
  let errorStats = null;
  if (latest?.id) {
    const errPath = path.join(archiveRunsDir(), latest.id, 'errors.csv');
    const errData = readJsonSafe && fs.existsSync(errPath) ? (() => {
      try {
        const { rows } = readCsvTable(errPath, 50000);
        const warn  = rows.filter(r => (r['Mức độ'] || r.severity || '') === 'WARN').length;
        const error = rows.filter(r => (r['Mức độ'] || r.severity || '') === 'ERROR').length;
        const fatal = rows.filter(r => (r['Mức độ'] || r.severity || '') === 'FATAL').length;
        return { total: rows.length, warn, error, fatal };
      } catch { return null; }
    })() : null;
    errorStats = errData;
  }
  const today = todayDateInput();
  const savedScanTo = String(meta.scan_to_date || '').trim();
  return {
    id: ARCHIVE_ID,
    name: meta.name || ARCHIVE_LABEL,
    description: meta.description || 'Quét toàn bộ danh sách người bệnh Hoàn tất để tạo dữ liệu gốc; nghiên cứu riêng sẽ lọc từ kho này rồi mới lấy dữ liệu sâu.',
    source_filename: meta.source_filename || '',
    source_uploaded_at: meta.source_uploaded_at || '',
    scan_from_date: meta.scan_from_date || '2026-01-01',
    // Metadata cũ có thể lưu ngày 29/05; UI/API mặc định phải mở rộng tới ngày hiện tại.
    scan_to_date: savedScanTo && savedScanTo > today ? savedScanTo : today,
    source_count: sourceCount,
    has_source: fs.existsSync(archiveSourcePath()),
    can_scan_without_source: true,
    runs,
    latest_run: latest,
    updated_at: meta.updated_at || '',
    fatal_alert: fatalAlert,
    error_stats: errorStats,
  };
}

function updateArchive(patch) {
  ensureArchiveStore();
  const current = readJsonSafe(archiveMetaPath(), {});
  const next = { ...current, ...patch, id: ARCHIVE_ID, name: ARCHIVE_LABEL, updated_at: nowIso() };
  writeJsonAtomic(archiveMetaPath(), next);
  return readArchive();
}

function resolveArchiveRunId(requested) {
  if (requested && requested !== 'latest') return safeFilePart(requested);
  const runs = listArchiveRuns();
  return runs[0]?.id || '';
}

function resolveArchiveRunIdForAction(requested = 'latest') {
  const rid = resolveArchiveRunId(String(requested || 'latest'));
  if (rid) return rid;
  const archive = readArchive();
  return safeFilePart(archive.latest_run?.id || archive.last_run_id || '');
}

function resolveStudyRunIdForAction(studyId, requested = 'latest') {
  if (requested && requested !== 'latest') return safeFilePart(requested);
  return resolveRunId(studyId, 'latest') || nowFileStamp();
}

function archiveTablePath(tableKey, runId = 'latest') {
  const table = TABLES[tableKey] || TABLES.patients;
  if (tableKey === 'cohort') return archiveSourcePath();
  const rid = resolveArchiveRunId(runId);
  if (!rid) return '';
  return path.join(archiveRunsDir(), rid, table.file);
}

function tableCountsForRunDir(runDir) {
  const manifest = readJsonSafe(path.join(runDir, 'manifest.json'), {}) || {};
  const saved = { ...(manifest.outputs || {}), ...(manifest.normalized_outputs || {}) };
  const counts = {};
  for (const [key, meta] of Object.entries(TABLES)) {
    if (meta.root !== 'run') continue;
    const filePath = path.join(runDir, meta.file);
    // Số trên dashboard phải phản ánh snapshot đang nằm trên đĩa, không ưu tiên
    // metadata cũ. countCsvRows đã cache theo mtime nên việc đếm lại này không
    // buộc parse toàn bộ CSV ở mỗi lần refresh.
    if (fs.existsSync(filePath)) counts[key] = countCsvRows(filePath);
    else if (saved[key] != null && Number.isFinite(Number(saved[key]))) counts[key] = Number(saved[key]);
    else counts[key] = 0;
  }
  return counts;
}

function computeExtractCoverage(runDir) {
  const statusPath = path.join(runDir, 'extract_status.csv');
  const table = readCsvTable(statusPath, Number.MAX_SAFE_INTEGER);
  const rows = table.rows || [];
  const total = rows.length;
  const byOverall = { done: 0, pending: 0, error: 0, other: 0 };
  const byCompletion = {};
  const fileDone = { xn_cdha: 0, profile: 0, discharge: 0, surgery: 0, order_history: 0 };
  let ready = 0;
  let manualReview = 0;
  for (const row of rows) {
    const overall = String(row.overall_status || '').trim() || 'other';
    if (byOverall[overall] == null) byOverall.other += 1; else byOverall[overall] += 1;
    const level = String(row.completion_level || '').trim() || 'unknown';
    byCompletion[level] = (byCompletion[level] || 0) + 1;
    if (row.popup_status === 'done' && row.xn_status === 'done' && row.cdha_status === 'done') fileDone.xn_cdha += 1;
    if (row.profile_status === 'done') fileDone.profile += 1;
    if (row.discharge_status === 'done') fileDone.discharge += 1;
    if (row.surgery_status === 'done') fileDone.surgery += 1;
    if (row.order_history_status === 'done') fileDone.order_history += 1;
    if (String(row.ready_for_analysis || '') === '1') ready += 1;
  }
  const ar = readCsvTable(path.join(runDir, 'analysis_ready.csv'), Number.MAX_SAFE_INTEGER);
  for (const row of ar.rows || []) {
    if (String(row.needs_manual_review || '').trim()) manualReview += 1;
  }
  return { total, ready, manual_review: manualReview, by_overall: byOverall, by_completion: byCompletion, file_done: fileDone };
}


const RESEARCH_PROGRESS_PARTS = [
  { key: 'xn_cdha', label: 'XN & CĐHA', fields: ['popup_status', 'xn_status', 'cdha_status'] },
  { key: 'profile', label: 'Hồ sơ nền', fields: ['profile_status'] },
  { key: 'discharge', label: 'Ra viện', fields: ['discharge_status'] },
  { key: 'surgery', label: 'Phẫu thuật', fields: ['surgery_status'] },
  { key: 'order_history', label: 'Y lệnh', fields: ['order_history_status'] },
];

const RESEARCH_TASK_STATE_FILE = 'research_task_state.json';
const RESEARCH_TASK_ACTIVE_STATUSES = new Set(['queued', 'running']);
// Dùng để phân biệt task thật sự thuộc process Node hiện tại với trạng thái `running`
// bị lưu sót trên đĩa sau khi server bị restart/đóng ngang.
const RESEARCH_PROCESS_INSTANCE_ID = `${process.pid}-${Date.now()}-${crypto.randomUUID()}`;

function researchTaskStatePath(runDir) {
  return path.join(runDir, RESEARCH_TASK_STATE_FILE);
}

function readResearchTaskState(runDir) {
  const state = readJsonSafe(researchTaskStatePath(runDir), {}) || {};
  return state && typeof state === 'object' && !Array.isArray(state)
    ? { current: state.current || null, history: Array.isArray(state.history) ? state.history : [] }
    : { current: null, history: [] };
}

function writeResearchTaskState(runDir, state) {
  if (!runDir) return;
  ensureDir(runDir);
  const history = Array.isArray(state?.history) ? state.history.slice(-30) : [];
  writeJsonAtomic(researchTaskStatePath(runDir), { current: state?.current || null, history });
}

function beginResearchTask(runDir, info = {}) {
  const state = readResearchTaskState(runDir);
  const task = {
    id: `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    type: String(info.type || 'research_task'),
    label: String(info.label || 'Tác vụ nghiên cứu'),
    status: String(info.status || 'queued'),
    scope: String(info.scope || ''),
    run_id: String(info.run_id || path.basename(runDir || '')),
    missing_types: Array.isArray(info.missing_types) ? info.missing_types : [],
    summary: info.summary || {},
    message: String(info.message || 'Đã xếp hàng chờ chạy.'),
    started_at: nowIso(),
    heartbeat_at: nowIso(),
    process_instance_id: RESEARCH_PROCESS_INSTANCE_ID,
  };
  const history = state.current ? [...state.history, state.current] : state.history;
  writeResearchTaskState(runDir, { current: task, history });
  return task;
}

function updateResearchTask(runDir, taskId, patch = {}) {
  const state = readResearchTaskState(runDir);
  const current = state.current || {};
  if (!current.id || (taskId && current.id !== taskId)) return current;
  const next = { ...current, ...patch, heartbeat_at: nowIso() };
  writeResearchTaskState(runDir, { current: next, history: state.history });
  return next;
}

function finishResearchTask(runDir, taskId, status, patch = {}) {
  const state = readResearchTaskState(runDir);
  const current = state.current || {};
  if (!current.id || (taskId && current.id !== taskId)) return current;
  const finished = { ...current, ...patch, status: String(status || 'done'), finished_at: nowIso(), heartbeat_at: nowIso() };
  writeResearchTaskState(runDir, { current: null, history: [...state.history, finished] });
  return finished;
}

function activeResearchTask(runDir) {
  const state = readResearchTaskState(runDir);
  const cur = state.current;
  if (!cur || typeof cur !== 'object') return null;
  const status = String(cur.status || '').toLowerCase();
  if (!RESEARCH_TASK_ACTIVE_STATUSES.has(status)) return null;

  const instanceId = String(cur.process_instance_id || '').trim();
  const taskFromAnotherProcess = instanceId !== RESEARCH_PROCESS_INSTANCE_ID;

  // `research_task_state.json` là file bền vững. Nếu Node bị restart giữa chừng,
  // task cũ không thể còn chạy nhưng trước đây state vẫn là running tới 8 giờ,
  // khiến frontend khóa nút Lấy dữ liệu/Cập nhật. Task không có instance id cũng
  // là state từ phiên bản cũ, nên phải giải phóng ngay sau khi nâng cấp/restart.
  if (taskFromAnotherProcess) {
    finishResearchTask(runDir, cur.id, 'interrupted', {
      message: 'Tác vụ trước đã dừng khi server khởi động lại. Có thể bấm Lấy dữ liệu/Cập nhật để tiếp tục phần còn thiếu.',
      interrupted_reason: 'server_restarted',
    });
    return null;
  }

  return cur;
}

function researchStatusDone(value) {
  const s = String(value || '').trim().toLowerCase();
  return s === 'done' || s === 'ok' || s === 'success' || s === '1' || s === 'true';
}

function progressCodeFromKey(key, value = {}) {
  return String(
    value['Mã BN'] || value.ma_bn || value.patient_code || String(key || '').split('|')[0] || ''
  ).replace(/^day:[^|]*\|page:[^|]*\|row:/, '').trim();
}

function progressResearchCode(value = {}) {
  return String(value['Mã NC'] || value.research_code || value.ma_nc || '').trim();
}

function progressPatientName(value = {}) {
  return String(value['Họ tên'] || value.ho_ten || value.patient_name || value.ten_bn || '').trim();
}

function progressUpdatedAt(value = {}) {
  return String(value.finished_at || value.updated_at || value.started_at || '').trim();
}

function readProgressMapSafe(filePath) {
  const raw = readJsonSafe(filePath, {}) || {};
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
}

function buildProgressSeedRows(runDir, scopeMeta = {}, isArchive = true) {
  const candidates = [
    ['extract_status', path.join(runDir, 'extract_status.csv')],
    ['research_source', path.join(runDir, 'research_source.csv')],
    ['initial_list', path.join(runDir, 'du_lieu_ban_dau.csv')],
    ['patients', path.join(runDir, 'mau_nghien_cuu.csv')],
  ];
  if (!isArchive && scopeMeta?.id) candidates.push(['cohort', cohortPath(scopeMeta.id)]);
  for (const [, fp] of candidates) {
    if (!fp || !fs.existsSync(fp)) continue;
    const table = readCsvTable(fp, 50000);
    if (table.rows?.length) return table.rows;
  }
  return [];
}

function pickProgressValue(row, names) {
  return getCell(row, names);
}

function buildHchanhFileStatus(progressMap, code, researchCode, fileKey) {
  const candidates = Object.values(progressMap || {}).filter(v => {
    if (!v || typeof v !== 'object') return false;
    const files = Array.isArray(v.files) ? v.files : [];
    if (!files.includes(fileKey)) return false;
    const vCode = String(v.ma_bn || v.patient_code || v['Mã BN'] || '').trim();
    const vRc = String(v.research_code || v.ma_nc || v['Mã NC'] || '').trim();
    if (researchCode && vRc && vRc === researchCode) return true;
    return vCode && code && vCode === code;
  });
  if (!candidates.length) return '';
  candidates.sort((a, b) => String(progressUpdatedAt(b)).localeCompare(String(progressUpdatedAt(a))));
  return String(candidates[0].status || '').trim();
}

function hchanhFileDone(progressMap, fileKey) {
  const seen = new Set();
  for (const v of Object.values(progressMap || {})) {
    if (!v || typeof v !== 'object') continue;
    const files = Array.isArray(v.files) ? v.files : [];
    if (!files.includes(fileKey)) continue;
    if (String(v.status || '').trim() !== 'done') continue;
    const key = String(v.research_code || v.ma_nc || v.ma_bn || v.patient_code || '').trim();
    if (key) seen.add(key);
  }
  return seen.size;
}

function missingLabelsForProgressRow(row) {
  const labels = [];
  for (const part of RESEARCH_PROGRESS_PARTS) {
    const done = part.fields.every(f => researchStatusDone(row[f]));
    if (!done) labels.push(part.label);
  }
  return labels;
}

function researchStatusRunning(value) {
  const s = String(value || '').trim().toLowerCase();
  return ['running', 'processing', 'in_progress', 'working'].some(x => s.includes(x));
}

function researchStatusError(value) {
  const s = String(value || '').trim().toLowerCase();
  return ['error', 'failed', 'timeout', 'no_url', 'no_session', 'skipped_recent_failure'].some(x => s.includes(x));
}

function researchStatusLabel(value) {
  const s = String(value || '').trim();
  const l = s.toLowerCase();
  if (researchStatusDone(l)) return 'Đã lấy';
  if (researchStatusRunning(l)) return 'Đang lấy';
  if (researchStatusError(l)) return 'Lỗi';
  if (l === 'partial' || l === 'incomplete' || l === 'running_partial') return 'Một phần';
  if (!s || ['pending', 'missing'].includes(l)) return 'Chưa lấy';
  return s;
}

function progressPartValue(row, part) {
  const values = part.fields.map(f => String(row?.[f] || '').trim()).filter(Boolean);
  if (!values.length) return '';
  if (values.every(v => researchStatusDone(v))) return 'done';
  if (values.some(v => researchStatusRunning(v))) return 'running';
  if (values.some(v => researchStatusError(v))) return values.find(v => researchStatusError(v)) || 'error';
  if (values.some(v => v.toLowerCase() === 'partial')) return 'partial';
  return values[0];
}

function progressMonitorRow(row) {
  const partValues = Object.fromEntries(RESEARCH_PROGRESS_PARTS.map(part => [part.key, progressPartValue(row, part)]));
  const partLabels = Object.fromEntries(RESEARCH_PROGRESS_PARTS.map(part => [part.key, researchStatusLabel(partValues[part.key])]));
  const hasRunning = Object.values(partValues).some(researchStatusRunning) || researchStatusRunning(row.overall_status);
  const hasError = Object.values(partValues).some(researchStatusError) || researchStatusError(row.overall_status) || Boolean(String(row.last_error || '').trim());
  const ready = Boolean(row.ready || researchStatusDone(row.overall_status) || String(row.ready_for_analysis || '') === '1');
  const missing = Array.isArray(row.missing) ? row.missing : missingLabelsForProgressRow(row);
  let state = 'waiting';
  let state_label = 'Chưa lấy đủ';
  if (ready) { state = 'done'; state_label = 'Đủ dữ liệu'; }
  else if (hasRunning) { state = 'running'; state_label = 'Đang lấy'; }
  else if (hasError) { state = 'error'; state_label = 'Lỗi/cần xem'; }
  else if (missing.length) { state = 'missing'; state_label = 'Còn thiếu'; }
  return {
    key: row.key,
    sample: row.research_code || row.patient_code || row.key,
    research_code: row.research_code || '',
    patient_code: row.patient_code || '',
    patient_name: row.patient_name || '',
    state,
    state_label,
    missing: missing.join(', '),
    xn_cdha: partLabels.xn_cdha,
    profile: partLabels.profile,
    discharge: partLabels.discharge,
    surgery: partLabels.surgery,
    order_history: partLabels.order_history,
    last_error: String(row.last_error || '').split('\n')[0].slice(0, 180),
    updated_at: row.updated_at || '',
  };
}

function monitorRowSortKey(row) {
  const order = { running: 0, error: 1, missing: 2, waiting: 3, done: 4 };
  return [order[row.state] ?? 9, String(row.updated_at || '')];
}

function progressPartStats(rows, part) {
  const out = { key: part.key, label: part.label, total: 0, done: 0, running: 0, error: 0, missing: 0, waiting: 0 };
  for (const row of rows || []) {
    out.total += 1;
    const value = progressPartValue(row, part);
    if (researchStatusDone(value)) out.done += 1;
    else if (researchStatusRunning(value)) out.running += 1;
    else if (researchStatusError(value)) out.error += 1;
    else if (String(value || '').trim()) out.missing += 1;
    else out.waiting += 1;
  }
  out.missing = Math.max(out.missing, Math.max(0, out.total - out.done - out.running - out.error - out.waiting));
  return out;
}

function isRowMissingXnCdha(row) {
  return !researchStatusDone(row?.xn_status) || !researchStatusDone(row?.cdha_status) || !researchStatusDone(row?.popup_status);
}

function rowResearchCode(row) {
  return String(row?.research_code || row?.['Mã NC'] || row?.ma_nc || '').trim();
}

function progressMatchesCode(key, val, patientCodes, researchCodes) {
  const rawKey = String(key || '');
  const code = progressCodeFromKey(rawKey, val);
  const rc = progressResearchCode(val);
  if (code && patientCodes.has(code)) return true;
  if (rc && researchCodes.has(rc)) return true;
  for (const item of patientCodes) if (item && rawKey.includes(item)) return true;
  for (const item of researchCodes) if (item && rawKey.includes(item)) return true;
  return false;
}

function resetXnCdhaProgress(runDir, statusRows = []) {
  const patientCodes = new Set(statusRows.map(r => String(r.patient_code || r['Mã BN'] || '').trim()).filter(Boolean));
  const researchCodes = new Set(statusRows.map(rowResearchCode).filter(Boolean));
  const progressPath = path.join(runDir, 'progress.json');
  const progress = readJsonSafe(progressPath, {}) || {};
  let resetCount = 0;
  for (const [key, val] of Object.entries(progress)) {
    if (String(key).startsWith('__') || !val || typeof val !== 'object') continue;
    if (!progressMatchesCode(key, val, patientCodes, researchCodes)) continue;
    progress[key] = {
      ...val,
      popup: '',
      xn: '',
      cdha: '',
      status: 'pending_refetch',
      committed: false,
      reset_for_refetch: true,
      updated_at: nowIso(),
    };
    resetCount += 1;
  }
  if (resetCount) writeJsonAtomic(progressPath, progress);
  return { resetCount, patientCodes, researchCodes };
}

function sourceRowsForXnCdhaRefetch(runDir, fallbackPath, statusRows = [], sourceRunId = '', dateDefaults = {}) {
  const patientCodes = new Set(statusRows.map(r => String(r.patient_code || r['Mã BN'] || '').trim()).filter(Boolean));
  const researchCodes = new Set(statusRows.map(rowResearchCode).filter(Boolean));
  // Một số file nguồn (đặc biệt extract_status/research_source cũ) có Mã NC nhưng
  // thiếu Mã BN. Deep worker bắt buộc cần Mã BN để tìm trên EMR, nên khôi phục
  // Mã BN từ chính statusRows theo Mã NC trước khi dựng CSV refetch.
  const patientCodeByResearchCode = new Map();
  for (const statusRow of statusRows) {
    const rc = rowResearchCode(statusRow);
    const code = String(statusRow.patient_code || statusRow['Mã BN'] || '').trim();
    if (rc && code && !patientCodeByResearchCode.has(rc)) patientCodeByResearchCode.set(rc, code);
  }

  const allCandidates = [];
  const pushRows = (fp) => {
    if (!fp || !fs.existsSync(fp)) return;
    const table = readCsvTable(fp, Number.MAX_SAFE_INTEGER);
    for (const row of table.rows || []) allCandidates.push(row);
  };
  pushRows(path.join(runDir, 'research_source.csv'));
  pushRows(fallbackPath);
  pushRows(path.join(runDir, 'du_lieu_ban_dau.csv'));
  pushRows(path.join(runDir, 'mau_nghien_cuu.csv'));
  pushRows(path.join(runDir, 'du_lieu_goc.csv'));
  pushRows(path.join(runDir, 'extract_status.csv'));

  const picked = [];
  const seen = new Set();
  const coveredTargets = new Set();
  for (const sourceRow of allCandidates) {
    const rc = rowResearchCode(sourceRow);
    const originalCode = patientCode(sourceRow) || String(sourceRow.patient_code || '').trim();
    const code = originalCode || (rc ? (patientCodeByResearchCode.get(rc) || '') : '');
    // Không bao giờ đưa dòng không có Mã BN vào deep worker. Mã NC một mình
    // không đủ để tìm bệnh nhân trên D/s Điều trị nội trú.
    if (!code) continue;
    if (!patientCodes.has(code) && !researchCodes.has(rc)) continue;

    const row = originalCode ? sourceRow : {
      ...sourceRow,
      'Mã BN': code,
      patient_code: String(sourceRow.patient_code || code).trim(),
    };
    const key = `${rc || ''}|${code}|${getCell(row, ['Ngày vào viện','T/G vào','fetch_from_date'])}|${getCell(row, ['Ngày ra viện','T/G ra','fetch_to_date'])}`;
    if (seen.has(key)) continue;
    seen.add(key);
    picked.push(row);
    coveredTargets.add(rc ? `rc:${rc}` : `bn:${code}`);
  }

  // Bổ sung từng target còn thiếu từ extract_status, không chỉ fallback khi picked rỗng.
  // Nhờ vậy một vài dòng nguồn lỗi/thiếu Mã BN không làm mất các ca refetch khác.
  for (const row of statusRows) {
    const code = String(row.patient_code || row['Mã BN'] || '').trim();
    if (!code) continue;
    const rc = rowResearchCode(row);
    const targetKey = rc ? `rc:${rc}` : `bn:${code}`;
    if (coveredTargets.has(targetKey)) continue;
    const fallbackRow = {
      'Mã NC': rc,
      'Mã BN': code,
      'Họ tên': String(row.patient_name || row['Họ tên'] || '').trim(),
      'Ngày vào viện': String(row.admission_date || row['Ngày vào viện'] || dateDefaults.from_date || '').trim(),
      'Ngày ra viện': String(row.discharge_date || row['Ngày ra viện'] || dateDefaults.to_date || '').trim(),
      'fetch_from_date': dateDefaults.from_date || '',
      'fetch_to_date': dateDefaults.to_date || '',
      'source_run_id': sourceRunId || '',
    };
    const key = `${rc || ''}|${code}|${fallbackRow['Ngày vào viện']}|${fallbackRow['Ngày ra viện']}`;
    if (seen.has(key)) continue;
    seen.add(key);
    picked.push(fallbackRow);
    coveredTargets.add(targetKey);
  }
  return picked;
}

function buildResearchProgressSnapshot(runDir, scopeMeta = {}, { isArchive = true } = {}) {
  if (!runDir || !fs.existsSync(runDir)) {
    const total = Number(scopeMeta?.source_count || scopeMeta?.cohort_count || 0) || 0;
    return {
      exists: false,
      run_id: '',
      total,
      ready: 0,
      missingCount: total,
      manualReview: 0,
      modules: RESEARCH_PROGRESS_PARTS.map(p => ({ ...p, done: 0, missing: total })),
      missingRows: [],
      rows: [],
      counts: { running: 0, error: 0, missing: total, waiting: total, done: 0 },
      recentUpdates: [],
      active_task: null,
      generated_at: nowIso(),
    };
  }

  const manifest = readJsonSafe(path.join(runDir, 'manifest.json'), {}) || {};
  const progress = readProgressMapSafe(path.join(runDir, 'progress.json'));
  const hchanhProgress = readProgressMapSafe(path.join(runDir, 'hchanh_auto_progress.json'));
  const orderProgress = readProgressMapSafe(path.join(runDir, 'order_history_auto_progress.json'));
  const extractTable = readCsvTable(path.join(runDir, 'extract_status.csv'), 50000);
  const seedRows = extractTable.rows?.length ? extractTable.rows : buildProgressSeedRows(runDir, scopeMeta, isArchive);

  const rowsByKey = new Map();
  const putRow = (row, idx = 0) => {
    const researchCode = pickProgressValue(row, ['research_code', 'Mã NC', 'Ma NC']);
    const code = patientCode(row) || pickProgressValue(row, ['patient_code', 'Mã BN', 'Ma BN', 'MABN']);
    const key = researchCode || code || `row:${idx}`;
    if (!rowsByKey.has(key)) {
      rowsByKey.set(key, {
        key,
        research_code: researchCode || '',
        patient_code: code || '',
        patient_name: pickProgressValue(row, ['patient_name', 'Họ tên', 'Ho ten', 'Tên BN', 'Ten BN']) || '',
        popup_status: String(row.popup_status || '').trim(),
        xn_status: String(row.xn_status || '').trim(),
        cdha_status: String(row.cdha_status || '').trim(),
        profile_status: String(row.profile_status || '').trim(),
        discharge_status: String(row.discharge_status || '').trim(),
        surgery_status: String(row.surgery_status || '').trim(),
        order_history_status: String(row.order_history_status || '').trim(),
        overall_status: String(row.overall_status || '').trim(),
        ready_for_analysis: String(row.ready_for_analysis || '').trim(),
        missing_required: String(row.missing_required || '').trim(),
        last_error: String(row.last_error || row.error || '').trim(),
        updated_at: '',
      });
    }
    return rowsByKey.get(key);
  };

  seedRows.forEach(putRow);

  for (const [key, item] of Object.entries(progress || {})) {
    if (!item || typeof item !== 'object' || String(key).startsWith('__')) continue;
    const code = progressCodeFromKey(key, item);
    const researchCode = progressResearchCode(item);
    const rowKey = researchCode || code || key;
    const row = rowsByKey.get(rowKey) || rowsByKey.get(code) || rowsByKey.get(researchCode) || {
      key: rowKey,
      research_code: researchCode,
      patient_code: code,
      patient_name: progressPatientName(item),
      popup_status: '', xn_status: '', cdha_status: '', profile_status: '', discharge_status: '', surgery_status: '', order_history_status: '',
      overall_status: '', ready_for_analysis: '', missing_required: '', last_error: '', updated_at: '',
    };
    row.research_code = row.research_code || researchCode;
    row.patient_code = row.patient_code || code;
    row.patient_name = row.patient_name || progressPatientName(item);
    row.popup_status = String(item.popup || row.popup_status || '').trim();
    row.xn_status = String(item.xn || row.xn_status || '').trim();
    row.cdha_status = String(item.cdha || row.cdha_status || '').trim();
    row.last_error = String(item.last_error || item.error || row.last_error || '').trim();
    row.updated_at = progressUpdatedAt(item) || row.updated_at;
    if (item.status) row.overall_status = String(item.status || row.overall_status || '').trim();
    if (item.committed === true && !researchStatusDone(row.overall_status)) row.overall_status = row.overall_status || 'running_partial';
    rowsByKey.set(row.key || rowKey, row);
  }

  for (const row of rowsByKey.values()) {
    const code = row.patient_code;
    const rc = row.research_code;
    row.profile_status = row.profile_status || buildHchanhFileStatus(hchanhProgress, code, rc, 'profile');
    row.discharge_status = row.discharge_status || buildHchanhFileStatus(hchanhProgress, code, rc, 'discharge');
    row.surgery_status = row.surgery_status || buildHchanhFileStatus(hchanhProgress, code, rc, 'surgery');
    row.order_history_status = row.order_history_status || buildHchanhFileStatus(orderProgress, code, rc, 'order_history') || buildHchanhFileStatus(hchanhProgress, code, rc, 'order_history');
    const missing = missingLabelsForProgressRow(row);
    row.missing = missing;
    row.ready = missing.length === 0;
  }

  const rows = Array.from(rowsByKey.values());
  const progressPatients = Object.entries(progress || {}).filter(([k, v]) => !String(k).startsWith('__') && v && typeof v === 'object').map(([, v]) => v);
  const liveDoneXnCdha = progressPatients.filter(v => v?.committed === true || v?.status === 'done' || (v?.popup === 'done' && v?.xn === 'done' && v?.cdha === 'done')).length;
  const liveTotalFromProgress = progressPatients.reduce((max, v) => Math.max(max, Number(v?.total || 0)), 0) || progressPatients.length;
  const total = rows.length || Math.max(
    liveTotalFromProgress,
    Number(manifest.patients_count || 0),
    Number(scopeMeta?.source_count || scopeMeta?.cohort_count || 0),
    Number(manifest.normalized_outputs?.initial_list || manifest.normalized_outputs?.patients || 0)
  );

  const ready = rows.filter(r => r.ready || researchStatusDone(r.overall_status) || String(r.ready_for_analysis || '') === '1').length;
  let manualReview = 0;
  const analysisReady = readCsvTable(path.join(runDir, 'analysis_ready.csv'), 50000);
  for (const row of analysisReady.rows || []) if (String(row.needs_manual_review || '').trim()) manualReview += 1;

  const modules = RESEARCH_PROGRESS_PARTS.map(part => {
    const stats = progressPartStats(rows, part);
    if (!rows.length && total) stats.missing = total;
    stats.missing = Math.max(0, stats.total - stats.done - stats.running - stats.error - stats.waiting);
    return stats;
  });

  const missingRows = rows
    .filter(r => r.missing?.length || String(r.last_error || '').trim())
    .sort((a, b) => String(b.updated_at || '').localeCompare(String(a.updated_at || '')))
    .slice(0, 300)
    .map(r => ({
      key: r.key,
      sample: r.research_code || r.patient_code || r.key,
      patient_code: r.patient_code || '',
      patient_name: r.patient_name || '',
      missing: r.missing || [],
      last_error: String(r.last_error || '').split('\n')[0].slice(0, 180),
    }));

  const monitorRows = rows.map(progressMonitorRow).sort((a, b) => {
    const ak = monitorRowSortKey(a);
    const bk = monitorRowSortKey(b);
    if (ak[0] !== bk[0]) return ak[0] - bk[0];
    return String(b.updated_at || '').localeCompare(String(a.updated_at || ''));
  });
  const counts = {
    running: monitorRows.filter(r => r.state === 'running').length,
    error: monitorRows.filter(r => r.state === 'error').length,
    missing: monitorRows.filter(r => r.state === 'missing').length,
    waiting: monitorRows.filter(r => r.state === 'waiting').length,
    done: monitorRows.filter(r => r.state === 'done').length,
  };

  const updateEvents = [];
  for (const row of rows) {
    const updated = [];
    for (const part of RESEARCH_PROGRESS_PARTS) {
      if (part.fields.every(f => researchStatusDone(row[f]))) updated.push(part.label);
    }
    if (!updated.length) continue;
    updateEvents.push({
      key: row.key,
      sample: row.research_code || row.patient_code || row.key,
      patient_code: row.patient_code || '',
      patient_name: row.patient_name || '',
      updated: updated.join(', '),
      result: row.ready ? 'Đủ dữ liệu' : 'Đã cập nhật một phần',
      missing: (row.missing || []).join(', '),
      updated_at: row.updated_at || '',
    });
  }
  updateEvents.sort((a, b) => String(b.updated_at || '').localeCompare(String(a.updated_at || '')));

  const fatalAlert = readJsonSafe(path.join(runDir, 'fatal_alert.json'), null);
  const activeTask = activeResearchTask(runDir);
  const taskState = readResearchTaskState(runDir);
  const lastFinishedTask = Array.isArray(taskState.history) && taskState.history.length
    ? taskState.history[taskState.history.length - 1]
    : null;
  const lastTaskStopped = ['cancelled', 'interrupted'].includes(String(lastFinishedTask?.status || '').toLowerCase());
  // Không hiển thị đồng thời “Đang chạy” và “đã dừng giữa chừng”. Ngoài fatal
  // của worker, cancellation/restart cũng được coi là trạng thái có thể resume.
  const stopped = !activeTask && (fatalAlert || lastTaskStopped) ? {
    ma_nc: String(fatalAlert?.ma_nc || '').trim(),
    ma_bn: String(fatalAlert?.ma_bn || '').trim(),
    ho_ten: String(fatalAlert?.ho_ten || '').trim(),
    hint: 'Tác vụ đã dừng giữa chừng. Bấm cập nhật lại để chạy tiếp từ phần chưa lấy.',
  } : null;

  return {
    exists: true,
    run_id: path.basename(runDir),
    total,
    ready,
    missingCount: Math.max(0, total - ready),
    manualReview,
    modules,
    missingRows,
    rows: monitorRows.slice(0, 500),
    counts,
    recentUpdates: updateEvents.slice(0, 80),
    active_task: activeTask ? {
      id: activeTask.id,
      type: activeTask.type,
      label: activeTask.label,
      status: activeTask.status,
      message: activeTask.message || '',
      missing_types: activeTask.missing_types || [],
      summary: activeTask.summary || {},
      started_at: activeTask.started_at || '',
      heartbeat_at: activeTask.heartbeat_at || '',
    } : null,
    stopped,
    generated_at: nowIso(),
  };
}

function buildCoverageSummary(runDir) {
  if (!runDir || !fs.existsSync(runDir)) return { exists: false, run_id: '', counts: {}, extract: computeExtractCoverage('/__missing__') };
  const counts = tableCountsForRunDir(runDir);
  const extract = computeExtractCoverage(runDir);
  const blockers = [];
  if (!counts.analysis_ready) blockers.push('Chưa có analysis_ready.csv.');
  if (!extract.total) blockers.push('Chưa có extract_status.csv.');
  if (extract.total && extract.ready < extract.total) blockers.push(`Còn ${extract.total - extract.ready}/${extract.total} dòng chưa đạt ready_for_analysis.`);
  if (extract.manual_review > 0) blockers.push(`Còn ${extract.manual_review} dòng cần manual review.`);
  return {
    exists: true,
    run_id: path.basename(runDir),
    counts,
    extract,
    final_dataset_ready: blockers.length === 0,
    blockers,
  };
}

function finalizeAnalysisDataset(runDir) {
  const coverage = buildCoverageSummary(runDir);
  if (!coverage.exists) {
    const err = new Error('Chưa có run để tạo dataset cuối.');
    err.status = 400;
    throw err;
  }
  if (!coverage.final_dataset_ready) {
    const err = new Error(`Chưa thể tạo dataset cuối: ${coverage.blockers.join(' ')}`);
    err.status = 409;
    err.coverage = coverage;
    throw err;
  }
  const selectedSrc = path.join(runDir, 'analysis_selected.csv');
  const readySrc = path.join(runDir, 'analysis_ready.csv');
  const src = fs.existsSync(selectedSrc) ? selectedSrc : readySrc;
  const dst = path.join(runDir, 'analysis_final.csv');
  const table = readCsvTable(src, Number.MAX_SAFE_INTEGER);
  const rows = (table.rows || []).filter(row => !String(row.needs_manual_review || '').trim());
  writeCsv(dst, table.columns, rows);
  const manifestPath = path.join(runDir, 'manifest.json');
  const manifest = readJsonSafe(manifestPath, {});
  const outputs = { ...(manifest.outputs || {}), analysis_final: rows.length };
  writeJsonAtomic(manifestPath, {
    ...manifest,
    outputs,
    final_dataset_created_at: nowIso(),
    final_dataset_source: path.basename(src),
  });
  let database = null;
  let database_warning = '';
  try {
    database = forceSyncDatabaseAfterDerivedOutput(runDir);
  } catch (err) {
    database_warning = String(err?.message || err);
    console.warn('[RESEARCH][SQLITE] Dataset cuối đã tạo nhưng chưa sync SQLite:', database_warning);
  }
  return { count: rows.length, source: path.basename(src), coverage: buildCoverageSummary(runDir), database, database_warning };
}


function pathSizeBytes(targetPath) {
  try {
    const st = fs.statSync(targetPath);
    if (st.isDirectory()) {
      return fs.readdirSync(targetPath).reduce((sum, name) => sum + pathSizeBytes(path.join(targetPath, name)), 0);
    }
    return st.size || 0;
  } catch (_) {
    return 0;
  }
}

function removePathSafe(baseDir, relativePath) {
  const base = path.resolve(baseDir);
  const target = path.resolve(baseDir, relativePath);
  if (!target.startsWith(base + path.sep)) return { path: relativePath, removed: false, bytes: 0, skipped: true };
  const bytes = pathSizeBytes(target);
  try {
    if (!fs.existsSync(target)) return { path: relativePath, removed: false, bytes: 0 };
    fs.rmSync(target, { recursive: true, force: true });
    return { path: relativePath, removed: true, bytes };
  } catch (err) {
    return { path: relativePath, removed: false, bytes: 0, error: err.message };
  }
}

function dedupeRowsByHash(rows) {
  const seen = new Set();
  const out = [];
  for (const row of rows || []) {
    const key = row.row_hash || stableHash(row);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(row);
  }
  return out;
}

function dedupeRowsByStableKey(rows, keyColumns = []) {
  const seen = new Set();
  const out = [];
  for (const row of rows || []) {
    const key = keyColumns.length
      ? keyColumns.map(col => String(row?.[col] ?? '').trim()).join('|')
      : stableHash(row || {});
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(row);
  }
  return out;
}

function dedupeSurgeryRows(rows) {
  const byKey = new Map();
  for (const row of rows || []) {
    const encounter = String(row?.encounter_id || row?.patient_code || '').trim();
    const time = String(row?.surgery_datetime || row?.surgery_date || '').trim().slice(0, 16);
    const procedure = normalizeSimple(row?.surgery_name || row?.surgery_method || '');
    const room = normalizeSimple(row?.operating_room || '');
    const key = [encounter, time, procedure, room].join('|');
    if (!key.replace(/\|/g, '')) continue;
    const current = byKey.get(key);
    if (!current) {
      byKey.set(key, { ...row });
      continue;
    }
    const merged = mergeRowsPreferFilled(current, row);
    merged.source = [...new Set([current.source, row.source].filter(Boolean).join(';').split(';').map(x => x.trim()).filter(Boolean))].join('; ');
    merged.row_hash = stableHash({ ...merged, source_run_id: undefined, source: undefined });
    merged.surgery_id = `surg_${merged.row_hash}`;
    byKey.set(key, merged);
  }
  return Array.from(byKey.values());
}

function cleanResearchGenerated(runDir, { encoded = true, debug = true, derived = false } = {}) {
  if (!runDir || !fs.existsSync(runDir)) {
    const err = new Error('Chưa có run để dọn dữ liệu.');
    err.status = 400;
    throw err;
  }
  const before_bytes = pathSizeBytes(runDir);
  const removed = [];
  if (encoded) removed.push(removePathSafe(runDir, ENCODED_DIRNAME));
  if (debug) {
    for (const item of RESEARCH_DEBUG_PATHS) removed.push(removePathSafe(runDir, item));
  }
  if (derived) {
    for (const item of RESEARCH_DERIVED_FILES) removed.push(removePathSafe(runDir, item));
  }
  const after_bytes = pathSizeBytes(runDir);
  const manifestPath = path.join(runDir, 'manifest.json');
  const manifest = readJsonSafe(manifestPath, {});
  writeJsonAtomic(manifestPath, {
    ...manifest,
    cleaned_generated_at: nowIso(),
    cleaned_generated_options: { encoded: Boolean(encoded), debug: Boolean(debug), derived: Boolean(derived) },
  });
  return {
    before_bytes,
    after_bytes,
    removed_bytes: Math.max(0, before_bytes - after_bytes),
    removed: removed.filter(x => x.removed || x.error || x.skipped),
  };
}


const ENCODED_DIRNAME = 'encoded';
const RESEARCH_DERIVED_FILES = [
  'patients.csv', 'encounters.csv', 'diagnoses.csv', 'lab_results.csv', 'imaging_results.csv',
  'surgery_results.csv', 'medication_orders.csv', 'medication_day_summary.csv', 'clinical_notes.csv',
  'patient_day.csv', 'analysis_ready.csv', 'analysis_selected.csv', 'analysis_final.csv', 'extract_status.csv',
];
const RESEARCH_DEBUG_PATHS = [
  'hchanh_auto_raw', 'order_history_auto_raw',
  'resource_log.jsonl', 'browser_restarts.jsonl', 'browser_restart_status.json', 'action_log.txt',
];

function dictCell(row, name) {
  return String(row?.[name] ?? '').trim();
}

function dictKeyFromValues(values) {
  return values.map(v => normalizeSimple(v)).join('|');
}

function loadDictionary(encodedDir, filename, codeColumn, columns, keyColumns) {
  const filePath = path.join(encodedDir, filename);
  const table = readCsvTable(filePath, Number.MAX_SAFE_INTEGER);
  const rows = Array.isArray(table.rows) ? table.rows : [];
  const keyToCode = new Map();
  let maxCode = 0;
  for (const row of rows) {
    const code = Number(dictCell(row, codeColumn));
    if (Number.isFinite(code) && code > maxCode) maxCode = code;
    const explicitKey = dictCell(row, 'dict_key');
    const key = explicitKey || dictKeyFromValues(keyColumns.map(col => dictCell(row, col)));
    if (key && dictCell(row, codeColumn)) keyToCode.set(key, dictCell(row, codeColumn));
  }
  return { filePath, codeColumn, columns, keyColumns, rows, keyToCode, nextCode: maxCode + 1, newRows: 0 };
}

function allocateDictionaryCode(dict, values) {
  const clean = {};
  for (const [k, v] of Object.entries(values || {})) clean[k] = String(v ?? '').trim();
  const key = clean.dict_key || dictKeyFromValues(dict.keyColumns.map(col => clean[col]));
  if (!key || key.split('|').every(part => !part)) return '';
  const existing = dict.keyToCode.get(key);
  if (existing) return existing;
  const code = String(dict.nextCode++);
  const now = nowIso();
  const row = { ...clean, [dict.codeColumn]: code, dict_key: key, created_at: now, updated_at: now };
  for (const col of dict.columns) if (row[col] == null) row[col] = '';
  dict.rows.push(row);
  dict.keyToCode.set(key, code);
  dict.newRows += 1;
  return code;
}

function saveDictionary(dict) {
  writeCsv(dict.filePath, dict.columns, dict.rows);
}

function buildEncodedDataset(runDir) {
  if (!runDir || !fs.existsSync(runDir)) {
    const err = new Error('Chưa có run để tạo dữ liệu encoded.');
    err.status = 400;
    throw err;
  }
  const encodedDir = path.join(runDir, ENCODED_DIRNAME);
  ensureDir(encodedDir);

  const labDict = loadDictionary(encodedDir, 'lab_dictionary.csv', 'lab_code', [
    'lab_code', 'lab_group', 'test_name_raw', 'test_name_norm', 'unit', 'ref_range_raw', 'dict_key', 'created_at', 'updated_at',
  ], ['test_name_norm', 'unit', 'ref_range_raw', 'lab_group']);
  const imagingDict = loadDictionary(encodedDir, 'imaging_dictionary.csv', 'imaging_code', [
    'imaging_code', 'service_name_raw', 'service_name_norm', 'modality', 'body_region', 'dict_key', 'created_at', 'updated_at',
  ], ['service_name_norm', 'modality', 'body_region']);
  const drugDict = loadDictionary(encodedDir, 'drug_dictionary.csv', 'drug_code', [
    'drug_code', 'drug_name_raw', 'drug_name_norm', 'drug_group_guess', 'active_ingredient', 'dict_key', 'created_at', 'updated_at',
  ], ['drug_name_norm', 'active_ingredient', 'drug_group_guess']);
  const routeDict = loadDictionary(encodedDir, 'route_dictionary.csv', 'route_code', [
    'route_code', 'route_raw', 'route_norm', 'dict_key', 'created_at', 'updated_at',
  ], ['route_norm', 'route_raw']);
  const diagnosisDict = loadDictionary(encodedDir, 'diagnosis_dictionary.csv', 'diagnosis_code', [
    'diagnosis_code', 'icd_code', 'diagnosis_text', 'diagnosis_text_norm', 'dict_key', 'created_at', 'updated_at',
  ], ['icd_code', 'diagnosis_text_norm']);
  const procedureDict = loadDictionary(encodedDir, 'procedure_dictionary.csv', 'procedure_code', [
    'procedure_code', 'surgery_name', 'surgery_name_norm', 'surgery_method', 'surgery_class', 'dict_key', 'created_at', 'updated_at',
  ], ['surgery_name_norm', 'surgery_method', 'surgery_class']);
  const anesthesiaDict = loadDictionary(encodedDir, 'anesthesia_dictionary.csv', 'anesthesia_code', [
    'anesthesia_code', 'anesthesia_method', 'anesthesia_method_norm', 'dict_key', 'created_at', 'updated_at',
  ], ['anesthesia_method_norm']);

  const labRows = readCsvTable(path.join(runDir, 'lab_results.csv'), Number.MAX_SAFE_INTEGER).rows || [];
  const labEncoded = labRows.map(row => {
    const labCode = allocateDictionaryCode(labDict, {
      lab_group: dictCell(row, 'lab_group'),
      test_name_raw: dictCell(row, 'test_name_raw'),
      test_name_norm: dictCell(row, 'test_name_norm') || normalizeSimple(dictCell(row, 'test_name_raw')),
      unit: dictCell(row, 'unit'),
      ref_range_raw: dictCell(row, 'ref_range_raw'),
    });
    return {
      lab_result_id: dictCell(row, 'lab_result_id'), research_code: dictCell(row, 'research_code'), patient_code: dictCell(row, 'patient_code'), encounter_id: dictCell(row, 'encounter_id'), encounter_match_status: dictCell(row, 'encounter_match_status'),
      lab_datetime: dictCell(row, 'lab_datetime'), lab_date: dictCell(row, 'lab_date'), lab_code: labCode,
      result_raw: dictCell(row, 'result_raw'), result_operator: dictCell(row, 'result_operator'), result_num: dictCell(row, 'result_num'), result_text: dictCell(row, 'result_text'),
      flag_raw: dictCell(row, 'flag_raw'), flag_norm: dictCell(row, 'flag_norm'),
      days_from_admission: dictCell(row, 'days_from_admission'), days_from_surgery: dictCell(row, 'days_from_surgery'), days_from_discharge: dictCell(row, 'days_from_discharge'), is_within_encounter: dictCell(row, 'is_within_encounter'),
      source_run_id: dictCell(row, 'source_run_id'), row_hash: dictCell(row, 'row_hash'),
    };
  });
  const labEncodedCols = ['lab_result_id', 'research_code', 'patient_code', 'encounter_id', 'encounter_match_status', 'lab_datetime', 'lab_date', 'lab_code', 'result_raw', 'result_operator', 'result_num', 'result_text', 'flag_raw', 'flag_norm', 'days_from_admission', 'days_from_surgery', 'days_from_discharge', 'is_within_encounter', 'source_run_id', 'row_hash'];

  const imagingRows = readCsvTable(path.join(runDir, 'imaging_results.csv'), Number.MAX_SAFE_INTEGER).rows || [];
  const imagingEncoded = imagingRows.map(row => {
    const serviceNameNorm = normalizeSimple(dictCell(row, 'service_name_raw'));
    const imagingCode = allocateDictionaryCode(imagingDict, {
      service_name_raw: dictCell(row, 'service_name_raw'),
      service_name_norm: serviceNameNorm,
      modality: dictCell(row, 'modality'),
      body_region: dictCell(row, 'body_region'),
    });
    return {
      imaging_id: dictCell(row, 'imaging_id'), research_code: dictCell(row, 'research_code'), patient_code: dictCell(row, 'patient_code'), encounter_id: dictCell(row, 'encounter_id'), encounter_match_status: dictCell(row, 'encounter_match_status'),
      ordered_at: dictCell(row, 'ordered_at'), order_date: dictCell(row, 'order_date'), imaging_code: imagingCode,
      has_result_text: dictCell(row, 'result_text') ? '1' : '0', has_conclusion_text: dictCell(row, 'conclusion_text') ? '1' : '0',
      status: dictCell(row, 'status'), days_from_admission: dictCell(row, 'days_from_admission'), days_from_surgery: dictCell(row, 'days_from_surgery'), days_from_discharge: dictCell(row, 'days_from_discharge'), is_within_encounter: dictCell(row, 'is_within_encounter'), source_run_id: dictCell(row, 'source_run_id'), row_hash: dictCell(row, 'row_hash'),
    };
  });
  const imagingEncodedCols = ['imaging_id', 'research_code', 'patient_code', 'encounter_id', 'encounter_match_status', 'ordered_at', 'order_date', 'imaging_code', 'has_result_text', 'has_conclusion_text', 'status', 'days_from_admission', 'days_from_surgery', 'days_from_discharge', 'is_within_encounter', 'source_run_id', 'row_hash'];

  const medRows = readCsvTable(path.join(runDir, 'medication_orders.csv'), Number.MAX_SAFE_INTEGER).rows || [];
  const medEncoded = medRows.map(row => {
    const drugCode = allocateDictionaryCode(drugDict, {
      drug_name_raw: dictCell(row, 'drug_name_raw'),
      drug_name_norm: dictCell(row, 'drug_name_norm') || normalizeSimple(dictCell(row, 'drug_name_raw')),
      drug_group_guess: dictCell(row, 'drug_group_guess'),
      active_ingredient: dictCell(row, 'active_ingredient'),
    });
    const routeCode = allocateDictionaryCode(routeDict, {
      route_raw: dictCell(row, 'route_raw'),
      route_norm: dictCell(row, 'route_norm') || normalizeSimple(dictCell(row, 'route_raw')),
    });
    return {
      med_order_id: dictCell(row, 'med_order_id'), research_code: dictCell(row, 'research_code'), patient_code: dictCell(row, 'patient_code'), encounter_id: dictCell(row, 'encounter_id'),
      order_datetime: dictCell(row, 'order_datetime'), order_date: dictCell(row, 'order_date'), drug_code: drugCode, route_code: routeCode,
      dose_raw: dictCell(row, 'dose_raw'), times_per_day: dictCell(row, 'times_per_day'),
      surgery_datetime_ref: dictCell(row, 'surgery_datetime_ref'), surgery_date_ref: dictCell(row, 'surgery_date_ref'), postop_day_index: dictCell(row, 'postop_day_index'), postop_day_label: dictCell(row, 'postop_day_label'), is_postop_day_1_3: dictCell(row, 'is_postop_day_1_3'),
      source: dictCell(row, 'source'), source_run_id: dictCell(row, 'source_run_id'), row_hash: dictCell(row, 'row_hash'),
    };
  });
  const medEncodedCols = ['med_order_id', 'research_code', 'patient_code', 'encounter_id', 'order_datetime', 'order_date', 'drug_code', 'route_code', 'dose_raw', 'times_per_day', 'surgery_datetime_ref', 'surgery_date_ref', 'postop_day_index', 'postop_day_label', 'is_postop_day_1_3', 'source', 'source_run_id', 'row_hash'];

  const diagnosisRows = readCsvTable(path.join(runDir, 'diagnoses.csv'), Number.MAX_SAFE_INTEGER).rows || [];
  const diagnosisEncoded = diagnosisRows.map(row => {
    const diagnosisCode = allocateDictionaryCode(diagnosisDict, {
      icd_code: dictCell(row, 'icd_code'),
      diagnosis_text: dictCell(row, 'diagnosis_text'),
      diagnosis_text_norm: normalizeSimple(dictCell(row, 'diagnosis_text')),
    });
    return {
      diagnosis_id: dictCell(row, 'diagnosis_id'), research_code: dictCell(row, 'research_code'), patient_code: dictCell(row, 'patient_code'), encounter_id: dictCell(row, 'encounter_id'),
      diagnosis_date: dictCell(row, 'diagnosis_date'), diagnosis_type: dictCell(row, 'diagnosis_type'), diagnosis_code: diagnosisCode,
      source: dictCell(row, 'source'), source_run_id: dictCell(row, 'source_run_id'), row_hash: dictCell(row, 'row_hash'),
    };
  });
  const diagnosisEncodedCols = ['diagnosis_id', 'research_code', 'patient_code', 'encounter_id', 'diagnosis_date', 'diagnosis_type', 'diagnosis_code', 'source', 'source_run_id', 'row_hash'];

  const surgeryRows = readCsvTable(path.join(runDir, 'surgery_results.csv'), Number.MAX_SAFE_INTEGER).rows || [];
  const surgeryEncoded = surgeryRows.map(row => {
    const procedureCode = allocateDictionaryCode(procedureDict, {
      surgery_name: dictCell(row, 'surgery_name'),
      surgery_name_norm: normalizeSimple(dictCell(row, 'surgery_name')),
      surgery_method: dictCell(row, 'surgery_method'),
      surgery_class: dictCell(row, 'surgery_class'),
    });
    const anesthesiaCode = allocateDictionaryCode(anesthesiaDict, {
      anesthesia_method: dictCell(row, 'anesthesia_method'),
      anesthesia_method_norm: normalizeSimple(dictCell(row, 'anesthesia_method')),
    });
    return {
      surgery_id: dictCell(row, 'surgery_id'), research_code: dictCell(row, 'research_code'), patient_code: dictCell(row, 'patient_code'), encounter_id: dictCell(row, 'encounter_id'),
      surgery_datetime: dictCell(row, 'surgery_datetime'), surgery_date: dictCell(row, 'surgery_date'), procedure_code: procedureCode, anesthesia_code: anesthesiaCode,
      status: dictCell(row, 'status'), source: dictCell(row, 'source'), source_run_id: dictCell(row, 'source_run_id'), row_hash: dictCell(row, 'row_hash'),
    };
  });
  const surgeryEncodedCols = ['surgery_id', 'research_code', 'patient_code', 'encounter_id', 'surgery_datetime', 'surgery_date', 'procedure_code', 'anesthesia_code', 'status', 'source', 'source_run_id', 'row_hash'];

  const selectedAnalysisPath = path.join(runDir, 'analysis_selected.csv');
  const analysisSourceFile = fs.existsSync(selectedAnalysisPath) ? 'analysis_selected.csv' : 'analysis_ready.csv';
  const arTable = readCsvTable(path.join(runDir, analysisSourceFile), Number.MAX_SAFE_INTEGER);
  const analysisEncoded = (arTable.rows || []).map(row => {
    const diagnosisCode = allocateDictionaryCode(diagnosisDict, {
      icd_code: '', diagnosis_text: dictCell(row, 'diagnosis_raw'), diagnosis_text_norm: normalizeSimple(dictCell(row, 'diagnosis_raw')),
    });
    const procedureCode = allocateDictionaryCode(procedureDict, {
      surgery_name: dictCell(row, 'surgery_name'), surgery_name_norm: normalizeSimple(dictCell(row, 'surgery_name')), surgery_method: dictCell(row, 'surgery_method'), surgery_class: '',
    });
    const anesthesiaCode = allocateDictionaryCode(anesthesiaDict, {
      anesthesia_method: dictCell(row, 'anesthesia_method'), anesthesia_method_norm: normalizeSimple(dictCell(row, 'anesthesia_method')),
    });
    const out = { ...row };
    delete out.patient_name;
    delete out.diagnosis_raw;
    delete out.surgery_name;
    delete out.surgery_method;
    delete out.anesthesia_method;
    out.sex_code = normalizeSimple(row.sex).startsWith('nam') ? '1' : normalizeSimple(row.sex).startsWith('nu') ? '2' : '';
    out.diagnosis_code = diagnosisCode;
    out.procedure_code = procedureCode;
    out.anesthesia_code = anesthesiaCode;
    return out;
  });
  const analysisEncodedPreferred = [
    'research_code', 'patient_code', 'sex_code', 'birth_year', 'age', 'admission_date', 'surgery_date', 'discharge_date', 'hospital_stay_days', 'time_to_surgery_hours',
    'diagnosis_code', 'procedure_code', 'anesthesia_code',
  ];

  writeCsv(path.join(encodedDir, 'lab_results_encoded.csv'), labEncodedCols, labEncoded);
  writeCsv(path.join(encodedDir, 'imaging_results_encoded.csv'), imagingEncodedCols, imagingEncoded);
  writeCsv(path.join(encodedDir, 'medication_orders_encoded.csv'), medEncodedCols, medEncoded);
  writeCsv(path.join(encodedDir, 'diagnoses_encoded.csv'), diagnosisEncodedCols, diagnosisEncoded);
  writeCsv(path.join(encodedDir, 'surgery_results_encoded.csv'), surgeryEncodedCols, surgeryEncoded);
  writeCsvUnion(path.join(encodedDir, 'analysis_ready_encoded.csv'), analysisEncoded, analysisEncodedPreferred);
  if (analysisSourceFile === 'analysis_selected.csv') {
    writeCsvUnion(path.join(encodedDir, 'analysis_selected_encoded.csv'), analysisEncoded, analysisEncodedPreferred);
  } else {
    try { fs.unlinkSync(path.join(encodedDir, 'analysis_selected_encoded.csv')); } catch (_) {}
  }

  for (const dict of [labDict, imagingDict, drugDict, routeDict, diagnosisDict, procedureDict, anesthesiaDict]) saveDictionary(dict);

  const outputs = {
    lab_results_encoded: labEncoded.length,
    lab_dictionary: labDict.rows.length,
    imaging_results_encoded: imagingEncoded.length,
    imaging_dictionary: imagingDict.rows.length,
    medication_orders_encoded: medEncoded.length,
    drug_dictionary: drugDict.rows.length,
    route_dictionary: routeDict.rows.length,
    diagnoses_encoded: diagnosisEncoded.length,
    diagnosis_dictionary: diagnosisDict.rows.length,
    surgery_results_encoded: surgeryEncoded.length,
    procedure_dictionary: procedureDict.rows.length,
    anesthesia_dictionary: anesthesiaDict.rows.length,
    analysis_ready_encoded: analysisEncoded.length,
    analysis_selected_encoded: analysisSourceFile === 'analysis_selected.csv' ? analysisEncoded.length : 0,
  };
  const new_entries = {
    lab_dictionary: labDict.newRows,
    imaging_dictionary: imagingDict.newRows,
    drug_dictionary: drugDict.newRows,
    route_dictionary: routeDict.newRows,
    diagnosis_dictionary: diagnosisDict.newRows,
    procedure_dictionary: procedureDict.newRows,
    anesthesia_dictionary: anesthesiaDict.newRows,
  };
  const manifestPath = path.join(runDir, 'manifest.json');
  const manifest = readJsonSafe(manifestPath, {});
  writeJsonAtomic(manifestPath, {
    ...manifest,
    encoded_at: nowIso(),
    encoded_schema_version: 2,
    encoded_analysis_source: analysisSourceFile,
    encoded_outputs: outputs,
    encoded_new_entries: new_entries,
  });
  writeJsonAtomic(path.join(encodedDir, 'encoding_manifest.json'), {
    dataset_type: 'research_dictionary_encoded',
    run_id: path.basename(runDir),
    created_at: nowIso(),
    schema_version: 2,
    analysis_source: analysisSourceFile,
    rule: 'Nếu chuỗi mới chưa có trong dictionary thì tự cấp mã số tiếp theo và lưu lại dictionary; mã cũ được giữ nguyên.',
    outputs,
    new_entries,
  });
  let database = null;
  let database_warning = '';
  try {
    database = forceSyncDatabaseAfterDerivedOutput(runDir);
  } catch (err) {
    database_warning = String(err?.message || err);
    console.warn('[RESEARCH][SQLITE] Encoded dataset đã tạo nhưng chưa sync SQLite:', database_warning);
  }
  return { run_id: path.basename(runDir), outputs, new_entries, database, database_warning };
}

function chooseArchiveRunIdForResume({ fromDate = '', toDate = '' } = {}) {
  const archive = readArchive();
  const meta = readJsonSafe(archiveMetaPath(), {});
  const requestedToMs = dateOnlyMs(toDate);

  const sameFrom = (run) => !fromDate || String(run.from_date || '') === String(fromDate || '');
  const sameOrExpandableTo = (run) => {
    if (!toDate) return true;
    const runTo = String(run.to_date || '').trim();
    if (runTo === String(toDate || '')) return true;
    const runToMs = dateOnlyMs(runTo);
    // Cho phép dùng lại run cũ khi chỉ mở rộng ngày kết thúc đến hôm nay.
    // Như vậy du_lieu_ban_dau.csv cũ vẫn là mốc để quét tăng dần và dừng sớm.
    if (Number.isFinite(runToMs) && Number.isFinite(requestedToMs)) return runToMs <= requestedToMs;
    return false;
  };

  // Khi quét dữ liệu gốc không có trước tổng số bệnh nhân, nên không thể dựa vào
  // patients_count/done_patients để biết run còn dở. Nếu server/máy bị tắt ngang,
  // active_run_id vẫn còn trong metadata; ưu tiên dùng lại run này để quét tiếp.
  const activeRunId = safeFilePart(meta.active_run_id || '');
  if (activeRunId) {
    const activeRunDir = path.join(archiveRunsDir(), activeRunId);
    if (fs.existsSync(activeRunDir)) {
      const manifest = readJsonSafe(path.join(activeRunDir, 'manifest.json'), {});
      const activeRun = { id: activeRunId, from_date: manifest.from_date || '', to_date: manifest.to_date || '' };
      if (sameFrom(activeRun) && sameOrExpandableTo(activeRun)) return activeRunId;
    }
  }

  const sourceUploadedAt = archive.source_uploaded_at ? new Date(archive.source_uploaded_at).getTime() : 0;
  const runs = listArchiveRuns();
  const reusableRuns = runs
    .filter(r => !sourceUploadedAt || new Date(r.created_at).getTime() >= sourceUploadedAt)
    .filter(sameFrom)
    .filter(sameOrExpandableTo);

  const incomplete = reusableRuns.find(r => r.patients_count > 0 && r.done_patients < r.patients_count);
  if (incomplete?.id) return incomplete.id;

  // Với Bước 1, vẫn ưu tiên dùng lại run gần nhất cùng ngày bắt đầu/khoảng mở rộng
  // để quét tăng dần lên đầu danh sách, thay vì tạo run rỗng rồi phải quét lại toàn bộ.
  if (reusableRuns[0]?.id) return reusableRuns[0].id;

  return nowFileStamp();
}

function chooseStudyRunIdForResume(studyId) {
  const runs = listRuns(studyId);
  const incomplete = runs.find(r => r.patients_count > 0 && r.done_patients < r.patients_count);
  return incomplete?.id || nowFileStamp();
}

function isStoppedRunResult(result) {
  return result && (result.code === 130 || (result.code === -1 && !result.killedByTimeout));
}

function validatePatientCsv(csv, requiredMessage = 'CSV cần có cột Mã BN.') {
  const bytes = Buffer.byteLength(csv, 'utf8');
  if (!String(csv || '').trim()) throw new Error('File CSV rỗng.');
  if (bytes > MAX_CSV_BYTES) {
    const err = new Error('CSV quá lớn.');
    err.status = 413;
    throw err;
  }
  const parsed = parseCsv(csv, { maxRows: 200000 });
  if (!parsed.columns.length || !parsed.rows.length) throw new Error('CSV không có dữ liệu.');
  const hasPatientId = parsed.columns.some(c => /mabn|mabenhnhan/i.test(normalizedKey(c)));
  if (!hasPatientId) throw new Error(requiredMessage);
  return parsed;
}

function copyRowsByPatients(sourceFile, targetFile, patientSet, codeMap) {
  const data = readCsvTable(sourceFile, Number.MAX_SAFE_INTEGER);
  if (!data.columns.length) {
    writeCsv(targetFile, [], []);
    return 0;
  }
  const rows = data.rows
    .filter(row => patientSet.has(patientCode(row)))
    .map(row => {
      const next = { ...row };
      const code = codeMap.get(patientCode(row));
      if (code) next['Mã NC'] = code;
      return next;
    });
  writeCsv(targetFile, data.columns, rows);
  return rows.length;
}

// v9: strict date parsing, typed numeric filters/custom fields 1/0, và bỏ
// patient-level surgery fallback khi chuẩn hóa medication_orders.
const NORMALIZED_SCHEMA_VERSION = 9;

const NORMALIZED_COLUMNS = {
  patients: [
    'patient_code', 'patient_name', 'sex', 'birth_date', 'age', 'birth_year',
    'address', 'phone_number', 'citizen_id', 'insurance_subject', 'insurance_card', 'insurance_type',
    'insurance_valid_from', 'insurance_valid_to', 'first_research_code', 'encounter_count',
    'source_input', 'source_run_id', 'row_hash',
  ],
  encounters: [
    'encounter_id', 'research_code', 'patient_code', 'admission_date', 'discharge_date',
    'treatment_duration', 'department', 'room_bed', 'admission_diagnosis', 'discharge_diagnosis',
    'diagnosis_raw', 'comorbidity_text', 'complication_text', 'discharge_status',
    'surgery_date', 'emr_admission_id', 'emr_treatment_id', 'emr_noitru_id', 'needs_manual_review',
    'source_run_id', 'source_status', 'row_hash',
  ],
  diagnoses: [
    'diagnosis_id', 'research_code', 'patient_code', 'encounter_id', 'diagnosis_date',
    'diagnosis_type', 'icd_code', 'diagnosis_text', 'source', 'source_run_id', 'row_hash',
  ],
  lab_results: [
    'lab_result_id', 'research_code', 'patient_code', 'encounter_id', 'encounter_match_status', 'lab_datetime', 'lab_date',
    'lab_group', 'test_name_raw', 'test_name_norm', 'result_raw', 'result_operator', 'result_num', 'result_text',
    'unit', 'ref_range_raw', 'flag_raw', 'flag_norm',
    'days_from_admission', 'days_from_surgery', 'days_from_discharge', 'is_within_encounter',
    'source_run_id', 'row_hash',
  ],
  imaging_results: [
    'imaging_id', 'research_code', 'patient_code', 'encounter_id', 'encounter_match_status', 'ordered_at', 'order_date',
    'service_name_raw', 'modality', 'body_region', 'result_text', 'conclusion_text',
    'status', 'days_from_admission', 'days_from_surgery', 'days_from_discharge', 'is_within_encounter',
    'source_run_id', 'row_hash',
  ],
  surgery_results: [
    'surgery_id', 'research_code', 'patient_code', 'encounter_id', 'encounter_match_status', 'surgery_datetime', 'surgery_date',
    'surgery_name', 'surgery_method', 'anesthesia_method', 'surgery_class', 'status',
    'preop_diagnosis', 'postop_diagnosis', 'operating_room',
    'days_from_admission', 'days_from_discharge', 'is_within_encounter',
    'source', 'source_run_id', 'row_hash',
  ],
  medication_orders: [
    'med_order_id', 'research_code', 'patient_code', 'encounter_id', 'encounter_match_status', 'order_datetime', 'order_date',
    'drug_name_raw', 'drug_name_norm', 'drug_group_guess', 'active_ingredient', 'route_raw', 'route_norm',
    'dose_raw', 'times_per_day', 'raw_line',
    'surgery_datetime_ref', 'surgery_date_ref', 'postop_day_index', 'postop_day_label', 'is_postop_day_1_3',
    'days_from_admission', 'days_from_discharge', 'is_within_encounter',
    'source', 'source_run_id', 'row_hash',
  ],
  medication_day_summary: [
    'research_code', 'patient_code', 'encounter_id', 'order_date', 'drug_count',
    'route_set', 'drugs_display', 'drugs_json', 'source_run_id', 'row_hash',
  ],
  clinical_notes: [
    'note_id', 'research_code', 'patient_code', 'encounter_id', 'encounter_match_status', 'note_datetime', 'note_date',
    'doctor_name', 'note_type', 'clinical_text', 'order_text', 'status',
    'days_from_admission', 'days_from_discharge', 'is_within_encounter',
    'source', 'source_run_id', 'row_hash',
  ],
  patient_day: [
    'research_code', 'patient_code', 'encounter_id', 'date', 'hospital_day',
    'has_lab', 'lab_count', 'has_imaging', 'imaging_count', 'has_surgery', 'surgery_count', 'has_medication', 'medication_count',
    'hb', 'hct', 'neutrophil', 'lymphocyte', 'monocyte', 'rdw', 'plt',
    'creatinine', 'egfr', 'wbc', 'crp', 'source_run_id', 'row_hash',
  ],
  analysis_ready: [
    'research_code', 'encounter_id', 'patient_code', 'patient_name', 'sex', 'birth_year', 'age',
    'admission_date', 'surgery_date', 'discharge_date', 'hospital_stay_days', 'time_to_surgery_hours',
    'diagnosis_raw',
    // inference fields (injury_side_suggested, hip_fracture_suggested, v.v.) được sinh động theo analysis_config
    // và được gộp vào đây bởi writeCsvDynamic — không hardcode ở đây để tránh cột rỗng với NC khác chuyên khoa
    'surgery_name', 'surgery_method', 'anesthesia_method', 'comorbidity_text', 'complication_text',
    'hb', 'hct', 'neutrophil', 'lymphocyte', 'monocyte', 'rdw', 'plt',
    'imaging_summary', 'needs_manual_review', 'source_run_id', 'row_hash',
  ],
  extract_status: [
    'research_code', 'encounter_id', 'patient_code', 'patient_name', 'popup_status', 'xn_status', 'cdha_status',
    'profile_status', 'discharge_status', 'surgery_status', 'order_history_status',
    'overall_status', 'completion_level', 'ready_for_analysis', 'missing_required',
    'lab_count', 'imaging_count', 'surgery_count', 'medication_count',
    'last_error', 'source_run_id',
  ],
};

function stableHash(value) {
  return crypto.createHash('sha1').update(JSON.stringify(value || {})).digest('hex').slice(0, 16);
}

function normalizeSimple(value) {
  return removeVietnameseMarks(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function normalizeToken(value) {
  return normalizeSimple(value).replace(/\s+/g, '_');
}

function parseAnyDate(value) {
  const s = String(value || '').trim();
  if (!s) return null;
  let m = s.match(/(\d{1,2}):(\d{2})\s+(\d{1,2})[\/-](\d{1,2})[\/-](\d{4})/);
  if (m) return strictLocalDate(Number(m[5]), Number(m[4]), Number(m[3]), Number(m[1]), Number(m[2]));
  m = s.match(/(\d{1,2})[\/-](\d{1,2})[\/-](\d{4})\s+(\d{1,2}):(\d{2})/);
  if (m) return strictLocalDate(Number(m[3]), Number(m[2]), Number(m[1]), Number(m[4]), Number(m[5]));
  m = s.match(/(\d{1,2})[\/-](\d{1,2})[\/-](\d{4})/);
  if (m) return strictLocalDate(Number(m[3]), Number(m[2]), Number(m[1]));
  m = s.match(/(\d{4})-(\d{1,2})-(\d{1,2})(?:[T\s](\d{1,2}):(\d{2}))?/);
  if (m) return strictLocalDate(Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4] || 0), Number(m[5] || 0));
  return null;
}

function isoDate(value) {
  const d = parseAnyDate(value);
  if (!d || Number.isNaN(d.getTime())) return '';
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function isoDateTime(value) {
  const d = parseAnyDate(value);
  if (!d || Number.isNaN(d.getTime())) return '';
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${y}-${m}-${day} ${hh}:${mm}`;
}

function dateOffsetDays(startDate, date) {
  const a = parseAnyDate(startDate);
  const b = parseAnyDate(date);
  if (!a || !b) return '';
  const a0 = new Date(a.getFullYear(), a.getMonth(), a.getDate()).getTime();
  const b0 = new Date(b.getFullYear(), b.getMonth(), b.getDate()).getTime();
  return String(Math.floor((b0 - a0) / 86400000));
}

function daysBetween(startDate, date) {
  const offset = dateOffsetDays(startDate, date);
  return offset === '' ? '' : String(Number(offset) + 1);
}

function eventTemporalFields(ctx, eventDate) {
  const admission = ctx?.admission_date || '';
  const surgery = ctx?.surgery_date || '';
  const discharge = ctx?.discharge_date || '';
  const event = parseAnyDate(eventDate);
  const admissionDt = parseAnyDate(admission);
  const dischargeDt = parseAnyDate(discharge);
  let within = '';
  if (event && admissionDt) {
    const end = dischargeDt || new Date(admissionDt.getTime() + 60 * 86400000);
    within = event.getTime() >= admissionDt.getTime() && event.getTime() <= end.getTime() ? '1' : '0';
  }
  return {
    days_from_admission: dateOffsetDays(admission, eventDate),
    days_from_surgery: dateOffsetDays(surgery, eventDate),
    days_from_discharge: dateOffsetDays(discharge, eventDate),
    is_within_encounter: within,
  };
}

function firstNonEmpty(row, names) {
  return getCell(row, names);
}

function normalizedIdentity(value) {
  return String(value || '').trim().toLowerCase().replace(/\s+/g, '');
}

function rowNoitruId(row) {
  return firstNonEmpty(row, [
    'noitruid', 'noi_tru_id', 'NoiTruID', 'Mã nội trú', 'Ma noi tru',
    'emr_noitru_id', 'treatment_uuid',
  ]);
}

function rowExistingEncounterId(row) {
  return firstNonEmpty(row, ['encounter_id', 'visit_id']);
}

function buildEncounterId(row, sourceRunId = '') {
  // sourceRunId cố ý không tham gia khóa: cùng một lượt điều trị phải giữ nguyên ID
  // khi chạy lại ở ngày khác hoặc từ một run khác.
  const existing = rowExistingEncounterId(row);
  if (existing) return existing;

  const treatmentId = normalizedIdentity(rowEmrTreatmentId(row) || rowNoitruId(row));
  if (treatmentId) return `enc_${stableHash(['treatment', treatmentId])}`;

  const admissionId = normalizedIdentity(rowEmrAdmissionId(row));
  if (admissionId) return `enc_${stableHash(['admission', admissionId])}`;

  const maBn = patientCode(row);
  const admission = isoDateTime(firstNonEmpty(row, [
    'Ngày vào viện', 'Ngay vao vien', 'Ngày nhập viện', 'Ngay nhap vien',
    'T/G vào', 'TG vao', 'admission_date', 'ngay_vao_vien', 'ngay_vao',
  ])) || isoDate(firstNonEmpty(row, [
    'Ngày vào viện', 'Ngay vao vien', 'Ngày nhập viện', 'Ngay nhap vien',
    'T/G vào', 'TG vao', 'admission_date', 'ngay_vao_vien', 'ngay_vao',
  ]));
  const discharge = isoDateTime(firstNonEmpty(row, [
    'Ngày ra viện', 'Ngay ra vien', 'Ngày xuất viện', 'Ngay xuat vien',
    'T/G ra', 'TG ra', 'discharge_date', 'ngay_ra_vien', 'ngay_ra',
  ])) || isoDate(firstNonEmpty(row, [
    'Ngày ra viện', 'Ngay ra vien', 'Ngày xuất viện', 'Ngay xuat vien',
    'T/G ra', 'TG ra', 'discharge_date', 'ngay_ra_vien', 'ngay_ra',
  ]));
  if (maBn && admission) return `enc_${stableHash(['visit', maBn, admission, discharge || ''])}`;

  const researchCode = firstNonEmpty(row, ['Mã NC', 'Ma NC', 'research_code']);
  if (researchCode) return `enc_${stableHash(['research', researchCode])}`;

  // Khóa cuối cùng chỉ để không làm hỏng schema. Dòng này phải được đánh dấu
  // manual review vì không đủ bằng chứng để ghép lượt tự động.
  return `enc_unresolved_${stableHash([
    maBn,
    firstNonEmpty(row, ['Họ tên', 'Ho ten', 'patient_name']),
    firstNonEmpty(row, ['Khoa', 'department']),
    firstNonEmpty(row, ['Chẩn đoán', 'Chan doan', 'diagnosis_raw']),
  ])}`;
}

function contextVisitKey(code, admission, discharge) {
  return [code || '', admission || '', discharge || ''].join('|');
}

function addContextMapKey(map, key, ctx) {
  if (!key) return;
  const current = map.get(key);
  if (!current) {
    map.set(key, ctx);
    return;
  }
  const list = Array.isArray(current) ? current : [current];
  if (!list.some(item => item?.encounter_id === ctx.encounter_id)) list.push(ctx);
  map.set(key, list);
}

function uniqueContext(value) {
  if (!value) return null;
  if (Array.isArray(value)) return value.length === 1 ? value[0] : null;
  return value;
}

function rowEventDate(row) {
  return isoDateTime(firstNonEmpty(row, [
    'lab_datetime', 'ordered_at', 'surgery_datetime', 'order_datetime', 'note_datetime',
    'TG xét nghiệm', 'Thời gian xét nghiệm', 'TG chỉ định', 'TG y lệnh',
    'Ngày chỉ định', 'Ngày xét nghiệm', 'Ngày phẫu thuật', 'Thời gian', 'Ngày',
  ])) || isoDate(firstNonEmpty(row, [
    'lab_date', 'order_date', 'surgery_date', 'note_date',
    'Ngày chỉ định', 'Ngày xét nghiệm', 'Ngày phẫu thuật', 'Ngày',
  ]));
}

function eventInsideContext(eventDate, ctx) {
  if (!eventDate || !ctx?.admission_date) return false;
  const event = parseAnyDate(eventDate);
  const admission = parseAnyDate(ctx.admission_date);
  const discharge = parseAnyDate(ctx.discharge_date);
  if (!event || !admission) return false;
  const start = admission.getTime() - 86400000;
  const end = (discharge || new Date(admission.getTime() + 60 * 86400000)).getTime() + 86400000;
  return event.getTime() >= start && event.getTime() <= end;
}

function unresolvedContext(code, candidates = []) {
  return {
    patient_code: code || '',
    encounter_id: '',
    research_code: '',
    needs_manual_review: candidates.length > 1 ? 'encounter_match_ambiguous' : 'encounter_match_missing',
  };
}

function encounterMatchStatus(ctx) {
  if (ctx?.encounter_id) return 'matched';
  const reason = String(ctx?.needs_manual_review || '');
  if (reason.includes('ambiguous')) return 'ambiguous';
  return 'missing';
}

function buildContextMap(patientRows, sourceRunId = '') {
  const map = new Map();
  const byPatient = new Map();
  for (const row of patientRows) {
    const code = patientCode(row);
    if (!code) continue;
    const admission = isoDateTime(firstNonEmpty(row, ['Ngày vào viện', 'Ngay vao vien', 'Ngày nhập viện', 'Ngay nhap vien', 'T/G vào', 'TG vao', 'admission_date']))
      || isoDate(firstNonEmpty(row, ['Ngày vào viện', 'Ngay vao vien', 'Ngày nhập viện', 'Ngay nhap vien', 'T/G vào', 'TG vao', 'admission_date']));
    const discharge = isoDateTime(firstNonEmpty(row, ['Ngày ra viện', 'Ngay ra vien', 'Ngày xuất viện', 'Ngay xuat vien', 'discharge_date']))
      || isoDate(firstNonEmpty(row, ['Ngày ra viện', 'Ngay ra vien', 'Ngày xuất viện', 'Ngay xuat vien', 'discharge_date']));
    const admissionDiagnosis = firstNonEmpty(row, ['Chẩn đoán vào viện', 'Chan doan vao vien', 'Chẩn đoán', 'Chan doan', 'diagnosis_raw']);
    const ctx = {
      research_code: firstNonEmpty(row, ['Mã NC', 'Ma NC', 'research_code']),
      patient_code: code,
      patient_name: firstNonEmpty(row, ['Họ tên', 'Ho ten', 'Tên BN', 'Ten BN', 'patient_name']),
      sex: firstNonEmpty(row, ['Giới', 'Gioi', 'GT', 'sex']),
      birth_date: isoDate(firstNonEmpty(row, ['Ngày sinh', 'Ngay sinh', 'birth_date', 'DOB'])),
      age: firstNonEmpty(row, ['Tuổi', 'Tuoi', 'age']),
      address: firstNonEmpty(row, ['Địa chỉ', 'Dia chi', 'address']),
      phone_number: firstNonEmpty(row, ['Điện thoại', 'Dien thoai', 'SĐT', 'SDT', 'Số điện thoại', 'So dien thoai', 'phone', 'phone_number']),
      citizen_id: firstNonEmpty(row, ['Số CMND', 'So CMND', 'Số CMT', 'So CMT', 'CMND', 'CMT', 'CCCD', 'citizen_id']),
      insurance_subject: firstNonEmpty(row, ['Đối tượng', 'Doi tuong', 'insurance_subject']),
      insurance_card: firstNonEmpty(row, ['Số thẻ', 'So the', 'Số thẻ BHYT', 'So the BHYT', 'insurance_card']),
      insurance_type: firstNonEmpty(row, ['Loại', 'Loai', 'Loại BHYT', 'Loai BHYT', 'insurance_type']),
      insurance_valid_from: isoDate(firstNonEmpty(row, ['Giá trị từ', 'Gia tri tu', 'Từ ngày', 'Tu ngay', 'valid_from'])),
      insurance_valid_to: isoDate(firstNonEmpty(row, ['Giá trị đến', 'Gia tri den', 'Đến ngày', 'Den ngay', 'valid_to'])),
      source_input: firstNonEmpty(row, ['Nguồn input', 'Nguon input', 'source_input']),
      admission_date: admission,
      discharge_date: discharge,
      treatment_duration: firstNonEmpty(row, ['Thời gian điều trị', 'Thoi gian dieu tri', 'treatment_duration']),
      department: firstNonEmpty(row, ['Khoa', 'department', 'Khoa chuyển đến', 'Khoa dieu tri']),
      room_bed: firstNonEmpty(row, ['Phòng/Giường', 'Phong/Giuong', 'Phòng', 'Phong', 'room_bed']),
      admission_diagnosis: admissionDiagnosis,
      diagnosis_raw: admissionDiagnosis,
      surgery_date: isoDate(firstNonEmpty(row, ['Ngày mổ', 'Ngay mo', 'Ngày phẫu thuật', 'Ngay phau thuat', 'surgery_date'])),
      emr_admission_id: rowEmrAdmissionId(row),
      emr_treatment_id: rowEmrTreatmentId(row),
      emr_noitru_id: rowNoitruId(row),
      needs_manual_review: firstNonEmpty(row, ['__needs_manual_review', 'needs_manual_review']),
      encounter_id: buildEncounterId(row, sourceRunId),
    };

    const patientList = byPatient.get(code) || [];
    if (!patientList.some(item => item.encounter_id === ctx.encounter_id)) patientList.push(ctx);
    byPatient.set(code, patientList);

    addContextMapKey(map, `encounter:${ctx.encounter_id}`, ctx);
    if (ctx.research_code) addContextMapKey(map, `research:${ctx.research_code}`, ctx);
    if (ctx.emr_treatment_id) addContextMapKey(map, `treatment:${normalizedIdentity(ctx.emr_treatment_id)}`, ctx);
    if (ctx.emr_noitru_id) addContextMapKey(map, `noitru:${normalizedIdentity(ctx.emr_noitru_id)}`, ctx);
    if (ctx.emr_admission_id) addContextMapKey(map, `admission:${normalizedIdentity(ctx.emr_admission_id)}`, ctx);
    if (admission || discharge) addContextMapKey(map, `visit:${contextVisitKey(code, admission, discharge)}`, ctx);
  }
  for (const [code, list] of byPatient.entries()) map.set(`patient:${code}`, list);
  return map;
}

function contextForRow(ctxMap, row, code) {
  const explicitEncounter = rowExistingEncounterId(row);
  if (explicitEncounter) {
    const exact = uniqueContext(ctxMap.get(`encounter:${explicitEncounter}`));
    if (exact) return exact;
  }

  const treatmentId = rowEmrTreatmentId(row);
  if (treatmentId) {
    const exact = uniqueContext(ctxMap.get(`treatment:${normalizedIdentity(treatmentId)}`));
    if (exact) return exact;
  }
  const noitruId = rowNoitruId(row);
  if (noitruId) {
    const exact = uniqueContext(ctxMap.get(`noitru:${normalizedIdentity(noitruId)}`));
    if (exact) return exact;
  }
  const admissionId = rowEmrAdmissionId(row);
  if (admissionId) {
    const exact = uniqueContext(ctxMap.get(`admission:${normalizedIdentity(admissionId)}`));
    if (exact) return exact;
  }

  const researchCode = firstNonEmpty(row, ['Mã NC', 'Ma NC', 'research_code']);
  if (researchCode) {
    const exact = uniqueContext(ctxMap.get(`research:${researchCode}`));
    if (exact) return exact;
  }

  const admission = isoDateTime(firstNonEmpty(row, ['Ngày vào viện', 'Ngay vao vien', 'T/G vào', 'TG vao', 'admission_date']))
    || isoDate(firstNonEmpty(row, ['Ngày vào viện', 'Ngay vao vien', 'T/G vào', 'TG vao', 'admission_date']));
  const discharge = isoDateTime(firstNonEmpty(row, ['Ngày ra viện', 'Ngay ra vien', 'discharge_date']))
    || isoDate(firstNonEmpty(row, ['Ngày ra viện', 'Ngay ra vien', 'discharge_date']));
  if (admission || discharge) {
    const exact = uniqueContext(ctxMap.get(`visit:${contextVisitKey(code, admission, discharge)}`));
    if (exact) return exact;
  }

  const candidates = ctxMap.get(`patient:${code}`) || [];
  if (candidates.length === 1) return candidates[0];
  const eventDate = rowEventDate(row);
  if (eventDate && candidates.length > 1) {
    const temporal = candidates.filter(ctx => eventInsideContext(eventDate, ctx));
    if (temporal.length === 1) return temporal[0];
  }
  return unresolvedContext(code, candidates);
}

function normalizeSex(value) {
  const s = normalizeSimple(value);
  if (!s) return '';
  if (s.startsWith('nam') || s === 'm' || s === 'male') return 'Nam';
  if (s.startsWith('nu') || s === 'f' || s === 'female') return 'Nữ';
  return String(value || '').trim();
}

function extractBirthYear(value) {
  const m = String(value || '').match(/\b(19\d{2}|20\d{2})\b/);
  return m ? m[1] : '';
}

function normalizeLabName(value) {
  const s = normalizeSimple(value);
  const rules = [
    [/creatinin|creatinine/, 'creatinine'],
    [/egfr|muc loc cau than|loc cau than/, 'egfr'],
    [/bach cau|wbc|white blood/, 'wbc'],
    [/crp|c reactive/, 'crp'],
    [/hemoglobin|hgb|hb\b/, 'hemoglobin'],
    [/hematocrit|hct|dung tich hong cau/, 'hct'],
    [/neutrophil|bach cau trung tinh|neu\b|neut\b/, 'neutrophil'],
    [/lymphocyte|lympho|lym\b/, 'lymphocyte'],
    [/monocyte|mono\b/, 'monocyte'],
    [/rdw/, 'rdw'],
    [/tieu cau|plt|platelet/, 'platelet'],
    [/ure|urea/, 'urea'],
    [/ast|got/, 'ast'],
    [/alt|gpt/, 'alt'],
    [/duong mau|glucose/, 'glucose'],
  ];
  for (const [re, key] of rules) if (re.test(s)) return key;
  return normalizeToken(value);
}

function resultOperator(value) {
  const s = String(value || '').trim();
  const m = s.match(/^(<=|>=|<|>|≤|≥|=)/);
  if (!m) return '';
  return m[1].replace('≤', '<=').replace('≥', '>=');
}

function parseNumeric(value) {
  const s = String(value || '').replace(',', '.');
  const m = s.match(/[-+]?\d+(?:\.\d+)?/);
  return m ? m[0] : '';
}

function resultText(value) {
  const n = parseNumeric(value);
  if (!n) return String(value || '').trim();
  const stripped = String(value || '').replace(',', '.').replace(n, '').trim();
  return stripped && !/^[<>≤≥=\s.]+$/.test(stripped) ? String(value || '').trim() : '';
}

function normalizeFlag(value) {
  const s = normalizeSimple(value);
  if (!s) return '';
  if (/bat thuong|abnormal|\*/.test(s)) return 'abnormal';
  const high = /cao|high|tang|\bh\b/.test(s);
  const low = /thap|low|giam|\bl\b/.test(s);
  if (high && low) return 'abnormal';
  if (high) return 'high';
  if (low) return 'low';
  if (/bt|binh thuong|normal/.test(s)) return 'normal';
  return 'unknown';
}

function modalityFromService(value) {
  const s = normalizeSimple(value);
  if (/\bct\b|cat lop|scanner/.test(s)) return 'CT';
  if (/mri|cong huong tu/.test(s)) return 'MRI';
  if (/sieu am/.test(s)) return 'Siêu âm';
  if (/x quang|xquang|x ray|xray|\bxq\b/.test(s)) return 'X-quang';
  if (/mat do xuong|dexa/.test(s)) return 'DEXA';
  if (/dien tim|ecg/.test(s)) return 'Điện tim';
  return 'Khác';
}

function bodyRegionFromService(value) {
  const s = normalizeSimple(value);
  const regions = [
    [/nguc|phoi/, 'Ngực/phổi'],
    [/bung|o bung|gan|mat|tuy|than/, 'Bụng'],
    [/tim|mach/, 'Tim mạch'],
    [/cot song|that lung|co lung/, 'Cột sống'],
    [/goi/, 'Gối'],
    [/hang|khung chau|chau/, 'Há/khu chậu'],
    [/so nao|dau/, 'Sọ não'],
    [/co|tuyen giap/, 'Cổ'],
  ];
  for (const [re, label] of regions) if (re.test(s)) return label;
  return '';
}

function normalizeDrugName(value) {
  return normalizeToken(String(value || '').replace(/\([^)]*\)/g, ''));
}

function normalizeRoute(value) {
  const s = normalizeSimple(value);
  if (!s) return '';
  if (/truyen.*tinh mach|ttm|tinh mach.*truyen/.test(s)) return 'truyền_tĩnh_mạch';
  if (/tiem.*tinh mach|tinh mach|tm\b|iv\b/.test(s)) return 'tiêm_tĩnh_mạch';
  if (/tiem bap|bap|im\b/.test(s)) return 'tiêm_bắp';
  if (/duoi da|tiem da|sc\b/.test(s)) return 'tiêm_dưới_da';
  if (/uong|duong uong|po\b/.test(s)) return 'uống';
  if (/boi|ngoai da/.test(s)) return 'bôi';
  if (/khi dung|hit|phun khi dung/.test(s)) return 'khí_dung';
  return normalizeToken(value);
}

function classifyDrugGroup(value) {
  const s = normalizeSimple(value);
  if (!s) return '';
  const groups = [];
  if (/paracetamol|acetaminophen|perfalgan|efferalgan|panadol|hapacol|tramadol|morphin|morphine|fentanyl|pethidin|nalbuphin|nefopam|ketorolac|diclofenac|meloxicam|celecoxib|etoricoxib|ibuprofen|naproxen|gabapentin|pregabalin/.test(s)) groups.push('giảm_đau');
  if (/cefazolin|cefuroxim|ceftriaxon|ceftazidim|cefepim|cefixim|cephalexin|ampicillin|amoxicillin|augmentin|piperacillin|tazobactam|meropenem|imipenem|ertapenem|vancomycin|clindamycin|metronidazol|ciprofloxacin|levofloxacin|moxifloxacin|amikacin|gentamicin|linezolid/.test(s)) groups.push('kháng_sinh');
  if (/aspirin|clopidogrel|ticagrelor|prasugrel|dipyridamol/.test(s)) groups.push('kháng_kết_tập_tiểu_cầu');
  if (/heparin|enoxaparin|lovenox|rivaroxaban|apixaban|dabigatran|warfarin|acenocoumarol/.test(s)) groups.push('kháng_đông');
  if (/omeprazol|esomeprazol|pantoprazol|lansoprazol|rabeprazol|famotidin|ranitidin/.test(s)) groups.push('dạ_dày');
  if (/insulin|metformin|gliclazid|glimepirid|sitagliptin|dapagliflozin|empagliflozin/.test(s)) groups.push('đái_tháo_đường');
  return groups.join('; ');
}

function byEncounterCount(rows, dateKey) {
  const map = new Map();
  for (const row of rows) {
    const encounter = String(row?.encounter_id || '').trim();
    if (!encounter) continue; // không gộp dữ liệu chưa ghép lượt vào mọi lượt của cùng BN
    const bucket = map.get(encounter) || { total: 0, byDate: new Map() };
    bucket.total += 1;
    const d = row[dateKey] || '';
    if (d) bucket.byDate.set(d, (bucket.byDate.get(d) || 0) + 1);
    map.set(encounter, bucket);
  }
  return map;
}

function visitSignature(row, sourceRunId = '') {
  const existingEncounter = rowExistingEncounterId(row);
  if (existingEncounter) return `encounter:${existingEncounter}`;
  const treatmentId = normalizedIdentity(rowEmrTreatmentId(row) || rowNoitruId(row));
  if (treatmentId) return `treatment:${treatmentId}`;
  const admissionId = normalizedIdentity(rowEmrAdmissionId(row));
  if (admissionId) return `admission:${admissionId}`;
  const code = patientCode(row);
  const researchCode = firstNonEmpty(row, ['Mã NC', 'Ma NC', 'research_code']);
  const admission = rowAdmissionTime(row);
  const discharge = rowDischargeTime(row);
  if (researchCode) return `research:${researchCode}`;
  if (code && admission) return `visit:${code}|${admission}|${discharge || ''}`;
  if (code) return `patient_unresolved:${code}|${stableHash([
    firstNonEmpty(row, ['Họ tên', 'Ho ten', 'patient_name']),
    firstNonEmpty(row, ['Khoa', 'department']),
    firstNonEmpty(row, ['Chẩn đoán', 'Chan doan', 'diagnosis_raw']),
  ])}`;
  return `row:${stableHash(row)}`;
}

function rowCompletenessScore(row) {
  if (!row || typeof row !== 'object') return 0;
  let score = 0;
  for (const value of Object.values(row)) {
    const text = String(value ?? '').trim();
    if (!text) continue;
    score += Math.min(8, text.length > 20 ? 8 : 1);
  }
  return score;
}

function mergeRowsPreferFilled(base, patch) {
  const out = { ...(base || {}) };
  for (const [key, value] of Object.entries(patch || {})) {
    const next = String(value ?? '').trim();
    if (!next) continue;
    const cur = String(out[key] ?? '').trim();
    if (!cur || next.length > cur.length) out[key] = value;
  }
  return out;
}


function rowAdmissionTime(row) {
  return isoDateTime(firstNonEmpty(row, ['T/G vào', 'TG vao', 'Thời gian vào', 'Thoi gian vao', 'Ngày vào viện', 'Ngay vao vien', 'ngay_vao_vien', 'ngay_vao', 'admission_date']))
    || isoDate(firstNonEmpty(row, ['T/G vào', 'TG vao', 'Ngày vào viện', 'Ngay vao vien', 'ngay_vao_vien', 'ngay_vao', 'admission_date']));
}

function rowDischargeTime(row) {
  return isoDateTime(firstNonEmpty(row, ['Ngày ra viện', 'Ngay ra vien', 'Ngày xuất viện', 'Ngay xuat vien', 'ngay_ra_vien', 'ngay_ra', 'discharge_date']))
    || isoDate(firstNonEmpty(row, ['Ngày ra viện', 'Ngay ra vien', 'Ngày xuất viện', 'Ngay xuat vien', 'ngay_ra_vien', 'ngay_ra', 'discharge_date']));
}

function rowResearchCode(row) {
  return firstNonEmpty(row, ['Mã NC', 'Ma NC', 'research_code']);
}

function rowEmrAdmissionId(row) {
  return firstNonEmpty(row, ['Mã vào viện', 'Ma vao vien', 'emr_admission_id', 'vaovienid', 'admission_id']);
}

function rowEmrTreatmentId(row) {
  return firstNonEmpty(row, ['Mã điều trị', 'Ma dieu tri', 'emr_treatment_id', 'dieutriid', 'treatment_id']);
}

function appendManualReview(row, message) {
  const out = { ...(row || {}) };
  const cur = String(out.__needs_manual_review || out.needs_manual_review || '').trim();
  out.__needs_manual_review = [...new Set([cur, message].filter(Boolean).join('; ').split(';').map(x => x.trim()).filter(Boolean))].join('; ');
  return out;
}

function intervalsOverlap(aStart, aEnd, bStart, bEnd) {
  const as = parseAnyDate(aStart);
  const ae = parseAnyDate(aEnd);
  const bs = parseAnyDate(bStart);
  const be = parseAnyDate(bEnd);
  if (!as || !bs) return false;
  if (!ae || !be) return false;
  return as.getTime() <= be.getTime() + 86400000 && bs.getTime() <= ae.getTime() + 86400000;
}

function isTimeInsideVisit(timeValue, admissionValue, dischargeValue) {
  const t = parseAnyDate(timeValue);
  const a = parseAnyDate(admissionValue);
  const d = parseAnyDate(dischargeValue);
  if (!t || !a) return false;
  const end = d || new Date(a.getTime() + 60 * 86400000);
  return t.getTime() >= a.getTime() - 86400000 && t.getTime() <= end.getTime() + 86400000;
}

function combineEncounterSources({ initialRows = [], deepRows = [], patientRows = [], hchanhProfileRows = [], hchanhDischargeRows = [], sourceRunId = '' } = {}) {
  const map = new Map();

  function sameStrongIdentity(row, existing, sourceStatus = '') {
    const researchA = rowResearchCode(row);
    const researchB = rowResearchCode(existing);
    if (researchA && researchB && researchA === researchB) return true;

    const admissionIdA = normalizedIdentity(rowEmrAdmissionId(row));
    const admissionIdB = normalizedIdentity(rowEmrAdmissionId(existing));
    if (admissionIdA && admissionIdB && admissionIdA === admissionIdB) return true;

    const treatmentIdA = normalizedIdentity(rowEmrTreatmentId(row) || rowNoitruId(row));
    const treatmentIdB = normalizedIdentity(rowEmrTreatmentId(existing) || rowNoitruId(existing));
    if (treatmentIdA && treatmentIdB && treatmentIdA === treatmentIdB) return true;

    const a1 = rowAdmissionTime(row);
    const a2 = rowDischargeTime(row);
    const b1 = rowAdmissionTime(existing);
    const b2 = rowDischargeTime(existing);
    if (a1 && b1 && a1 === b1 && (!a2 || !b2 || a2 === b2)) return true;

    // Chỉ cho phép ghép T/G vào khoa nằm trong khoảng điều trị khi một phía thực sự
    // là dòng initial. Không dùng overlap chung vì hai lượt gần nhau có thể bị gộp sai.
    const existingIsInitial = String(existing.__source_status || '').split('+').includes('initial');
    if (existingIsInitial && a1 && a2 && b1 && isTimeInsideVisit(b1, a1, a2)) return true;
    if (sourceStatus === 'initial' && b1 && b2 && a1 && isTimeInsideVisit(a1, b1, b2)) return true;
    return false;
  }

  function findExistingSigFor(row, sourceStatus) {
    const code = patientCode(row);
    if (!code || sourceStatus === 'initial') return '';
    for (const [sig, existing] of map.entries()) {
      if (patientCode(existing) !== code) continue;
      if (sameStrongIdentity(row, existing, sourceStatus)) return sig;
    }
    return '';
  }

  function add(row, sourceStatus) {
    const code = patientCode(row);
    if (!code) return;
    let withStatus = { ...(row || {}) };
    if (sourceStatus && !withStatus.__source_status) withStatus.__source_status = sourceStatus;

    const existingSig = findExistingSigFor(withStatus, sourceStatus);
    const sameCodeCount = Array.from(map.values()).filter(x => patientCode(x) === code).length;
    if (!existingSig && sameCodeCount > 0 && sourceStatus !== 'initial') {
      withStatus = appendManualReview(withStatus, 'encounter_match_ambiguous');
    }

    const baseSig = existingSig || visitSignature(withStatus, sourceRunId);
    const sig = (!existingSig && withStatus.__needs_manual_review && /^patient_unresolved:/.test(baseSig))
      ? `row:${code}|${stableHash(withStatus)}`
      : baseSig;
    const existing = map.get(sig);
    if (!existing) { map.set(sig, withStatus); return; }
    const merged = rowCompletenessScore(withStatus) >= rowCompletenessScore(existing)
      ? mergeRowsPreferFilled(withStatus, existing)
      : mergeRowsPreferFilled(existing, withStatus);
    merged.__source_status = [...new Set([existing.__source_status, sourceStatus].filter(Boolean).join('+').split('+').filter(Boolean))].join('+');
    merged.__needs_manual_review = [...new Set([existing.__needs_manual_review, withStatus.__needs_manual_review].filter(Boolean).join('; ').split(';').map(x => x.trim()).filter(Boolean))].join('; ');
    map.set(sig, merged);
  }
  for (const row of initialRows) add(row, 'initial');
  for (const row of patientRows) add(row, 'sample');
  for (const row of deepRows) add(row, 'deep');
  for (const row of hchanhProfileRows) add(row, 'hchanh_profile');
  for (const row of hchanhDischargeRows) add(row, 'hchanh_discharge');
  return Array.from(map.values()).sort((a, b) => {
    const da = parseDateTimeCell(firstNonEmpty(a, ['Ngày vào viện', 'Ngay vao vien', 'T/G vào', 'TG vao', 'ngay_vao_vien', 'ngay_vao']));
    const db = parseDateTimeCell(firstNonEmpty(b, ['Ngày vào viện', 'Ngay vao vien', 'T/G vào', 'TG vao', 'ngay_vao_vien', 'ngay_vao']));
    const ta = da ? da.getTime() : 0;
    const tb = db ? db.getTime() : 0;
    if (ta !== tb) return ta - tb;
    return String(patientCode(a)).localeCompare(String(patientCode(b)));
  });
}

function dedupeByHash(rows) {
  const seen = new Set();
  const out = [];
  for (const row of rows || []) {
    const key = row.row_hash || stableHash(row);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(row);
  }
  return out;
}

function hchanhProfileRow(payload, meta = {}) {
  const p = payload || {};
  const maBn = p.ma_bn || meta.ma_bn || '';
  return {
    'Mã BN': maBn,
    'Mã vào viện': meta.emr_admission_id || meta.vaovienid || '',
    'Mã điều trị': meta.emr_treatment_id || meta.dieutriid || meta.noitruid || '',
    'Mã nội trú': meta.emr_noitru_id || meta.noitruid || '',
    'URL bác sĩ': meta.record_doctor_url || meta.doctor_url || '',
    'URL điều dưỡng': meta.record_nursing_url || meta.nursing_url || '',
    'Họ tên': p.ho_ten || meta.ho_ten || '',
    'Giới': p.gioi_tinh || p.gioi || '',
    'Ngày sinh': p.ngay_sinh || '',
    'Tuổi': p.tuoi || '',
    'Địa chỉ': p.dia_chi || '',
    'Điện thoại': p.dien_thoai || p.sdt || '',
    'Số CMND': p.cmnd || p.cccd || p.so_cmnd || p.so_cmt || '',
    'Đối tượng': p.doi_tuong || '',
    'Số thẻ': p.bhyt_code || p.so_the_bhyt || '',
    'Loại': p.bhyt_loai || '',
    'Giá trị từ': p.bhyt_tu_ngay || '',
    'Giá trị đến': p.bhyt_den_ngay || '',
    'Ngày vào viện': p.ngay_vao_vien || p.ngay_vao || '',
    'Ngày ra viện': p.ngay_ra_vien || p.ngay_ra || '',
    'Thời gian điều trị': p.so_ngay_dieu_tri || '',
    'Chẩn đoán': p.chan_doan || '',
    'Chẩn đoán vào viện': p.chan_doan_vao || '',
    'Chẩn đoán ra viện': p.chan_doan_ra || '',
    'Phòng/Giường': p.phong || '',
    'Nguồn input': 'hchanh_profile',
  };
}

function hchanhDischargeRow(payload, meta = {}) {
  const p = payload || {};
  const benhKem = Array.isArray(p.benh_kem) ? p.benh_kem.join('; ') : String(p.benh_kem || '');
  return {
    'Mã BN': p.ma_bn || meta.ma_bn || '',
    'Mã vào viện': meta.emr_admission_id || meta.vaovienid || '',
    'Mã điều trị': meta.emr_treatment_id || meta.dieutriid || meta.noitruid || '',
    'Mã nội trú': meta.emr_noitru_id || meta.noitruid || '',
    'URL bác sĩ': meta.record_doctor_url || meta.doctor_url || '',
    'URL điều dưỡng': meta.record_nursing_url || meta.nursing_url || '',
    'Họ tên': meta.ho_ten || '',
    'Ngày vào viện': p.ngay_vao || p.ngay_vao_vien || '',
    'Ngày ra viện': p.raw_time || [p.gio_ra, p.ngay_ra].filter(Boolean).join(' ') || p.ngay_ra || '',
    'Thời gian điều trị': p.tong_so_ngay_dt || p.so_ngay_tai_khoa || '',
    'Chẩn đoán': p.chan_doan_chinh || p.chan_doan_ra || '',
    'Chẩn đoán vào viện': p.chan_doan_vao || '',
    'Chẩn đoán ra viện': p.chan_doan_ra || p.chan_doan_chinh || '',
    'Bệnh kèm': benhKem,
    'Biến chứng': p.bien_chung || '',
    'Tai biến': p.tai_bien || '',
    'Tình trạng ra': p.tinh_trang_ra || p.ket_qua || p.xu_tri || '',
    'ICD chính': p.chan_doan_chinh_icd || '',
    'Nguồn input': 'hchanh_discharge',
  };
}

function jsonShort(value, max = 3000) {
  try {
    const s = JSON.stringify(value ?? '', null, 0);
    return s.length > max ? `${s.slice(0, max)}…` : s;
  } catch (_) {
    return String(value || '').slice(0, max);
  }
}

// index.patients (Hành chánh) giữ 1 dòng mới nhất theo mã BN, không phân biệt
// theo đợt nằm viện. Nếu bệnh nhân tái nhập viện, index có thể đã cập nhật
// admission_time của đợt MỚI trong khi file discharge/surgery/order_history còn
// là dữ liệu của đợt CŨ (chưa ai fetch lại cho đợt mới). Chỉ nhận dữ liệu lấy
// TỪ lúc nhập khoa hiện tại trở về sau — tránh gán nhầm dữ liệu đợt cũ vào kho
// nghiên cứu (khác với Hành chánh, dữ liệu nghiên cứu phải đúng, không thể tự
// quét bù lại như module khác nên bắt buộc phải lọc ở đây).
function hchanhSharedDataMatchesEncounter(payload, meta) {
  const fetchedAt = parseAnyDate(payload?._meta?.fetched_at);
  const admissionAt = parseAnyDate(meta?.admission_time);
  if (!fetchedAt || !admissionAt) return true; // thiếu mốc để so sánh, giữ hành vi cũ
  return fetchedAt.getTime() >= admissionAt.getTime();
}

function flattenHchanhIntoResearchRun(ctx, runDir) {
  const index = readHchanhIndex(ctx);
  const patients = Object.values(index?.patients || {});
  const profileRows = [];
  const dischargeRows = [];
  const surgeryRows = [];
  const orderRows = [];
  for (const meta of patients) {
    const maBn = String(meta?.ma_bn || '').trim();
    if (!maBn) continue;
    const all = readHchanhPatientAll(ctx, maBn) || {};
    if (all.profile) profileRows.push(hchanhProfileRow(all.profile, meta));
    if (all.discharge && hchanhSharedDataMatchesEncounter(all.discharge, meta)) dischargeRows.push(hchanhDischargeRow(all.discharge, meta));
    const surgeries = (all.surgery && hchanhSharedDataMatchesEncounter(all.surgery, meta) && Array.isArray(all.surgery?.surgeries)) ? all.surgery.surgeries : [];
    for (const item of surgeries) {
      const detail = item.detail || {};
      surgeryRows.push({
        'Mã BN': maBn,
        'Mã vào viện': meta.emr_admission_id || meta.vaovienid || '',
        'Mã điều trị': meta.emr_treatment_id || meta.dieutriid || meta.noitruid || '',
        'Mã nội trú': meta.emr_noitru_id || meta.noitruid || '',
        'Ngày vào viện': meta.admission_time || '',
        'Ngày ra viện': meta.discharge_time || '',
        'Họ tên': item.ho_ten || meta.ho_ten || '',
        'Ngày phẫu thuật': detail.bat_dau || item.thoi_gian || '',
        'Tên phẫu thuật': detail.dich_vu_phau_thuat || item.noi_dung_phau_thuat || '',
        'Phương pháp phẫu thuật': detail.phuong_phap_pt || detail.phuong_phap_phau_thuat || '',
        'PPVC': detail.pp_vo_cam || detail.phuong_phap_vo_cam || '',
        'Phân loại PT': detail.phan_loai_pt || item.tinh_trang || '',
        'Trạng thái': item.trang_thai || '',
        'Chẩn đoán trước mổ': detail.chan_doan_truoc_mo || '',
        'Chẩn đoán sau mổ': detail.chan_doan_sau_mo || '',
        'Phòng mổ': item.phong_mo || '',
        'Nguồn': 'hchanh_surgery',
        'Raw JSON': jsonShort(item),
      });
    }
    const historyRows = (all.order_history && hchanhSharedDataMatchesEncounter(all.order_history, meta) && Array.isArray(all.order_history?.rows)) ? all.order_history.rows : [];
    for (const item of historyRows) {
      orderRows.push({
        'Mã BN': maBn,
        'Mã vào viện': meta.emr_admission_id || meta.vaovienid || '',
        'Mã điều trị': meta.emr_treatment_id || meta.dieutriid || meta.noitruid || '',
        'Mã nội trú': meta.emr_noitru_id || meta.noitruid || '',
        'Ngày vào viện': meta.admission_time || '',
        'Ngày ra viện': meta.discharge_time || '',
        'Họ tên': meta.ho_ten || '',
        'TG y lệnh': item.tg_ylenh || item.ngay || '',
        'Ngày': item.ngay || '',
        'Bác sĩ': item.bac_si || '',
        'Diễn biến': item.dien_bien || '',
        'Tên y lệnh': item.ten_y_lenh || '',
        'Y lệnh khác': item.y_lenh_khac || '',
        'KQ': item.kq_text || '',
        'Trạng thái': item.status || '',
        'Nguồn': 'hchanh_order_history',
        'Raw JSON': jsonShort(item),
      });
    }
  }
  const dir = path.resolve(runDir);
  ensureDir(dir);
  if (profileRows.length) writeCsv(path.join(dir, 'hchanh_profile.csv'), Object.keys(profileRows[0]), profileRows);
  if (dischargeRows.length) writeCsv(path.join(dir, 'hchanh_discharge.csv'), Object.keys(dischargeRows[0]), dischargeRows);
  if (surgeryRows.length) writeCsv(path.join(dir, 'hchanh_surgery.csv'), Object.keys(surgeryRows[0]), surgeryRows);
  if (orderRows.length) writeCsv(path.join(dir, 'hchanh_order_history.csv'), Object.keys(orderRows[0]), orderRows);
  return { profile: profileRows.length, discharge: dischargeRows.length, surgery: surgeryRows.length, order_history: orderRows.length };
}


function unionColumnsForRows(rows, preferred = []) {
  const seen = new Set();
  const out = [];
  for (const col of preferred || []) {
    if (!seen.has(col)) { seen.add(col); out.push(col); }
  }
  for (const row of rows || []) {
    for (const col of Object.keys(row || {})) {
      if (!seen.has(col)) { seen.add(col); out.push(col); }
    }
  }
  return out;
}

function writeCsvUnion(filePath, rows, preferred = []) {
  const cols = unionColumnsForRows(rows, preferred);
  if (!cols.length) {
    writeFileAtomic(filePath, '\ufeff\n', 'utf-8');
    return;
  }
  writeCsv(filePath, cols, rows || []);
}

function researchHchanhSourceKey(row, sourceRunId = '') {
  const explicit = firstNonEmpty(row, ['Research key', 'research_key', 'source_key']);
  if (explicit) return String(explicit);
  // Không dùng sourceRunId để progress của cùng một lượt có thể tiếp tục qua nhiều lần chạy.
  return buildEncounterId(row, sourceRunId);
}

function researchHchanhMeta(row, sourceRunId = '') {
  const code = patientCode(row);
  // fetch_from_date/fetch_to_date là khoảng lấy dữ liệu đã đồng bộ theo run;
  // không ghi đè Ngày vào/ra viện thật của người bệnh.
  const admissionRaw = firstNonEmpty(row, ['fetch_from_date', 'Ngày vào viện', 'Ngay vao vien', 'Ngày nhập viện', 'Ngay nhap vien', 'T/G vào', 'TG vao', 'admission_date']);
  const dischargeRaw = firstNonEmpty(row, ['fetch_to_date', 'Ngày ra viện', 'Ngay ra vien', 'Ngày xuất viện', 'Ngay xuat vien', 'T/G ra', 'TG ra', 'discharge_date']);
  const actualAdmission = firstNonEmpty(row, ['Ngày vào viện', 'Ngay vao vien', 'Ngày nhập viện', 'Ngay nhap vien', 'T/G vào', 'TG vao', 'admission_date']);
  const actualDischarge = firstNonEmpty(row, ['Ngày ra viện', 'Ngay ra vien', 'Ngày xuất viện', 'Ngay xuat vien', 'T/G ra', 'TG ra', 'discharge_date']);
  return {
    source_key: researchHchanhSourceKey(row, sourceRunId),
    research_code: firstNonEmpty(row, ['Mã NC', 'Ma NC', 'research_code']),
    ma_bn: code,
    ho_ten: firstNonEmpty(row, ['Họ tên', 'Ho ten', 'Tên BN', 'Ten BN', 'patient_name']),
    date_from: isoDate(admissionRaw) || admissionRaw || '',
    date_to: isoDate(dischargeRaw) || dischargeRaw || '',
    admission_raw: actualAdmission || admissionRaw || '',
    discharge_raw: actualDischarge || dischargeRaw || '',
    emr_admission_id: rowEmrAdmissionId(row) || '',
    emr_treatment_id: rowEmrTreatmentId(row) || '',
    emr_noitru_id: rowNoitruId(row) || '',
    doctor_url: firstNonEmpty(row, ['URL bác sĩ', 'URL bac si', 'record_doctor_url', 'doctor_url']),
    nursing_url: firstNonEmpty(row, ['URL điều dưỡng', 'URL dieu duong', 'record_nursing_url', 'nursing_url']),
  };
}

function withResearchHchanhMeta(out, meta, sourceRunId) {
  return {
    ...out,
    'Mã NC': meta.research_code || out['Mã NC'] || '',
    'Research key': meta.source_key,
    'Nguồn input': out['Nguồn input'] || out['Nguồn'] || 'hchanh_auto',
    // Ghi ngày vào/ra viện thật để contextForRow build được encounter_id đúng khi normalize
    'Ngày vào viện': out['Ngày vào viện'] || meta.admission_raw || '',
    'Ngày ra viện':  out['Ngày ra viện']  || meta.discharge_raw  || '',
    'Mã vào viện': out['Mã vào viện'] || meta.emr_admission_id || '',
    'Mã điều trị': out['Mã điều trị'] || meta.emr_treatment_id || meta.emr_noitru_id || '',
    'Mã nội trú': out['Mã nội trú'] || meta.emr_noitru_id || '',
    'URL bác sĩ': out['URL bác sĩ'] || meta.doctor_url || '',
    'URL điều dưỡng': out['URL điều dưỡng'] || meta.nursing_url || '',
    'source_run_id': sourceRunId || '',
  };
}

function hchanhPayloadHasUsefulData(payload, fields = []) {
  if (!payload || typeof payload !== 'object') return false;
  const status = String(payload._fetch_status || '').toLowerCase();
  if (['error', 'no_url', 'no_session', 'timeout'].includes(status)) return false;
  if (String(payload._reason || '') === 'patient_not_completed_currently') return false;
  if (!fields.length) return !['empty'].includes(status);
  return fields.some(k => {
    const v = payload[k];
    if (Array.isArray(v)) return v.length > 0;
    return String(v ?? '').trim() !== '';
  });
}

function hchanhFetchOutputToRows(output, sourceRow, sourceRunId = '') {
  const meta = researchHchanhMeta(sourceRow, sourceRunId);
  const profileRows = [];
  const dischargeRows = [];
  const surgeryRows = [];
  const orderRows = [];
  const payload = output && typeof output === 'object' ? output : {};

  if (hchanhPayloadHasUsefulData(payload.profile, [
    'bhyt_code', 'ngay_vao_vien', 'ngay_sinh', 'dia_chi', 'doi_tuong', 'chan_doan_vao',
  ])) {
    profileRows.push(withResearchHchanhMeta(hchanhProfileRow(payload.profile, meta), meta, sourceRunId));
  }
  if (hchanhPayloadHasUsefulData(payload.discharge, [
    'xu_tri', 'tinh_trang_ra', 'ket_qua', 'chan_doan_chinh', 'chan_doan_ra', 'ngay_ra', 'raw_time', 'benh_kem',
  ])) {
    dischargeRows.push(withResearchHchanhMeta(hchanhDischargeRow(payload.discharge, meta), meta, sourceRunId));
  }

  const surgeries = Array.isArray(payload.surgery?.surgeries) ? payload.surgery.surgeries : [];
  for (const item of surgeries) {
    const detail = item?.detail || {};
    surgeryRows.push(withResearchHchanhMeta({
      'Mã BN': meta.ma_bn,
      'Họ tên': item?.ho_ten || meta.ho_ten || '',
      'Ngày phẫu thuật': detail.bat_dau || item?.thoi_gian || detail.ngay_phau_thuat || '',
      'Tên phẫu thuật': detail.dich_vu_phau_thuat || item?.noi_dung_phau_thuat || detail.ten_phau_thuat || '',
      'Phương pháp phẫu thuật': detail.phuong_phap_pt || detail.phuong_phap_phau_thuat || detail.pppt || '',
      'PPVC': detail.pp_vo_cam || detail.phuong_phap_vo_cam || detail.ppvc || '',
      'Phân loại PT': detail.phan_loai_pt || item?.tinh_trang || '',
      'Trạng thái': item?.trang_thai || '',
      'Chẩn đoán trước mổ': detail.chan_doan_truoc_mo || '',
      'Chẩn đoán sau mổ': detail.chan_doan_sau_mo || '',
      'Phòng mổ': item?.phong_mo || '',
      'Nguồn': 'hchanh_auto_surgery',
      'Raw JSON': jsonShort(item),
    }, meta, sourceRunId));
  }

  const historyRows = Array.isArray(payload.order_history?.rows) ? payload.order_history.rows : [];
  for (const item of historyRows) {
    orderRows.push(withResearchHchanhMeta({
      'Mã BN': meta.ma_bn,
      'Họ tên': meta.ho_ten || '',
      'TG y lệnh': item?.tg_ylenh || item?.ngay || '',
      'Ngày': item?.ngay || '',
      'Bác sĩ': item?.bac_si || '',
      'Diễn biến': item?.dien_bien || '',
      'Tên y lệnh': item?.ten_y_lenh || '',
      'Y lệnh khác': item?.y_lenh_khac || '',
      'KQ': item?.kq_text || '',
      'Trạng thái': item?.status || '',
      'Nguồn': 'hchanh_auto_order_history',
      'Raw JSON': jsonShort(item),
    }, meta, sourceRunId));
  }

  return { profileRows, dischargeRows, surgeryRows, orderRows, meta };
}

function runDateContext(runDir, defaults = {}) {
  const manifest = readJsonSafe(path.join(runDir, 'manifest.json'), {}) || {};
  const from = String(manifest.from_date || defaults.from_date || defaults.scan_from_date || defaults.fallbackDateFrom || '').trim();
  const to = String(manifest.to_date || defaults.to_date || defaults.scan_to_date || defaults.fallbackDateTo || '').trim();
  return {
    from_date: isoDate(from) || from || '',
    to_date: isoDate(to) || to || '',
    manifest,
  };
}

function researchSourceCandidatePaths(runDir, fallbackPath = '') {
  // Thứ tự nguồn gốc thống nhất:
  // 1) research_source.csv nếu đã tạo
  // 2) du_lieu_ban_dau.csv: danh sách Hoàn tất được Bước 1 quét, cũng là input của Bước 2 XN/CĐHA
  // 3) cohort.csv/fallback: danh sách mẫu của nghiên cứu riêng
  // 4) raw sâu chỉ dùng dự phòng khi thiếu nguồn 1-3
  // 5) bảng chuẩn hóa chỉ là dự phòng cuối, không làm nguồn chính.
  return [
    path.join(runDir, 'research_source.csv'),
    path.join(runDir, 'du_lieu_ban_dau.csv'),
    fallbackPath,
    path.join(runDir, 'mau_nghien_cuu.csv'),
    path.join(runDir, 'du_lieu_goc.csv'),
    path.join(runDir, 'du_lieu_ban_dau_da_gop.csv'),
    path.join(runDir, 'patients.csv'),
    path.join(runDir, 'encounters.csv'),
    path.join(runDir, 'analysis_ready.csv'),
  ].filter(Boolean);
}

function rowFetchDateWindow(row, dateCtx = {}) {
  const admissionRaw = rowAdmissionTime(row) || firstNonEmpty(row, [
    'Ngày vào viện', 'Ngay vao vien', 'Ngày nhập viện', 'Ngay nhap vien',
    'T/G vào', 'TG vao', 'admission_date', 'ngay_vao_vien', 'ngay_vao', 'fetch_from_date',
  ]);
  const dischargeRaw = rowDischargeTime(row) || firstNonEmpty(row, [
    'Ngày ra viện', 'Ngay ra vien', 'Ngày xuất viện', 'Ngay xuat vien',
    'T/G ra', 'TG ra', 'discharge_date', 'ngay_ra_vien', 'ngay_ra', 'fetch_to_date',
  ]);
  const from = isoDate(admissionRaw) || isoDate(dateCtx.from_date) || admissionRaw || dateCtx.from_date || '';
  const to = isoDate(dischargeRaw) || isoDate(dateCtx.to_date) || dischargeRaw || dateCtx.to_date || from || '';
  return { from, to, admissionRaw, dischargeRaw };
}

function normalizeResearchSourceRows(rows, { sourceFile = '', sourceRunId = '', dateCtx = {} } = {}) {
  const out = [];
  const seen = new Map();
  const baseName = sourceFile ? path.basename(sourceFile) : '';
  for (const row of rows || []) {
    const code = patientCode(row);
    if (!code) continue;
    const win = rowFetchDateWindow(row, dateCtx);
    const researchCode = firstNonEmpty(row, ['Mã NC', 'Ma NC', 'research_code']) || `NC${String(out.length + 1).padStart(4, '0')}`;
    const key = researchHchanhSourceKey({ ...row, 'Mã NC': researchCode, fetch_from_date: win.from, fetch_to_date: win.to }, sourceRunId);
    const normalized = {
      ...row,
      'Mã NC': researchCode,
      'Mã BN': code,
      'Họ tên': firstNonEmpty(row, ['Họ tên', 'Ho ten', 'Tên BN', 'Ten BN', 'patient_name']),
      // Không ghi đè ngày vào/ra viện thật; fetch_* chỉ dùng cho các worker tự động.
      fetch_from_date: win.from,
      fetch_to_date: win.to,
      source_scan_from_date: dateCtx.from_date || '',
      source_scan_to_date: dateCtx.to_date || '',
      source_file: baseName,
      source_run_id: sourceRunId || '',
      'Research key': key,
    };
    if (!seen.has(key)) seen.set(key, normalized);
    else seen.set(key, mergeRowsPreferFilled(seen.get(key), normalized));
  }
  return Array.from(seen.values());
}

function preferredResearchSourceSeedPath(runDir, fallbackPath = '') {
  const runPath = path.resolve(runDir);
  // Chỉ xét các file raw có thể là nguồn thật. Không xét patients.csv/encounters.csv
  // vì đó là output chuẩn hóa và luôn có mtime mới hơn research_source.csv.
  const candidates = [
    path.join(runPath, 'du_lieu_ban_dau.csv'),
    fallbackPath,
    path.join(runPath, 'mau_nghien_cuu.csv'),
    path.join(runPath, 'du_lieu_goc.csv'),
    path.join(runPath, 'du_lieu_ban_dau_da_gop.csv'),
  ].filter(Boolean);
  for (const file of candidates) {
    try {
      if (fs.statSync(file).isFile() && countCsvRows(file) > 0) return file;
    } catch (_) {}
  }
  return '';
}

function researchSourceNeedsRefresh(runDir, sourcePath, fallbackPath = '') {
  if (!sourcePath || !fs.existsSync(sourcePath)) return true;
  const seedPath = preferredResearchSourceSeedPath(runDir, fallbackPath);
  if (!seedPath) return false;
  try {
    const sourceStat = fs.statSync(sourcePath);
    const seedStat = fs.statSync(seedPath);
    return seedStat.mtimeMs > sourceStat.mtimeMs;
  } catch (_) {
    return true;
  }
}

function ensureResearchSourceRows(runDir, { fallbackPath = '', sourceRunId = '', dateDefaults = {}, force = false } = {}) {
  const runPath = path.resolve(runDir);
  ensureDir(runPath);
  const sourcePath = path.join(runPath, 'research_source.csv');
  const dateCtx = runDateContext(runPath, dateDefaults);

  const sourceStale = !force && researchSourceNeedsRefresh(runPath, sourcePath, fallbackPath);
  if (!force && !sourceStale && fs.existsSync(sourcePath)) {
    const existing = readCsvTable(sourcePath, Number.MAX_SAFE_INTEGER);
    const rows = (existing.rows || []).filter(r => patientCode(r));
    if (rows.length) {
      return { rows, file: sourcePath, base_file: firstNonEmpty(rows[0], ['source_file']) || path.basename(sourcePath), candidates: researchSourceCandidatePaths(runPath, fallbackPath), date_context: dateCtx };
    }
  }

  const candidates = researchSourceCandidatePaths(runPath, fallbackPath).filter(f => path.basename(f || '') !== 'research_source.csv');
  let pickedFile = '';
  let pickedRows = [];
  for (const file of candidates) {
    if (!file || !fs.existsSync(file)) continue;
    const parsed = readCsvTable(file, Number.MAX_SAFE_INTEGER);
    const rows = (parsed.rows || []).filter(r => patientCode(r));
    if (rows.length) {
      pickedFile = file;
      pickedRows = rows;
      break;
    }
  }
  if (!pickedRows.length) return { rows: [], file: '', base_file: '', candidates, date_context: dateCtx };

  const normalized = normalizeResearchSourceRows(pickedRows, { sourceFile: pickedFile, sourceRunId, dateCtx });
  writeCsvUnion(sourcePath, normalized, [
    'Mã NC', 'Mã BN', 'Họ tên', 'Ngày vào viện', 'Ngày ra viện',
    'fetch_from_date', 'fetch_to_date', 'source_scan_from_date', 'source_scan_to_date',
    'source_file', 'source_run_id', 'Research key',
  ]);

  const manifestPath = path.join(runPath, 'manifest.json');
  const manifest = readJsonSafe(manifestPath, {}) || {};
  writeJsonAtomic(manifestPath, {
    ...manifest,
    updated_at: nowIso(),
    research_source_at: nowIso(),
    research_source_file: path.basename(pickedFile),
    research_source_rows: normalized.length,
    research_source_scan_from_date: dateCtx.from_date || '',
    research_source_scan_to_date: dateCtx.to_date || '',
  });

  return { rows: normalized, file: sourcePath, base_file: pickedFile, candidates, date_context: dateCtx };
}

function readResearchHchanhSourceRows(runDir, fallbackPath = '', options = {}) {
  // Tất cả nút tự động trong nghiên cứu phải dùng research_source.csv làm nguồn chung.
  // Nếu file này chưa có thì tạo từ du_lieu_ban_dau.csv/cohort.csv, tức cùng nguồn với Bước 2 XN/CĐHA.
  return ensureResearchSourceRows(runDir, {
    fallbackPath,
    sourceRunId: options.sourceRunId || path.basename(path.resolve(runDir)),
    dateDefaults: options.dateDefaults || {},
    force: options.force === true,
  });
}

function uniqueResearchHchanhRows(rows, sourceRunId = '') {
  const map = new Map();
  for (const row of rows || []) {
    const code = patientCode(row);
    if (!code) continue;
    const key = researchHchanhSourceKey(row, sourceRunId);
    if (!map.has(key)) map.set(key, row);
    else map.set(key, mergeRowsPreferFilled(map.get(key), row));
  }
  return Array.from(map.values());
}

function removeResearchSourceKey(rows, sourceKey) {
  return (rows || []).filter(r => String(r?.['Research key'] || r?.source_key || '') !== String(sourceKey || ''));
}

function appendResearchRunLog(runDir, line) {
  try {
    fs.appendFileSync(path.join(runDir, 'action_log.txt'), `${line}\n`, 'utf-8');
  } catch (_) {}
}



const CASE_TRACE_JSONL = 'research_case_trace.jsonl';
const CASE_TRACE_RECENT_JSON = 'research_case_trace_recent.json';
const CASE_TRACE_RECENT_LIMIT = 10;

function clipTraceText(value, limit = 900) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, limit);
}

function normalizeCaseTraceEvent(event = {}) {
  const tag = clipTraceText(event.tag || 'WARN', 80);
  const out = {
    ts: clipTraceText(event.ts || nowIso(), 40),
    tag,
    step: clipTraceText(event.step || '', 260),
    screen: clipTraceText(event.screen || '', 260),
    sees: clipTraceText(event.sees || '', 900),
    takes: clipTraceText(event.takes || '', 900),
    writes: clipTraceText(event.writes || '', 900),
    target: clipTraceText(event.target || '', 420),
  };
  if (event.data && typeof event.data === 'object' && !Array.isArray(event.data)) {
    out.data = {};
    for (const [k, v] of Object.entries(event.data)) {
      out.data[clipTraceText(k, 80)] = typeof v === 'object' ? v : clipTraceText(v, 500);
    }
  }
  return out;
}

function readCaseTraceRecent(runDir) {
  const p = path.join(runDir || '', CASE_TRACE_RECENT_JSON);
  const arr = readJsonSafe(p, []);
  return Array.isArray(arr) ? arr : [];
}

function writeCaseTraceRecent(runDir, recent) {
  try {
    writeJsonAtomic(path.join(runDir, CASE_TRACE_RECENT_JSON), (recent || []).slice(-CASE_TRACE_RECENT_LIMIT));
  } catch (_) {}
}

function appendResearchCaseTrace(runDir, meta = {}, events = [], options = {}) {
  if (!runDir) return null;
  ensureDir(runDir);
  const safeEvents = (Array.isArray(events) ? events : [])
    .filter(Boolean)
    .slice(-200)
    .map(normalizeCaseTraceEvent);
  const payload = {
    case_id: clipTraceText(meta.case_id || meta.source_key || `${meta.ma_bn || ''}|${meta.research_code || ''}|${Date.now()}`, 220),
    ts: nowIso(),
    mode: clipTraceText(options.mode || meta.mode || '', 80),
    status: clipTraceText(options.status || meta.status || '', 40),
    index: Number(meta.index || options.index || 0) || 0,
    total: Number(meta.total || options.total || 0) || 0,
    ma_bn: clipTraceText(meta.ma_bn || meta['Mã BN'] || '', 80),
    ho_ten: clipTraceText(meta.ho_ten || meta['Họ tên'] || '', 160),
    research_code: clipTraceText(meta.research_code || meta['Mã NC'] || '', 120),
    date_from: clipTraceText(meta.date_from || meta['Ngày vào viện'] || '', 80),
    date_to: clipTraceText(meta.date_to || meta['Ngày ra viện'] || '', 80),
    files: Array.isArray(meta.files || options.files) ? (meta.files || options.files).map(x => clipTraceText(x, 40)) : [],
    counts: options.counts || meta.counts || {},
    output: clipTraceText(options.output || meta.output || '', 260),
    events: safeEvents,
  };
  try {
    fs.appendFileSync(path.join(runDir, CASE_TRACE_JSONL), JSON.stringify(payload) + '\n', 'utf-8');
  } catch (_) {}
  const recent = readCaseTraceRecent(runDir).filter(x => x && x.case_id !== payload.case_id);
  recent.push(payload);
  writeCaseTraceRecent(runDir, recent);
  return payload;
}

function readResearchCaseTrace(runDir, limit = CASE_TRACE_RECENT_LIMIT) {
  const max = Math.max(1, Math.min(50, Number(limit || CASE_TRACE_RECENT_LIMIT)));
  const recent = readCaseTraceRecent(runDir);
  if (recent.length) return recent.slice(-max).reverse();
  const p = path.join(runDir || '', CASE_TRACE_JSONL);
  if (!p || !fs.existsSync(p)) return [];
  try {
    return fs.readFileSync(p, 'utf-8')
      .split('\n')
      .filter(Boolean)
      .slice(-max)
      .map(line => { try { return JSON.parse(line); } catch (_) { return null; } })
      .filter(Boolean)
      .reverse();
  } catch (_) {
    return [];
  }
}

function maskTraceIdentifier(value) {
  const s = String(value || '').trim();
  if (!s) return '';
  if (s.length <= 4) return '*'.repeat(s.length);
  return `${s.slice(0, 4)}${'*'.repeat(Math.min(6, Math.max(4, s.length - 4)))}`;
}

function redactTraceText(value) {
  let text = String(value || '');
  if (!text) return text;
  text = text.replace(/(usid=)[^&\s]+/gi, '$1[REDACTED]');
  text = text.replace(/(keyword=)\d{5,}/gi, '$1[MA_BN]');
  text = text.replace(/(ma_bn=)\d{5,}/gi, '$1[MA_BN]');
  text = text.replace(/(Mã BN=)\d{5,}/gi, '$1[MA_BN]');
  text = text.replace(/(Họ tên=)[^;|]+/gi, '$1[REDACTED]');
  text = text.replace(/(input_|output_)(\d{4})_\d{5,}_/g, '$1$2_[MA_BN]_');
  text = text.replace(/[A-Z]:\\[^|]+?(.runtime[/\\]research|hchanh_auto_raw|order_history_auto_raw)/gi, '[LOCAL_PATH]\\$1');
  return clipTraceText(text, 900);
}

function redactCaseTracePayload(cases = []) {
  return (Array.isArray(cases) ? cases : []).map(c => ({
    ...c,
    ma_bn: maskTraceIdentifier(c?.ma_bn),
    ho_ten: c?.ho_ten ? '[REDACTED]' : '',
    events: Array.isArray(c?.events) ? c.events.map(ev => ({
      ...ev,
      step: redactTraceText(ev?.step),
      screen: redactTraceText(ev?.screen),
      sees: redactTraceText(ev?.sees),
      takes: redactTraceText(ev?.takes),
      writes: redactTraceText(ev?.writes),
      target: redactTraceText(ev?.target),
    })) : [],
  }));
}

function hchanhDefaultFiles(files) {
  const allowed = new Set(['profile', 'discharge', 'surgery', 'order_history']);
  const requested = Array.isArray(files) ? files.map(x => String(x || '').trim()).filter(Boolean) : [];
  const filtered = requested.filter(x => allowed.has(x));
  // Mặc định lấy profile + discharge + surgery (không lấy y lệnh vì không phải NC nào cũng cần).
  // Nếu caller truyền order_history vào files thì gộp luôn vào 1 lần fetch.
  return filtered.length ? filtered : ['profile', 'discharge', 'surgery'];
}

function orderHistoryDefaultFiles(files) {
  const requested = Array.isArray(files) ? files.map(x => String(x || '').trim()).filter(Boolean) : [];
  return requested.includes('order_history') ? ['order_history'] : ['order_history'];
}

function orderHistoryRunLabel(files) {
  const joined = (files || []).join(',');
  return joined === 'order_history' ? 'lịch sử y lệnh' : `lịch sử y lệnh (${joined})`;
}


function parseResearchHeadless(value, defaultValue = true) {
  if (value === undefined || value === null || value === '') return defaultValue;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  const text = String(value).trim().toLowerCase();
  if (['0', 'false', 'no', 'n', 'off', 'visible', 'show'].includes(text)) return false;
  if (['1', 'true', 'yes', 'y', 'on', 'hidden', 'headless'].includes(text)) return true;
  return defaultValue;
}

function researchHeadlessFromBody(body) {
  // Riêng module nghiên cứu mặc định chạy ẩn để không bật nhiều cửa sổ Chrome khi quét dài.
  // Vẫn cho phép bật lại cửa sổ bằng body.headless=false nếu cần debug.
  return parseResearchHeadless(body?.headless, true);
}

function statusCountsFromHchanhOutput(output) {
  const counts = { ok: 0, attention: 0, error: 0, total: 0 };
  for (const payload of Object.values(output || {})) {
    const st = String(payload?._fetch_status || '').toLowerCase();
    counts.total += 1;
    if (st === 'ok') counts.ok += 1;
    else if (['empty', 'partial'].includes(st)) counts.attention += 1;
    else if (['error', 'no_url', 'no_session', 'timeout'].includes(st)) counts.error += 1;
  }
  return counts;
}
function hchanhFailureCacheKey(meta, wantedFiles, status = 'Hoàn tất') {
  const maBn = String(meta?.ma_bn || '').trim();
  const filesKey = [...(wantedFiles || [])].map(v => String(v || '').trim()).filter(Boolean).sort().join(',');
  return `${maBn}|${String(status || '').trim()}|${filesKey}`;
}

function hchanhFailureSignatureFromTrace(workerTrace = [], output = {}) {
  const tags = new Set((Array.isArray(workerTrace) ? workerTrace : []).map(ev => String(ev?.tag || '')));
  if (tags.has('ERROR.NO_PATIENT_LINK')) return 'no_patient_link';
  if (tags.has('ERROR.NO_URL_PROFILE') || tags.has('ERROR.NO_URL_DISCHARGE') || tags.has('ERROR.NO_URL_ORDER_HISTORY') || tags.has('ERROR.NO_URL_SURGERY')) return 'no_url';
  const statuses = Object.entries(output || {})
    .filter(([k, v]) => !String(k).startsWith('_') && v && typeof v === 'object')
    .map(([, v]) => String(v?._fetch_status || '').toLowerCase())
    .filter(Boolean);
  if (statuses.length && statuses.every(st => st === 'no_url')) return 'no_url';
  if (statuses.includes('no_session')) return 'no_session';
  if (statuses.includes('timeout')) return 'timeout';
  if (statuses.includes('error')) return 'error';
  return '';
}

function hchanhFailureCacheIsFresh(item, maxAgeHours = 24) {
  if (!item || typeof item !== 'object') return false;
  const ts = Date.parse(item.ts || item.finished_at || '');
  if (!Number.isFinite(ts)) return false;
  return Date.now() - ts <= maxAgeHours * 3600 * 1000;
}


async function fetchHchanhForResearchRun(ctx, runDir, {
  sourceRows = [], sourceRunId = '', files = null, headless = true, force = false,
  fallbackDateFrom = '', fallbackDateTo = '', limit = 0,
  mode = 'hchanh_auto', saveRaw = false,
} = {}) {
  const normalizedMode = String(mode || '').trim() === 'order_history_auto' ? 'order_history_auto' : 'hchanh_auto';
  const wantedFiles = normalizedMode === 'order_history_auto' ? orderHistoryDefaultFiles(files) : hchanhDefaultFiles(files);
  const runLabel = normalizedMode === 'order_history_auto' ? orderHistoryRunLabel(wantedFiles) : 'hành chánh tự động';
  const progressFile = normalizedMode === 'order_history_auto' ? 'order_history_auto_progress.json' : 'hchanh_auto_progress.json';
  const rawFolder = normalizedMode === 'order_history_auto' ? 'order_history_auto_raw' : 'hchanh_auto_raw';
  const logPrefix = normalizedMode === 'order_history_auto' ? 'ORDER AUTO' : 'HC AUTO';

  const runPath = path.resolve(runDir);
  ensureDir(runPath);
  const progressPath = path.join(runPath, progressFile);
  const rawDir = path.join(runPath, rawFolder);
  ensureDir(rawDir);

  const rows = uniqueResearchHchanhRows(sourceRows, sourceRunId);
  const selectedRows = limit > 0 ? rows.slice(0, limit) : rows;
  let progress = readJsonSafe(progressPath, {}) || {};
  const failureCachePath = path.join(runPath, `${normalizedMode}_failure_cache.json`);
  let failureCache = readJsonSafe(failureCachePath, {}) || {};

  let profileRows = readCsvTable(path.join(runPath, 'hchanh_profile.csv'), Number.MAX_SAFE_INTEGER).rows;
  let dischargeRows = readCsvTable(path.join(runPath, 'hchanh_discharge.csv'), Number.MAX_SAFE_INTEGER).rows;
  let surgeryRows = readCsvTable(path.join(runPath, 'hchanh_surgery.csv'), Number.MAX_SAFE_INTEGER).rows;
  let orderRows = readCsvTable(path.join(runPath, 'hchanh_order_history.csv'), Number.MAX_SAFE_INTEGER).rows;

  const stats = { total: selectedRows.length, processed: 0, skipped: 0, ok: 0, attention: 0, error: 0, cancelled: false };
  appendResearchRunLog(runPath, `[${new Date().toLocaleString('vi-VN')}] Bắt đầu lấy ${runLabel}: ${selectedRows.length} ca | files=${wantedFiles.join(',')}`);

  for (let idx = 0; idx < selectedRows.length; idx += 1) {
    // Job hành chánh spawn một Python worker cho từng ca. Cờ huỷ phải được kiểm tra
    // ở cấp vòng lặp, nếu không kill ca hiện tại xong sẽ lập tức spawn ca kế tiếp.
    if (isCancelRequested(ctx.sid)) {
      stats.cancelled = true;
      appendResearchRunLog(runPath, `[${logPrefix}] ĐÃ DỪNG theo yêu cầu trước ca ${idx + 1}/${selectedRows.length}; không spawn worker mới.`);
      break;
    }

    const row = selectedRows[idx];
    const meta = researchHchanhMeta(row, sourceRunId);
    const key = meta.source_key;
    const display = `${idx + 1}/${selectedRows.length} ${meta.ma_bn} - ${meta.ho_ten || ''}`.trim();
    if (!force && progress[key]?.status === 'done') {
      stats.skipped += 1;
      continue;
    }

    const failKey = hchanhFailureCacheKey(meta, wantedFiles, 'Hoàn tất');
    const previousFailure = failureCache[failKey];
    if (!force && hchanhFailureCacheIsFresh(previousFailure) && ['no_patient_link', 'no_url'].includes(String(previousFailure.reason || ''))) {
      stats.skipped += 1;
      progress[key] = {
        ...(progress[key] || {}),
        ma_bn: meta.ma_bn, ho_ten: meta.ho_ten, research_code: meta.research_code,
        encounter_id: key, admission_date: meta.admission_raw || '', discharge_date: meta.discharge_raw || '',
        status: 'skipped_recent_failure',
        skipped_at: nowIso(),
        skipped_reason: previousFailure.reason,
        previous_failure_at: previousFailure.ts,
        files: wantedFiles,
      };
      writeJsonAtomic(progressPath, progress);
      appendResearchRunLog(runPath, `[${logPrefix}] BỎ QUA ${display}: đã fail gần đây cùng lý do (${previousFailure.reason}) lúc ${previousFailure.ts}`);
      appendResearchCaseTrace(runPath, {
        case_id: key, source_key: key, index: idx + 1, total: selectedRows.length, ma_bn: meta.ma_bn, ho_ten: meta.ho_ten, research_code: meta.research_code, date_from: meta.date_from || fallbackDateFrom || '', date_to: meta.date_to || fallbackDateTo || '', files: wantedFiles, mode: normalizedMode,
      }, [
        { ts: nowIso(), tag: 'CASE.START', step: 'Bắt đầu case nhưng phát hiện lỗi lặp gần đây', screen: 'server/routes/research.js', sees: display, takes: wantedFiles.join(','), writes: 'skip case', target: progressPath },
        { ts: nowIso(), tag: 'WARN', step: 'Bỏ qua do BN đã fail gần đây cùng lý do', screen: 'failure_cache', sees: `reason=${previousFailure.reason}; previous=${previousFailure.ts}`, takes: 'failure cache', writes: 'progress.status=skipped_recent_failure', target: failureCachePath },
      ], { mode: normalizedMode, status: 'skipped_recent_failure', files: wantedFiles, counts: {} });
      continue;
    }

    const inputPath = path.join(rawDir, `input_${String(idx + 1).padStart(4, '0')}_${safeFilePart(meta.ma_bn)}_${key}.json`);
    const outPath = path.join(rawDir, `output_${String(idx + 1).padStart(4, '0')}_${safeFilePart(meta.ma_bn)}_${key}.json`);
    const dateFrom = meta.date_from || fallbackDateFrom || '';
    const dateTo = meta.date_to || fallbackDateTo || dateFrom || '';
    const inputPayload = {
      ...row,
      ma_bn: meta.ma_bn,
      ho_ten: meta.ho_ten,
      research_code: meta.research_code,
      date_from: dateFrom,
      date_to: dateTo,
      inpatient_status: 'Hoàn tất',
      research_mode: true,
    };
    writeJsonAtomic(inputPath, inputPayload);
    appendResearchRunLog(runPath, `[${logPrefix}] [${display}] ${dateFrom || '—'} → ${dateTo || '—'} | ${wantedFiles.join(',')}`);

    progress[key] = { ...(progress[key] || {}), ma_bn: meta.ma_bn, ho_ten: meta.ho_ten, research_code: meta.research_code, encounter_id: key, admission_date: meta.admission_raw || '', discharge_date: meta.discharge_raw || '', status: 'running', started_at: nowIso(), files: wantedFiles };
    writeJsonAtomic(progressPath, progress);

    const args = ['--input', inputPath, '--out', outPath, '--scope', 'discharge', '--files', wantedFiles.join(',')];
    if (dateFrom) args.push('--from', dateFrom);
    if (dateTo) args.push('--to', dateTo);
    args.push('--status', 'Hoàn tất');
    if (headless) args.push('--headless');

    let result;
    try {
      result = await runScript('hchanh_fetch.py', args, {
        onSpawn: killFn => registerCancel(ctx.sid, killFn),
        runtimeDir: ctx.dir,
      });
    } finally {
      unregisterCancel(ctx.sid);
    }

    const cancelRequested = isCancelRequested(ctx.sid);
    stats.processed += 1;

    // Nếu worker bị kill vì người dùng bấm Dừng, đây không phải lỗi dữ liệu của BN.
    // Đưa ca đang dở về pending_refetch để lần sau chạy lại, rồi thoát hẳn vòng lặp.
    if (cancelRequested && (result.spawnError || result.killedByTimeout || result.code !== 0)) {
      stats.cancelled = true;
      progress[key] = {
        ...progress[key],
        status: 'pending_refetch',
        cancelled_at: nowIso(),
        error: '',
      };
      writeJsonAtomic(progressPath, progress);
      appendResearchRunLog(runPath, `[${logPrefix}] ĐÃ DỪNG ${display}: ca đang dở sẽ được lấy lại ở lần Cập nhật sau.`);
      break;
    }

    if (result.spawnError || result.killedByTimeout || result.code !== 0) {
      stats.error += 1;
      const message = result.spawnError || (result.killedByTimeout ? 'timeout' : fmtPyError('hchanh_fetch.py lỗi', result));
      progress[key] = { ...progress[key], status: 'error', finished_at: nowIso(), error: message };
      appendResearchRunLog(runPath, `[${logPrefix}] LỖI ${display}: ${String(message).split('\n')[0]}`);
      appendResearchCaseTrace(runPath, {
        case_id: key, source_key: key, index: idx + 1, total: selectedRows.length, ma_bn: meta.ma_bn, ho_ten: meta.ho_ten, research_code: meta.research_code, date_from: dateFrom, date_to: dateTo, files: wantedFiles, mode: normalizedMode,
      }, [
        { ts: nowIso(), tag: 'CASE.START', step: 'Bắt đầu xử lý case nhưng worker lỗi', screen: 'server/routes/research.js', sees: display, takes: wantedFiles.join(','), writes: 'progress error', target: progressPath },
        { ts: nowIso(), tag: 'ERROR', step: 'hchanh_fetch.py trả lỗi', screen: 'worker/hchanh_fetch.py', sees: String(message).split('\n')[0], takes: 'stderr/stdout', writes: 'progress.status=error', target: progressPath },
      ], { mode: normalizedMode, status: 'error', files: wantedFiles, counts: {} });
      writeJsonAtomic(progressPath, progress);
      continue;
    }

    const output = readJsonSafe(outPath, {}) || {};
    const workerTrace = Array.isArray(output?._case_trace) ? output._case_trace : [];
    // Không ghi lại dữ liệu Nghiên cứu vừa quét vào kho dùng chung của Hành
    // chánh: kho đó đóng dấu "fetched_at" bằng thời điểm ghi (bây giờ), trong
    // khi Nghiên cứu có thể đang xử lý một đợt nằm viện CŨ (không theo thứ tự
    // thời gian thực). Nếu ghi vào đây, Kiểm hồ sơ (đọc lại kho này và chỉ tin
    // dữ liệu có fetched_at mới hơn thời điểm ra viện của ca đang kiểm) có thể
    // bị đánh lừa nhận nhầm dữ liệu đợt cũ là dữ liệu đợt hiện tại — dữ liệu
    // Kiểm hồ sơ/Nghiên cứu phải luôn đúng nên không đánh đổi lấy việc tránh
    // quét lại ở đây.
    if (!saveRaw) {
      try { fs.rmSync(inputPath, { force: true }); } catch (_) {}
      try { fs.rmSync(outPath, { force: true }); } catch (_) {}
    }
    const flat = hchanhFetchOutputToRows(output, row, sourceRunId);
    profileRows = dedupeRowsByStableKey(removeResearchSourceKey(profileRows, key).concat(flat.profileRows), ['Research key', 'Mã BN', 'Ngày vào viện', 'Ngày ra viện']);
    dischargeRows = dedupeRowsByStableKey(removeResearchSourceKey(dischargeRows, key).concat(flat.dischargeRows), ['Research key', 'Mã BN', 'Ngày vào viện', 'Ngày ra viện', 'Chẩn đoán ra viện']);
    surgeryRows = dedupeRowsByStableKey(removeResearchSourceKey(surgeryRows, key).concat(flat.surgeryRows), ['Research key', 'Mã BN', 'Ngày phẫu thuật', 'Tên phẫu thuật', 'Phương pháp phẫu thuật']);
    orderRows = dedupeRowsByStableKey(removeResearchSourceKey(orderRows, key).concat(flat.orderRows), ['Research key', 'Mã BN', 'TG y lệnh', 'Tên y lệnh', 'Y lệnh khác']);

    writeCsvUnion(path.join(runPath, 'hchanh_profile.csv'), profileRows, ['Mã NC', 'Mã BN', 'Họ tên', 'Giới', 'Ngày sinh', 'Tuổi', 'Địa chỉ', 'Điện thoại', 'Số CMND', 'Đối tượng', 'Số thẻ', 'Ngày vào viện', 'Ngày ra viện', 'Chẩn đoán', 'Research key']);
    writeCsvUnion(path.join(runPath, 'hchanh_discharge.csv'), dischargeRows, ['Mã NC', 'Mã BN', 'Họ tên', 'Ngày vào viện', 'Ngày ra viện', 'Thời gian điều trị', 'Chẩn đoán', 'Chẩn đoán ra viện', 'Bệnh kèm', 'Biến chứng', 'Tai biến', 'Tình trạng ra', 'Research key']);
    writeCsvUnion(path.join(runPath, 'hchanh_surgery.csv'), surgeryRows, ['Mã NC', 'Mã BN', 'Họ tên', 'Ngày vào viện', 'Ngày ra viện', 'Ngày phẫu thuật', 'Tên phẫu thuật', 'Phương pháp phẫu thuật', 'PPVC', 'Phân loại PT', 'Trạng thái', 'Chẩn đoán trước mổ', 'Chẩn đoán sau mổ', 'Research key']);
    writeCsvUnion(path.join(runPath, 'hchanh_order_history.csv'), orderRows, ['Mã NC', 'Mã BN', 'Họ tên', 'TG y lệnh', 'Ngày', 'Bác sĩ', 'Diễn biến', 'Tên y lệnh', 'Y lệnh khác', 'KQ', 'Trạng thái', 'Research key']);

    const csvTraceEvents = [
      { ts: nowIso(), tag: 'OUTPUT.WRITE_CSV', step: 'Backend ghi bảng hchanh_profile.csv', screen: 'server/routes/research.js', sees: `profileRows=${flat.profileRows.length}; total=${profileRows.length}`, takes: 'output.profile', writes: 'hchanh_profile.csv', target: path.join(runPath, 'hchanh_profile.csv') },
      { ts: nowIso(), tag: 'OUTPUT.WRITE_CSV', step: 'Backend ghi bảng hchanh_discharge.csv', screen: 'server/routes/research.js', sees: `dischargeRows=${flat.dischargeRows.length}; total=${dischargeRows.length}`, takes: 'output.discharge', writes: 'hchanh_discharge.csv', target: path.join(runPath, 'hchanh_discharge.csv') },
      { ts: nowIso(), tag: 'OUTPUT.WRITE_CSV', step: 'Backend ghi bảng hchanh_surgery.csv', screen: 'server/routes/research.js', sees: `surgeryRows=${flat.surgeryRows.length}; total=${surgeryRows.length}`, takes: 'output.surgery.surgeries', writes: 'hchanh_surgery.csv', target: path.join(runPath, 'hchanh_surgery.csv') },
      { ts: nowIso(), tag: 'OUTPUT.WRITE_CSV', step: 'Backend ghi bảng hchanh_order_history.csv', screen: 'server/routes/research.js', sees: `orderRows=${flat.orderRows.length}; total=${orderRows.length}`, takes: 'output.order_history.rows', writes: 'hchanh_order_history.csv', target: path.join(runPath, 'hchanh_order_history.csv') },
    ];

    const sc = statusCountsFromHchanhOutput(output);
    const failureSignature = hchanhFailureSignatureFromTrace(workerTrace, output);
    if (sc.error && failureSignature) {
      failureCache[failKey] = {
        ts: nowIso(), reason: failureSignature, ma_bn: meta.ma_bn, ho_ten: meta.ho_ten, files: wantedFiles, source_key: key,
        rows: { profile: flat.profileRows.length, discharge: flat.dischargeRows.length, surgery: flat.surgeryRows.length, order_history: flat.orderRows.length },
      };
      writeJsonAtomic(failureCachePath, failureCache);
    } else if (!sc.error && failureCache[failKey]) {
      delete failureCache[failKey];
      writeJsonAtomic(failureCachePath, failureCache);
    }
    if (sc.error) stats.error += 1;
    else if (sc.attention) stats.attention += 1;
    else stats.ok += 1;
    progress[key] = {
      ...progress[key], status: sc.error ? 'error' : (sc.attention ? 'partial' : 'done'),
      finished_at: nowIso(), output: path.basename(outPath), counts: sc,
      rows: { profile: flat.profileRows.length, discharge: flat.dischargeRows.length, surgery: flat.surgeryRows.length, order_history: flat.orderRows.length },
    };
    writeJsonAtomic(progressPath, progress);
    const savedTrace = appendResearchCaseTrace(runPath, {
      case_id: key,
      source_key: key,
      index: idx + 1,
      total: selectedRows.length,
      ma_bn: meta.ma_bn,
      ho_ten: meta.ho_ten,
      research_code: meta.research_code,
      date_from: dateFrom,
      date_to: dateTo,
      files: wantedFiles,
      mode: normalizedMode,
    }, workerTrace.concat(csvTraceEvents), {
      mode: normalizedMode,
      status: progress[key].status,
      files: wantedFiles,
      counts: { profile: flat.profileRows.length, discharge: flat.dischargeRows.length, surgery: flat.surgeryRows.length, order_history: flat.orderRows.length },
      output: saveRaw ? outPath : path.basename(outPath),
    });
    appendResearchRunLog(runPath, `[TRACE][CASE.END] ${display}: ghi case trace ${savedTrace?.events?.length || 0} bước vào ${CASE_TRACE_RECENT_JSON}`);
    appendResearchRunLog(runPath, `[${logPrefix}] Xong ${display}: status=${progress[key].status} | profile=${flat.profileRows.length}, discharge=${flat.dischargeRows.length}, surgery=${flat.surgeryRows.length}, order=${flat.orderRows.length}`);

    // Trường hợp người dùng bấm Dừng đúng lúc worker vừa hoàn tất: giữ kết quả ca vừa xong
    // nhưng tuyệt đối không chuyển sang ca tiếp theo.
    if (cancelRequested) {
      stats.cancelled = true;
      appendResearchRunLog(runPath, `[${logPrefix}] ĐÃ DỪNG sau ${display}; kết quả ca vừa hoàn tất đã được giữ.`);
      break;
    }
  }

  appendResearchRunLog(runPath, `[${new Date().toLocaleString('vi-VN')}] ${stats.cancelled ? 'Đã dừng' : 'Kết thúc'} lấy ${runLabel}: ok=${stats.ok}, partial=${stats.attention}, error=${stats.error}, skipped=${stats.skipped}`);
  const manifestPath = path.join(runPath, 'manifest.json');
  const manifest = readJsonSafe(manifestPath, {}) || {};
  writeJsonAtomic(manifestPath, {
    ...manifest,
    ...(normalizedMode === 'order_history_auto'
      ? { order_history_auto_at: nowIso(), order_history_auto_files: wantedFiles, order_history_auto_stats: stats }
      : { hchanh_auto_at: nowIso(), hchanh_auto_files: wantedFiles, hchanh_auto_stats: stats }),
  });
  return { ...stats, files: wantedFiles, progress_path: progressPath };
}

function inferInjurySide(...texts) {
  const s = normalizeSimple(texts.filter(Boolean).join(' '));
  const hasLeft = /\btrai\b|ben trai|hang trai|dui trai/.test(s);
  const hasRight = /\bphai\b|ben phai|hang phai|dui phai/.test(s);
  if (hasLeft && hasRight) return 'Hai bên/không rõ';
  if (hasLeft) return 'Trái';
  if (hasRight) return 'Phải';
  return '';
}

function inferHipFracture(...texts) {
  const s = normalizeSimple(texts.filter(Boolean).join(' '));
  return /(gay|fracture).*(co xuong dui|lien mau chuyen|duoi mau chuyen|dau tren xuong dui|vung hang|khop hang|femur|hip)|s72/.test(s) ? '1' : '';
}

// ── Analysis config presets theo chuyên khoa ──────────────────────────────────
// Mỗi preset định nghĩa: inference_fields (các cột tự động suy luận từ text)
// và needs_review_checks (các điều kiện dùng để tạo cột needs_manual_review).
// Khi tạo nghiên cứu mới, user chọn preset; config lưu vào study.json.
// normalizeRunOutputs đọc config này để sinh analysis_ready phù hợp.

const ANALYSIS_PRESETS = {
  ortho_fracture: {
    label: 'Chấn thương chỉnh hình — Gãy xương',
    inference_fields: [
      { key: 'injury_side_suggested',  label: 'Bên tổn thương',   fn: 'inferInjurySide' },
      { key: 'hip_fracture_suggested', label: 'Gãy vùng háng',    fn: 'inferHipFracture' },
      { key: 'spine_involved',         label: 'Cột sống',         fn: 'inferSpineInvolved' },
    ],
    needs_review_checks: [
      { field: 'injury_side_suggested',  empty_label: 'bên tổn thương' },
      { field: 'hip_fracture_suggested', empty_label: 'gãy vùng háng' },
      { field: 'surgery_date',           empty_label: 'ngày phẫu thuật' },
    ],
  },
  ortho_joint: {
    label: 'Chấn thương chỉnh hình — Khớp / Thay khớp',
    inference_fields: [
      { key: 'injury_side_suggested', label: 'Bên tổn thương', fn: 'inferInjurySide' },
      { key: 'joint_type_suggested',  label: 'Loại khớp',      fn: 'inferJointType' },
    ],
    needs_review_checks: [
      { field: 'injury_side_suggested', empty_label: 'bên tổn thương' },
      { field: 'joint_type_suggested',  empty_label: 'loại khớp' },
      { field: 'surgery_date',          empty_label: 'ngày phẫu thuật' },
    ],
  },
  neuro_spine: {
    label: 'Thần kinh — Cột sống / Tủy sống',
    inference_fields: [
      { key: 'injury_side_suggested', label: 'Bên tổn thương', fn: 'inferInjurySide' },
      { key: 'spine_involved',        label: 'Cột sống',       fn: 'inferSpineInvolved' },
      { key: 'neuro_deficit',         label: 'Thiếu hụt thần kinh', fn: 'inferNeuroDeficit' },
    ],
    needs_review_checks: [
      { field: 'spine_involved',  empty_label: 'vị trí cột sống' },
      { field: 'neuro_deficit',   empty_label: 'thiếu hụt thần kinh' },
      { field: 'surgery_date',    empty_label: 'ngày phẫu thuật' },
    ],
  },
  neuro_brain: {
    label: 'Thần kinh — Sọ não / Đột quỵ',
    inference_fields: [
      { key: 'injury_side_suggested', label: 'Bên tổn thương', fn: 'inferInjurySide' },
      { key: 'stroke_type',           label: 'Loại đột quỵ',   fn: 'inferStrokeType' },
      { key: 'neuro_deficit',         label: 'Thiếu hụt thần kinh', fn: 'inferNeuroDeficit' },
    ],
    needs_review_checks: [
      { field: 'stroke_type',   empty_label: 'loại đột quỵ' },
      { field: 'neuro_deficit', empty_label: 'thiếu hụt thần kinh' },
    ],
  },
  general: {
    label: 'Tổng quát (không inference)',
    inference_fields: [],
    needs_review_checks: [],
  },
};

function customFieldValidationOptions(presetId = 'general') {
  const reservedColumns = [...new Set(Object.values(NORMALIZED_COLUMNS).flat())];
  const inferenceFields = Object.values(ANALYSIS_PRESETS)
    .flatMap(item => (item?.inference_fields || []).map(field => field.key));
  const selectedPreset = ANALYSIS_PRESETS[presetId] || ANALYSIS_PRESETS.general;
  return {
    reservedColumns,
    inferenceFields: [...new Set([
      ...inferenceFields,
      ...(selectedPreset?.inference_fields || []).map(field => field.key),
    ])],
  };
}

function cleanCustomFields(rawFields, presetId = 'general', strict = true) {
  return sanitizeCustomFields(rawFields, {
    ...customFieldValidationOptions(presetId),
    strict,
  });
}

// Các hàm inference theo preset
function _runInference(fnName, diagnosisText) {
  switch (fnName) {
    case 'inferInjurySide':     return inferInjurySide(diagnosisText);
    case 'inferHipFracture':    return inferHipFracture(diagnosisText);
    case 'inferSpineInvolved': {
      const s = normalizeSimple(diagnosisText);
      // Chỉ đánh dấu cột sống khi có từ khóa đặc hiệu
      // KHÔNG dùng 'nguc'/'co lung' đơn độc (xuất hiện trong X-quang ngực thông thường)
      return /(cot song|doi song|dot song|that lung|dau lung|co lung cot song|tuy song|thoat vi dia dem|hep ong song|truot dot song|viem cot song|gap khuc cot song|gay cot song|gay doi|lumbar|cervical|thoracic spine|spinal|vertebr|than kinh toa|radiculopathy|myelopathy)/.test(s) ? '1' : '';
    }
    case 'inferJointType': {
      const s = normalizeSimple(diagnosisText);
      if (/(khop goi|knee|goi)/.test(s)) return 'Gối';
      if (/(khop hang|hip|hang)/.test(s)) return 'Háng';
      if (/(khop vai|shoulder|vai)/.test(s)) return 'Vai';
      if (/(khop khuy|elbow|khuy tay)/.test(s)) return 'Khuỷu';
      if (/(khop co chan|ankle|co chan)/.test(s)) return 'Cổ chân';
      if (/(khop co tay|wrist|co tay)/.test(s)) return 'Cổ tay';
      return '';
    }
    case 'inferStrokeType': {
      const s = normalizeSimple(diagnosisText);
      if (/(xuat huyet|hemorrhage|chay mau|xhnn|xhmc|xhdn)/.test(s)) return 'Xuất huyết';
      if (/(nhet mach|infarct|thieu mau cuc bo|nhoi mau|nhoi mau nao)/.test(s)) return 'Nhồi máu';
      if (/(thoang qua|tia|tia stroke|thoang thieu mau)/.test(s)) return 'TIA';
      return '';
    }
    case 'inferNeuroDeficit': {
      const s = normalizeSimple(diagnosisText);
      if (/(liet nua nguoi|hemiplegia|hemiparesis|liet chi|paraplegia|tu chi)/.test(s)) return 'Liệt vận động';
      if (/(roi loan ngon ngu|aphasia|kho noi|noi kho)/.test(s)) return 'Ngôn ngữ';
      if (/(roi loan y thuc|mat y thuc|hom me|lom)/.test(s)) return 'Ý thức';
      return '';
    }
    default: return '';
  }
}

// Đọc analysis_config từ study.json; fallback về general để tránh bias theo chuyên khoa.
function loadAnalysisConfig(runDir) {
  // Tìm study.json ngược từ runDir: runs/<runId>/ -> study root -> study.json
  try {
    const studyRoot = path.dirname(path.dirname(path.resolve(runDir)));
    const studyMeta = readJsonSafe(path.join(studyRoot, 'study.json'), {});
    if (studyMeta?.analysis_config) {
      const preset = ANALYSIS_PRESETS[studyMeta.analysis_config.preset] ? studyMeta.analysis_config.preset : 'general';
      return {
        ...studyMeta.analysis_config,
        preset,
        // Nghiên cứu cũ có thể chứa tên cột/pattern không còn an toàn. Khi đọc để
        // normalize thì bỏ qua field lỗi thay vì để nó ghi đè cột hệ thống.
        custom_fields: cleanCustomFields(studyMeta.analysis_config.custom_fields, preset, false),
      };
    }
  } catch (_) {}
  // Fallback: backward compat với kho gốc và nghiên cứu cũ
  return { preset: 'general', custom_fields: [] };
}

function hoursBetween(start, end) {
  const a = parseAnyDate(start);
  const b = parseAnyDate(end);
  if (!a || !b) return '';
  const diff = (b.getTime() - a.getTime()) / 3600000;
  return Number.isFinite(diff) ? String(Math.round(diff * 10) / 10) : '';
}


const NORMALIZE_INPUT_FILES = [
  'research_source.csv',
  'du_lieu_ban_dau.csv',
  'mau_nghien_cuu.csv',
  'du_lieu_goc.csv',
  'thong_tin_benh_nhan_bo_sung.csv',
  'hchanh_profile.csv',
  'hchanh_discharge.csv',
  'hchanh_surgery.csv',
  'hchanh_order_history.csv',
  'lich_su_xn.csv',
  'lich_su_cdha.csv',
  'progress.json',
  'hchanh_auto_progress.json',
  'order_history_auto_progress.json',
];

const NORMALIZE_OUTPUT_FILES = [
  'patients.csv',
  'encounters.csv',
  'diagnoses.csv',
  'lab_results.csv',
  'imaging_results.csv',
  'surgery_results.csv',
  'medication_orders.csv',
  'medication_day_summary.csv',
  'clinical_notes.csv',
  'patient_day.csv',
  'analysis_ready.csv',
  'extract_status.csv',
];

function normalizeInputSignature(runDir) {
  const dir = path.resolve(runDir);
  const files = [];
  for (const name of NORMALIZE_INPUT_FILES) {
    const file = path.join(dir, name);
    try {
      const st = fs.statSync(file);
      files.push({ name, size: st.size, mtimeMs: Math.floor(st.mtimeMs) });
    } catch (_) {
      files.push({ name, missing: true });
    }
  }
  // analysis_config/variable_selection nằm trong study.json, không phải CSV input.
  // Đưa vào signature để bấm Chuẩn hóa sau khi đổi biến sẽ luôn sinh lại dataset.
  try {
    files.push({ name: 'analysis_config', hash: stableHash(loadAnalysisConfig(dir) || {}) });
  } catch (_) {
    files.push({ name: 'analysis_config', missing: true });
  }
  return stableHash(files);
}

function normalizedOutputsAvailable(runDir) {
  const dir = path.resolve(runDir);
  const config = loadAnalysisConfig(dir);
  const required = [...NORMALIZE_OUTPUT_FILES];
  if (variableSelection.hasActiveSelection(config?.variable_selection)) required.push('analysis_selected.csv');
  return required.every(name => {
    try { return fs.statSync(path.join(dir, name)).isFile(); }
    catch (_) { return false; }
  });
}

function normalizeRunOutputs(runDir, { sourceRunId = '', force = false } = {}) {
  const dir = path.resolve(runDir);
  ensureDir(dir);
  const runId = sourceRunId || path.basename(dir);
  const manifestPath = path.join(dir, 'manifest.json');
  const manifestBefore = readJsonSafe(manifestPath, {}) || {};
  // Đồng bộ nguồn chuẩn trước khi tính signature/cache. Nếu Bước 1 vừa cập nhật
  // du_lieu_ban_dau.csv thì research_source.csv cũ không được phép giữ nguyên.
  const sourceInfo = ensureResearchSourceRows(dir, { sourceRunId: runId });
  let inputSignature = normalizeInputSignature(dir);
  if (!force
    && Number(manifestBefore.normalized_schema_version || 0) === NORMALIZED_SCHEMA_VERSION
    && manifestBefore.normalized_input_signature === inputSignature
    && normalizedOutputsAvailable(dir)
    && manifestBefore.normalized_outputs) {
    let database = null;
    try {
      database = syncDatabaseForRun(dir, { runId, inputSignature, force: false });
    } catch (err) {
      console.warn('[RESEARCH][SQLITE] Không đồng bộ được SQLite cache:', err.message);
    }
    return {
      ...manifestBefore.normalized_outputs,
      cached: true,
      input_signature: inputSignature,
      database: database ? publicDatabaseInfo(database) : publicDatabaseInfo(databaseInfo(datasetDirFromRunDir(dir))),
    };
  }

  // Đọc analysis config từ study.json của nghiên cứu này
  const analysisConfig = loadAnalysisConfig(dir);
  const preset = ANALYSIS_PRESETS[analysisConfig.preset] || ANALYSIS_PRESETS.general;
  const customFields = Array.isArray(analysisConfig.custom_fields) ? analysisConfig.custom_fields : [];

  const sourceTable = readCsvTable(path.join(dir, 'research_source.csv'), Number.MAX_SAFE_INTEGER);
  const patientTable = readCsvTable(path.join(dir, 'mau_nghien_cuu.csv'), Number.MAX_SAFE_INTEGER);
  const deepTable = readCsvTable(path.join(dir, 'du_lieu_goc.csv'), Number.MAX_SAFE_INTEGER);
  const initialTable = readCsvTable(path.join(dir, 'du_lieu_ban_dau.csv'), Number.MAX_SAFE_INTEGER);
  const extraTable = readCsvTable(path.join(dir, 'thong_tin_benh_nhan_bo_sung.csv'), Number.MAX_SAFE_INTEGER);
  const hchanhProfileTable = readCsvTable(path.join(dir, 'hchanh_profile.csv'), Number.MAX_SAFE_INTEGER);
  const hchanhDischargeTable = readCsvTable(path.join(dir, 'hchanh_discharge.csv'), Number.MAX_SAFE_INTEGER);
  const hchanhSurgeryTable = readCsvTable(path.join(dir, 'hchanh_surgery.csv'), Number.MAX_SAFE_INTEGER);
  const hchanhOrderTable = readCsvTable(path.join(dir, 'hchanh_order_history.csv'), Number.MAX_SAFE_INTEGER);

  const encounterSourceRows = combineEncounterSources({
    initialRows: sourceTable.rows.length ? sourceTable.rows : initialTable.rows,
    patientRows: patientTable.rows,
    deepRows: deepTable.rows,
    hchanhProfileRows: hchanhProfileTable.rows,
    hchanhDischargeRows: hchanhDischargeTable.rows,
    sourceRunId: runId,
  });
  const patientsRaw = encounterSourceRows.length ? encounterSourceRows : (patientTable.rows.length ? patientTable.rows : initialTable.rows);

  const ctxMap = buildContextMap(patientsRaw, runId);
  const demographicByPatient = new Map();
  const extraByEncounter = new Map();
  function mergeExtra(row, includePatientDemographics = false) {
    const code = patientCode(row);
    if (!code) return;
    if (includePatientDemographics) {
      demographicByPatient.set(code, mergeRowsPreferFilled(demographicByPatient.get(code) || {}, row));
    }
    const ctx = contextForRow(ctxMap, row, code);
    if (ctx.encounter_id) {
      extraByEncounter.set(ctx.encounter_id, mergeRowsPreferFilled(extraByEncounter.get(ctx.encounter_id) || {}, row));
    }
  }
  for (const row of extraTable.rows || []) mergeExtra(row, true);
  for (const row of hchanhProfileTable.rows || []) mergeExtra(row, true);
  for (const row of hchanhDischargeTable.rows || []) mergeExtra(row, false);
  function extraForContext(code, ctx) {
    return mergeRowsPreferFilled(demographicByPatient.get(code) || {}, extraByEncounter.get(ctx?.encounter_id) || {});
  }

  const encounterRows = patientsRaw.filter(row => patientCode(row));
  const encounterById = new Map();
  const encounters = [];
  for (const row of encounterRows) {
    const code = patientCode(row);
    const ctx = contextForRow(ctxMap, row, code);
    const extra = extraForContext(code, ctx);
    const admissionDiagnosis = ctx.admission_diagnosis || firstNonEmpty(extra, ['Chẩn đoán vào viện', 'Chan doan vao vien']) || ctx.diagnosis_raw || firstNonEmpty(row, ['Chẩn đoán', 'Chan doan']);
    const dischargeDiagnosis = firstNonEmpty(row, ['Chẩn đoán ra viện', 'Chan doan ra vien']) || firstNonEmpty(extra, ['Chẩn đoán ra viện', 'Chan doan ra vien']) || '';
    const out = {
      encounter_id: ctx.encounter_id || buildEncounterId(row, runId),
      research_code: ctx.research_code || firstNonEmpty(row, ['Mã NC', 'Ma NC', 'research_code']) || '',
      patient_code: code,
      admission_date: ctx.admission_date || isoDateTime(firstNonEmpty(extra, ['Ngày vào viện', 'Ngay vao vien', 'ngay_vao_vien', 'ngay_vao'])) || '',
      discharge_date: ctx.discharge_date || isoDateTime(firstNonEmpty(extra, ['Ngày ra viện', 'Ngay ra vien', 'Ngày xuất viện', 'Ngay xuat vien', 'ngay_ra_vien', 'ngay_ra'])) || '',
      treatment_duration: ctx.treatment_duration || firstNonEmpty(extra, ['Thời gian điều trị', 'Thoi gian dieu tri', 'so_ngay_dieu_tri']) || '',
      department: ctx.department || '',
      room_bed: ctx.room_bed || firstNonEmpty(extra, ['Phòng/Giường', 'Phong/Giuong', 'Phòng', 'Phong']) || '',
      admission_diagnosis: admissionDiagnosis,
      discharge_diagnosis: dischargeDiagnosis,
      diagnosis_raw: dischargeDiagnosis || admissionDiagnosis || ctx.diagnosis_raw || '',
      comorbidity_text: firstNonEmpty(row, ['Bệnh kèm', 'Benh kem', 'Bệnh nền', 'Benh nen']) || firstNonEmpty(extra, ['Bệnh kèm', 'Benh kem', 'Bệnh nền', 'Benh nen']) || '',
      complication_text: firstNonEmpty(row, ['Biến chứng', 'Bien chung', 'Tai biến', 'Tai bien']) || firstNonEmpty(extra, ['Biến chứng', 'Bien chung', 'Tai biến', 'Tai bien']) || '',
      discharge_status: firstNonEmpty(row, ['Tình trạng ra', 'Tinh trang ra', 'Kết quả', 'Ket qua']) || firstNonEmpty(extra, ['Tình trạng ra', 'Tinh trang ra', 'Kết quả', 'Ket qua']) || '',
      surgery_date: ctx.surgery_date || isoDate(firstNonEmpty(row, ['Ngày mổ', 'Ngay mo', 'Ngày phẫu thuật', 'Ngay phau thuat'])) || '',
      emr_admission_id: ctx.emr_admission_id || rowEmrAdmissionId(row) || '',
      emr_treatment_id: ctx.emr_treatment_id || rowEmrTreatmentId(row) || '',
      emr_noitru_id: ctx.emr_noitru_id || rowNoitruId(row) || '',
      needs_manual_review: [ctx.needs_manual_review, firstNonEmpty(row, ['__needs_manual_review', 'needs_manual_review'])]
        .filter(Boolean).join('; '),
      source_run_id: runId,
      source_status: row.__source_status || '',
    };
    out.row_hash = stableHash(out);
    if (!encounterById.has(out.encounter_id)) {
      encounterById.set(out.encounter_id, out);
      encounters.push(out);
    } else {
      const merged = mergeRowsPreferFilled(encounterById.get(out.encounter_id), out);
      merged.row_hash = stableHash(merged);
      encounterById.set(out.encounter_id, merged);
    }
  }
  const finalEncounters = Array.from(encounterById.values());

  const patientByCode = new Map();
  for (const row of encounterRows) {
    const code = patientCode(row);
    if (!code) continue;
    const ctx = contextForRow(ctxMap, row, code);
    const extra = extraForContext(code, ctx);
    const base = patientByCode.get(code) || {
      patient_code: code,
      patient_name: '', sex: '', birth_date: '', age: '', birth_year: '',
      address: '', phone_number: '', citizen_id: '', insurance_subject: '', insurance_card: '', insurance_type: '',
      insurance_valid_from: '', insurance_valid_to: '', first_research_code: '', encounter_count: 0,
      source_input: '', source_run_id: runId,
    };
    const candidate = {
      patient_code: code,
      patient_name: ctx.patient_name || firstNonEmpty(extra, ['Họ tên', 'Ho ten']) || '',
      sex: normalizeSex(ctx.sex || firstNonEmpty(extra, ['Giới', 'Gioi', 'GT', 'sex'])),
      birth_date: ctx.birth_date || isoDate(firstNonEmpty(extra, ['Ngày sinh', 'Ngay sinh', 'birth_date'])) || '',
      age: ctx.age || firstNonEmpty(extra, ['Tuổi', 'Tuoi', 'age']) || '',
      birth_year: extractBirthYear(ctx.birth_date || ctx.age || firstNonEmpty(extra, ['Năm sinh', 'Nam sinh', 'Ngày sinh', 'Ngay sinh']) || ctx.patient_name || ''),
      address: ctx.address || firstNonEmpty(extra, ['Địa chỉ', 'Dia chi', 'address']) || '',
      phone_number: ctx.phone_number || firstNonEmpty(extra, ['Điện thoại', 'Dien thoai', 'SĐT', 'SDT', 'Số điện thoại', 'So dien thoai', 'phone', 'phone_number']) || '',
      citizen_id: ctx.citizen_id || firstNonEmpty(extra, ['Số CMND', 'So CMND', 'Số CMT', 'So CMT', 'CMND', 'CMT', 'CCCD', 'citizen_id']) || '',
      insurance_subject: ctx.insurance_subject || firstNonEmpty(extra, ['Đối tượng', 'Doi tuong']) || '',
      insurance_card: ctx.insurance_card || firstNonEmpty(extra, ['Số thẻ BHYT', 'So the BHYT', 'Số thẻ', 'So the', 'insurance_card']) || '',
      insurance_type: ctx.insurance_type || firstNonEmpty(extra, ['Loại', 'Loai', 'Loại BHYT', 'Loai BHYT']) || '',
      insurance_valid_from: ctx.insurance_valid_from || isoDate(firstNonEmpty(extra, ['Giá trị từ', 'Gia tri tu', 'Từ ngày', 'Tu ngay'])) || '',
      insurance_valid_to: ctx.insurance_valid_to || isoDate(firstNonEmpty(extra, ['Giá trị đến', 'Gia tri den', 'Đến ngày', 'Den ngay'])) || '',
      first_research_code: base.first_research_code || ctx.research_code || '',
      source_input: ctx.source_input || firstNonEmpty(extra, ['Nguồn input', 'Nguon input']) || '',
      source_run_id: runId,
    };
    const merged = mergeRowsPreferFilled(base, candidate);
    merged.encounter_count = (Number(base.encounter_count) || 0) + 1;
    patientByCode.set(code, merged);
  }
  const encounterCountByCode = new Map();
  for (const enc of finalEncounters) {
    encounterCountByCode.set(enc.patient_code, (encounterCountByCode.get(enc.patient_code) || 0) + 1);
  }
  for (const [code, row] of patientByCode.entries()) {
    row.encounter_count = encounterCountByCode.get(code) || 0;
    row.row_hash = stableHash(row);
    patientByCode.set(code, row);
  }
  const patients = Array.from(patientByCode.values()).sort((a, b) => String(a.patient_code).localeCompare(String(b.patient_code)));

  const labRaw = readCsvTable(path.join(dir, 'lich_su_xn.csv'), Number.MAX_SAFE_INTEGER).rows;
  const labResults = labRaw.map((row, idx) => {
    const code = patientCode(row);
    const ctx = contextForRow(ctxMap, row, code);
    const rawTime = firstNonEmpty(row, ['TG xét nghiệm', 'Thời gian xét nghiệm', 'TG chỉ định', 'Thời gian', 'Ngày xét nghiệm', 'Ngày chỉ định']);
    const name = firstNonEmpty(row, ['Chỉ số', 'Chi so', 'Tên xét nghiệm', 'Ten xet nghiem']);
    const result = firstNonEmpty(row, ['Kết quả', 'Ket qua', 'result']);
    const base = {
      research_code: firstNonEmpty(row, ['Mã NC', 'Ma NC']) || ctx.research_code || '',
      patient_code: code,
      encounter_id: ctx.encounter_id || '',
      encounter_match_status: encounterMatchStatus(ctx),
      lab_datetime: isoDateTime(rawTime),
      lab_date: isoDate(firstNonEmpty(row, ['Ngày xét nghiệm', 'Ngày chỉ định'])) || isoDate(rawTime),
      lab_group: firstNonEmpty(row, ['Loại XN', 'Loai XN', 'Nhóm XN']),
      test_name_raw: name,
      test_name_norm: normalizeLabName(name),
      result_raw: result,
      result_operator: resultOperator(result),
      result_num: parseNumeric(result),
      result_text: resultText(result),
      unit: firstNonEmpty(row, ['Đơn vị', 'Don vi', 'unit']),
      ref_range_raw: firstNonEmpty(row, ['Khoảng tham chiếu', 'Khoang tham chieu', 'ref_range']),
      flag_raw: firstNonEmpty(row, ['Bất thường', 'Bat thuong', 'flag']),
      flag_norm: normalizeFlag(firstNonEmpty(row, ['Bất thường', 'Bat thuong', 'flag'])),
      ...eventTemporalFields(ctx, rawTime),
      source_run_id: runId,
    };
    base.row_hash = stableHash(base);
    base.lab_result_id = `lab_${base.row_hash || stableHash([idx, base.patient_code])}`;
    return base;
  });

  const imagingRaw = readCsvTable(path.join(dir, 'lich_su_cdha.csv'), Number.MAX_SAFE_INTEGER).rows;
  const imagingResults = imagingRaw.map((row, idx) => {
    const code = patientCode(row);
    const ctx = contextForRow(ctxMap, row, code);
    const rawTime = firstNonEmpty(row, ['TG chỉ định', 'TG chi dinh', 'Thời gian', 'Ngày chỉ định']);
    const service = firstNonEmpty(row, ['Tên dịch vụ', 'Ten dich vu', 'Dịch vụ', 'Dich vu']);
    const base = {
      research_code: firstNonEmpty(row, ['Mã NC', 'Ma NC']) || ctx.research_code || '',
      patient_code: code,
      encounter_id: ctx.encounter_id || '',
      encounter_match_status: encounterMatchStatus(ctx),
      ordered_at: isoDateTime(rawTime),
      order_date: isoDate(firstNonEmpty(row, ['Ngày chỉ định', 'Ngay chi dinh'])) || isoDate(rawTime),
      service_name_raw: service,
      modality: firstNonEmpty(row, ['Nhóm dịch vụ', 'Nhom dich vu']) || modalityFromService(service),
      body_region: bodyRegionFromService(service),
      result_text: firstNonEmpty(row, ['Mô tả/Kết quả', 'Mo ta/Ket qua', 'Kết quả', 'Ket qua']),
      conclusion_text: firstNonEmpty(row, ['Kết luận', 'Ket luan']),
      status: firstNonEmpty(row, ['Trạng thái', 'Trang thai']),
      ...eventTemporalFields(ctx, rawTime),
      source_run_id: runId,
    };
    base.row_hash = stableHash(base);
    base.imaging_id = `img_${base.row_hash || stableHash([idx, base.patient_code])}`;
    return base;
  });

  const diagnosisRows = [];
  for (const enc of finalEncounters) {
    const items = [
      ['admission', enc.admission_diagnosis, ''],
      ['discharge', enc.discharge_diagnosis, ''],
      ['comorbidity', enc.comorbidity_text, ''],
      ['complication', enc.complication_text, ''],
    ];
    for (const [type, text, icd] of items) {
      if (!String(text || '').trim()) continue;
      const row = {
        research_code: enc.research_code,
        patient_code: enc.patient_code,
        encounter_id: enc.encounter_id,
        diagnosis_date: type === 'discharge' ? isoDate(enc.discharge_date) : isoDate(enc.admission_date),
        diagnosis_type: type,
        icd_code: icd || (String(text).match(/\b([A-Z]\d{2}(?:\.\d+)?)\b/)?.[1] || ''),
        diagnosis_text: text,
        source: 'encounter',
        source_run_id: runId,
      };
      row.row_hash = stableHash(row);
      row.diagnosis_id = `dx_${row.row_hash}`;
      diagnosisRows.push(row);
    }
  }
  const diagnoses = dedupeByHash(diagnosisRows);

  const surgeryRaw = [
    ...hchanhSurgeryTable.rows,
    ...readCsvTable(path.join(dir, 'lich_su_phau_thuat.csv'), Number.MAX_SAFE_INTEGER).rows,
    ...readCsvTable(path.join(dir, 'phau_thuat.csv'), Number.MAX_SAFE_INTEGER).rows,
  ];
  let surgeryResults = surgeryRaw.map((row, idx) => {
    const code = patientCode(row);
    const ctx = contextForRow(ctxMap, row, code);
    const dt = firstNonEmpty(row, ['Ngày phẫu thuật', 'Ngay phau thuat', 'Thời gian', 'Thoi gian', 'bat_dau', 'surgery_datetime', 'surgery_date']);
    const base = {
      research_code: firstNonEmpty(row, ['Mã NC', 'Ma NC', 'research_code']) || ctx.research_code || '',
      patient_code: code,
      encounter_id: ctx.encounter_id || '',
      encounter_match_status: encounterMatchStatus(ctx),
      surgery_datetime: isoDateTime(dt),
      surgery_date: isoDate(dt),
      surgery_name: firstNonEmpty(row, ['Tên phẫu thuật', 'Ten phau thuat', 'Dịch vụ phẫu thuật', 'Dich vu phau thuat', 'dich_vu_phau_thuat', 'noi_dung_phau_thuat']),
      surgery_method: firstNonEmpty(row, ['Phương pháp phẫu thuật', 'Phuong phap phau thuat', 'phuong_phap_pt', 'PPPT']),
      anesthesia_method: firstNonEmpty(row, ['PPVC', 'Phương pháp vô cảm', 'Phuong phap vo cam', 'pp_vo_cam']),
      surgery_class: firstNonEmpty(row, ['Phân loại PT', 'Phan loai PT', 'phan_loai_pt']),
      status: firstNonEmpty(row, ['Trạng thái', 'Trang thai', 'status']),
      preop_diagnosis: firstNonEmpty(row, ['Chẩn đoán trước mổ', 'Chan doan truoc mo', 'chan_doan_truoc_mo']),
      postop_diagnosis: firstNonEmpty(row, ['Chẩn đoán sau mổ', 'Chan doan sau mo', 'chan_doan_sau_mo']),
      operating_room: firstNonEmpty(row, ['Phòng mổ', 'Phong mo', 'phong_mo']),
      ...eventTemporalFields(ctx, dt),
      source: firstNonEmpty(row, ['Nguồn', 'source']) || 'surgery_raw',
      source_run_id: runId,
    };
    base.row_hash = stableHash(base);
    base.surgery_id = `surg_${base.row_hash || stableHash([idx, base.patient_code])}`;
    return base;
  }).filter(r => r.patient_code && (r.surgery_date || r.surgery_name || r.surgery_method));
  surgeryResults = dedupeSurgeryRows(surgeryResults);

  // Chỉ index theo encounter đã ghép chắc chắn. Không dùng patient_code làm fallback:
  // một bệnh nhân có thể có nhiều đợt điều trị/phẫu thuật khác nhau.
  const firstSurgeryForMedicationByEncounter = firstSurgeryByEncounter(surgeryResults);

  const existingMedRows = readCsvTable(path.join(dir, 'medication_orders.csv'), Number.MAX_SAFE_INTEGER).rows;
  const medicationRowsFromHistory = [];
  for (const row of hchanhOrderTable.rows || []) {
    const raw = [firstNonEmpty(row, ['Tên y lệnh', 'Ten y lenh']), firstNonEmpty(row, ['Y lệnh khác', 'Y lenh khac'])].filter(Boolean).join('\n');
    if (!raw) continue;
    for (const line of raw.split(/\n+/).map(x => x.trim()).filter(Boolean)) {
      if (!/\(tt\)|thuoc|vien|ong|chai|uong|tiem|truyen|xịt|hit|bơm|boi/i.test(line)) continue;
      medicationRowsFromHistory.push({ ...row, raw_line: line });
    }
  }
  const medSourceRows = [
    // medication_orders.csv là output chuẩn hóa; không feed lại chính nó để tránh nhân đôi mỗi lần normalize.
    // Chỉ giữ các dòng legacy/raw nếu file cũ chưa có med_order_id và source_run_id.
    ...existingMedRows.filter(r => !r.med_order_id && !r.source_run_id && firstNonEmpty(r, ['drug_name_raw', 'raw_line', 'Tên thuốc', 'Ten thuoc'])),
    ...medicationRowsFromHistory,
  ];
  let medicationOrders = medSourceRows.map((row, idx) => {
    const code = patientCode(row);
    const ctx = contextForRow(ctxMap, row, code);
    const rawLine = firstNonEmpty(row, ['raw_line', 'Raw line', 'Tên y lệnh', 'Ten y lenh', 'Y lệnh khác', 'Y lenh khac']);
    const rawTime = firstNonEmpty(row, ['order_datetime', 'TG y lệnh', 'TG y lenh', 'Thời gian', 'Ngày', 'order_date']);
    const drug = firstNonEmpty(row, ['drug_name_raw', 'Tên thuốc', 'Ten thuoc']) || rawLine.replace(/^\(TT\)\s*/i, '').slice(0, 180);
    const orderDate = isoDate(rawTime);
    const surgeryRef = surgeryForMedicationContext(firstSurgeryForMedicationByEncounter, ctx);
    const surgeryDate = surgeryRef ? (surgeryRef.surgery_date || isoDate(surgeryRef.surgery_datetime)) : '';
    const postopOffset = surgeryDate && orderDate ? dateOffsetDays(surgeryDate, orderDate) : '';
    const postopNumber = postopOffset === '' ? NaN : Number(postopOffset);
    const base = {
      research_code: firstNonEmpty(row, ['Mã NC', 'Ma NC', 'research_code']) || ctx.research_code || '',
      patient_code: code,
      encounter_id: ctx.encounter_id || '',
      encounter_match_status: encounterMatchStatus(ctx),
      order_datetime: isoDateTime(rawTime),
      order_date: orderDate,
      drug_name_raw: drug,
      drug_name_norm: normalizeDrugName(drug),
      drug_group_guess: classifyDrugGroup(drug || rawLine),
      active_ingredient: firstNonEmpty(row, ['active_ingredient', 'Hoạt chất', 'Hoat chat']),
      route_raw: firstNonEmpty(row, ['route_raw', 'Đường dùng', 'Duong dung']) || rawLine,
      route_norm: normalizeRoute(firstNonEmpty(row, ['route_raw', 'Đường dùng', 'Duong dung']) || rawLine),
      dose_raw: firstNonEmpty(row, ['dose_raw', 'Liều', 'Lieu']) || rawLine,
      times_per_day: firstNonEmpty(row, ['times_per_day', 'Số lần', 'So lan']),
      raw_line: rawLine,
      surgery_datetime_ref: surgeryRef ? (surgeryRef.surgery_datetime || '') : '',
      surgery_date_ref: surgeryDate,
      postop_day_index: Number.isFinite(postopNumber) ? String(postopNumber) : '',
      postop_day_label: Number.isFinite(postopNumber) ? `N${postopNumber}` : '',
      // Không có surgery reference thì để missing, không biến unknown thành 0.
      is_postop_day_1_3: Number.isFinite(postopNumber) ? (postopNumber >= 1 && postopNumber <= 3 ? '1' : '0') : '',
      ...eventTemporalFields(ctx, rawTime),
      source: firstNonEmpty(row, ['source', 'Nguồn']) || 'hchanh_order_history',
      source_run_id: runId,
    };
    base.row_hash = stableHash(base);
    base.med_order_id = `med_${base.row_hash || stableHash([idx, base.patient_code])}`;
    return base;
  }).filter(r => r.patient_code && r.drug_name_raw);
  medicationOrders = dedupeRowsByHash(medicationOrders);

  const medicationDayMap = new Map();
  for (const med of medicationOrders) {
    if (!med.patient_code || !med.encounter_id || !med.order_date) continue;
    const key = [med.patient_code, med.encounter_id || '', med.order_date].join('|');
    const bucket = medicationDayMap.get(key) || {
      research_code: med.research_code,
      patient_code: med.patient_code,
      encounter_id: med.encounter_id,
      order_date: med.order_date,
      drug_count: 0,
      routeSet: new Set(),
      drugs: [],
      source_run_id: runId,
    };
    bucket.drug_count += 1;
    if (med.route_norm) bucket.routeSet.add(med.route_norm);
    if (med.drug_name_raw) bucket.drugs.push(med.drug_name_raw);
    medicationDayMap.set(key, bucket);
  }
  const medicationDaySummary = Array.from(medicationDayMap.values()).map(b => {
    const row = {
      research_code: b.research_code,
      patient_code: b.patient_code,
      encounter_id: b.encounter_id,
      order_date: b.order_date,
      drug_count: b.drug_count,
      route_set: Array.from(b.routeSet).join('; '),
      drugs_display: b.drugs.slice(0, 20).join('; '),
      drugs_json: JSON.stringify(b.drugs),
      source_run_id: runId,
    };
    row.row_hash = stableHash(row);
    return row;
  });

  let clinicalNotes = (hchanhOrderTable.rows || []).map((row, idx) => {
    const code = patientCode(row);
    const ctx = contextForRow(ctxMap, row, code);
    const rawTime = firstNonEmpty(row, ['TG y lệnh', 'TG y lenh', 'Thời gian', 'Ngày']);
    const base = {
      research_code: firstNonEmpty(row, ['Mã NC', 'Ma NC', 'research_code']) || ctx.research_code || '',
      patient_code: code,
      encounter_id: ctx.encounter_id || '',
      encounter_match_status: encounterMatchStatus(ctx),
      note_datetime: isoDateTime(rawTime),
      note_date: isoDate(rawTime),
      doctor_name: firstNonEmpty(row, ['Bác sĩ', 'Bac si', 'doctor_name']),
      note_type: 'order_history',
      clinical_text: firstNonEmpty(row, ['Diễn biến', 'Dien bien']),
      order_text: [firstNonEmpty(row, ['Tên y lệnh', 'Ten y lenh']), firstNonEmpty(row, ['Y lệnh khác', 'Y lenh khac'])].filter(Boolean).join('\n'),
      status: firstNonEmpty(row, ['Trạng thái', 'Trang thai', 'status']),
      ...eventTemporalFields(ctx, rawTime),
      source: firstNonEmpty(row, ['Nguồn', 'source']) || 'hchanh_order_history',
      source_run_id: runId,
    };
    base.row_hash = stableHash(base);
    base.note_id = `note_${base.row_hash || stableHash([idx, base.patient_code])}`;
    return base;
  }).filter(r => r.patient_code && (r.clinical_text || r.order_text));
  clinicalNotes = dedupeRowsByHash(clinicalNotes);

  const labByEncounter = byEncounterCount(labResults, 'lab_date');
  const imagingByEncounter = byEncounterCount(imagingResults, 'order_date');
  const surgeryByEncounter = byEncounterCount(surgeryResults, 'surgery_date');
  const medicationByEncounter = byEncounterCount(medicationOrders, 'order_date');
  const patientDayMap = new Map();
  function ensurePatientDay(row, date) {
    if (!row.patient_code || !row.encounter_id || !date) return null;
    const key = [row.patient_code, row.encounter_id || '', date].join('|');
    if (!patientDayMap.has(key)) {
      const ctx = contextForRow(ctxMap, row, row.patient_code);
      patientDayMap.set(key, {
        research_code: row.research_code || ctx.research_code || '',
        patient_code: row.patient_code,
        encounter_id: row.encounter_id || ctx.encounter_id || '',
        date,
        hospital_day: daysBetween(ctx.admission_date, date),
        has_lab: '0', lab_count: 0,
        has_imaging: '0', imaging_count: 0,
        has_surgery: '0', surgery_count: 0,
        has_medication: '0', medication_count: 0,
        hb: '', hct: '', neutrophil: '', lymphocyte: '', monocyte: '', rdw: '', plt: '',
        creatinine: '', egfr: '', wbc: '', crp: '',
        source_run_id: runId,
      });
    }
    return patientDayMap.get(key);
  }
  const pdLabMap = {
    hemoglobin: 'hb', hct: 'hct', neutrophil: 'neutrophil', lymphocyte: 'lymphocyte', monocyte: 'monocyte', rdw: 'rdw', platelet: 'plt',
    creatinine: 'creatinine', egfr: 'egfr', wbc: 'wbc', crp: 'crp',
  };
  for (const lab of labResults) {
    const pd = ensurePatientDay(lab, lab.lab_date);
    if (!pd) continue;
    pd.has_lab = '1';
    pd.lab_count += 1;
    const col = pdLabMap[lab.test_name_norm];
    if (col && !pd[col]) pd[col] = lab.result_raw;
  }
  for (const img of imagingResults) {
    const pd = ensurePatientDay(img, img.order_date);
    if (!pd) continue;
    pd.has_imaging = '1';
    pd.imaging_count += 1;
  }
  for (const surg of surgeryResults) {
    const pd = ensurePatientDay(surg, surg.surgery_date);
    if (!pd) continue;
    pd.has_surgery = '1';
    pd.surgery_count += 1;
  }
  for (const med of medicationOrders) {
    const pd = ensurePatientDay(med, med.order_date);
    if (!pd) continue;
    pd.has_medication = '1';
    pd.medication_count += 1;
  }
  const patientDay = Array.from(patientDayMap.values()).map(pd => {
    pd.row_hash = stableHash(pd);
    return pd;
  }).sort((a, b) => `${a.patient_code}|${a.encounter_id}|${a.date}`.localeCompare(`${b.patient_code}|${b.encounter_id}|${b.date}`));

  const firstLabByEncounter = new Map();
  for (const lab of labResults) {
    const col = pdLabMap[lab.test_name_norm];
    if (!col) continue;
    const key = lab.encounter_id;
    if (!key) continue;
    const bucket = firstLabByEncounter.get(key) || {};
    const old = bucket[`_${col}_time`] || '';
    if (!bucket[col] || String(lab.lab_datetime || '').localeCompare(old) < 0) {
      bucket[col] = lab.result_raw;
      bucket[`_${col}_time`] = lab.lab_datetime || '';
    }
    firstLabByEncounter.set(key, bucket);
  }
  // Đặt tên khác với hàm firstSurgeryByEncounter import ở đầu file (dùng cho
  // medication linkage, dòng ~4861 trong cùng hàm này) — trùng tên biến const
  // sẽ khiến JS coi cả hàm này nằm trong "vùng chết tạm thời" (TDZ) của tên đó
  // ngay từ đầu, làm lệnh gọi hàm import ở trên ném lỗi "Cannot access before
  // initialization" mỗi khi chạy nhánh không lấy từ cache.
  const firstSurgeryByEncounterMap = new Map();
  for (const surg of surgeryResults) {
    const timeStr = String(surg.surgery_datetime || surg.surgery_date || '');
    const upsert = (key) => {
      if (!key) return;
      const old = firstSurgeryByEncounterMap.get(key);
      const oldTime = old ? String(old.surgery_datetime || old.surgery_date || '') : '';
      if (!old || (timeStr && timeStr.localeCompare(oldTime) < 0)) {
        firstSurgeryByEncounterMap.set(key, surg);
      }
    };
    // Chỉ ghép theo đúng lượt điều trị. Dòng thiếu encounter_id phải được xử lý thủ công,
    // không được phát tán sang mọi lượt của cùng người bệnh.
    upsert(surg.encounter_id);
  }
  const imagingTextByEncounter = new Map();
  for (const img of imagingResults) {
    const key = img.encounter_id;
    if (!key) continue;
    const old = imagingTextByEncounter.get(key) || '';
    imagingTextByEncounter.set(key, `${old}\n${img.service_name_raw || ''}\n${img.result_text || ''}\n${img.conclusion_text || ''}`.trim());
  }
  const analysisReady = finalEncounters.map(enc => {
    const p = patientByCode.get(enc.patient_code) || {};
    const labs = firstLabByEncounter.get(enc.encounter_id) || {};
    const surg = firstSurgeryByEncounterMap.get(enc.encounter_id) || {};
    const diagnosisText = [enc.diagnosis_raw, enc.admission_diagnosis, enc.discharge_diagnosis, imagingTextByEncounter.get(enc.encounter_id) || ''].join('\n');
    const sDate = surg.surgery_datetime || surg.surgery_date || enc.surgery_date || '';

    // Sinh các inference fields theo preset của nghiên cứu
    const inferredFields = {};
    for (const inf of preset.inference_fields) {
      inferredFields[inf.key] = _runInference(inf.fn, diagnosisText);
    }

    // Custom fields: pattern matching trên diagnosisText
    // diagnosisText được chuẩn hóa bỏ dấu; pattern cũng phải được chuẩn hóa tương ứng.
    // Field boolean luôn trả 1/0, không dùng chuỗi rỗng để tránh nhầm "0" với missing.
    const customFieldValues = evaluateCustomFields(customFields, normalizeSimple(diagnosisText));

    // needs_manual_review: chạy checks của preset + cờ ghép encounter không chắc chắn.
    const reviewItems = String(enc.needs_manual_review || '').split(';').map(x => x.trim()).filter(Boolean);
    for (const chk of preset.needs_review_checks) {
      const val = chk.field === 'surgery_date' ? sDate : (inferredFields[chk.field] || '');
      if (!val) reviewItems.push(chk.empty_label);
    }

    const row = {
      research_code: enc.research_code,
      encounter_id: enc.encounter_id,
      patient_code: enc.patient_code,
      patient_name: p.patient_name || '',
      sex: p.sex || '',
      birth_year: p.birth_year || '',
      age: p.age || '',
      admission_date: enc.admission_date,
      surgery_date: sDate,
      discharge_date: enc.discharge_date,
      hospital_stay_days: enc.treatment_duration || daysBetween(enc.admission_date, enc.discharge_date),
      time_to_surgery_hours: hoursBetween(enc.admission_date, sDate),
      diagnosis_raw: enc.diagnosis_raw,
      ...inferredFields,
      ...customFieldValues,
      surgery_name: surg.surgery_name || '',
      surgery_method: surg.surgery_method || '',
      anesthesia_method: surg.anesthesia_method || '',
      comorbidity_text: enc.comorbidity_text || '',
      complication_text: enc.complication_text || '',
      hb: labs.hb || '', hct: labs.hct || '', neutrophil: labs.neutrophil || '', lymphocyte: labs.lymphocyte || '', monocyte: labs.monocyte || '', rdw: labs.rdw || '', plt: labs.plt || '',
      imaging_summary: (imagingTextByEncounter.get(enc.encounter_id) || '').slice(0, 1200),
      needs_manual_review: reviewItems.join('; '),
      source_run_id: runId,
    };
    row.row_hash = stableHash(row);
    return row;
  });

  const progress = readJsonSafe(path.join(dir, 'progress.json'), {});
  const hchanhProgress = readJsonSafe(path.join(dir, 'hchanh_auto_progress.json'), {});
  const orderProgress  = readJsonSafe(path.join(dir, 'order_history_auto_progress.json'), {});

  const encounterCountByPatient = new Map();
  for (const enc of finalEncounters) {
    encounterCountByPatient.set(enc.patient_code, (encounterCountByPatient.get(enc.patient_code) || 0) + 1);
  }

  function progressMatchScore(key, entry, enc) {
    if (!entry || typeof entry !== 'object') return -1;
    const entryEncounter = String(entry.encounter_id || '').trim();
    if (key === enc.encounter_id || entryEncounter === enc.encounter_id) return 100;

    const entryResearch = String(entry.research_code || entry['Mã NC'] || '').trim();
    if (entryResearch && enc.research_code && entryResearch === enc.research_code) return 90;

    const entryCode = String(entry.ma_bn || entry['Mã BN'] || key.split('|')[0] || '').trim();
    if (!entryCode || entryCode !== enc.patient_code) return -1;

    const entryAdmission = isoDateTime(entry.admission_date || entry['Ngày vào viện'] || '')
      || isoDate(entry.admission_date || entry['Ngày vào viện'] || '');
    const entryDischarge = isoDateTime(entry.discharge_date || entry['Ngày ra viện'] || '')
      || isoDate(entry.discharge_date || entry['Ngày ra viện'] || '');
    const encAdmission = isoDateTime(enc.admission_date) || isoDate(enc.admission_date);
    const encDischarge = isoDateTime(enc.discharge_date) || isoDate(enc.discharge_date);
    if (entryAdmission && encAdmission && entryAdmission === encAdmission) {
      if (!entryDischarge || !encDischarge || entryDischarge === encDischarge) return 70;
    }

    // Chỉ fallback theo Mã BN khi chắc chắn người bệnh chỉ có đúng một lượt trong cohort.
    return encounterCountByPatient.get(enc.patient_code) === 1 ? 10 : -1;
  }

  function bestProgressEntry(progressMap, enc, fileKey = '') {
    let best = null;
    let bestScore = -1;
    let bestTime = '';
    for (const [key, entry] of Object.entries(progressMap || {})) {
      if (key.startsWith('__') || !entry || typeof entry !== 'object') continue;
      if (fileKey && !(Array.isArray(entry.files) && entry.files.includes(fileKey))) continue;
      const score = progressMatchScore(key, entry, enc);
      if (score < 0) continue;
      const time = String(entry.updated_at || entry.finished_at || entry.started_at || '');
      const completedBonus = (entry.committed === true || entry.status === 'done') ? 5 : 0;
      const totalScore = score + completedBonus;
      if (!best || totalScore > bestScore || (totalScore === bestScore && time > bestTime)) {
        best = entry;
        bestScore = totalScore;
        bestTime = time;
      }
    }
    return best || {};
  }

  function statusFromProgressEntry(entry) {
    if (!entry || typeof entry !== 'object') return '';
    if (entry.status === 'done') return 'done';
    if (entry.status === 'error') return 'error';
    if (entry.status === 'partial') return 'partial';
    return entry.status || '';
  }

  const extractStatus = finalEncounters.map(enc => {
    const code = enc.patient_code;
    const item = bestProgressEntry(progress, enc);
    const popup = item.popup || item.status || '';
    const xn = item.xn || '';
    const cdha = item.cdha || '';

    // Trạng thái hành chánh theo từng file
    const profileStatus      = statusFromProgressEntry(bestProgressEntry(hchanhProgress, enc, 'profile'));
    const dischargeStatus    = statusFromProgressEntry(bestProgressEntry(hchanhProgress, enc, 'discharge'));
    const surgeryStatus      = statusFromProgressEntry(bestProgressEntry(hchanhProgress, enc, 'surgery'));
    const orderHistoryStatus = statusFromProgressEntry(bestProgressEntry(orderProgress, enc, 'order_history'))
      || statusFromProgressEntry(bestProgressEntry(hchanhProgress, enc, 'order_history')); 

    const hasError = item.error || popup === 'error' || xn === 'error' || cdha === 'error'
      || profileStatus === 'error' || dischargeStatus === 'error'
      || surgeryStatus === 'error' || orderHistoryStatus === 'error';
    const xnCdhaDone = popup === 'done' && xn === 'done' && cdha === 'done';
    const hchanhDone = profileStatus === 'done' && dischargeStatus === 'done';
    const surgeryRequired = surgeryByEncounter.get(enc.encounter_id)?.total > 0 || enc.surgery_date;
    const orderRequired = surgeryRequired || medicationByEncounter.get(enc.encounter_id)?.total > 0;
    const surgeryDone = !surgeryRequired || surgeryStatus === 'done';
    const orderDone = !orderRequired || orderHistoryStatus === 'done';
    const missingRequired = [];
    if (!xnCdhaDone) missingRequired.push('xn_cdha');
    if (profileStatus !== 'done') missingRequired.push('profile');
    if (dischargeStatus !== 'done') missingRequired.push('discharge');
    if (!surgeryDone) missingRequired.push('surgery');
    if (!orderDone) missingRequired.push('order_history');
    const encounterUnsafe = /encounter_match_(?:ambiguous|missing)/.test(String(enc.needs_manual_review || ''));
    if (encounterUnsafe) missingRequired.push('encounter_match');
    const readyForAnalysis = !hasError && missingRequired.length === 0;
    const completionLevel = readyForAnalysis
      ? 'full_required'
      : (xnCdhaDone && hchanhDone ? 'clinical_admin' : xnCdhaDone ? 'xn_cdha' : 'partial');
    const overall = readyForAnalysis
      ? 'done'
      : hasError ? 'error' : 'pending';

    return {
      research_code: enc.research_code || '',
      encounter_id: enc.encounter_id || '',
      patient_code: code,
      patient_name: patientByCode.get(code)?.patient_name || '',
      popup_status: popup,
      xn_status: xn,
      cdha_status: cdha,
      profile_status: profileStatus,
      discharge_status: dischargeStatus,
      surgery_status: surgeryStatus,
      order_history_status: orderHistoryStatus,
      overall_status: overall,
      completion_level: completionLevel,
      ready_for_analysis: readyForAnalysis ? '1' : '0',
      missing_required: missingRequired.join('; '),
      lab_count: labByEncounter.get(enc.encounter_id)?.total || 0,
      imaging_count: imagingByEncounter.get(enc.encounter_id)?.total || 0,
      surgery_count: surgeryByEncounter.get(enc.encounter_id)?.total || 0,
      medication_count: medicationByEncounter.get(enc.encounter_id)?.total || 0,
      last_error: item.error || '',
      source_run_id: runId,
    };
  });

  writeCsv(path.join(dir, 'patients.csv'), NORMALIZED_COLUMNS.patients, patients);
  writeCsv(path.join(dir, 'encounters.csv'), NORMALIZED_COLUMNS.encounters, finalEncounters);
  writeCsv(path.join(dir, 'diagnoses.csv'), NORMALIZED_COLUMNS.diagnoses, diagnoses);
  writeCsv(path.join(dir, 'lab_results.csv'), NORMALIZED_COLUMNS.lab_results, labResults);
  writeCsv(path.join(dir, 'imaging_results.csv'), NORMALIZED_COLUMNS.imaging_results, imagingResults);
  writeCsv(path.join(dir, 'surgery_results.csv'), NORMALIZED_COLUMNS.surgery_results, surgeryResults);
  writeCsv(path.join(dir, 'medication_orders.csv'), NORMALIZED_COLUMNS.medication_orders, medicationOrders);
  writeCsv(path.join(dir, 'medication_day_summary.csv'), NORMALIZED_COLUMNS.medication_day_summary, medicationDaySummary);
  writeCsv(path.join(dir, 'clinical_notes.csv'), NORMALIZED_COLUMNS.clinical_notes, clinicalNotes);
  writeCsv(path.join(dir, 'patient_day.csv'), NORMALIZED_COLUMNS.patient_day, patientDay);
  // Cột analysis_ready = cột cố định + inference fields của preset + custom fields
  const analysisReadyBaseCols = [
    'research_code', 'encounter_id', 'patient_code', 'patient_name', 'sex', 'birth_year', 'age',
    'admission_date', 'surgery_date', 'discharge_date', 'hospital_stay_days', 'time_to_surgery_hours',
    'diagnosis_raw',
  ];
  const inferenceColKeys = preset.inference_fields.map(f => f.key);
  const customColKeys    = customFields.filter(cf => cf.name).map(cf => cf.name);
  const analysisReadyTrailCols = [
    'surgery_name', 'surgery_method', 'anesthesia_method', 'comorbidity_text', 'complication_text',
    'hb', 'hct', 'neutrophil', 'lymphocyte', 'monocyte', 'rdw', 'plt',
    'imaging_summary', 'needs_manual_review', 'source_run_id', 'row_hash',
  ];
  const analysisReadyCols = [...analysisReadyBaseCols, ...inferenceColKeys, ...customColKeys, ...analysisReadyTrailCols];
  writeCsv(path.join(dir, 'analysis_ready.csv'), analysisReadyCols, analysisReady);

  const variableSelectionSpec = analysisConfig.variable_selection || null;
  const selectedAnalysis = buildSelectedAnalysisForRun(dir, analysisReady, {
    analysis_ready: analysisReady,
    patients,
    patient_master: patients,
    encounters: finalEncounters,
    diagnoses,
    lab_results: labResults,
    imaging_results: imagingResults,
    surgery_results: surgeryResults,
    medication_orders: medicationOrders,
    medication_day_summary: medicationDaySummary,
    clinical_notes: clinicalNotes,
    patient_day: patientDay,
  }, variableSelectionSpec);
  if (!selectedAnalysis) {
    try { fs.unlinkSync(path.join(dir, 'analysis_selected.csv')); } catch (_) {}
    try { fs.unlinkSync(path.join(dir, 'analysis_selection_manifest.json')); } catch (_) {}
  }

  try { fs.unlinkSync(path.join(dir, 'analysis_final.csv')); } catch (_) {}
  writeCsv(path.join(dir, 'extract_status.csv'), NORMALIZED_COLUMNS.extract_status, extractStatus);

  // research_source.csv có thể vừa được tạo ở đầu normalize, nên tính lại signature
  // trước khi ghi manifest để lần bấm Chuẩn hóa sau có thể trả kết quả ngay.
  inputSignature = normalizeInputSignature(dir);
  const manifest = readJsonSafe(manifestPath, {});
  const outputs = {
    initial_list: initialTable.rows.length,
    research_source: sourceTable.rows.length || sourceInfo.rows?.length || 0,
    deep_source: deepTable.rows.length,
    raw_patients: patientTable.rows.length,
    patient_extra: extraTable.rows.length,
    hchanh_profile: hchanhProfileTable.rows.length,
    hchanh_discharge: hchanhDischargeTable.rows.length,
    hchanh_surgery: hchanhSurgeryTable.rows.length,
    hchanh_order_history: hchanhOrderTable.rows.length,
    patients: patients.length,
    encounters: finalEncounters.length,
    diagnoses: diagnoses.length,
    lab_results: labResults.length,
    unmatched_lab_results: labResults.filter(row => row.encounter_match_status !== 'matched').length,
    imaging_results: imagingResults.length,
    unmatched_imaging_results: imagingResults.filter(row => row.encounter_match_status !== 'matched').length,
    surgery_results: surgeryResults.length,
    unmatched_surgery_results: surgeryResults.filter(row => row.encounter_match_status !== 'matched').length,
    medication_orders: medicationOrders.length,
    unmatched_medication_orders: medicationOrders.filter(row => row.encounter_match_status !== 'matched').length,
    medication_day_summary: medicationDaySummary.length,
    clinical_notes: clinicalNotes.length,
    patient_day: patientDay.length,
    analysis_ready: analysisReady.length,
    analysis_selected: selectedAnalysis ? selectedAnalysis.rows : 0,
    extract_status: extractStatus.length,
  };
  let database = null;
  try {
    database = syncDatabaseForRun(dir, { runId, inputSignature, force: true });
  } catch (err) {
    console.warn('[RESEARCH][SQLITE] Không tạo/cập nhật được SQLite:', err.message);
  }
  const databasePublic = database
    ? publicDatabaseInfo(database)
    : publicDatabaseInfo(databaseInfo(datasetDirFromRunDir(dir)));

  writeJsonAtomic(manifestPath, {
    ...manifest,
    normalized_at: nowIso(),
    normalized_schema_version: NORMALIZED_SCHEMA_VERSION,
    normalized_input_signature: inputSignature,
    normalized_outputs: outputs,
    normalized_database: databasePublic,
    variable_selection_applied: Boolean(selectedAnalysis),
    variable_selection_output: selectedAnalysis ? { rows: selectedAnalysis.rows, columns: selectedAnalysis.columns } : null,
  });
  return { ...outputs, cached: false, input_signature: inputSignature, database: databasePublic };
}

function normalizeArchiveLatest() {
  const runId = resolveArchiveRunId('latest');
  if (!runId) throw new Error('Kho dữ liệu gốc chưa có run để chuẩn hóa.');
  const runDir = path.join(archiveRunsDir(), runId);
  const counts = normalizeRunOutputs(runDir, { sourceRunId: runId });
  return { run_id: runId, counts };
}

function normalizeStudyLatest(studyId) {
  const runId = resolveRunId(studyId, 'latest');
  if (!runId) throw new Error('Nghiên cứu chưa có run để chuẩn hóa.');
  const runDir = path.join(runsDir(studyId), runId);
  const counts = normalizeRunOutputs(runDir, { sourceRunId: runId });
  return { run_id: runId, counts };
}

function importArchiveToStudy(study, filters) {
  const archive = readArchive();
  if (!archive.latest_run?.id) throw new Error('Kho dữ liệu gốc chưa có lần quét dữ liệu.');
  const archiveRunId = archive.latest_run.id;
  let patientFile = archiveTablePath('initial_list', archiveRunId);
  let patientData = readCsvTable(patientFile, Number.MAX_SAFE_INTEGER);
  if (!patientData.rows.length) {
    patientFile = archiveTablePath('patients', archiveRunId);
    patientData = readCsvTable(patientFile, Number.MAX_SAFE_INTEGER);
  }
  if (!patientData.rows.length) throw new Error('Kho dữ liệu gốc chưa có bảng dữ liệu ban đầu để lọc người bệnh.');

  const dateFilteredPatients = patientData.rows.filter(row => rowPassesDateFilter(row, filters));
  const selection = sanitizeVariableSelection(filters?.variable_selection || activeVariableSelectionFromStudy(study));
  const archiveRunDir = path.join(archiveRunsDir(), archiveRunId);
  const tableRowsByKey = loadRunTablesForSelection(archiveRunDir, selection, dateFilteredPatients);
  const selectionResult = variableSelection.filterCohortRowsByVariableSelection(dateFilteredPatients, selection, tableRowsByKey);
  const selectedPatients = variableSelection.hasActiveSelection(selection) ? selectionResult.rows : dateFilteredPatients;
  const selectedVisits = selectedPatients.filter(row => patientCode(row));
  if (!selectedVisits.length) throw new Error(variableSelection.hasActiveSelection(selection)
    ? 'Không có bệnh nhân phù hợp điều kiện lọc và variable selection.'
    : 'Không có bệnh nhân phù hợp điều kiện lọc.');

  ensureDir(studyDir(study.id));
  const usedCodes = new Set();
  const cohortRows = selectedVisits.map((row, index) => {
    const next = { ...row };
    let code = getCell(next, ['Mã NC', 'Ma NC', 'research_code']);
    if (!code || usedCodes.has(code)) code = `NC${String(index + 1).padStart(4, '0')}`;
    usedCodes.add(code);
    next['Mã NC'] = code;
    return next;
  });
  const cohortColumns = [...patientData.columns];
  if (!cohortColumns.includes('Mã NC')) cohortColumns.unshift('Mã NC');
  writeCsv(cohortPath(study.id), cohortColumns, cohortRows);

  // Không copy dữ liệu XN/CĐHA/Thuốc từ kho gốc sang nghiên cứu.
  // Nghiên cứu chỉ nhận danh sách Mã BN đã lọc; bước "Lấy thêm dữ liệu EMR"
  // sẽ dùng chính các Mã BN này để mở EMR và ghi run riêng cho nghiên cứu.
  const updated = updateStudy(study.id, {
    cohort_source: 'archive',
    cohort_source_run_id: archiveRunId,
    cohort_filter: filters || {},
    variable_selection: variableSelection.hasActiveSelection(selection) ? selection : study.variable_selection,
    analysis_config: variableSelection.hasActiveSelection(selection)
      ? { ...(study.analysis_config || {}), variable_selection: selection }
      : study.analysis_config,
    variable_selection_import: variableSelection.hasActiveSelection(selection) ? {
      applied: true,
      input_count: patientData.rows.length,
      date_filtered_count: dateFilteredPatients.length,
      matched_count: cohortRows.length,
      condition_count: selection.conditions.length,
      applied_at: nowIso(),
    } : { applied: false, input_count: patientData.rows.length, date_filtered_count: dateFilteredPatients.length, matched_count: cohortRows.length, applied_at: nowIso() },
    last_import_at: nowIso(),
  });
  return {
    study: updated,
    source_run_id: archiveRunId,
    count: cohortRows.length,
    variable_selection: variableSelection.hasActiveSelection(selection) ? {
      applied: true,
      condition_count: selection.conditions.length,
      selected_variable_count: selection.selected_variables.length,
      date_filtered_count: dateFilteredPatients.length,
    } : { applied: false },
  };
}

router.post('/research/archive/dismiss-alert', (_req, res) => {
  try {
    const runId = resolveArchiveRunId('latest');
    if (runId) {
      const alertPath = path.join(archiveRunsDir(), runId, 'fatal_alert.json');
      if (fs.existsSync(alertPath)) fs.unlinkSync(alertPath);
    }
    return res.json({ status: 'ok' });
  } catch (err) {
    return res.status(err.status || 400).json({ status: 'error', message: String(err.message || err) });
  }
});

router.get('/research/archive', (_req, res) => {
  return res.json({ status: 'ok', archive: readArchive() });
});

router.post('/research/archive/source', (req, res) => {
  try {
    ensureArchiveStore();
    const csv = String(req.body?.csv || '');
    const parsed = validatePatientCsv(csv, 'CSV tổng cần có cột Mã BN. Nên có thêm Ngày vào viện và Ngày ra viện để lọc nghiên cứu.');
    writeFileAtomic(archiveSourcePath(), csv.replace(/^\ufeff/, ''), 'utf-8');
    const original = String(req.body?.filename || 'source.csv').trim();
    const archive = updateArchive({ source_filename: original || 'source.csv', source_uploaded_at: nowIso() });
    return res.json({ status: 'ok', archive, columns: parsed.columns, count: parsed.count });
  } catch (err) {
    return res.status(err.status || 400).json({ status: 'error', message: String(err.message || err) });
  }
});


router.get('/research/archive/patient-history', (req, res) => {
  const startedAt = Date.now();
  try {
    const runId = resolveArchiveRunId(String(req.query.runId || 'latest'));
    const runDir = runId ? path.join(archiveRunsDir(), runId) : '';
    const data = buildPatientHistory(runDir, String(req.query.q || ''));
    const elapsed = Date.now() - startedAt;
    if (elapsed > 1200) console.warn(`[RESEARCH][LOOKUP] ${elapsed}ms | q=${String(req.query.q || '').slice(0, 80)} | source=${data.data_source || '?'}`);

    // Không bao giờ trả một response lịch sử quá lớn làm Express/V8 lỗi Invalid string length.
    let eventRows = 0;
    for (const patient of data.patients || []) {
      for (const enc of patient.encounters || []) {
        eventRows += Number(enc?.labs?.length || 0)
          + Number(enc?.imaging?.length || 0)
          + Number(enc?.medications?.length || 0)
          + Number(enc?.surgeries?.length || 0);
      }
    }
    if (eventRows > 12000) {
      return res.status(413).json({
        status: 'error',
        code: 'RESEARCH_LOOKUP_TOO_LARGE',
        message: 'Kết quả chi tiết quá lớn. Hãy tra cứu bằng mã BN/mã NC cụ thể hơn.',
        candidate_count: Number(data.total_matches || 0),
      });
    }
    return res.json({ status: 'ok', run_id: runId || '', ...data, request_ms: elapsed });
  } catch (err) {
    console.error('[RESEARCH][LOOKUP][ERROR]', err);
    return res.status(err.status || 400).json({ status: 'error', message: String(err.message || err) });
  }
});

router.get('/research/archive/variable-catalog', (req, res) => {
  try {
    const runId = resolveArchiveRunId(String(req.query.runId || 'latest'));
    const runDir = runId ? path.join(archiveRunsDir(), runId) : '';
    const catalog = buildVariableCatalog(runDir);
    return res.json({ status: 'ok', run_id: runId || '', catalog });
  } catch (err) {
    return res.status(err.status || 400).json({ status: 'error', message: String(err.message || err) });
  }
});

router.get('/research/archive/data', (req, res) => {
  try {
    const archive = readArchive();
    const tableKey = TABLES[req.query.table] ? String(req.query.table) : 'patients';
    const runId = resolveArchiveRunId(String(req.query.runId || 'latest'));
    const filePath = archiveTablePath(tableKey, runId || 'latest');
    const data = filePath ? readCsvTable(filePath, MAX_TABLE_ROWS) : { columns: [], rows: [], count: 0, limited: false, exists: false };
    const displayRows = sortRowsForTable(tableKey, data.rows);
    const redact = researchResponseShouldRedact(req);
    const output = redact ? redactCsvTable(data.columns, displayRows, EXPORT_SENSITIVE_COLUMNS) : { columns: data.columns, rows: displayRows, removed_columns: [] };
    return res.json({
      status: 'ok',
      archive,
      table: { key: tableKey, ...TABLES[tableKey] },
      run_id: runId || '',
      columns: output.columns,
      rows: output.rows,
      redacted: redact,
      removed_columns: output.removed_columns,
      count: data.count,
      limited: data.limited,
      exists: data.exists,
      max_rows: MAX_TABLE_ROWS,
    });
  } catch (err) {
    return res.status(err.status || 400).json({ status: 'error', message: String(err.message || err) });
  }
});

router.get('/research/archive/export', (req, res) => {
  try {
    const tableKey = TABLES[req.query.table] ? String(req.query.table) : 'analysis_ready';
    const runId = resolveArchiveRunId(String(req.query.runId || 'latest'));
    const filePath = archiveTablePath(tableKey, runId || 'latest');
    return sendCsvFile(res, filePath, `archive_${runId || 'latest'}_${tableKey}`, { redact: researchResponseShouldRedact(req) });
  } catch (err) {
    return res.status(err.status || 400).json({ status: 'error', message: String(err.message || err) });
  }
});

router.get('/research/archive/coverage', (req, res) => {
  try {
    const runId = resolveArchiveRunId(String(req.query.runId || 'latest'));
    const runDir = runId ? path.join(archiveRunsDir(), runId) : '';
    return res.json({ status: 'ok', coverage: buildCoverageSummary(runDir) });
  } catch (err) {
    return res.status(err.status || 400).json({ status: 'error', message: String(err.message || err) });
  }
});

router.get('/research/archive/progress', (req, res) => {
  try {
    const runId = resolveArchiveRunIdFast(String(req.query.runId || 'latest'));
    const archive = readArchiveProgressMeta(runId);
    const runDir = runId ? path.join(archiveRunsDir(), runId) : '';
    const progress = buildResearchProgressSnapshot(runDir, archive, { isArchive: true });
    return res.json({ status: 'ok', run_id: runId || '', progress });
  } catch (err) {
    return res.status(err.status || 400).json({ status: 'error', message: String(err.message || err) });
  }
});

router.post('/research/archive/finalize-dataset', (_req, res) => {
  try {
    const runId = resolveArchiveRunIdForAction('latest');
    if (!runId) return res.status(400).json({ status: 'error', message: 'Kho gốc chưa có run.' });
    const result = finalizeAnalysisDataset(path.join(archiveRunsDir(), runId));
    const archive = updateArchive({ last_finalized_at: nowIso() });
    return res.json({ status: 'ok', message: `Đã tạo analysis_final.csv (${result.count} dòng).`, archive, ...result });
  } catch (err) {
    return res.status(err.status || 400).json({ status: 'error', message: String(err.message || err), coverage: err.coverage || undefined });
  }
});

router.post('/research/archive/build-encoded-dataset', (_req, res) => {
  try {
    const runId = resolveArchiveRunIdForAction('latest');
    if (!runId) return res.status(400).json({ status: 'error', message: 'Kho gốc chưa có run.' });
    const result = buildEncodedDataset(path.join(archiveRunsDir(), runId));
    const archive = updateArchive({ last_encoded_at: nowIso() });
    return res.json({ status: 'ok', message: `Đã tạo/cập nhật dữ liệu encoded cho ${runId}.`, archive, ...result });
  } catch (err) {
    return res.status(err.status || 400).json({ status: 'error', message: String(err.message || err) });
  }
});

router.post('/research/archive/clean-generated', (req, res) => {
  try {
    const runId = resolveArchiveRunIdForAction('latest');
    if (!runId) return res.status(400).json({ status: 'error', message: 'Kho gốc chưa có run.' });
    const result = cleanResearchGenerated(path.join(archiveRunsDir(), runId), {
      encoded: req.body?.encoded !== false,
      debug: req.body?.debug !== false,
      derived: req.body?.derived === true,
    });
    const archive = updateArchive({ last_cleaned_at: nowIso() });
    return res.json({ status: 'ok', message: `Đã dọn file phụ cho ${runId}.`, archive, run_id: runId, ...result });
  } catch (err) {
    return res.status(err.status || 400).json({ status: 'error', message: String(err.message || err) });
  }
});

router.get('/research/archive/log', (req, res) => {
  try {
    const runId = resolveArchiveRunId(String(req.query.runId || 'latest'));
    if (!runId) return res.json({ status: 'ok', lines: [], run_id: '' });
    const logPath = path.join(archiveRunsDir(), runId, 'action_log.txt');
    const maxLines = Math.min(2000, Number(req.query.lines || 500));
    if (!fs.existsSync(logPath)) return res.json({ status: 'ok', lines: [], run_id: runId, exists: false });
    const text = fs.readFileSync(logPath, 'utf-8');
    const all  = text.split('\n').filter(l => l.trim());
    const lines = all.slice(-maxLines);
    return res.json({ status: 'ok', lines, total: all.length, run_id: runId, exists: true });
  } catch (err) {
    return res.status(err.status || 400).json({ status: 'error', message: String(err.message || err) });
  }
});

router.get('/research/studies/:studyId/log', (req, res) => {
  try {
    const study = readStudy(req.params.studyId);
    if (!study) return res.status(404).json({ status: 'error', message: 'Không tìm thấy nghiên cứu.' });
    const runId = resolveRunId(study.id, String(req.query.runId || 'latest'));
    if (!runId) return res.json({ status: 'ok', lines: [], run_id: '' });
    const logPath = path.join(runsDir(study.id), runId, 'action_log.txt');
    const maxLines = Math.min(2000, Number(req.query.lines || 500));
    if (!fs.existsSync(logPath)) return res.json({ status: 'ok', lines: [], run_id: runId, exists: false });
    const text = fs.readFileSync(logPath, 'utf-8');
    const all  = text.split('\n').filter(l => l.trim());
    const lines = all.slice(-maxLines);
    return res.json({ status: 'ok', lines, total: all.length, run_id: runId, exists: true });
  } catch (err) {
    return res.status(err.status || 400).json({ status: 'error', message: String(err.message || err) });
  }
});

router.get('/research/archive/case-trace', (req, res) => {
  try {
    const runId = resolveArchiveRunId(String(req.query.runId || 'latest'));
    if (!runId) return res.json({ status: 'ok', cases: [], run_id: '' });
    const runDir = path.join(archiveRunsDir(), runId);
    const limit = Math.min(50, Math.max(1, Number(req.query.limit || CASE_TRACE_RECENT_LIMIT)));
    const cases = readResearchCaseTrace(runDir, limit);
    const redact = researchResponseShouldRedact(req);
    return res.json({ status: 'ok', run_id: runId, cases: redact ? redactCaseTracePayload(cases) : cases, limit, redacted: redact });
  } catch (err) {
    return res.status(err.status || 400).json({ status: 'error', message: String(err.message || err) });
  }
});

router.get('/research/studies/:studyId/case-trace', (req, res) => {
  try {
    const study = readStudy(req.params.studyId);
    if (!study) return res.status(404).json({ status: 'error', message: 'Không tìm thấy nghiên cứu.' });
    const runId = resolveRunId(study.id, String(req.query.runId || 'latest'));
    if (!runId) return res.json({ status: 'ok', cases: [], run_id: '' });
    const runDir = path.join(runsDir(study.id), runId);
    const limit = Math.min(50, Math.max(1, Number(req.query.limit || CASE_TRACE_RECENT_LIMIT)));
    const cases = readResearchCaseTrace(runDir, limit);
    const redact = researchResponseShouldRedact(req);
    return res.json({ status: 'ok', run_id: runId, cases: redact ? redactCaseTracePayload(cases) : cases, limit, redacted: redact });
  } catch (err) {
    return res.status(err.status || 400).json({ status: 'error', message: String(err.message || err) });
  }
});

router.post('/research/archive/normalize', (_req, res) => {
  try {
    const result = normalizeArchiveLatest();
    const archive = result.counts?.cached ? readArchive() : updateArchive({ last_normalized_at: nowIso() });
    return res.json({ status: 'ok', message: result.counts?.cached ? 'Dữ liệu đã chuẩn hóa sẵn, không cần chạy lại.' : 'Đã chuẩn hóa kho dữ liệu gốc.', archive, ...result });
  } catch (err) {
    return res.status(err.status || 400).json({ status: 'error', message: String(err.message || err) });
  }
});

router.post('/research/archive/import-hchanh', (req, res) => {
  const ctx = getRuntimePaths(req);
  try {
    const runId = resolveArchiveRunId(String(req.body?.runId || 'latest')) || safeFilePart(req.body?.runId || nowFileStamp());
    if (!runId) return res.status(400).json({ status: 'error', message: 'Kho dữ liệu gốc chưa có run để gộp dữ liệu hành chánh.' });
    const runDir = path.join(archiveRunsDir(), runId);
    ensureDir(runDir);
    const imported = flattenHchanhIntoResearchRun(ctx, runDir);
    const normalized = normalizeRunOutputs(runDir, { sourceRunId: runId });
    const archive = updateArchive({ last_run_id: runId, last_run_at: nowIso(), last_normalized_at: nowIso(), last_hchanh_import_at: nowIso() });
    return res.json({
      status: 'ok',
      message: `Đã gộp dữ liệu hành chánh vào kho nghiên cứu: nền=${imported.profile}, ra viện=${imported.discharge}, phẫu thuật=${imported.surgery}, y lệnh=${imported.order_history}.`,
      archive,
      run_id: runId,
      imported,
      normalized,
    });
  } catch (err) {
    return res.status(err.status || 400).json({ status: 'error', message: String(err.message || err) });
  }
});


router.post('/research/archive/fetch-hchanh', async (req, res) => {
  const ctx = getRuntimePaths(req);
  try {
    const archive = readArchive();
    const runId = resolveArchiveRunIdForAction(req.body?.runId || 'latest');
    if (!runId) return res.status(400).json({ status: 'error', message: 'Kho dữ liệu gốc chưa có run. Hãy chạy Bước 1 — Quét danh sách trước.' });
    const runDir = path.join(archiveRunsDir(), runId);
    const effectiveFromDate = String(req.body?.fromDate || archive.scan_from_date || '').trim();
    const effectiveToDate = String(req.body?.toDate || archive.scan_to_date || todayDateInput()).trim();
    const sourceInfo = readResearchHchanhSourceRows(runDir, archiveSourcePath(), {
      sourceRunId: runId,
      dateDefaults: { from_date: effectiveFromDate, to_date: effectiveToDate },
    });
    const { rows, file, base_file: baseFile, date_context: dateContext } = sourceInfo;
    if (!rows.length) return res.status(400).json({ status: 'error', message: `Không tìm thấy danh sách Mã BN để lấy hành chánh tự động trong run ${runId}. Hãy kiểm tra đã có du_lieu_ban_dau.csv/cohort.csv hoặc bấm Bước 1 trước.` });

    const files = hchanhDefaultFiles(req.body?.files);
    const limit = Number.isFinite(Number(req.body?.limit)) ? Math.max(0, Math.trunc(Number(req.body.limit))) : 0;
    updateArchive({ active_run_id: runId, active_mode: 'hchanh_auto' });

    await enqueueHeavy(ctx.sid, async () => {
      try {
        const fetched = await fetchHchanhForResearchRun(ctx, runDir, {
          sourceRows: rows,
          sourceRunId: runId,
          files,
          headless: researchHeadlessFromBody(req.body),
          force: req.body?.force === true,
          fallbackDateFrom: dateContext?.from_date || effectiveFromDate || '',
          fallbackDateTo: dateContext?.to_date || effectiveToDate || todayDateInput(),
          limit,
          mode: 'hchanh_auto',
        });
        const normalized = normalizeRunOutputs(runDir, { sourceRunId: runId });
        const updated = updateArchive({
          last_run_id: runId,
          last_run_at: nowIso(),
          last_normalized_at: nowIso(),
          last_hchanh_auto_at: nowIso(),
          active_run_id: '',
          active_mode: '',
        });
        return res.json({
          status: 'ok',
          message: `Đã tự động lấy hành chánh từ EMR: xử lý=${fetched.processed}, bỏ qua=${fetched.skipped}, OK=${fetched.ok}, cần xem=${fetched.attention}, lỗi=${fetched.error}.`,
          archive: updated,
          run_id: runId,
          source_file: path.basename(file || ''),
          source_base_file: path.basename(baseFile || ''),
          source_date_from: dateContext?.from_date || '',
          source_date_to: dateContext?.to_date || '',
          fetched,
          normalized,
        });
      } catch (err) {
        updateArchive({ active_run_id: '', active_mode: '', stopped_at: nowIso() });
        throw err;
      }
    });
  } catch (err) {
    console.error(err);
    if (!res.headersSent) res.status(500).json({ status: 'error', message: String(err.message || err) });
  }
});


router.post('/research/archive/fetch-order-history', async (req, res) => {
  const ctx = getRuntimePaths(req);
  try {
    const archive = readArchive();
    const runId = resolveArchiveRunIdForAction(req.body?.runId || 'latest');
    if (!runId) return res.status(400).json({ status: 'error', message: 'Kho dữ liệu gốc chưa có run. Hãy chạy Bước 1 — Quét danh sách trước.' });
    const runDir = path.join(archiveRunsDir(), runId);
    const effectiveFromDate = String(req.body?.fromDate || archive.scan_from_date || '').trim();
    const effectiveToDate = String(req.body?.toDate || archive.scan_to_date || todayDateInput()).trim();
    const sourceInfo = readResearchHchanhSourceRows(runDir, archiveSourcePath(), {
      sourceRunId: runId,
      dateDefaults: { from_date: effectiveFromDate, to_date: effectiveToDate },
    });
    const { rows, file, base_file: baseFile, date_context: dateContext } = sourceInfo;
    if (!rows.length) return res.status(400).json({ status: 'error', message: `Không tìm thấy danh sách Mã BN để lấy lịch sử y lệnh trong run ${runId}. Hãy kiểm tra đã có du_lieu_ban_dau.csv/cohort.csv hoặc bấm Bước 1 trước.` });

    const files = orderHistoryDefaultFiles(req.body?.files);
    const limit = Number.isFinite(Number(req.body?.limit)) ? Math.max(0, Math.trunc(Number(req.body.limit))) : 0;
    updateArchive({ active_run_id: runId, active_mode: 'order_history_auto' });

    await enqueueHeavy(ctx.sid, async () => {
      try {
        const fetched = await fetchHchanhForResearchRun(ctx, runDir, {
          sourceRows: rows,
          sourceRunId: runId,
          files,
          headless: researchHeadlessFromBody(req.body),
          force: req.body?.force === true,
          fallbackDateFrom: dateContext?.from_date || effectiveFromDate || '',
          fallbackDateTo: dateContext?.to_date || effectiveToDate || todayDateInput(),
          limit,
          mode: 'order_history_auto',
        });
        const normalized = normalizeRunOutputs(runDir, { sourceRunId: runId });
        const updated = updateArchive({
          last_run_id: runId,
          last_run_at: nowIso(),
          last_normalized_at: nowIso(),
          last_order_history_auto_at: nowIso(),
          active_run_id: '',
          active_mode: '',
        });
        return res.json({
          status: 'ok',
          message: `Đã tự động lấy ${orderHistoryRunLabel(files)} từ EMR: xử lý=${fetched.processed}, bỏ qua=${fetched.skipped}, OK=${fetched.ok}, cần xem=${fetched.attention}, lỗi=${fetched.error}.`,
          archive: updated,
          run_id: runId,
          source_file: path.basename(file || ''),
          source_base_file: path.basename(baseFile || ''),
          source_date_from: dateContext?.from_date || '',
          source_date_to: dateContext?.to_date || '',
          fetched,
          normalized,
        });
      } catch (err) {
        updateArchive({ active_run_id: '', active_mode: '', stopped_at: nowIso() });
        throw err;
      }
    });
  } catch (err) {
    console.error(err);
    if (!res.headersSent) res.status(500).json({ status: 'error', message: String(err.message || err) });
  }
});


router.post('/research/archive/patient-info', async (req, res) => {
  const ctx = getRuntimePaths(req);
  try {
    const archive = readArchive();
    if (!fs.existsSync(SCRIPT_PATH)) return res.status(500).json({ status: 'error', message: 'Thiếu script lấy dữ liệu nghiên cứu.' });
    const effectiveFromDate = String(req.body?.fromDate || archive.scan_from_date || '').trim();
    const effectiveToDate = String(req.body?.toDate || archive.scan_to_date || todayDateInput()).trim();
    const runId = safeFilePart(req.body?.runId || archive.latest_run?.id || chooseArchiveRunIdForResume({ fromDate: effectiveFromDate, toDate: effectiveToDate }) || nowFileStamp());
    const runDir = path.join(archiveRunsDir(), runId);
    const sourceInfo = readResearchHchanhSourceRows(runDir, archiveSourcePath(), {
      sourceRunId: runId,
      dateDefaults: { from_date: effectiveFromDate, to_date: effectiveToDate },
    });
    const inputPath = sourceInfo.file;
    if (!inputPath || !fs.existsSync(inputPath)) {
      return res.status(400).json({ status: 'error', message: 'Chưa có danh sách Mã BN. Hãy chạy Bước 1 — Quét danh sách trước.' });
    }
    const args = [
      '-u', SCRIPT_PATH,
      '--input', inputPath,
      '--project-id', ARCHIVE_ID,
      '--run-id', runId,
      '--out-root', RESEARCH_STORE_DIR,
      '--patient-info-only',
    ];
    if (effectiveFromDate) args.push('--from-date', effectiveFromDate);
    if (effectiveToDate) args.push('--to-date', effectiveToDate);
    if (researchHeadlessFromBody(req.body)) args.push('--headless');
    updateArchive({ active_run_id: runId, active_mode: 'patient_info' });

    await enqueueHeavy(ctx.sid, async () => {
      let result;
      try {
        result = await runPython(args, {
          cwd: ROOT_DIR,
          onSpawn: killFn => registerCancel(ctx.sid, killFn),
          extraEnv: { RESEARCH_INPUT_NAME: path.basename(inputPath) },
        });
      } finally {
        unregisterCancel(ctx.sid);
      }

      if (result.spawnError) return res.status(500).json({ status: 'error', message: `Không khởi động được Python: ${result.spawnError}` });
      if (result.killedByTimeout) return res.status(504).json({ status: 'error', message: 'Timeout khi lấy thông tin khác. Dữ liệu đã lưu từng mã BN, bấm lại để chạy tiếp.' });
      if (isStoppedRunResult(result)) {
        const normalized = normalizeRunOutputs(path.join(archiveRunsDir(), runId), { sourceRunId: runId });
        const updated = updateArchive({ last_run_id: runId, last_run_at: nowIso(), last_normalized_at: nowIso(), stopped_at: nowIso(), active_run_id: '', active_mode: '' });
        return res.json({ status: 'ok', stopped: true, message: 'Đã dừng. Thông tin khác đã lấy vẫn được giữ; bấm lại để chạy tiếp.', archive: updated, run_id: runId, normalized });
      }
      if (result.code !== 0) return res.status(500).json({ status: 'error', message: fmtPyError('Python lỗi khi lấy thông tin khác từ D/s Bệnh nhân. Dữ liệu đã lưu nếu chạy được một phần.', result) });

      const normalized = normalizeRunOutputs(path.join(archiveRunsDir(), runId), { sourceRunId: runId });
      const updated = updateArchive({ last_run_id: runId, last_run_at: nowIso(), last_normalized_at: nowIso(), active_run_id: '', active_mode: '' });
      return res.json({ status: 'ok', message: 'Đã lấy thông tin khác: Điện thoại, Số CMND/CCCD, BHYT, địa chỉ từ D/s Bệnh nhân.', archive: updated, run_id: runId, normalized });
    });
  } catch (err) {
    console.error(err);
    if (!res.headersSent) res.status(500).json({ status: 'error', message: String(err.message || err) });
  }
});

router.post('/research/archive/run', async (req, res) => {
  const ctx = getRuntimePaths(req);
  try {
    const archive = readArchive();
    if (!fs.existsSync(SCRIPT_PATH)) return res.status(500).json({ status: 'error', message: 'Thiếu script lấy dữ liệu nghiên cứu.' });

    const mode = String(req.body?.mode || '').toLowerCase();
    const deep = req.body?.deep === true || mode === 'deep';
    const fromDate = String(req.body?.fromDate || '2026-01-01').trim();
    const toDate = String(req.body?.toDate || todayDateInput()).trim();
    const runId = safeFilePart(req.body?.runId || (deep
      ? (archive.latest_run?.id || chooseArchiveRunIdForResume({ fromDate, toDate }) || nowFileStamp())
      : (req.body?.resume === false ? nowFileStamp() : chooseArchiveRunIdForResume({ fromDate, toDate }))
    ));
    const initialListPath = archiveTablePath('initial_list', runId);
    const inputPath = deep ? initialListPath : archiveSourcePath();
    if (deep && (!inputPath || !fs.existsSync(inputPath))) {
      return res.status(400).json({ status: 'error', message: 'Chưa có du_lieu_ban_dau.csv. Hãy chạy Bước 1 trước.' });
    }
    const args = [
      '-u', SCRIPT_PATH,
      '--input', inputPath,
      '--project-id', ARCHIVE_ID,
      '--run-id', runId,
      '--out-root', RESEARCH_STORE_DIR,
    ];
    if (!deep) args.push('--list-only');
    if (deep && initialListPath) args.push('--archive-initial-list', initialListPath);
    const rescanRecentDays = Number.isFinite(Number(req.body?.rescanRecentDays))
      ? Math.max(0, Math.min(30, Math.trunc(Number(req.body.rescanRecentDays))))
      : 7;
    if (fromDate) args.push('--from-date', fromDate);
    if (toDate) args.push('--to-date', toDate);
    if (!deep) args.push('--rescan-recent-days', String(rescanRecentDays));
    if (researchHeadlessFromBody(req.body)) args.push('--headless');
    updateArchive({ scan_from_date: fromDate, scan_to_date: toDate, active_run_id: runId, active_mode: deep ? 'deep' : 'initial' });

    await enqueueHeavy(ctx.sid, async () => {
      try {
        let result;
      try {
        result = await runPython(args, {
          cwd: ROOT_DIR,
          onSpawn: killFn => registerCancel(ctx.sid, killFn),
          extraEnv: { RESEARCH_INPUT_NAME: path.basename(inputPath) },
        });
        } finally {
          unregisterCancel(ctx.sid);
        }

        if (result.spawnError) return res.status(500).json({ status: 'error', message: `Không khởi động được Python: ${result.spawnError}` });
      const normalizeCurrentArchiveRun = () => {
        const currentRunDir = path.join(archiveRunsDir(), runId);
        // Bước 1 vừa thay đổi du_lieu_ban_dau.csv: luôn dựng lại nguồn chuẩn trước
        // khi normalize để progress/các bước sau không tiếp tục dùng mẫu cũ.
        if (!deep) {
          ensureResearchSourceRows(currentRunDir, {
            sourceRunId: runId,
            dateDefaults: { from_date: fromDate, to_date: toDate },
            force: true,
          });
        }
        return normalizeRunOutputs(currentRunDir, { sourceRunId: runId });
      };
      if (result.killedByTimeout) return res.status(504).json({ status: 'error', message: deep ? 'Timeout khi cập nhật dữ liệu gốc. Tiến độ đã lưu, bấm Bước 3 để chạy tiếp.' : 'Timeout khi quét danh sách ban đầu. Tiến độ đã lưu, bấm Bước 1 để chạy tiếp.' });
      if (isStoppedRunResult(result)) {
        const normalized = normalizeCurrentArchiveRun();
        const updated = updateArchive({ last_run_id: runId, last_run_at: nowIso(), last_normalized_at: nowIso(), stopped_at: nowIso() });
        return res.json({ status: 'ok', stopped: true, message: deep ? 'Đã dừng. Dữ liệu sâu đã commit vẫn được giữ; lần sau bấm Bước 3 để chạy tiếp.' : 'Đã dừng. Các trang đã quét xong đã lưu vào du_lieu_ban_dau.csv; lần sau bấm Bước 1 để quét lại và bỏ qua dòng đã có.', archive: updated, run_id: runId, normalized });
      }
      if (result.code !== 0) return res.status(500).json({ status: 'error', message: fmtPyError(deep ? 'Python lỗi khi cập nhật dữ liệu gốc. Tiến độ đã lưu nếu đã chạy được một phần.' : 'Python lỗi khi quét dữ liệu ban đầu. Tiến độ đã lưu nếu đã chạy được một phần.', result) });

      const normalized = normalizeCurrentArchiveRun();
      const updated = updateArchive({ last_run_id: runId, last_run_at: nowIso(), last_normalized_at: nowIso(), active_run_id: '', active_mode: '' });
        return res.json({ status: 'ok', message: deep ? 'Đã cập nhật dữ liệu gốc: lấy sâu từ du_lieu_ban_dau.csv, gộp/xóa các dòng đã nằm trong cùng đợt điều trị và chuẩn hóa.' : 'Đã quét dữ liệu ban đầu từ bảng Hoàn tất và chuẩn hóa dữ liệu gốc.', archive: updated, run_id: runId, normalized });
      } finally {
        updateArchive({ active_run_id: '', active_mode: '' });
      }
    });
  } catch (err) {
    console.error(err);
    if (!res.headersSent) res.status(500).json({ status: 'error', message: String(err.message || err) });
  }
});

router.get('/research/studies', (_req, res) => {
  return res.json({ status: 'ok', studies: listStudies() });
});

// ── Lấy lại chỗ thiếu ────────────────────────────────────────────────────────
// Đọc extract_status.csv, lọc BN còn thiếu loại dữ liệu nào, gọi đúng fetcher.
// scope = 'archive' | studyId
// missingTypes = ['xn_cdha', 'profile', 'discharge', 'surgery', 'order_history'] (mảng)
router.post('/research/refetch-missing', async (req, res) => {
  const ctx = getRuntimePaths(req);
  try {
    const rawScope     = String(req.body?.scope || ARCHIVE_ID).trim();
    const isArc        = rawScope === ARCHIVE_ID || rawScope === '__archive__' || rawScope === 'archive';
    const scope        = isArc ? ARCHIVE_ID : rawScope;
    const missingTypes = Array.isArray(req.body?.missingTypes) ? req.body.missingTypes : [];
    const headless     = researchHeadlessFromBody(req.body);
    const force        = req.body?.force === true;

    if (!missingTypes.length) {
      return res.status(400).json({ status: 'error', message: 'Cần chỉ định missingTypes cần lấy lại.' });
    }

    // Xác định runDir
    let runDir, runId, sourceRowsForHchanh, fallbackFrom, fallbackTo;
    if (isArc) {
      const archive = readArchive();
      runId = resolveArchiveRunIdForAction('latest');
      if (!runId) return res.status(400).json({ status: 'error', message: 'Kho gốc chưa có run. Chạy Bước 1 trước.' });
      runDir = path.join(archiveRunsDir(), runId);
      fallbackFrom = String(req.body?.fromDate || archive.scan_from_date || '').trim();
      fallbackTo   = String(req.body?.toDate || archive.scan_to_date || todayDateInput()).trim();
      const srcInfo = readResearchHchanhSourceRows(runDir, archiveSourcePath(), {
        sourceRunId: runId,
        dateDefaults: { from_date: fallbackFrom, to_date: fallbackTo },
      });
      sourceRowsForHchanh = srcInfo.rows;
    } else {
      const study = readStudy(scope);
      if (!study) return res.status(404).json({ status: 'error', message: 'Không tìm thấy nghiên cứu.' });
      runId = resolveRunId(study.id, 'latest');
      if (!runId) return res.status(400).json({ status: 'error', message: 'Nghiên cứu chưa có run.' });
      runDir = path.join(runsDir(study.id), runId);
      fallbackFrom = String(req.body?.fromDate || '').trim();
      fallbackTo   = String(req.body?.toDate || todayDateInput()).trim();
      const srcInfo = readResearchHchanhSourceRows(runDir, cohortPath(study.id), { sourceRunId: runId });
      sourceRowsForHchanh = srcInfo.rows;
    }

    // Đọc extract_status để lọc BN thiếu
    const statusTable = readCsvTable(path.join(runDir, 'extract_status.csv'), Number.MAX_SAFE_INTEGER);

    // Xác định BN cần lấy lại cho từng nhóm
    const needXnCdha = missingTypes.includes('xn_cdha');
    const hchanhFiles = missingTypes.filter(t => ['profile', 'discharge', 'surgery', 'order_history'].includes(t));

    // BN/lượt cần lấy lại XN/CĐHA: thiếu popup, XN hoặc CĐHA. Giữ cả Mã NC để tránh nhầm nhiều lần nhập viện.
    const missingXnCdhaRows = needXnCdha
      ? statusTable.rows.filter(r => isRowMissingXnCdha(r))
      : [];
    const missingXnCdha = [...new Set(missingXnCdhaRows.map(r => String(r.patient_code || r['Mã BN'] || '').trim()).filter(Boolean))];

    // BN cần lấy lại hành chánh: bất kỳ file nào trong hchanhFiles chưa done
    const missingHchanhRows = hchanhFiles.length
      ? sourceRowsForHchanh.filter(row => {
          const code = patientCode(row);
          const st = statusTable.rows.find(r => r.patient_code === code);
          if (!st) return true; // chưa có trong extract_status → chưa lấy
          return hchanhFiles.some(f => {
            const col = `${f}_status`;
            return st[col] !== 'done';
          });
        })
      : [];

    const summary = {
      xn_cdha_patients: missingXnCdha.length,
      hchanh_patients: missingHchanhRows.length,
      hchanh_files: hchanhFiles,
    };

    if (!missingXnCdha.length && !missingHchanhRows.length) {
      return res.json({ status: 'ok', message: 'Không có dữ liệu còn thiếu cho các loại đã chọn.', summary });
    }

    // Người dùng đang chủ động chạy tiếp phần còn thiếu: bỏ cảnh báo fatal cũ.
    // Nếu lần chạy mới gặp fatal thật, worker sẽ ghi lại fatal_alert.json.
    try {
      const oldAlertPath = path.join(runDir, 'fatal_alert.json');
      if (fs.existsSync(oldAlertPath)) fs.unlinkSync(oldAlertPath);
    } catch (_) {}

    const task = beginResearchTask(runDir, {
      type: 'refetch_missing',
      label: 'Bổ sung dữ liệu còn thiếu',
      status: 'queued',
      scope,
      run_id: runId,
      missing_types: missingTypes,
      summary,
      message: `Đã nhận yêu cầu bổ sung: XN/CĐHA=${summary.xn_cdha_patients}, hành chánh=${summary.hchanh_patients}.`,
    });

    await enqueueHeavy(ctx.sid, async () => {
      updateResearchTask(runDir, task.id, {
        status: 'running',
        message: 'Đang chạy bổ sung dữ liệu còn thiếu. Có thể chuyển tab, tiến độ vẫn được lưu ở backend.',
      });
      const results = {};
      try {

      const finishCancelled = () => {
        const normalized = normalizeRunOutputs(runDir, { sourceRunId: runId });
        if (isArc) {
          updateArchive({ last_run_id: runId, last_run_at: nowIso(), last_normalized_at: nowIso(), stopped_at: nowIso() });
        } else {
          updateStudy(scope, { last_run_id: runId, last_run_at: nowIso(), last_normalized_at: nowIso(), stopped_at: nowIso() });
        }
        const message = 'Đã dừng theo yêu cầu. Dữ liệu đã lấy xong vẫn được giữ; bấm Cập nhật để chạy tiếp phần còn thiếu.';
        finishResearchTask(runDir, task.id, 'cancelled', {
          message,
          summary,
          results,
        });
        appendResearchRunLog(runDir, `[REFETCH_MISSING] ${message}`);
        return res.json({
          status: 'ok',
          stopped: true,
          cancelled: true,
          message,
          summary,
          results,
          normalized,
        });
      };

      // Có thể người dùng bấm Dừng lúc job còn chờ heavy slot; không được bắt đầu worker đầu tiên.
      if (isCancelRequested(ctx.sid)) return finishCancelled();

      // Lấy lại hành chánh cho BN thiếu
      if (missingHchanhRows.length && hchanhFiles.length) {
        const fetched = await fetchHchanhForResearchRun(ctx, runDir, {
          sourceRows: missingHchanhRows,
          sourceRunId: runId,
          files: hchanhFiles,
          headless,
          force,
          fallbackDateFrom: fallbackFrom,
          fallbackDateTo: fallbackTo,
          mode: hchanhFiles.includes('order_history') && hchanhFiles.length === 1
            ? 'order_history_auto' : 'hchanh_auto',
        });
        results.hchanh = fetched;
        if (fetched.cancelled || isCancelRequested(ctx.sid)) return finishCancelled();
      }

      // XN/CĐHA — chạy lấy lại ngay trên subset BN/lượt còn thiếu, không chỉ đánh dấu chờ Bước 2.
      if (missingXnCdhaRows.length) {
        if (isCancelRequested(ctx.sid)) return finishCancelled();
        const reset = resetXnCdhaProgress(runDir, missingXnCdhaRows);
        const refetchRows = sourceRowsForXnCdhaRefetch(runDir, isArc ? archiveSourcePath() : cohortPath(scope), missingXnCdhaRows, runId, {
          from_date: fallbackFrom,
          to_date: fallbackTo,
        });
        if (!refetchRows.length) {
          results.xn_cdha = {
            patients: missingXnCdha.length,
            reset_in_progress: reset.resetCount,
            error: 'Không dựng được danh sách BN để lấy lại XN/CĐHA.',
          };
        } else {
          const inputDir = path.join(runDir, 'input');
          ensureDir(inputDir);
          const subsetPath = path.join(inputDir, `refetch_xn_cdha_${nowFileStamp()}.csv`);
          writeCsvUnion(subsetPath, refetchRows, [
            'Mã NC', 'Mã BN', 'Họ tên', 'T/G vào', 'TG vào', 'Ngày vào viện', 'Ngày ra viện',
            'fetch_from_date', 'fetch_to_date', 'source_scan_from_date', 'source_scan_to_date', 'source_file', 'source_run_id', 'Research key',
          ]);
          const args = [
            '-u', SCRIPT_PATH,
            '--input', subsetPath,
            '--project-id', scope,
            '--run-id', runId,
            '--out-root', RESEARCH_STORE_DIR,
          ];
          const initialListPath = isArc ? archiveTablePath('initial_list', runId) : '';
          if (isArc && initialListPath) args.push('--archive-initial-list', initialListPath);
          if (fallbackFrom) args.push('--from-date', fallbackFrom);
          if (fallbackTo) args.push('--to-date', fallbackTo);
          if (headless) args.push('--headless');
          appendResearchRunLog(runDir, `[REFETCH_XN_CDHA] Bắt đầu lấy lại ${refetchRows.length} dòng nguồn / ${missingXnCdha.length} BN còn thiếu`);
          let xnResult;
          try {
            xnResult = await runPython(args, {
              cwd: ROOT_DIR,
              onSpawn: killFn => registerCancel(ctx.sid, killFn),
              extraEnv: { RESEARCH_INPUT_NAME: path.basename(subsetPath), RESEARCH_REFETCH_MISSING: '1' },
            });
          } finally {
            unregisterCancel(ctx.sid);
          }
          if (isCancelRequested(ctx.sid)) {
            results.xn_cdha = {
              patients: missingXnCdha.length,
              input_rows: refetchRows.length,
              reset_in_progress: reset.resetCount,
              cancelled: true,
            };
            appendResearchRunLog(runDir, '[REFETCH_XN_CDHA] ĐÃ DỪNG theo yêu cầu; phần đã commit được giữ, phần còn lại sẽ lấy tiếp lần sau.');
            return finishCancelled();
          }
          if (xnResult.spawnError || xnResult.killedByTimeout || xnResult.code !== 0) {
            results.xn_cdha = {
              patients: missingXnCdha.length,
              input_rows: refetchRows.length,
              reset_in_progress: reset.resetCount,
              error: xnResult.spawnError || (xnResult.killedByTimeout ? 'timeout' : fmtPyError('Lấy lại XN/CĐHA lỗi', xnResult)),
            };
            appendResearchRunLog(runDir, `[REFETCH_XN_CDHA] LỖI: ${String(results.xn_cdha.error).split('\n')[0]}`);
          } else {
            results.xn_cdha = {
              patients: missingXnCdha.length,
              input_rows: refetchRows.length,
              reset_in_progress: reset.resetCount,
              message: `Đã chạy lấy lại XN/CĐHA cho ${refetchRows.length} dòng nguồn (${missingXnCdha.length} BN).`,
            };
            appendResearchRunLog(runDir, `[REFETCH_XN_CDHA] Xong: ${refetchRows.length} dòng nguồn / ${missingXnCdha.length} BN`);
          }
        }
      }

      const normalized = normalizeRunOutputs(runDir, { sourceRunId: runId });
      if (isArc) {
        updateArchive({ last_run_id: runId, last_run_at: nowIso(), last_normalized_at: nowIso() });
      } else {
        updateStudy(scope, { last_run_id: runId, last_run_at: nowIso(), last_normalized_at: nowIso() });
      }

      const message = [
        results.hchanh ? `Hành chánh: xử lý=${results.hchanh.processed}, OK=${results.hchanh.ok}, lỗi=${results.hchanh.error}` : '',
        results.xn_cdha ? (results.xn_cdha.error ? `XN/CĐHA lỗi: ${String(results.xn_cdha.error).split('\n')[0]}` : results.xn_cdha.message) : '',
      ].filter(Boolean).join(' | ');
      finishResearchTask(runDir, task.id, results.xn_cdha?.error ? 'error' : 'done', {
        message: message || 'Đã hoàn tất bổ sung dữ liệu còn thiếu.',
        summary,
        results,
      });

      return res.json({
        status: 'ok',
        message,
        summary,
        results,
        normalized,
      });
      } catch (taskErr) {
        finishResearchTask(runDir, task.id, 'error', {
          message: String(taskErr?.message || taskErr || 'Tác vụ bổ sung dữ liệu lỗi.'),
          summary,
          results,
        });
        throw taskErr;
      }
    });
  } catch (err) {
    console.error(err);
    if (!res.headersSent) res.status(500).json({ status: 'error', message: String(err.message || err) });
  }
});

router.get('/research/analysis-presets', (_req, res) => {
  const out = Object.entries(ANALYSIS_PRESETS).map(([id, p]) => ({
    id,
    label: p.label,
    inference_fields: p.inference_fields.map(f => ({ key: f.key, label: f.label })),
  }));
  return res.json({ status: 'ok', presets: out });
});


function sanitizeVariableSelection(input) {
  return variableSelection.sanitizeVariableSelection(input);
}

function activeVariableSelectionFromStudy(study) {
  return study?.variable_selection || study?.analysis_config?.variable_selection || null;
}

function readRunRowsForSelection(runDir, tableKey, fallbackRows = []) {
  if (!tableKey) return [];
  if (Array.isArray(fallbackRows) && ['cohort', 'initial_list', 'research_source'].includes(tableKey) && fallbackRows.length) return fallbackRows;
  const table = TABLES[tableKey];
  if (!table || table.root !== 'run') return [];
  return readCsvTable(path.join(runDir, table.file), Number.MAX_SAFE_INTEGER).rows || [];
}

function loadRunTablesForSelection(runDir, selection, fallbackRows = []) {
  const out = {};
  const keys = new Set();
  for (const item of [...(selection?.selected_variables || []), ...(selection?.conditions || [])]) {
    if (item?.table) keys.add(item.table);
  }
  for (const key of keys) out[key] = readRunRowsForSelection(runDir, key, fallbackRows);
  if (fallbackRows?.length) {
    out.initial_list = out.initial_list || fallbackRows;
    out.cohort = out.cohort || fallbackRows;
    out.research_source = out.research_source || fallbackRows;
  }
  return out;
}

function buildSelectedAnalysisForRun(runDir, analysisReadyRows, normalizedRowsByKey, selection) {
  if (!variableSelection.hasActiveSelection(selection)) return null;
  const selected = variableSelection.buildSelectedAnalysisDataset(analysisReadyRows || [], selection, normalizedRowsByKey || {});
  writeCsv(path.join(runDir, 'analysis_selected.csv'), selected.columns, selected.rows);
  writeJsonAtomic(path.join(runDir, 'analysis_selection_manifest.json'), {
    ...selected.manifest,
    run_id: path.basename(runDir),
    source: 'variable_selection',
  });
  return { rows: selected.rows.length, columns: selected.columns.length, manifest: selected.manifest };
}

router.post('/research/studies', (req, res) => {
  try {
    const name = String(req.body?.name || '').trim();
    if (!name) return res.status(400).json({ status: 'error', message: 'Cần nhập tên nghiên cứu.' });
    const id = req.body?.id ? cleanStudyId(req.body.id) : uniqueStudyId(name);
    if (id === ARCHIVE_ID) return res.status(400).json({ status: 'error', message: 'Mã này đang dùng cho kho dữ liệu gốc.' });
    if (fs.existsSync(studyDir(id))) return res.status(409).json({ status: 'error', message: 'Mã nghiên cứu đã tồn tại.' });
    ensureDir(studyDir(id));

    // Validate analysis_config
    const rawPreset = String(req.body?.analysis_config?.preset || 'general');
    const presetId  = ANALYSIS_PRESETS[rawPreset] ? rawPreset : 'general';
    const customFields = cleanCustomFields(req.body?.analysis_config?.custom_fields, presetId, true);
    const rawVariableSelection = req.body?.variable_selection || req.body?.analysis_config?.variable_selection || null;
    const variable_selection = rawVariableSelection ? sanitizeVariableSelection(rawVariableSelection) : null;
    const analysis_config = { preset: presetId, custom_fields: customFields };
    if (variable_selection) analysis_config.variable_selection = variable_selection;

    const meta = {
      id,
      name,
      description: String(req.body?.description || '').trim(),
      type: 'archive_derived',
      analysis_config,
      variable_selection,
      created_at: nowIso(),
      updated_at: nowIso(),
    };
    writeJsonAtomic(studyMetaPath(id), meta);
    return res.json({ status: 'ok', study: readStudy(id) });
  } catch (err) {
    return res.status(err.status || 400).json({ status: 'error', message: String(err.message || err) });
  }
});

router.post('/research/studies/:studyId/analysis-config', (req, res) => {
  try {
    const study = readStudy(req.params.studyId);
    if (!study) return res.status(404).json({ status: 'error', message: 'Không tìm thấy nghiên cứu.' });

    const rawPreset = String(req.body?.preset || 'general');
    const presetId  = ANALYSIS_PRESETS[rawPreset] ? rawPreset : 'general';
    const customFields = cleanCustomFields(req.body?.custom_fields, presetId, true);
    const analysis_config = { preset: presetId, custom_fields: customFields };
    if (study.analysis_config?.variable_selection) analysis_config.variable_selection = study.analysis_config.variable_selection;
    const updated = updateStudy(study.id, { analysis_config });
    return res.json({ status: 'ok', message: `Đã cập nhật cấu hình phân tích: ${ANALYSIS_PRESETS[presetId].label}.`, study: updated });
  } catch (err) {
    return res.status(err.status || 400).json({ status: 'error', message: String(err.message || err) });
  }
});

router.get('/research/studies/:studyId', (req, res) => {
  try {
    const study = readStudy(req.params.studyId);
    if (!study) return res.status(404).json({ status: 'error', message: 'Không tìm thấy nghiên cứu.' });
    return res.json({ status: 'ok', study });
  } catch (err) {
    return res.status(err.status || 400).json({ status: 'error', message: String(err.message || err) });
  }
});

router.post('/research/studies/:studyId/cohort', (req, res) => {
  try {
    const study = readStudy(req.params.studyId);
    if (!study) return res.status(404).json({ status: 'error', message: 'Không tìm thấy nghiên cứu.' });
    const csv = String(req.body?.csv || '');
    const parsed = validatePatientCsv(csv, 'CSV cần có cột Mã BN.');
    writeFileAtomic(cohortPath(study.id), csv.replace(/^\ufeff/, ''), 'utf-8');
    const original = String(req.body?.filename || 'cohort.csv').trim();
    updateStudy(study.id, { cohort_filename: original || 'cohort.csv', cohort_uploaded_at: nowIso(), cohort_source: 'upload' });
    return res.json({ status: 'ok', study: readStudy(study.id), columns: parsed.columns, count: parsed.count });
  } catch (err) {
    return res.status(err.status || 400).json({ status: 'error', message: String(err.message || err) });
  }
});

router.delete('/research/studies/:studyId', (req, res) => {
  try {
    const { studyId } = req.params;
    const study = readStudy(studyId);
    if (!study) return res.status(404).json({ status: 'error', message: 'Không tìm thấy nghiên cứu.' });
    // Xóa toàn bộ thư mục nghiên cứu (kể cả runs, cohort, study.json)
    fs.rmSync(studyDir(studyId), { recursive: true, force: true });
    return res.json({ status: 'ok', message: `Đã xóa nghiên cứu "${study.name}".` });
  } catch (err) {
    return res.status(err.status || 400).json({ status: 'error', message: String(err.message || err) });
  }
});

// Lưu cohort từ danh sách đã lọc trên frontend (mảng rows JSON → ghi thành cohort.csv)
router.post('/research/studies/:studyId/cohort-from-filtered', (req, res) => {
  try {
    const study = readStudy(req.params.studyId);
    if (!study) return res.status(404).json({ status: 'error', message: 'Không tìm thấy nghiên cứu.' });
    const rows = Array.isArray(req.body?.rows) ? req.body.rows : [];
    if (!rows.length) return res.status(400).json({ status: 'error', message: 'Danh sách rỗng.' });
    const normalizedRows = rows.map((row, idx) => {
      const next = { ...(row || {}) };
      const code = firstNonEmpty(next, ['Mã BN', 'Ma BN', 'MABN', 'patient_code']);
      if (code && !next['Mã BN']) next['Mã BN'] = code;
      const name = firstNonEmpty(next, ['Họ tên', 'Ho ten', 'patient_name']);
      if (name && !next['Họ tên']) next['Họ tên'] = name;
      const researchCode = firstNonEmpty(next, ['Mã NC', 'Ma NC', 'research_code']) || `NC${String(idx + 1).padStart(4, '0')}`;
      if (!next['Mã NC']) next['Mã NC'] = researchCode;
      if (!next['Ngày vào viện'] && next.admission_date) next['Ngày vào viện'] = next.admission_date;
      if (!next['Ngày ra viện'] && next.discharge_date) next['Ngày ra viện'] = next.discharge_date;
      if (!next['Chẩn đoán'] && next.diagnosis_raw) next['Chẩn đoán'] = next.diagnosis_raw;
      if (!next['Tuổi'] && next.age) next['Tuổi'] = next.age;
      if (!next['Giới'] && next.sex) next['Giới'] = next.sex;
      return next;
    });
    const colSet = new Set(['Mã NC', 'Mã BN', 'Họ tên', 'Giới', 'Tuổi', 'Ngày vào viện', 'Ngày ra viện', 'Chẩn đoán']);
    for (const row of normalizedRows) Object.keys(row).forEach(k => colSet.add(k));
    const cols = Array.from(colSet);
    const escape = v => { const s = String(v ?? ''); return /[",\n\r;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
    const csv = '\ufeff' + cols.map(escape).join(',') + '\n'
      + normalizedRows.map(r => cols.map(c => escape(r[c] ?? '')).join(',')).join('\n');
    writeFileAtomic(cohortPath(study.id), csv.replace(/^\ufeff/, ''), 'utf-8');
    updateStudy(study.id, {
      cohort_filename: 'cohort.csv',
      cohort_uploaded_at: nowIso(),
      cohort_source: 'filtered',
      cohort_count: rows.length,
    });
    return res.json({ status: 'ok', study: readStudy(study.id), count: rows.length });
  } catch (err) {
    return res.status(err.status || 400).json({ status: 'error', message: String(err.message || err) });
  }
});

router.post('/research/studies/:studyId/import-from-archive', (req, res) => {
  try {
    const study = readStudy(req.params.studyId);
    if (!study) return res.status(404).json({ status: 'error', message: 'Không tìm thấy nghiên cứu.' });
    const result = importArchiveToStudy(study, {
      admitFrom: String(req.body?.admitFrom || ''),
      admitTo: String(req.body?.admitTo || ''),
      dischargeFrom: String(req.body?.dischargeFrom || ''),
      dischargeTo: String(req.body?.dischargeTo || ''),
    });
    return res.json({ status: 'ok', message: `Đã tạo danh sách ${result.count} Mã BN từ kho gốc. Bấm Lấy thêm dữ liệu EMR để quét dữ liệu riêng cho nghiên cứu.`, ...result });
  } catch (err) {
    return res.status(err.status || 400).json({ status: 'error', message: String(err.message || err) });
  }
});

router.get('/research/studies/:studyId/data', (req, res) => {
  try {
    const study = readStudy(req.params.studyId);
    if (!study) return res.status(404).json({ status: 'error', message: 'Không tìm thấy nghiên cứu.' });
    const tableKey = TABLES[req.query.table] ? String(req.query.table) : 'patients';
    const runId = resolveRunId(study.id, String(req.query.runId || 'latest'));
    const filePath = tablePathFor(study.id, tableKey, runId || 'latest');
    const data = filePath ? readCsvTable(filePath, MAX_TABLE_ROWS) : { columns: [], rows: [], count: 0, limited: false, exists: false };
    const displayRows = sortRowsForTable(tableKey, data.rows);
    const redact = researchResponseShouldRedact(req);
    const output = redact ? redactCsvTable(data.columns, displayRows, EXPORT_SENSITIVE_COLUMNS) : { columns: data.columns, rows: displayRows, removed_columns: [] };
    return res.json({
      status: 'ok',
      study,
      table: { key: tableKey, ...TABLES[tableKey] },
      run_id: runId || '',
      columns: output.columns,
      rows: output.rows,
      redacted: redact,
      removed_columns: output.removed_columns,
      count: data.count,
      limited: data.limited,
      exists: data.exists,
      max_rows: MAX_TABLE_ROWS,
    });
  } catch (err) {
    return res.status(err.status || 400).json({ status: 'error', message: String(err.message || err) });
  }
});

router.get('/research/studies/:studyId/export', (req, res) => {
  try {
    const study = readStudy(req.params.studyId);
    if (!study) return res.status(404).json({ status: 'error', message: 'Không tìm thấy nghiên cứu.' });
    const tableKey = TABLES[req.query.table] ? String(req.query.table) : 'analysis_ready';
    const runId = resolveRunId(study.id, String(req.query.runId || 'latest'));
    const filePath = tablePathFor(study.id, tableKey, runId || 'latest');
    return sendCsvFile(res, filePath, `${study.id}_${runId || 'latest'}_${tableKey}`, { redact: researchResponseShouldRedact(req) });
  } catch (err) {
    return res.status(err.status || 400).json({ status: 'error', message: String(err.message || err) });
  }
});

router.get('/research/studies/:studyId/coverage', (req, res) => {
  try {
    const study = readStudy(req.params.studyId);
    if (!study) return res.status(404).json({ status: 'error', message: 'Không tìm thấy nghiên cứu.' });
    const runId = resolveRunId(study.id, String(req.query.runId || 'latest'));
    const runDir = runId ? path.join(runsDir(study.id), runId) : '';
    return res.json({ status: 'ok', coverage: buildCoverageSummary(runDir) });
  } catch (err) {
    return res.status(err.status || 400).json({ status: 'error', message: String(err.message || err) });
  }
});

router.get('/research/studies/:studyId/progress', (req, res) => {
  try {
    const runId = resolveStudyRunIdFast(req.params.studyId, String(req.query.runId || 'latest'));
    const study = readStudyProgressMeta(req.params.studyId, runId);
    if (!study) return res.status(404).json({ status: 'error', message: 'Không tìm thấy nghiên cứu.' });
    const runDir = runId ? path.join(runsDir(study.id), runId) : '';
    const progress = buildResearchProgressSnapshot(runDir, study, { isArchive: false });
    return res.json({ status: 'ok', run_id: runId || '', progress });
  } catch (err) {
    return res.status(err.status || 400).json({ status: 'error', message: String(err.message || err) });
  }
});

router.post('/research/studies/:studyId/finalize-dataset', (req, res) => {
  try {
    const study = readStudy(req.params.studyId);
    if (!study) return res.status(404).json({ status: 'error', message: 'Không tìm thấy nghiên cứu.' });
    const runId = resolveRunId(study.id, String(req.query.runId || 'latest'));
    if (!runId) return res.status(400).json({ status: 'error', message: 'Nghiên cứu chưa có run.' });
    const result = finalizeAnalysisDataset(path.join(runsDir(study.id), runId));
    const updated = updateStudy(study.id, { last_finalized_at: nowIso() });
    return res.json({ status: 'ok', message: `Đã tạo analysis_final.csv (${result.count} dòng).`, study: updated, ...result });
  } catch (err) {
    return res.status(err.status || 400).json({ status: 'error', message: String(err.message || err), coverage: err.coverage || undefined });
  }
});

router.post('/research/studies/:studyId/build-encoded-dataset', (req, res) => {
  try {
    const study = readStudy(req.params.studyId);
    if (!study) return res.status(404).json({ status: 'error', message: 'Không tìm thấy nghiên cứu.' });
    const runId = resolveRunId(study.id, String(req.query.runId || 'latest'));
    if (!runId) return res.status(400).json({ status: 'error', message: 'Nghiên cứu chưa có run.' });
    const result = buildEncodedDataset(path.join(runsDir(study.id), runId));
    const updated = updateStudy(study.id, { last_encoded_at: nowIso() });
    return res.json({ status: 'ok', message: `Đã tạo/cập nhật dữ liệu encoded cho ${runId}.`, study: updated, ...result });
  } catch (err) {
    return res.status(err.status || 400).json({ status: 'error', message: String(err.message || err) });
  }
});

router.post('/research/studies/:studyId/clean-generated', (req, res) => {
  try {
    const study = readStudy(req.params.studyId);
    if (!study) return res.status(404).json({ status: 'error', message: 'Không tìm thấy nghiên cứu.' });
    const runId = resolveRunId(study.id, String(req.query.runId || 'latest'));
    if (!runId) return res.status(400).json({ status: 'error', message: 'Nghiên cứu chưa có run.' });
    const result = cleanResearchGenerated(path.join(runsDir(study.id), runId), {
      encoded: req.body?.encoded !== false,
      debug: req.body?.debug !== false,
      derived: req.body?.derived === true,
    });
    const updated = updateStudy(study.id, { last_cleaned_at: nowIso() });
    return res.json({ status: 'ok', message: `Đã dọn file phụ cho ${runId}.`, study: updated, run_id: runId, ...result });
  } catch (err) {
    return res.status(err.status || 400).json({ status: 'error', message: String(err.message || err) });
  }
});

router.post('/research/studies/:studyId/normalize', (req, res) => {
  try {
    const study = readStudy(req.params.studyId);
    if (!study) return res.status(404).json({ status: 'error', message: 'Không tìm thấy nghiên cứu.' });
    const result = normalizeStudyLatest(study.id);
    const updated = result.counts?.cached ? study : updateStudy(study.id, { last_normalized_at: nowIso() });
    return res.json({ status: 'ok', message: result.counts?.cached ? 'Dữ liệu nghiên cứu đã chuẩn hóa sẵn, không cần chạy lại.' : 'Đã chuẩn hóa dữ liệu nghiên cứu.', study: updated, ...result });
  } catch (err) {
    return res.status(err.status || 400).json({ status: 'error', message: String(err.message || err) });
  }
});


router.post('/research/studies/:studyId/fetch-hchanh', async (req, res) => {
  const ctx = getRuntimePaths(req);
  try {
    const study = readStudy(req.params.studyId);
    if (!study) return res.status(404).json({ status: 'error', message: 'Không tìm thấy nghiên cứu.' });
    if (!fs.existsSync(cohortPath(study.id))) return res.status(400).json({ status: 'error', message: 'Chưa có danh sách bệnh nhân cho nghiên cứu này.' });

    const runId = resolveStudyRunIdForAction(study.id, req.body?.runId || 'latest');
    const runDir = path.join(runsDir(study.id), runId);
    ensureDir(runDir);

    // Nếu nghiên cứu riêng chưa có run XN/CĐHA, dùng cohort làm nguồn nền cho run hành chánh.
    const initialPath = path.join(runDir, 'du_lieu_ban_dau.csv');
    const samplePath = path.join(runDir, 'mau_nghien_cuu.csv');
    if (!fs.existsSync(initialPath)) fs.copyFileSync(cohortPath(study.id), initialPath);
    if (!fs.existsSync(samplePath)) fs.copyFileSync(cohortPath(study.id), samplePath);
    const manifestPath = path.join(runDir, 'manifest.json');
    const manifest = readJsonSafe(manifestPath, {}) || {};
    const archiveSourceManifest = study.cohort_source_run_id
      ? readJsonSafe(path.join(archiveRunsDir(), safeFilePart(study.cohort_source_run_id), 'manifest.json'), {}) || {}
      : {};
    const dateDefaults = {
      from_date: String(req.body?.fromDate || manifest.from_date || archiveSourceManifest.from_date || '').trim(),
      to_date: String(req.body?.toDate || manifest.to_date || archiveSourceManifest.to_date || '').trim(),
    };
    writeJsonAtomic(manifestPath, {
      created_at: manifest.created_at || nowIso(),
      updated_at: nowIso(),
      source: manifest.source || 'study_hchanh_auto',
      source_run_id: manifest.source_run_id || study.cohort_source_run_id || '',
      from_date: manifest.from_date || dateDefaults.from_date || '',
      to_date: manifest.to_date || dateDefaults.to_date || '',
      patients_count: manifest.patients_count || countCsvRows(cohortPath(study.id)),
      ...manifest,
    });

    const sourceInfo = readResearchHchanhSourceRows(runDir, cohortPath(study.id), { sourceRunId: runId, dateDefaults });
    const { rows, file, base_file: baseFile, date_context: dateContext } = sourceInfo;
    if (!rows.length) return res.status(400).json({ status: 'error', message: `Không tìm thấy danh sách Mã BN để lấy hành chánh tự động trong run ${runId}. Hãy kiểm tra đã có du_lieu_ban_dau.csv/cohort.csv hoặc bấm Bước 1 trước.` });
    const files = hchanhDefaultFiles(req.body?.files);
    const limit = Number.isFinite(Number(req.body?.limit)) ? Math.max(0, Math.trunc(Number(req.body.limit))) : 0;

    await enqueueHeavy(ctx.sid, async () => {
      const fetched = await fetchHchanhForResearchRun(ctx, runDir, {
        sourceRows: rows,
        sourceRunId: runId,
        files,
        headless: researchHeadlessFromBody(req.body),
        force: req.body?.force === true,
        fallbackDateFrom: dateContext?.from_date || String(req.body?.fromDate || ''),
        fallbackDateTo: dateContext?.to_date || String(req.body?.toDate || ''),
        limit,
        mode: 'hchanh_auto',
      });
      const normalized = normalizeRunOutputs(runDir, { sourceRunId: runId });
      const updated = updateStudy(study.id, {
        last_run_id: runId,
        last_run_at: nowIso(),
        last_normalized_at: nowIso(),
        last_hchanh_auto_at: nowIso(),
      });
      return res.json({
        status: 'ok',
        message: `Đã tự động lấy hành chánh từ EMR cho nghiên cứu: xử lý=${fetched.processed}, bỏ qua=${fetched.skipped}, OK=${fetched.ok}, cần xem=${fetched.attention}, lỗi=${fetched.error}.`,
        study: updated,
        run_id: runId,
        source_file: path.basename(file || ''),
        source_base_file: path.basename(baseFile || ''),
        source_date_from: dateContext?.from_date || '',
        source_date_to: dateContext?.to_date || '',
        fetched,
        normalized,
      });
    });
  } catch (err) {
    console.error(err);
    if (!res.headersSent) res.status(500).json({ status: 'error', message: String(err.message || err) });
  }
});


router.post('/research/studies/:studyId/fetch-order-history', async (req, res) => {
  const ctx = getRuntimePaths(req);
  try {
    const study = readStudy(req.params.studyId);
    if (!study) return res.status(404).json({ status: 'error', message: 'Không tìm thấy nghiên cứu.' });
    if (!fs.existsSync(cohortPath(study.id))) return res.status(400).json({ status: 'error', message: 'Chưa có danh sách bệnh nhân cho nghiên cứu này.' });

    const runId = resolveStudyRunIdForAction(study.id, req.body?.runId || 'latest');
    const runDir = path.join(runsDir(study.id), runId);
    ensureDir(runDir);

    const initialPath = path.join(runDir, 'du_lieu_ban_dau.csv');
    const samplePath = path.join(runDir, 'mau_nghien_cuu.csv');
    if (!fs.existsSync(initialPath)) fs.copyFileSync(cohortPath(study.id), initialPath);
    if (!fs.existsSync(samplePath)) fs.copyFileSync(cohortPath(study.id), samplePath);
    const manifestPath = path.join(runDir, 'manifest.json');
    const manifest = readJsonSafe(manifestPath, {}) || {};
    const archiveSourceManifest = study.cohort_source_run_id
      ? readJsonSafe(path.join(archiveRunsDir(), safeFilePart(study.cohort_source_run_id), 'manifest.json'), {}) || {}
      : {};
    const dateDefaults = {
      from_date: String(req.body?.fromDate || manifest.from_date || archiveSourceManifest.from_date || '').trim(),
      to_date: String(req.body?.toDate || manifest.to_date || archiveSourceManifest.to_date || '').trim(),
    };
    writeJsonAtomic(manifestPath, {
      created_at: manifest.created_at || nowIso(),
      updated_at: nowIso(),
      source: manifest.source || 'study_order_history_auto',
      source_run_id: manifest.source_run_id || study.cohort_source_run_id || '',
      from_date: manifest.from_date || dateDefaults.from_date || '',
      to_date: manifest.to_date || dateDefaults.to_date || '',
      patients_count: manifest.patients_count || countCsvRows(cohortPath(study.id)),
      ...manifest,
    });

    const sourceInfo = readResearchHchanhSourceRows(runDir, cohortPath(study.id), { sourceRunId: runId, dateDefaults });
    const { rows, file, base_file: baseFile, date_context: dateContext } = sourceInfo;
    if (!rows.length) return res.status(400).json({ status: 'error', message: `Không tìm thấy danh sách Mã BN để lấy lịch sử y lệnh trong run ${runId}. Hãy kiểm tra đã có du_lieu_ban_dau.csv/cohort.csv hoặc bấm Bước 1 trước.` });

    const files = orderHistoryDefaultFiles(req.body?.files);
    const limit = Number.isFinite(Number(req.body?.limit)) ? Math.max(0, Math.trunc(Number(req.body.limit))) : 0;

    await enqueueHeavy(ctx.sid, async () => {
      const fetched = await fetchHchanhForResearchRun(ctx, runDir, {
        sourceRows: rows,
        sourceRunId: runId,
        files,
        headless: researchHeadlessFromBody(req.body),
        force: req.body?.force === true,
        fallbackDateFrom: dateContext?.from_date || String(req.body?.fromDate || ''),
        fallbackDateTo: dateContext?.to_date || String(req.body?.toDate || ''),
        limit,
        mode: 'order_history_auto',
      });
      const normalized = normalizeRunOutputs(runDir, { sourceRunId: runId });
      const updated = updateStudy(study.id, {
        last_run_id: runId,
        last_run_at: nowIso(),
        last_normalized_at: nowIso(),
        last_order_history_auto_at: nowIso(),
      });
      return res.json({
        status: 'ok',
        message: `Đã tự động lấy ${orderHistoryRunLabel(files)} từ EMR cho nghiên cứu: xử lý=${fetched.processed}, bỏ qua=${fetched.skipped}, OK=${fetched.ok}, cần xem=${fetched.attention}, lỗi=${fetched.error}.`,
        study: updated,
        run_id: runId,
        source_file: path.basename(file || ''),
        source_base_file: path.basename(baseFile || ''),
        source_date_from: dateContext?.from_date || '',
        source_date_to: dateContext?.to_date || '',
        fetched,
        normalized,
      });
    });
  } catch (err) {
    console.error(err);
    if (!res.headersSent) res.status(500).json({ status: 'error', message: String(err.message || err) });
  }
});


router.post('/research/studies/:studyId/patient-info', async (req, res) => {
  const ctx = getRuntimePaths(req);
  try {
    const study = readStudy(req.params.studyId);
    if (!study) return res.status(404).json({ status: 'error', message: 'Không tìm thấy nghiên cứu.' });
    if (!fs.existsSync(cohortPath(study.id))) return res.status(400).json({ status: 'error', message: 'Chưa có danh sách bệnh nhân cho nghiên cứu này.' });
    if (!fs.existsSync(SCRIPT_PATH)) return res.status(500).json({ status: 'error', message: 'Thiếu script lấy dữ liệu nghiên cứu.' });
    const runId = resolveStudyRunIdForAction(study.id, req.body?.runId || 'latest');
    const runDir = path.join(runsDir(study.id), runId);
    ensureDir(runDir);
    const initialPath = path.join(runDir, 'du_lieu_ban_dau.csv');
    const samplePath = path.join(runDir, 'mau_nghien_cuu.csv');
    if (!fs.existsSync(initialPath)) fs.copyFileSync(cohortPath(study.id), initialPath);
    if (!fs.existsSync(samplePath)) fs.copyFileSync(cohortPath(study.id), samplePath);
    const archiveSourceManifest = study.cohort_source_run_id
      ? readJsonSafe(path.join(archiveRunsDir(), safeFilePart(study.cohort_source_run_id), 'manifest.json'), {}) || {}
      : {};
    const sourceInfo = readResearchHchanhSourceRows(runDir, cohortPath(study.id), {
      sourceRunId: runId,
      dateDefaults: { from_date: archiveSourceManifest.from_date || '', to_date: archiveSourceManifest.to_date || '' },
    });
    const inputPath = sourceInfo.file || cohortPath(study.id);
    const args = [
      '-u', SCRIPT_PATH,
      '--input', inputPath,
      '--project-id', study.id,
      '--run-id', runId,
      '--out-root', RESEARCH_STORE_DIR,
      '--patient-info-only',
    ];
    if (researchHeadlessFromBody(req.body)) args.push('--headless');

    await enqueueHeavy(ctx.sid, async () => {
      let result;
      try {
        result = await runPython(args, {
          cwd: ROOT_DIR,
          onSpawn: killFn => registerCancel(ctx.sid, killFn),
          extraEnv: { RESEARCH_INPUT_NAME: path.basename(inputPath) },
        });
      } finally {
        unregisterCancel(ctx.sid);
      }

      if (result.spawnError) return res.status(500).json({ status: 'error', message: `Không khởi động được Python: ${result.spawnError}` });
      if (result.killedByTimeout) return res.status(504).json({ status: 'error', message: 'Timeout khi lấy thông tin khác. Dữ liệu đã lưu từng mã BN, bấm lại để chạy tiếp.' });
      if (isStoppedRunResult(result)) {
        const normalized = normalizeRunOutputs(path.join(runsDir(study.id), runId), { sourceRunId: runId });
        const updated = updateStudy(study.id, { last_run_id: runId, last_run_at: nowIso(), last_normalized_at: nowIso(), stopped_at: nowIso() });
        return res.json({ status: 'ok', stopped: true, message: 'Đã dừng. Thông tin khác đã lấy vẫn được giữ; bấm lại để chạy tiếp.', study: updated, run_id: runId, normalized });
      }
      if (result.code !== 0) return res.status(500).json({ status: 'error', message: fmtPyError('Python lỗi khi lấy thông tin khác từ D/s Bệnh nhân. Dữ liệu đã lưu nếu chạy được một phần.', result) });

      const normalized = normalizeRunOutputs(path.join(runsDir(study.id), runId), { sourceRunId: runId });
      const updated = updateStudy(study.id, { last_run_id: runId, last_run_at: nowIso(), last_normalized_at: nowIso() });
      return res.json({ status: 'ok', message: 'Đã lấy thông tin khác: Điện thoại, Số CMND/CCCD, BHYT, địa chỉ từ D/s Bệnh nhân.', study: updated, run_id: runId, normalized });
    });
  } catch (err) {
    console.error(err);
    if (!res.headersSent) res.status(500).json({ status: 'error', message: String(err.message || err) });
  }
});

router.post('/research/studies/:studyId/run', async (req, res) => {
  const ctx = getRuntimePaths(req);
  try {
    const study = readStudy(req.params.studyId);
    if (!study) return res.status(404).json({ status: 'error', message: 'Không tìm thấy nghiên cứu.' });
    if (!fs.existsSync(cohortPath(study.id))) return res.status(400).json({ status: 'error', message: 'Chưa có danh sách bệnh nhân cho nghiên cứu này.' });
    if (!fs.existsSync(SCRIPT_PATH)) return res.status(500).json({ status: 'error', message: 'Thiếu script lấy dữ liệu nghiên cứu.' });

    const runId = safeFilePart(req.body?.runId || (req.body?.resume === false ? nowFileStamp() : chooseStudyRunIdForResume(study.id)));
    const args = [
      '-u', SCRIPT_PATH,
      '--input', cohortPath(study.id),
      '--project-id', study.id,
      '--run-id', runId,
      '--out-root', RESEARCH_STORE_DIR,
    ];
    if (req.body?.fromDate) args.push('--from-date', String(req.body.fromDate));
    if (req.body?.toDate) args.push('--to-date', String(req.body.toDate));
    if (researchHeadlessFromBody(req.body)) args.push('--headless');
    const archiveInitialListPath = study.cohort_source === 'archive' && study.cohort_source_run_id
      ? archiveTablePath('initial_list', study.cohort_source_run_id)
      : '';
    if (archiveInitialListPath && fs.existsSync(archiveInitialListPath)) {
      args.push('--archive-initial-list', archiveInitialListPath);
    }

    updateStudy(study.id, { active_run_id: runId, active_mode: 'deep' });

    await enqueueHeavy(ctx.sid, async () => {
      try {
      let result;
      try {
        result = await runPython(args, {
          cwd: ROOT_DIR,
          onSpawn: killFn => registerCancel(ctx.sid, killFn),
          extraEnv: { RESEARCH_INPUT_NAME: path.basename(cohortPath(study.id)) },
        });
      } finally {
        unregisterCancel(ctx.sid);
      }

      if (result.spawnError) return res.status(500).json({ status: 'error', message: `Không khởi động được Python: ${result.spawnError}` });
      if (result.killedByTimeout) return res.status(504).json({ status: 'error', message: 'Timeout khi lấy dữ liệu nghiên cứu. Tiến độ đã lưu, bấm Lấy thêm/tiếp tục để chạy tiếp từ ca chưa xong.' });
      if (isStoppedRunResult(result)) {
        const normalized = normalizeRunOutputs(path.join(runsDir(study.id), runId), { sourceRunId: runId });
        const updated = updateStudy(study.id, { last_run_id: runId, last_run_at: nowIso(), last_normalized_at: nowIso(), stopped_at: nowIso() });
        return res.json({ status: 'ok', stopped: true, message: 'Đã dừng. Các ca đã đủ dữ liệu đã lưu; ca đang dở sẽ được lấy lại khi bấm Lấy thêm/tiếp tục.', study: updated, run_id: runId, normalized });
      }
      if (result.code !== 0) return res.status(500).json({ status: 'error', message: fmtPyError('Python lỗi khi lấy dữ liệu nghiên cứu. Tiến độ đã lưu nếu đã chạy được một phần.', result) });

      const normalized = normalizeRunOutputs(path.join(runsDir(study.id), runId), { sourceRunId: runId });
      const updated = updateStudy(study.id, { last_run_id: runId, last_run_at: nowIso(), last_normalized_at: nowIso(), active_run_id: '', active_mode: '' });
      return res.json({ status: 'ok', message: 'Đã lấy và chuẩn hóa dữ liệu nghiên cứu.', study: updated, run_id: runId, normalized });
      } finally {
        updateStudy(study.id, { active_run_id: '', active_mode: '' });
      }
    });
  } catch (err) {
    console.error(err);
    if (!res.headersSent) res.status(500).json({ status: 'error', message: String(err.message || err) });
  }
});

module.exports = router;
