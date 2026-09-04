// server/routes/hchanh.js — /api/hchanh/*
//
// Module hành chánh hoàn toàn độc lập với bệnh phòng/trực.
// Dữ liệu lưu ở hchanh/ trong session, không đụng đến data/.
//
// Endpoints:
//   GET  /api/hchanh/index                  → danh sách BN + trạng thái fetch
//   POST /api/hchanh/sync                   → đồng bộ danh sách BN từ scan
//   POST /api/hchanh/fetch                  → fetch dữ liệu 1 BN theo scope
//   GET  /api/hchanh/patient/:ma_bn         → đọc toàn bộ data 1 BN
//   GET  /api/hchanh/dashboard              → build dashboard từ hchanh/
//   POST /api/hchanh/ticket                 → tạo/cập nhật phiếu sửa
//   GET  /api/hchanh/tickets                → đọc tất cả phiếu sửa
//   PATCH /api/hchanh/ticket/:ticketId      → cập nhật trạng thái phiếu
//   POST /api/hchanh/snapshot/:kind         → chốt snapshot sáng/chiều
//   GET  /api/hchanh/snapshot               → đọc snapshot
//   POST /api/hchanh/clear                  → xóa toàn bộ dữ liệu hành chánh
//   GET  /api/hchanh/print-ward-list        → in danh sách xếp phòng (HTML)

'use strict';

const router = require('express').Router();
const path   = require('path');
const fs     = require('fs');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');

const { getRuntimePaths, ensureSessionAssets }           = require('../services/session');
const { runScript, runWorker, fmtPyError, PYTHON_BIN }   = require('../services/python_runner');
const { enqueueHeavy, registerCancel, unregisterCancel, cancelSession } = require('../services/task_queue');
const { readJsonSafe, writeJsonAtomic, safeFilePart } = require('../utils/file');
const { appendActivity }                          = require('../services/activity_logger');
const { escapeHtml }                              = require('../utils/html');
const { rowsToCsv }                               = require('../utils/csv');
const { fetchGoogleSheetRecords, extractSpreadsheetInfo, postJsonToGoogleAppsScript, validateGoogleAppsScriptWebAppUrl } = require('../utils/google_sheet_records');
const {
  normalizeDischargePrintDates,
  dischargeDateFromRow,
  dischargeDateMatchesSelection,
} = require('../utils/discharge_print');
const { WORKER_DIR, ROOT_DIR, RUNTIME_ROOT, ALLOW_PUBLIC_GOOGLE_SHEET } = require('../constants');
const GOOGLE_SHEET_WRITE_TOKEN = String(process.env.EMR_GOOGLE_SHEET_WRITE_TOKEN || '').trim();

const {
  FETCH_SCOPES,
  hchanh_dir,
  hchanh_tickets_path,
  hchanh_snapshot_path,
  read_index,
  write_index,
  sync_index_from_patients,
  mark_fetch_error,
  clear_fetch_error,
  resolve_scope_from_tags,
  read_patient_file,
  write_patient_file,
  read_patient_all,
  check_missing_files,
  clear_patient_data,
  clear_all_hchanh_data,
  HCHANH_DATA_VERSION,
  hchanh_file_label,
  hchanh_file_stem,
} = require('../hchanh_data_contract');
const { buildHchanh_Dashboard, buildPatientCard }        = require('../services/hchanh/dashboard');
const { upsertTicket, updateTicket, readTicketStore } = require('../services/hchanh/ticket_store');
const { createSnapshot, readSnapshot }            = require('../services/hchanh/snapshot_store');
const {
  buildDashboard: buildRecordsSubmissionDashboard,
  addRecords: addRecordsSubmission,
  submitBatch: submitRecordsSubmissionBatch,
  markReturned: markRecordsSubmissionReturned,
  removeItems: removeRecordsSubmissionItems,
  updateBatchForExport: updateRecordsSubmissionBatchForExport,
  markBatchExported: markRecordsSubmissionBatchExported,
  captureHandoverSnapshots: captureRecordsSubmissionHandoverSnapshots,
  addDiscrepancy: addRecordsSubmissionDiscrepancy,
  normalizeDate: normalizeRecordsSubmissionDate,
} = require('../services/hchanh/records_submission_store');
const {
  KSD_GPB_STATUS,
  normalizeChecklist: normalizePaperChecklist,
  applyChecklistPatch: applyPaperChecklistPatch,
  paperRecordStatus,
  computeHandover,
  submissionReadiness,
  coverNoteSuggestion,
} = require('../services/hchanh/paper_record_status');
const { getKsdGpbStatus } = require('../services/hchanh/lab_result_adapter');

// ── Helper ────────────────────────────────────────────────────────────────────

function handleRoute(fn) {
  return (req, res) => {
    try {
      const ctx = getRuntimePaths(req);
      return fn(req, res, ctx);
    } catch (err) {
      console.error('[HCHANH]', err);
      return res.status(500).json({ status: 'error', message: String(err.message || err) });
    }
  };
}

function normId(v) {
  return String(v || '').trim();
}

function boolFromBody(value, fallback = false) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  const text = String(value ?? '').trim().toLowerCase();
  if (!text) return fallback;
  if (['1', 'true', 'yes', 'y', 'on', 'bat', 'bật'].includes(text)) return true;
  if (['0', 'false', 'no', 'n', 'off', 'tat', 'tắt'].includes(text)) return false;
  return fallback;
}

const TECHNICAL_FETCH_STATUSES = new Set(['error', 'no_session', 'no_url', 'timeout', 'cdha_timeout', 'missing_output', 'spawn_error', 'no_results_popup', 'no_cdha_tab', 'pending']);
const ATTENTION_FETCH_STATUSES = new Set(['empty', 'partial']);

function payloadFetchStatus(payload) {
  return String(payload?._fetch_status || '').replace(/\s+/g, ' ').trim().toLowerCase();
}

function fileFetchStatusLabel(status) {
  if (status === 'empty') return 'rỗng/chưa có nội dung';
  if (status === 'partial') return 'một phần';
  if (status === 'no_url') return 'không tìm được link hồ sơ';
  if (status === 'no_session') return 'không có phiên EMR';
  if (status === 'timeout') return 'quá thời gian lấy dữ liệu';
  if (status === 'spawn_error') return 'không khởi động được worker';
  if (status === 'error') return 'lỗi worker';
  if (status === 'no_results_popup') return 'không mở được cửa sổ Xem kết quả';
  if (status === 'no_cdha_tab') return 'không mở được tab CĐHA';
  if (status === 'cdha_timeout') return 'quá thời gian tải bảng CĐHA';
  if (status === 'missing_output') return 'worker thiếu kết quả được yêu cầu';
  if (status === 'pending') return 'worker chưa hoàn tất';
  return status || 'không rõ';
}

function normalizeFetchOutputInfo(fileKey, payload) {
  const status = payloadFetchStatus(payload);
  const label = hchanh_file_label(fileKey);
  return { key: fileKey, label, status, status_label: fileFetchStatusLabel(status), error: payload?._error || '' };
}

function missingFetchOutputInfo(fileKey) {
  return {
    key: fileKey,
    label: hchanh_file_label(fileKey),
    status: 'missing_output',
    status_label: fileFetchStatusLabel('missing_output'),
    error: 'Worker không trả về mục dữ liệu này.',
  };
}

function normalizeRowsForHchanhSync(rows, ctx) {
  const list = Array.isArray(rows) ? rows : [];
  if (!list.length) return [];

  // Nếu nguồn là data/patients.json v2 thì phòng có thể nằm ở board_state.room_assignments.
  const board = readJsonSafe(ctx.BOARD_STATE_PATH, null) || {};
  const roomMap = board && typeof board === 'object' && board.room_assignments && typeof board.room_assignments === 'object'
    ? board.room_assignments
    : {};

  return list.map(row => {
    if (!row || typeof row !== 'object') return row;
    const ma_bn = normId(row.ma_bn || row.patient_id || row.patientId || row.MaBN || row['Mã BN'] || row['Mã YT'] || row.id);
    const room = ma_bn ? (roomMap[ma_bn] || '') : '';
    return room && !row.Vi_Tri && !row.so_phong && !row.room && !row.phong
      ? { ...row, Vi_Tri: room, so_phong: room, room }
      : row;
  });
}

function rowsFromRuntimePatientsV2(ctx) {
  const payload = readJsonSafe(ctx.PATIENTS_PATH, null);
  const patients = payload && typeof payload === 'object' && payload.patients && typeof payload.patients === 'object'
    ? Object.values(payload.patients)
    : [];
  return normalizeRowsForHchanhSync(patients, ctx);
}

function readRowsForHchanhSync(ctx, bodyPatients = null) {
  if (Array.isArray(bodyPatients)) return normalizeRowsForHchanhSync(bodyPatients, ctx);

  // Ưu tiên đúng nguồn dữ liệu đã quét/đã xếp phòng hiện tại.
  const sorted = readJsonSafe(ctx.SORTED_PATH, null);
  if (Array.isArray(sorted) && sorted.length) return normalizeRowsForHchanhSync(sorted, ctx);

  const raw = readJsonSafe(ctx.RAW_PATH, null);
  if (Array.isArray(raw) && raw.length) return normalizeRowsForHchanhSync(raw, ctx);

  // Fallback v2 để module Hành chánh vẫn đồng bộ được khi dữ liệu đã được chuẩn hóa sang runtime v2.
  const v2 = rowsFromRuntimePatientsV2(ctx);
  if (v2.length) return v2;

  return [];
}


// ── Records-check index riêng ────────────────────────────────────────────────
// Tab Kiểm hồ sơ cần quét lại danh sách Hoàn tất độc lập, không lấy lại danh sách
// đang nằm khoa/sorted từ các tab trực hoặc hành chánh. Index này chỉ lưu danh sách
// ca Hoàn tất; dữ liệu chi tiết vẫn tái sử dụng hchanh/patients/{ma_bn}/.

function records_check_persistent_dir(_ctx = null) {
  const dir = path.join(RUNTIME_ROOT, 'records_check');
  try { fs.mkdirSync(dir, { recursive: true }); } catch (_) {}
  return dir;
}

function records_check_index_path(ctx) {
  return path.join(records_check_persistent_dir(ctx), 'records_check_index.json');
}

function records_check_google_sheet_cache_path(ctx) {
  return path.join(records_check_persistent_dir(ctx), 'google_sheet_records.json');
}

function records_check_google_sheet_config_path() {
  return path.join(ROOT_DIR, 'config', 'hchanh', 'records_check_google_sheet.json');
}

function resolve_records_check_source_file(rawPath) {
  const value = String(rawPath || '').trim();
  if (!value) return '';
  const allowedRoots = [
    path.join(ROOT_DIR, 'config', 'hchanh', 'imports'),
    path.join(RUNTIME_ROOT, 'imports'),
  ].map(root => path.resolve(root));
  const candidate = path.resolve(path.isAbsolute(value) ? value : path.join(ROOT_DIR, 'config', 'hchanh', 'imports', value));
  if (!allowedRoots.some(root => candidate === root || candidate.startsWith(root + path.sep))) {
    throw new Error('File CSV phải nằm trong config/hchanh/imports hoặc .runtime/imports.');
  }
  return candidate;
}

function read_records_check_google_sheet_config() {
  const fallback = {
    enabled: false,
    spreadsheet_url: '',
    source_file: '',
    sheet_gid: '0',
    auto_sync_on_open: false,
    timeout_ms: 20000,
    write_web_app_url: '',
    write_timeout_ms: 20000,
  };
  const loaded = readJsonSafe(records_check_google_sheet_config_path(), null);
  const config = (!loaded || typeof loaded !== 'object' || Array.isArray(loaded)) ? fallback : { ...fallback, ...loaded };
  const hasPublicUrl = Boolean(String(config.spreadsheet_url || '').trim());
  const writeWebAppUrl = String(config.write_web_app_url || '').trim();
  let writeConfigError = '';
  if (writeWebAppUrl) {
    try { validateGoogleAppsScriptWebAppUrl(writeWebAppUrl); }
    catch (err) { writeConfigError = String(err.message || err); }
  }
  return {
    ...config,
    source_file_resolved: resolve_records_check_source_file(config.source_file),
    public_sheet_blocked: hasPublicUrl && !ALLOW_PUBLIC_GOOGLE_SHEET,
    write_web_app_url: writeWebAppUrl,
    write_config_error: writeConfigError,
    write_configured: Boolean(writeWebAppUrl && GOOGLE_SHEET_WRITE_TOKEN && !writeConfigError),
  };
}

function read_records_check_google_sheet_cache(ctx) {
  const cache = readJsonSafe(records_check_google_sheet_cache_path(ctx), null);
  if (!cache || typeof cache !== 'object' || Array.isArray(cache)) {
    return {
      status: 'ok',
      enabled: Boolean(read_records_check_google_sheet_config().enabled),
      records: [],
      count: 0,
      fetched_at: '',
      stale: true,
    };
  }
  const records = Array.isArray(cache.records) ? cache.records : [];
  const { spreadsheet_url: _spreadsheetUrl, source_url: _sourceUrl, spreadsheet_id: _spreadsheetId, ...safeCache } = cache;
  return { ...safeCache, status: 'ok', records, count: records.length };
}

function googleSheetRecordIdentity(record) {
  const full = String(record?.storage_full_key || '').trim();
  const number = String(record?.storage_number || record?.storage_key || '').trim();
  const name = String(record?.patient_name_normalized || record?.patient_name || '').trim().toLowerCase();
  return `${full || `number::${number}`}::${name || '__missing_name__'}`;
}

function googleSheetRecordFingerprint(record) {
  const selected = {
    timestamp: String(record?.timestamp || ''),
    timestamp_ms: Number(record?.timestamp_ms ?? -1),
    storage_raw: String(record?.storage_raw || ''),
    storage_full_key: String(record?.storage_full_key || ''),
    patient_name: String(record?.patient_name || ''),
    row_number: Number(record?.row_number || 0),
  };
  return crypto.createHash('sha1').update(JSON.stringify(selected), 'utf8').digest('hex');
}

function compareGoogleSheetRecords(previousRecords, nextRecords) {
  const previous = new Map();
  const next = new Map();
  for (const record of Array.isArray(previousRecords) ? previousRecords : []) {
    previous.set(googleSheetRecordIdentity(record), googleSheetRecordFingerprint(record));
  }
  for (const record of Array.isArray(nextRecords) ? nextRecords : []) {
    next.set(googleSheetRecordIdentity(record), googleSheetRecordFingerprint(record));
  }

  let added = 0;
  let removed = 0;
  let updated = 0;
  for (const [key, fingerprint] of next.entries()) {
    if (!previous.has(key)) added += 1;
    else if (previous.get(key) !== fingerprint) updated += 1;
  }
  for (const key of previous.keys()) {
    if (!next.has(key)) removed += 1;
  }
  return { added, updated, removed, unchanged: added === 0 && updated === 0 && removed === 0 };
}

function records_check_legacy_session_index_path(ctx) {
  return path.join(hchanh_dir(ctx), 'records_check_index.json');
}

// Bản sao riêng chỉ lưu trạng thái Đã kiểm và tombstone bỏ kiểm. File này không
// bị thay thế khi quét lại danh sách, nên có thể phục hồi checklist nếu index đổi
// case_key hoặc bị ghi lại từ dữ liệu cũ.
function records_check_checked_backup_path(ctx) {
  return path.join(records_check_persistent_dir(ctx), 'records_check_checked_state.json');
}

function records_check_pdf_recovery_marker_path(ctx) {
  return path.join(records_check_persistent_dir(ctx), 'records_check_checked_recovery.json');
}

function mergeRecordsCheckedEventMap(target, source) {
  let changed = false;
  for (const [key, incoming] of Object.entries(source || {})) {
    if (!incoming || typeof incoming !== 'object') continue;
    const current = target[key];
    const incomingTime = recordsCheckedEventTime(incoming);
    const currentTime = recordsCheckedEventTime(current || {});
    const incomingWins = !current
      || incomingTime > currentTime
      || (incomingTime === currentTime && incoming.checked === false && current.checked !== false);
    if (!incomingWins) continue;
    target[key] = { ...incoming };
    changed = true;
  }
  return changed;
}

function asPlainObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function mergeRecordsCheckedBackupIntoIndex(ctx, index) {
  const backup = readJsonSafe(records_check_checked_backup_path(ctx), null);
  if (!backup || typeof backup !== 'object') return false;
  index.checked = asPlainObject(index.checked);
  index.checked_aliases = asPlainObject(index.checked_aliases);
  index.checklist = asPlainObject(index.checklist);
  index.checklist_aliases = asPlainObject(index.checklist_aliases);
  const changedKeys = mergeRecordsCheckedEventMap(index.checked, backup.checked || {});
  const changedAliases = mergeRecordsCheckedEventMap(index.checked_aliases, backup.checked_aliases || {});
  // Checklist hồ sơ giấy (bác sĩ/điều dưỡng/trưởng khoa ký, note bìa) dùng lại
  // đúng cơ chế backup + merge theo thời gian đã chạy ổn định cho dấu "Đã kiểm",
  // để không mất dữ liệu khi index.json bị ghi lại hoặc case_key đổi sau quét lại.
  const changedChecklistKeys = mergeRecordsCheckedEventMap(index.checklist, backup.checklist || {});
  const changedChecklistAliases = mergeRecordsCheckedEventMap(index.checklist_aliases, backup.checklist_aliases || {});
  return changedKeys || changedAliases || changedChecklistKeys || changedChecklistAliases;
}

function persistRecordsCheckedBackup(ctx, index) {
  const payload = {
    version: 2,
    updatedAt: new Date().toISOString(),
    checked: asPlainObject(index?.checked),
    checked_aliases: asPlainObject(index?.checked_aliases),
    checklist: asPlainObject(index?.checklist),
    checklist_aliases: asPlainObject(index?.checklist_aliases),
  };
  writeJsonAtomic(records_check_checked_backup_path(ctx), payload);
  return payload;
}

function records_check_patient_dir(ctx, case_key) {
  const safeId = safeFilePart(records_storage_key(case_key) || 'unknown');
  const dir = path.join(records_check_persistent_dir(ctx), 'patients', safeId);
  try { fs.mkdirSync(dir, { recursive: true }); } catch (_) {}
  return dir;
}

function records_check_patient_file(ctx, case_key, fileKey) {
  return path.join(records_check_patient_dir(ctx, case_key), `${hchanh_file_stem(fileKey)}.json`);
}

function read_records_patient_file(ctx, case_key, fileKey) {
  const filePath = records_check_patient_file(ctx, case_key, fileKey);
  const data = readJsonSafe(filePath, null);
  if (data !== null && data !== undefined) return data;
  // Tương thích dữ liệu cũ đang nằm trong session/hchanh/patients.
  return read_patient_file(ctx, records_storage_key(case_key), fileKey);
}

function write_records_patient_file(ctx, case_key, fileKey, payload) {
  const data = payload && typeof payload === 'object' && !Array.isArray(payload)
    ? { ...payload, _meta: { ...(payload._meta || {}), records_check_persistent: true, saved_at: new Date().toISOString() } }
    : payload;
  writeJsonAtomic(records_check_patient_file(ctx, case_key, fileKey), data);
  return data;
}

function read_records_patient_all(ctx, case_key) {
  const out = {};
  for (const fileKey of RECORDS_CHECK_FILES) {
    const data = read_records_patient_file(ctx, case_key, fileKey);
    if (data !== null && data !== undefined) out[fileKey] = data;
  }
  return out;
}

function read_records_check_index(ctx) {
  const persistentPath = records_check_index_path(ctx);
  const data = readJsonSafe(persistentPath, null);
  if (data && typeof data === 'object' && data.patients && typeof data.patients === 'object') {
    mergeRecordsCheckedBackupIntoIndex(ctx, data);
    return data;
  }

  // Tự migrate nhẹ dữ liệu cũ từ session hiện tại sang kho cố định.
  const legacy = readJsonSafe(records_check_legacy_session_index_path(ctx), null);
  if (legacy && typeof legacy === 'object' && legacy.patients && typeof legacy.patients === 'object') {
    const migrated = { ...legacy, migratedFromSession: ctx.sid || 'default', migratedAt: new Date().toISOString() };
    mergeRecordsCheckedBackupIntoIndex(ctx, migrated);
    writeJsonAtomic(persistentPath, migrated);
    persistRecordsCheckedBackup(ctx, migrated);
    return migrated;
  }
  const empty = { version: HCHANH_DATA_VERSION, updatedAt: null, lastScan: null, patients: {}, checked: {}, checked_aliases: {}, checklist: {}, checklist_aliases: {} };
  mergeRecordsCheckedBackupIntoIndex(ctx, empty);
  return empty;
}

function write_records_check_index(ctx, index) {
  const out = { ...index, version: HCHANH_DATA_VERSION, updatedAt: new Date().toISOString(), persistent: true };
  writeJsonAtomic(records_check_index_path(ctx), out);
  persistRecordsCheckedBackup(ctx, out);
  return out;
}

const RECORDS_CHECK_FILES = ['discharge', 'cls'];

function records_storage_key(metaOrKey) {
  if (metaOrKey && typeof metaOrKey === 'object') {
    return String(metaOrKey.case_key || metaOrKey.encounter_key || metaOrKey.storage_key || metaOrKey.ma_bn || '').trim();
  }
  return String(metaOrKey || '').trim();
}

function mark_records_fetch_error(ctx, case_key, error_msg) {
  const key = records_storage_key(case_key);
  if (!key) return read_records_check_index(ctx);
  const index = read_records_check_index(ctx);
  const meta = index.patients?.[key];
  if (!meta) return index;
  const now = new Date();
  const failures = Math.max(0, Number(meta.fetch_failure_count || 0)) + 1;
  const retryMinutes = Math.min(30, failures <= 1 ? 1 : (failures <= 2 ? 5 : (failures <= 3 ? 15 : 30)));
  meta.fetch_error = String(error_msg || '').slice(0, 500);
  meta.fetch_error_at = now.toISOString();
  meta.fetch_failure_count = failures;
  meta.next_retry_at = new Date(now.getTime() + retryMinutes * 60 * 1000).toISOString();
  return write_records_check_index(ctx, index);
}

function clear_records_fetch_error(ctx, case_key) {
  const key = records_storage_key(case_key);
  if (!key) return read_records_check_index(ctx);
  const index = read_records_check_index(ctx);
  const meta = index.patients?.[key];
  if (!meta) return index;
  meta.fetch_error = null;
  meta.fetch_error_at = null;
  meta.fetch_failure_count = 0;
  meta.next_retry_at = null;
  meta.last_fetch_success_at = new Date().toISOString();
  return write_records_check_index(ctx, index);
}

function mark_records_fetch_attempt(ctx, case_key) {
  const key = records_storage_key(case_key);
  if (!key) return read_records_check_index(ctx);
  const index = read_records_check_index(ctx);
  const meta = index.patients?.[key];
  if (!meta) return index;
  meta.fetch_attempt_count = Math.max(0, Number(meta.fetch_attempt_count || 0)) + 1;
  meta.last_fetch_attempt_at = new Date().toISOString();
  return write_records_check_index(ctx, index);
}

function mark_records_file_fetched(ctx, case_key, file_key) {
  const key = records_storage_key(case_key);
  if (!key) return read_records_check_index(ctx);
  const index = read_records_check_index(ctx);
  const meta = index.patients?.[key];
  if (!meta) return index;
  meta.fetched = { ...(meta.fetched || {}), [file_key]: new Date().toISOString() };
  return write_records_check_index(ctx, index);
}

function update_records_storage_from_discharge(ctx, case_key, dischargePayload) {
  const storage = firstStorageText(dischargePayload || {});
  const dischargeTime = recordsFirstDateText(
    dischargePayload?.raw_time,
    [dischargePayload?.gio_ra, dischargePayload?.ngay_ra].filter(Boolean).join(' '),
    dischargePayload?.ngay_ra
  );
  if (!storage && !dischargeTime) return read_records_check_index(ctx);
  const key = records_storage_key(case_key);
  if (!key) return read_records_check_index(ctx);
  const index = read_records_check_index(ctx);
  const meta = index.patients?.[key];
  if (!meta) return index;
  if (storage) {
    meta.so_luu_tru = storage;
    meta.storage_no = storage;
    meta.storage_updated_at = new Date().toISOString();
  }
  if (dischargeTime) {
    meta.discharge_time = dischargeTime;
    meta.discharge_updated_at = new Date().toISOString();
  }
  return write_records_check_index(ctx, index);
}

function firstRowText(row, keys, fallback = '') {
  for (const key of keys) {
    const value = row && typeof row === 'object' ? row[key] : null;
    const text = String(value ?? '').replace(/\s+/g, ' ').trim();
    if (text) return text;
  }
  return fallback;
}

const STORAGE_FIELD_KEYS = [
  'so_luu_tru', 'soLuuTru', 'SoLuuTru', 'storage_no', 'storageNo', 'storage',
  'ma_luu_tru', 'maLuuTru', 'so_hsba', 'soHSBA', 'SoHSBA',
  'Số lưu trữ', 'So luu tru', 'Số HSBA', 'So HSBA', 'Số hồ sơ', 'So ho so',
];

function isLikelyStorageText(value) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  if (!text) return false;
  const norm = text.normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd').replace(/Đ/g, 'D').toLowerCase();
  if (['binh thuong', 'tai nan', 'khong', 'co', 'hen kham', 'khong hen kham', 'ra vien'].includes(norm)) return false;
  return /\d/.test(text);
}

function firstStorageText(...sources) {
  for (const source of sources) {
    const direct = firstRowText(source, STORAGE_FIELD_KEYS, '');
    if (isLikelyStorageText(direct)) return direct;
    if (source && typeof source === 'object') {
      for (const [key, value] of Object.entries(source)) {
        const keyNorm = String(key || '')
          .normalize('NFD').replace(/[̀-ͯ]/g, '')
          .replace(/đ/g, 'd').replace(/Đ/g, 'D')
          .toLowerCase();
        if ((keyNorm.includes('luu') && keyNorm.includes('tru')) || keyNorm.includes('hsba')) {
          const text = String(value ?? '').replace(/\s+/g, ' ').trim();
          if (isLikelyStorageText(text)) return text;
        }
      }
    }
  }
  return '';
}

function records_row_id(row) {
  return firstRowText(row, [
    'ma_bn', 'patient_id', 'patientId', 'MaBN', 'Ma_BN', 'mabn', 'maBenhNhan',
    'Mã BN', 'Ma BN', 'Mã bệnh nhân', 'Ma benh nhan', 'Mã YT', 'Ma YT', 'ma_yt', 'id',
  ]);
}

function records_discharge_time_from_row(row, fallback = '') {
  return firstRowText(row, [
    'ngay_ra_vien', 'ngay_ra', 'discharge_time', 'discharge_date', 'raw_discharge_time',
    'T/G ra', 'TG ra', 'Thời gian ra', 'Thời gian ra viện', 'Ngày ra viện', 'Ngày ra',
  ], fallback);
}

function records_episode_id_from_row(row, fallback = '') {
  return firstRowText(row, [
    'tiepnhanid', 'tiep_nhan_id', 'TiepNhanID',
    'ma_luot_dieu_tri', 'treatment_id', 'ma_dieu_tri', 'so_vao_vien', 'visit_id',
    'encounter_id', 'hospital_visit_id', 'Mã lượt điều trị',
  ], fallback);
}

function stableHashText(value) {
  return crypto.createHash('sha1').update(String(value || ''), 'utf8').digest('hex').slice(0, 12);
}

function rowStableText(row) {
  if (!row || typeof row !== 'object') return '';
  return Object.keys(row).sort()
    .filter(key => !/url|href|link|usid|session|token|record_link_error/i.test(key))
    .map(key => `${key}=${String(row[key] ?? '').replace(/\s+/g, ' ').trim()}`)
    .join('|');
}

function recordsStrongIdsFromRow(row = {}) {
  const urls = [row?.record_doctor_url, row?.doctor_url, row?.record_nursing_url, row?.nursing_url];
  let urlNoiTru = '';
  let urlEpisode = '';
  for (const value of urls) {
    const ids = recordsIdsFromUrl(value);
    if (!urlNoiTru && ids.noitruid) urlNoiTru = ids.noitruid;
    if (!urlEpisode && ids.tiepnhanid) urlEpisode = ids.tiepnhanid;
  }
  return {
    noitruid: firstRowText(row, ['noitruid', 'noi_tru_id', 'NoiTruID'], '') || urlNoiTru,
    episode_id: firstRowText(row, ['episode_id'], '') || records_episode_id_from_row(row, '') || urlEpisode,
  };
}

function records_case_key(row) {
  const ma_bn = records_row_id(row);
  const admission_time = firstRowText(row, ['thoi_gian_vao_khoa', 'ward_admission_time', 'admission_time', 'tg_vao', 'thoi_gian_vao', 'T/G vào', 'Thời gian vào khoa', 'Ngày vào viện', 'Ngày vào'], '');
  const department = firstRowText(row, ['ten_khoa_dieu_tri', 'department_name', 'khoa_dieu_tri', 'department', 'khoa_chuyen_den', 'Tên khoa điều trị', 'Khoa điều trị', 'Khoa chuyển đến'], '');
  const discharge_time = records_discharge_time_from_row(row, '');
  const strongIds = recordsStrongIdsFromRow(row);
  const explicit = strongIds.noitruid || strongIds.episode_id || firstRowText(row, [
    'encounter_key', 'encounterKey', 'ma_luot_dieu_tri', 'treatment_id', 'ma_dieu_tri', 'so_vao_vien', 'visit_id', 'Mã lượt điều trị'
  ], '');
  if (explicit) return `${ma_bn || 'BN'}::${explicit}`;
  const base = [ma_bn, admission_time, discharge_time, department].filter(Boolean).join('::') || ma_bn;
  // Không dùng riêng ma_bn làm key. Nếu EMR không cho mã lượt thì hash chỉ lấy
  // trường ổn định của chính dòng nguồn, không gộp với dòng khác theo ngày vào.
  return `${base}::${stableHashText(rowStableText(row))}`;
}

function records_meta_from_row(row, existing = {}, ctx = {}, case_key = '') {
  const ma_bn = records_row_id(row);
  const admission_time = firstRowText(row, ['thoi_gian_vao_khoa', 'ward_admission_time', 'admission_time', 'tg_vao', 'thoi_gian_vao', 'T/G vào', 'Thời gian vào khoa', 'Ngày vào viện', 'Ngày vào'], existing.admission_time || '');
  const department = firstRowText(row, ['ten_khoa_dieu_tri', 'department_name', 'khoa_dieu_tri', 'department', 'khoa_chuyen_den', 'Tên khoa điều trị', 'Khoa điều trị', 'Khoa chuyển đến'], existing.department || '');
  const discharge_time = records_discharge_time_from_row(row, existing.discharge_time || '');
  const encounter_key = case_key || firstRowText(row, ['encounter_key', 'encounterKey', 'ma_luot_dieu_tri', 'treatment_id', 'ma_dieu_tri', 'so_vao_vien', 'visit_id', 'Mã lượt điều trị'], '') || (admission_time || department ? `${ma_bn}::${admission_time}::${department}` : ma_bn);
  return {
    ...existing,
    ma_bn,
    case_key: encounter_key,
    encounter_key,
    active: true,
    stale: false,
    records_check: true,
    last_seen_at: new Date().toISOString(),
    last_seen_session_id: ctx.sid || '',
    admission_time,
    discharge_time,
    department,
    so_luu_tru: firstStorageText(row, existing.source_row || {}, existing),
    inpatient_status: 'Hoàn tất',
    source_row: { ...(existing.source_row || {}), ...(row || {}) },
    noitruid: recordsStrongIdsFromRow(row).noitruid || existing.noitruid || '',
    episode_id: recordsStrongIdsFromRow(row).episode_id || existing.episode_id || '',
    tiepnhanid: firstRowText(row, ['tiepnhanid', 'tiep_nhan_id', 'TiepNhanID'], recordsStrongIdsFromRow(row).episode_id || existing.tiepnhanid || ''),
    record_doctor_url: firstRowText(row, ['record_doctor_url', 'doctor_url', 'patient_doctor_url', 'emr_doctor_url'], existing.record_doctor_url || ''),
    record_nursing_url: firstRowText(row, ['record_nursing_url', 'nursing_url', 'patient_nursing_url', 'emr_nursing_url'], existing.record_nursing_url || ''),
    ho_ten: firstRowText(row, ['ho_ten', 'name', 'patientName', 'patient_name', 'Họ tên', 'Ho ten', 'Tên bệnh nhân', 'Ten benh nhan'], existing.ho_ten || ''),
    phong: firstRowText(row, ['Vi_Tri', 'vi_tri', 'so_phong', 'phong', 'room', 'bed', 'phong_giuong', 'Phòng', 'Phong', 'Phòng/Giường', 'Phong/Giuong', 'Vị trí', 'Vi tri'], existing.phong || ''),
    workflow_tags: ['DISCHARGE'],
    scope_default: 'discharge',
    fetched: existing.fetched || {
      profile: null,
      discharge: null,
      billing: null,
      bed_days: null,
      surgery: null,
      order_history: null,
      cls: null,
    },
    fetch_error: existing.fetch_error || null,
    fetch_error_at: existing.fetch_error_at || null,
    fetch_attempt_count: Number(existing.fetch_attempt_count || 0) || 0,
    fetch_failure_count: Number(existing.fetch_failure_count || 0) || 0,
    last_fetch_attempt_at: existing.last_fetch_attempt_at || null,
    last_fetch_success_at: existing.last_fetch_success_at || null,
    next_retry_at: existing.next_retry_at || null,
  };
}

function recordsTextEq(a, b) {
  return String(a ?? '').replace(/\s+/g, ' ').trim().toLowerCase() === String(b ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
}

function findExistingRecordsEntry(index, row, caseKey) {
  if (index.patients?.[caseKey]) return { indexKey: caseKey, meta: index.patients[caseKey] };

  const maBn = records_row_id(row);
  const incoming = recordsStrongIdsFromRow(row);
  if (!maBn || (!incoming.noitruid && !incoming.episode_id)) return null;

  for (const [indexKey, meta] of Object.entries(index.patients || {})) {
    if (!meta || !recordsTextEq(meta.ma_bn, maBn)) continue;
    const current = recordsStrongIdsFromRow({ ...(meta.source_row || {}), ...meta });
    if (incoming.noitruid && current.noitruid && recordsTextEq(incoming.noitruid, current.noitruid)) {
      return { indexKey, meta, score: 120 };
    }
    if (incoming.episode_id && current.episode_id && recordsTextEq(incoming.episode_id, current.episode_id)) {
      return { indexKey, meta, score: 100 };
    }
  }
  // Không ghép chỉ vì trùng mã BN, ngày vào hoặc khoa. Mỗi dòng nguồn là một lượt độc lập.
  return null;
}


function recordsAliasText(value) {
  return String(value ?? '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd').replace(/Đ/g, 'D')
    .replace(/\s+/g, ' ').trim().toLowerCase();
}

function recordsAliasId(value) {
  return String(value ?? '').replace(/\s+/g, '').trim().toLowerCase();
}

function recordsAliasDate(value) {
  const n = recordsDateSortNumber(value);
  if (Number.isFinite(n) && n > 0) return String(n);
  return recordsAliasText(value).replace(/\s+/g, '');
}

function recordsIdsFromUrl(value) {
  const text = String(value || '').trim();
  if (!text) return {};
  try {
    const parsed = new URL(text, 'http://records-check.local');
    return {
      noitruid: parsed.searchParams.get('noitruid') || '',
      tiepnhanid: parsed.searchParams.get('tiepnhanid') || parsed.searchParams.get('tiepnhan') || '',
    };
  } catch (_) {
    const noitru = text.match(/[?&]noitruid=([^&#]+)/i);
    const tiepnhan = text.match(/[?&](?:tiepnhanid|tiepnhan)=([^&#]+)/i);
    return {
      noitruid: noitru ? decodeURIComponent(noitru[1]) : '',
      tiepnhanid: tiepnhan ? decodeURIComponent(tiepnhan[1]) : '',
    };
  }
}

function recordsAliasesFromCaseKey(caseKey) {
  const key = String(caseKey || '').trim();
  if (!key) return [];
  const out = [`key::${key}`];
  const direct = key.match(/^(episode|storage|admission|noitru|tiepnhan)::(.+)$/i);
  if (direct) out.push(`${direct[1].toLowerCase()}::${direct[2]}`);

  const parts = key.split('::').map(part => String(part || '').trim());
  if (parts[0] === 'episode' && parts[1] && parts[2]) {
    out.push(`episode::${recordsAliasId(parts[1])}::${recordsAliasId(parts[2])}`);
  } else if (parts[0] && parts[1]) {
    const maBn = recordsAliasId(parts[0]);
    const second = String(parts[1] || '').trim();
    const dateKey = recordsAliasDate(second);
    // Chỉ nhận đúng định dạng thời gian/ngày. Regex cũ bắt nhầm UUID có dấu “-”
    // thành ngày vào viện, từ đó tạo alias admission sai cho noitruid.
    const looksLikeAdmission = /^(?:(?:\d{1,2})[:h](?:\d{1,2})\s+)?(?:\d{1,2})[/. -](?:\d{1,2})[/. -](?:\d{4})(?:\s+(?:\d{1,2})[:h](?:\d{1,2}))?$/.test(second)
      || /^(?:\d{4})-(?:\d{1,2})-(?:\d{1,2})(?:[ T](?:\d{1,2}):(?:\d{1,2}))?$/.test(second);
    if (looksLikeAdmission) {
      if (dateKey) out.push(`admission::${maBn}::${dateKey}`);
      if (dateKey && parts[2]) out.push(`admission-dept::${maBn}::${dateKey}::${recordsAliasText(parts[2])}`);
    } else if (recordsAliasId(second)) {
      // Key mới dạng ma_bn::noitruid.
      out.push(`noitru::${maBn}::${recordsAliasId(second)}`);
    }
  }
  return [...new Set(out.filter(Boolean))];
}

function recordsIdentityAliases(rowOrMeta = {}, explicitKey = '') {
  const source = rowOrMeta?.source_row && typeof rowOrMeta.source_row === 'object' ? rowOrMeta.source_row : {};
  const maBnRaw = records_row_id(rowOrMeta) || records_row_id(source) || firstRowText(rowOrMeta, ['ma_bn'], '');
  const maBn = recordsAliasId(maBnRaw);
  const aliases = new Set(recordsAliasesFromCaseKey(explicitKey || records_storage_key(rowOrMeta)));
  if (!maBn) return [...aliases];

  const urlValues = [
    rowOrMeta?.record_doctor_url, rowOrMeta?.doctor_url, rowOrMeta?.record_nursing_url, rowOrMeta?.nursing_url,
    source?.record_doctor_url, source?.doctor_url, source?.record_nursing_url, source?.nursing_url,
  ];
  let urlNoiTru = '';
  let urlTiepNhan = '';
  for (const value of urlValues) {
    const ids = recordsIdsFromUrl(value);
    if (!urlNoiTru && ids.noitruid) urlNoiTru = ids.noitruid;
    if (!urlTiepNhan && ids.tiepnhanid) urlTiepNhan = ids.tiepnhanid;
  }

  const noitruid = firstRowText(rowOrMeta, ['noitruid', 'noi_tru_id', 'NoiTruID'], '')
    || firstRowText(source, ['noitruid', 'noi_tru_id', 'NoiTruID'], '')
    || urlNoiTru;
  const episodeId = records_episode_id_from_row(rowOrMeta, '')
    || records_episode_id_from_row(source, '')
    || urlTiepNhan;
  const tiepnhanid = firstRowText(rowOrMeta, ['tiepnhanid', 'tiep_nhan_id', 'TiepNhanID'], '')
    || firstRowText(source, ['tiepnhanid', 'tiep_nhan_id', 'TiepNhanID'], '')
    || urlTiepNhan;
  const storage = firstStorageText(rowOrMeta, source);
  const admission = firstRowText(rowOrMeta, ['thoi_gian_vao_khoa', 'ward_admission_time', 'admission_time', 'tg_vao', 'thoi_gian_vao', 'T/G vào', 'Thời gian vào khoa', 'Ngày vào viện', 'Ngày vào'], '')
    || firstRowText(source, ['thoi_gian_vao_khoa', 'ward_admission_time', 'admission_time', 'tg_vao', 'thoi_gian_vao', 'T/G vào', 'Thời gian vào khoa', 'Ngày vào viện', 'Ngày vào'], '');
  const department = firstRowText(rowOrMeta, ['ten_khoa_dieu_tri', 'department_name', 'khoa_dieu_tri', 'department', 'khoa_chuyen_den', 'Tên khoa điều trị', 'Khoa điều trị', 'Khoa chuyển đến'], '')
    || firstRowText(source, ['ten_khoa_dieu_tri', 'department_name', 'khoa_dieu_tri', 'department', 'khoa_chuyen_den', 'Tên khoa điều trị', 'Khoa điều trị', 'Khoa chuyển đến'], '');

  if (noitruid) aliases.add(`noitru::${maBn}::${recordsAliasId(noitruid)}`);
  if (episodeId) aliases.add(`episode::${maBn}::${recordsAliasId(episodeId)}`);
  if (tiepnhanid) aliases.add(`tiepnhan::${maBn}::${recordsAliasId(tiepnhanid)}`);
  if (storage) aliases.add(`storage::${maBn}::${recordsAliasId(storage)}`);
  const admissionKey = recordsAliasDate(admission);
  if (admissionKey) {
    aliases.add(`admission::${maBn}::${admissionKey}`);
    if (department) aliases.add(`admission-dept::${maBn}::${admissionKey}::${recordsAliasText(department)}`);
  }
  return [...aliases].filter(Boolean);
}

function recordsCheckedEventTime(entry = {}) {
  const raw = entry.changed_at || entry.checked_at || entry.unchecked_at || entry.updated_at || '';
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : 0;
}

function recordsCheckedAliasesForState(aliases = []) {
  // Tab Kiểm hồ sơ hiển thị từng dòng nguồn độc lập. Chỉ bí danh key chính xác
  // được dùng để lưu và khôi phục dấu Đã kiểm; không lan trạng thái theo lượt,
  // số lưu trữ hoặc ngày vào viện sang một dòng nguồn khác.
  return [...new Set((aliases || [])
    .map(value => String(value || '').trim())
    .filter(alias => alias.startsWith('key::')))];
}

function setRecordsCheckedAliasState(index, aliases, checked, changedAt, checkedAt = '') {
  index.checked_aliases = index.checked_aliases && typeof index.checked_aliases === 'object' && !Array.isArray(index.checked_aliases)
    ? index.checked_aliases : {};
  for (const alias of recordsCheckedAliasesForState(aliases)) {
    if (!alias) continue;
    index.checked_aliases[alias] = checked
      ? { checked: true, checked_at: checkedAt || changedAt, changed_at: changedAt }
      : { checked: false, unchecked_at: changedAt, changed_at: changedAt };
  }
}

function ensureRecordsCheckedAliases(index) {
  index.checked = index.checked && typeof index.checked === 'object' && !Array.isArray(index.checked) ? index.checked : {};
  index.checked_aliases = index.checked_aliases && typeof index.checked_aliases === 'object' && !Array.isArray(index.checked_aliases)
    ? index.checked_aliases : {};
  for (const [key, value] of Object.entries(index.checked)) {
    if (!value?.checked) continue;
    const meta = index.patients?.[key];
    const changedAt = value.checked_at || value.changed_at || new Date(0).toISOString();
    for (const alias of recordsCheckedAliasesForState(recordsIdentityAliases(meta || {}, key))) {
      const old = index.checked_aliases[alias];
      // Không hồi sinh một dấu đã được người dùng chủ động bỏ sau đó.
      if (old && old.checked === false && recordsCheckedEventTime(old) >= recordsCheckedEventTime(value)) continue;
      if (!old || recordsCheckedEventTime(old) <= recordsCheckedEventTime(value)) {
        index.checked_aliases[alias] = { checked: true, checked_at: value.checked_at || changedAt, changed_at: changedAt };
      }
    }
  }
  for (const [key, meta] of Object.entries(index.patients || {})) {
    if (!meta?.checked) continue;
    const changedAt = meta.checked_at || new Date(0).toISOString();
    for (const alias of recordsCheckedAliasesForState(recordsIdentityAliases(meta, key))) {
      const old = index.checked_aliases[alias];
      if (old && old.checked === false && recordsCheckedEventTime(old) >= recordsCheckedEventTime(meta)) continue;
      const changedMs = Date.parse(changedAt);
      if (!old || recordsCheckedEventTime(old) <= (Number.isFinite(changedMs) ? changedMs : 0)) {
        index.checked_aliases[alias] = { checked: true, checked_at: changedAt, changed_at: changedAt };
      }
    }
  }
  return index.checked_aliases;
}

function resolveRecordsCheckedState(index, aliases = [], candidateKeys = []) {
  const events = [];
  for (const key of candidateKeys || []) {
    const entry = index.checked?.[key];
    if (entry?.checked) events.push({ ...entry, checked: true, _priority: 2 });
    const keyAlias = index.checked_aliases?.[`key::${String(key || '').trim()}`];
    if (keyAlias && typeof keyAlias === 'object') events.push({ ...keyAlias, _priority: 3 });
  }
  for (const alias of recordsCheckedAliasesForState(aliases)) {
    if (String(alias || '').startsWith('key::')) continue; // đã xử lý theo candidateKeys phía trên
    const entry = index.checked_aliases?.[alias];
    if (entry && typeof entry === 'object') events.push({ ...entry, _priority: 1 });
  }
  if (!events.length) return null;
  events.sort((a, b) => recordsCheckedEventTime(b) - recordsCheckedEventTime(a) || Number(b._priority || 0) - Number(a._priority || 0) || Number(Boolean(a.checked)) - Number(Boolean(b.checked)));
  const latest = events[0];
  return {
    checked: Boolean(latest.checked),
    checked_at: latest.checked_at || null,
    changed_at: latest.changed_at || latest.checked_at || latest.unchecked_at || null,
  };
}

// ── Checklist hồ sơ giấy (bác sĩ/điều dưỡng/trưởng khoa ký, note bìa) ───────
// Dùng lại nguyên xi cơ chế key + alias + backup đã chạy ổn định cho dấu "Đã
// kiểm" ở trên, chỉ đổi map lưu (index.checklist / index.checklist_aliases) và
// không có khái niệm tombstone "bỏ chọn" vì mỗi trường chỉ là true/false hiện tại,
// không phải sự kiện có thể bị thu hồi như "Đã kiểm".

function setRecordsChecklistAliasState(index, aliases, checklistEvent, changedAt) {
  index.checklist_aliases = asPlainObject(index.checklist_aliases);
  for (const alias of recordsCheckedAliasesForState(aliases)) {
    if (!alias) continue;
    index.checklist_aliases[alias] = { ...checklistEvent, changed_at: changedAt };
  }
}

function ensureRecordsChecklistAliases(index) {
  index.checklist = asPlainObject(index.checklist);
  index.checklist_aliases = asPlainObject(index.checklist_aliases);
  for (const [key, value] of Object.entries(index.checklist)) {
    if (!value || typeof value !== 'object') continue;
    const meta = index.patients?.[key];
    const changedAt = value.updated_at || value.changed_at || new Date(0).toISOString();
    for (const alias of recordsCheckedAliasesForState(recordsIdentityAliases(meta || {}, key))) {
      const old = index.checklist_aliases[alias];
      if (!old || recordsCheckedEventTime(old) <= recordsCheckedEventTime(value)) {
        index.checklist_aliases[alias] = { ...value, changed_at: changedAt };
      }
    }
  }
  return index.checklist_aliases;
}

function resolveRecordsChecklistState(index, aliases = [], candidateKeys = []) {
  const events = [];
  for (const key of candidateKeys || []) {
    const entry = index.checklist?.[key];
    if (entry && typeof entry === 'object') events.push({ ...entry, _priority: 2 });
    const keyAlias = index.checklist_aliases?.[`key::${String(key || '').trim()}`];
    if (keyAlias && typeof keyAlias === 'object') events.push({ ...keyAlias, _priority: 3 });
  }
  for (const alias of recordsCheckedAliasesForState(aliases)) {
    if (String(alias || '').startsWith('key::')) continue;
    const entry = index.checklist_aliases?.[alias];
    if (entry && typeof entry === 'object') events.push({ ...entry, _priority: 1 });
  }
  if (!events.length) return normalizePaperChecklist(null);
  events.sort((a, b) => recordsCheckedEventTime(b) - recordsCheckedEventTime(a) || Number(b._priority || 0) - Number(a._priority || 0));
  return normalizePaperChecklist(events[0]);
}

function aliasesIntersect(a, b) {
  const set = new Set(a || []);
  return (b || []).some(value => set.has(value));
}

function recordsPayloadMigrationQuality(fileKey, payload) {
  if (!payload || typeof payload !== 'object') return 0;
  const status = payloadFetchStatus(payload);
  if (TECHNICAL_FETCH_STATUSES.has(status) || status === 'spawn_error') return 0;
  if (status === 'partial') return 1;
  if (status === 'empty' || status === 'no_results_popup') return fileKey === 'cls' ? 1 : 0;
  return 3;
}

function migrateRecordsPatientFiles(ctx, oldMeta, newCaseKey) {
  const oldKey = records_storage_key(oldMeta);
  const newKey = records_storage_key(newCaseKey);
  if (!oldKey || !newKey || oldKey === newKey) return false;
  let changed = false;
  for (const fileKey of RECORDS_CHECK_FILES) {
    const oldPath = records_check_patient_file(ctx, oldKey, fileKey);
    const newPath = records_check_patient_file(ctx, newKey, fileKey);
    try {
      if (!fs.existsSync(oldPath)) continue;
      const oldPayload = readJsonSafe(oldPath, null);
      const newPayload = fs.existsSync(newPath) ? readJsonSafe(newPath, null) : null;
      // Nếu khóa mới đã tạo file rỗng/lỗi nhưng khóa cũ có dữ liệu dùng được,
      // phải phục hồi dữ liệu tốt. Trước đây chỉ copy khi file mới chưa tồn tại,
      // nên kết quả “empty” đã chặn mất dữ liệu ra viện và số lưu trữ đúng.
      if (!fs.existsSync(newPath) || recordsPayloadMigrationQuality(fileKey, oldPayload) > recordsPayloadMigrationQuality(fileKey, newPayload)) {
        fs.copyFileSync(oldPath, newPath);
        changed = true;
      }
    } catch (err) {
      console.warn(`[RECORDS_CHECK/migrate] Không copy được ${fileKey} từ ${oldKey} sang ${newKey}:`, err.message);
    }
  }
  return changed;
}

function recordsMetaHasStrongIdentity(meta = {}) {
  const source = meta?.source_row && typeof meta.source_row === 'object' ? meta.source_row : {};
  const directNoiTru = firstRowText(meta, ['noitruid', 'noi_tru_id', 'NoiTruID'], '')
    || firstRowText(source, ['noitruid', 'noi_tru_id', 'NoiTruID'], '');
  const directEpisode = records_episode_id_from_row(meta, '') || records_episode_id_from_row(source, '');
  if (directNoiTru || directEpisode) return true;
  for (const value of [meta.record_doctor_url, meta.record_nursing_url, source.record_doctor_url, source.record_nursing_url]) {
    const ids = recordsIdsFromUrl(value);
    if (ids.noitruid || ids.tiepnhanid) return true;
  }
  return false;
}

function mergeRecordsFetchedTimes(current = {}, legacy = {}) {
  const out = { ...(legacy || {}), ...(current || {}) };
  for (const key of new Set([...Object.keys(legacy || {}), ...Object.keys(current || {})])) {
    const a = String(current?.[key] || '').trim();
    const b = String(legacy?.[key] || '').trim();
    if (!a && b) out[key] = b;
  }
  return out;
}

/**
 * Không tự hợp nhất khóa cũ theo ngày vào + khoa.
 * Chỉ nối khóa khi noitruid/episode_id trùng tuyệt đối trong findExistingRecordsEntry.
 */
function reconcileRecordsLegacyDuplicates(_ctx, _index) {
  return false;
}

function visibleRecordsCheckedMap(index, activeMetas = []) {
  const activeKeys = new Set((activeMetas || []).map(meta => records_storage_key(meta)).filter(Boolean));
  const out = {};
  for (const [key, value] of Object.entries(index?.checked || {})) {
    if (!value?.checked) continue;
    if (activeKeys.has(key)) out[key] = value;
  }
  return out;
}

function recordsRecoveryNameKey(value) {
  return recordsAliasText(value)
    .replace(/\s*-\s*pm\s*:\s*phong\s+phau\s+thuat\s*$/i, '')
    .replace(/\s*-\s*phong\s+phau\s+thuat\s*$/i, '')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function recordsRecoveryStorageKey(value) {
  const raw = String(value ?? '').replace(/\s+/g, ' ').trim();
  if (!raw) return '';
  const parts = raw.split('/').map(part => part.trim()).filter(Boolean);
  if (parts.length >= 2 && /^\d+$/.test(parts[1])) return String(Number(parts[1]));
  const groups = raw.match(/\d+/g) || [];
  if (!groups.length) return '';
  const candidate = groups.sort((a, b) => b.length - a.length)[0];
  return String(Number(candidate));
}

// buildRecordsCheckDashboard gọi hàm này ở mỗi lần build (mỗi lần load/mutate
// tab Kiểm hồ sơ). Thư mục print/ chỉ tăng dần theo số lần xuất PDF, nên quét
// readdir + stat từng file mỗi lần build là chi phí không cần thiết khi chưa
// có file mới. mtime của chính thư mục print/ đổi mỗi khi có file được
// thêm/xóa (hành vi POSIX chuẩn) nên dùng nó làm khóa cache: 1 stat rẻ để biết
// có cần quét lại hay không, thay vì luôn readdir + stat toàn bộ.
const _latestPrintedPdfCache = new Map();

function latestRecordsCheckPrintedPdf(ctx) {
  const printDir = path.join(records_check_persistent_dir(ctx), 'print');
  let dirStat;
  try {
    dirStat = fs.statSync(printDir);
  } catch (_) {
    _latestPrintedPdfCache.delete(printDir);
    return null;
  }
  const cached = _latestPrintedPdfCache.get(printDir);
  if (cached && cached.dirMtimeMs === dirStat.mtimeMs) return cached.result;
  try {
    const result = fs.readdirSync(printDir, { withFileTypes: true })
      .filter(entry => entry.isFile() && /^kiem_ho_so_.*\.pdf$/i.test(entry.name))
      .map(entry => {
        const filePath = path.join(printDir, entry.name);
        const stat = fs.statSync(filePath);
        const stamp = entry.name.match(/kiem_ho_so_(\d{12,14})/i)?.[1] || '';
        return { name: entry.name, path: filePath, mtimeMs: stat.mtimeMs, stamp };
      })
      // Tên file chứa đúng thời điểm xuất. mtime có thể bị thay đổi khi copy/giải nén.
      .sort((a, b) => b.stamp.localeCompare(a.stamp) || b.mtimeMs - a.mtimeMs || b.name.localeCompare(a.name))[0] || null;
    _latestPrintedPdfCache.set(printDir, { dirMtimeMs: dirStat.mtimeMs, result });
    return result;
  } catch (_) {
    return null;
  }
}

/**
 * Một số bản cũ chỉ lưu checkbox ở trình duyệt rồi in PDF, nên sau reload index
 * không còn đủ dấu Đã kiểm. Khi phát hiện PDF mới chưa từng migrate, đọc bảng in
 * và ghép lại theo cặp Họ tên + Số lưu trữ. Tombstone bỏ kiểm mới hơn PDF luôn
 * được ưu tiên, do đó không tự bật lại ca người dùng đã chủ động bỏ chọn.
 */
function recoverRecordsCheckedFromLatestPdf(ctx, index) {
  const latestPdf = latestRecordsCheckPrintedPdf(ctx);
  if (!latestPdf) return false;
  const markerPath = records_check_pdf_recovery_marker_path(ctx);
  const marker = readJsonSafe(markerPath, null);
  if (marker?.source_pdf === latestPdf.name && Number(marker?.source_mtime_ms || 0) === Number(latestPdf.mtimeMs || 0)) return false;

  const outPath = path.join(records_check_persistent_dir(ctx), `records_check_checked_recovery_${process.pid}.json`);
  const scriptPath = path.join(WORKER_DIR, 'records_check_recover_checked.py');
  if (!fs.existsSync(scriptPath)) return false;
  const result = spawnSync(PYTHON_BIN, ['-X', 'utf8', scriptPath, '--records-dir', records_check_persistent_dir(ctx), '--out', outPath], {
    cwd: ROOT_DIR,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 60_000,
    env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' },
  });
  const parsed = readJsonSafe(outPath, null);
  try { if (fs.existsSync(outPath)) fs.rmSync(outPath, { force: true }); } catch (_) {}
  if (result.error || Number(result.status ?? 1) !== 0 || !parsed || parsed.status !== 'ok') {
    console.warn('[RECORDS_CHECK/recover] Không đọc được PDF đã kiểm:', result.error?.message || result.stderr || parsed?.status || 'unknown');
    return false;
  }

  ensureRecordsCheckedAliases(index);
  const byIdentity = new Map();
  for (const [key, meta] of Object.entries(index.patients || {})) {
    if (!meta || typeof meta !== 'object') continue;
    const discharge = read_records_patient_file(ctx, key, 'discharge');
    const storageKey = recordsRecoveryStorageKey(firstStorageText(discharge || {}, meta, meta.source_row || {}));
    const nameKey = recordsRecoveryNameKey(meta.ho_ten || meta.source_row?.ho_ten || meta.source_row?.['Họ tên'] || '');
    if (!storageKey || !nameKey) continue;
    const identity = `${storageKey}::${nameKey}`;
    if (!byIdentity.has(identity)) byIdentity.set(identity, []);
    byIdentity.get(identity).push({ key, meta });
  }

  const sourceEventAt = parsed.source_generated_at || parsed.source_mtime || new Date(latestPdf.mtimeMs).toISOString();
  const sourceEventMs = Date.parse(sourceEventAt) || latestPdf.mtimeMs || Date.now();
  const unmatched = [];
  let recovered = 0;
  let alreadyChecked = 0;
  let skippedNewerUncheck = 0;

  for (const row of parsed.rows || []) {
    const storageKey = recordsRecoveryStorageKey(row?.so_luu_tru_in);
    const nameKey = recordsRecoveryNameKey(row?.ho_ten);
    const matches = byIdentity.get(`${storageKey}::${nameKey}`) || [];
    if (!matches.length) {
      unmatched.push({ ho_ten: row?.ho_ten || '', so_luu_tru_in: row?.so_luu_tru_in || '' });
      continue;
    }
    for (const { key, meta } of matches) {
      const aliases = recordsIdentityAliases(meta, key);
      const existing = resolveRecordsCheckedState(index, aliases, [key]);
      if (existing && existing.checked === false && recordsCheckedEventTime(existing) >= sourceEventMs) {
        skippedNewerUncheck += 1;
        continue;
      }
      if (existing?.checked) alreadyChecked += 1;
      else recovered += 1;
      meta.checked = true;
      meta.checked_at = existing?.checked_at || sourceEventAt;
      index.checked[key] = {
        checked: true,
        checked_at: existing?.checked_at || sourceEventAt,
        changed_at: existing?.changed_at || sourceEventAt,
        recovered_from_pdf: latestPdf.name,
      };
      setRecordsCheckedAliasState(index, aliases, true, existing?.changed_at || sourceEventAt, existing?.checked_at || sourceEventAt);
    }
  }

  writeJsonAtomic(markerPath, {
    version: 1,
    recovered_at: new Date().toISOString(),
    source_pdf: latestPdf.name,
    source_mtime_ms: latestPdf.mtimeMs,
    source_rows: Number(parsed.count || (parsed.rows || []).length),
    recovered,
    already_checked: alreadyChecked,
    skipped_newer_uncheck: skippedNewerUncheck,
    unmatched_count: unmatched.length,
    unmatched: unmatched.slice(0, 100),
  });
  return recovered > 0;
}

function parseDateForRecords(value) {
  const text = String(value ?? '').trim();
  if (!text) return null;
  let m = text.match(/(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{4})/);
  if (m) return new Date(Number(m[3]), Number(m[2]) - 1, Number(m[1]));
  m = text.match(/(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return null;
}

function rowDateCandidates(row, kind = 'all') {
  if (!row || typeof row !== 'object') return [];
  const dischargeKeys = [
    'ngay_ra_vien', 'ngay_ra', 'discharge_time', 'discharge_date', 'raw_discharge_time',
    'T/G ra', 'TG ra', 'Thời gian ra', 'Thời gian ra viện', 'Ngày ra viện', 'Ngày ra',
  ];
  const admissionKeys = [
    'thoi_gian_vao_khoa', 'ward_admission_time', 'admission_time', 'tg_vao', 'thoi_gian_vao',
    'T/G vào', 'Thời gian vào khoa', 'Ngày vào viện', 'Ngày vào',
  ];
  const keys = kind === 'discharge' ? dischargeKeys : (kind === 'admission' ? admissionKeys : [...dischargeKeys, ...admissionKeys]);
  return keys.map(key => parseDateForRecords(row[key])).filter(Boolean);
}

function filter_records_rows_by_range(rows, dateFrom = '', dateTo = '') {
  const start = parseDateForRecords(dateFrom);
  const end = parseDateForRecords(dateTo || dateFrom);
  const list = Array.isArray(rows) ? rows : [];
  if (!start && !end) return list;
  let sawAnyDate = false;
  const filtered = list.filter(row => {
    // Danh sách kiểm hồ sơ là danh sách ra viện: nếu có ngày ra thì chỉ lọc theo
    // ngày ra. Chỉ dùng ngày vào làm dự phòng khi dòng scan thật sự không có ngày ra.
    const dischargeDates = rowDateCandidates(row, 'discharge');
    const dates = dischargeDates.length ? dischargeDates : rowDateCandidates(row, 'admission');
    if (!dates.length) return true;
    sawAnyDate = true;
    const d = dates[0];
    return (!start || d >= start) && (!end || d <= end);
  });
  // Nếu bảng scan không có cột ngày nào đọc được thì không lọc, tránh làm mất toàn bộ danh sách.
  return sawAnyDate ? filtered : list;
}

function sync_records_check_index_from_rows(ctx, rows, scanMeta = {}) {
  const index = read_records_check_index(ctx);
  const now = new Date().toISOString();
  const list = Array.isArray(rows) ? rows : [];
  const seen = new Set();

  // Tạo lớp bí danh bền vững trước khi đổi active/case_key. Nhờ vậy dấu “Đã kiểm”
  // vẫn được nhận ra nếu lần quét mới sinh key khác do có thêm noitruid/link hồ sơ.
  ensureRecordsCheckedAliases(index);

  // Quét theo một khoảng ngày là thao tác bổ sung/cập nhật, không thay thế
  // toàn bộ kho kiểm hồ sơ. Khôi phục các ca cũ từng bị bản trước ẩn khi quét ngày mới.
  for (const meta of Object.values(index.patients || {})) {
    if (meta && typeof meta === 'object') {
      meta.active = true;
      meta.stale = false;
    }
  }

  for (const row of list) {
    if (!row || typeof row !== 'object') continue;
    const ma_bn = records_row_id(row);
    if (!ma_bn) continue;
    const case_key = records_case_key(row);
    if (!case_key) continue;
    seen.add(case_key);
    const matched = findExistingRecordsEntry(index, row, case_key);
    const existing = matched?.meta || {};
    const oldStorageKey = records_storage_key(existing);
    const aliases = [...new Set([
      ...recordsIdentityAliases(row, case_key),
      ...recordsIdentityAliases(existing, matched?.indexKey || oldStorageKey),
    ])];
    const checkedState = resolveRecordsCheckedState(index, aliases, [case_key, matched?.indexKey, oldStorageKey].filter(Boolean));

    if (matched && matched.indexKey !== case_key) {
      migrateRecordsPatientFiles(ctx, existing, case_key);
      delete index.patients[matched.indexKey];
      delete index.checked[matched.indexKey];
      if (oldStorageKey && oldStorageKey !== case_key) delete index.checked[oldStorageKey];
    }

    const nextMeta = records_meta_from_row({ ...row, inpatient_status: 'Hoàn tất', trang_thai: 'Hoàn tất' }, existing, ctx, case_key);
    if (checkedState?.checked) {
      const checkedAt = checkedState.checked_at || existing.checked_at || now;
      nextMeta.checked = true;
      nextMeta.checked_at = checkedAt;
      index.checked[case_key] = { checked: true, checked_at: checkedAt, changed_at: checkedState.changed_at || checkedAt };
      setRecordsCheckedAliasState(index, aliases, true, checkedState.changed_at || checkedAt, checkedAt);
    } else if (checkedState && checkedState.checked === false) {
      nextMeta.checked = false;
      nextMeta.checked_at = null;
      delete index.checked[case_key];
    }
    index.patients[case_key] = nextMeta;
  }

  // Dọn các khóa cũ còn sót từ lần chuyển sang noitruid và phục hồi file tốt
  // trước khi ghi index. Hàm này chỉ ghép cặp trùng chính xác thời gian vào + khoa.
  reconcileRecordsLegacyDuplicates(ctx, index);

  index.lastScan = {
    at: now,
    status: 'Hoàn tất',
    scanned_count: Number(scanMeta.scanned_count || list.length),
    filtered_count: list.length,
    active_count: Object.values(index.patients || {}).filter(p => p && p.active !== false).length,
    stale_count: 0,
    ...(scanMeta.date_from ? { date_from: scanMeta.date_from } : {}),
    ...(scanMeta.date_to ? { date_to: scanMeta.date_to } : {}),
  };
  return write_records_check_index(ctx, index);
}

function recordsCheckFileStatus(fileKey, payload, fetchedAt = null, required = true) {
  const status = String(payload?._fetch_status || '').replace(/\s+/g, ' ').trim().toLowerCase();
  if (!payload) return { state: 'not_started', tone: 'gray', label: 'Chưa lấy', required, present: false, fetchedAt };
  if (TECHNICAL_FETCH_STATUSES.has(status)) {
    const technicalLabel = status === 'no_results_popup'
      ? 'Không mở được Xem kết quả'
      : (status === 'no_cdha_tab'
          ? 'Không mở được CĐHA'
          : (status === 'cdha_timeout'
              ? 'CĐHA tải quá lâu'
              : (status === 'missing_output' ? 'Worker thiếu dữ liệu' : 'Lỗi lấy')));
    return { state: 'fetch_error', tone: 'red', label: technicalLabel, title: payload?._error || fileFetchStatusLabel(status), required, present: true, usable: false, fetchedAt };
  }
  if (status === 'empty') {
    if (fileKey === 'cls') return { state: 'empty', tone: 'green', label: 'Không có CĐHA', required, present: true, usable: true, fetchedAt };
    return { state: 'empty', tone: 'gray', label: 'Chưa ra viện', required, present: true, usable: false, fetchedAt };
  }
  if (status === 'partial') return { state: 'partial', tone: 'amber', label: 'Một phần', required, present: true, usable: false, fetchedAt };
  return { state: 'ok', tone: 'green', label: 'Đã có', required, present: true, usable: true, fetchedAt };
}

function recordsCheckPayloadUsable(fileKey, payload) {
  if (!payload || typeof payload !== 'object') return false;
  const status = String(payload?._fetch_status || '').replace(/\s+/g, ' ').trim().toLowerCase();
  if (TECHNICAL_FETCH_STATUSES.has(status) || status === 'partial') return false;
  if (status === 'empty') return fileKey === 'cls';
  return true;
}

function buildRecordsCheckCard(ctx, meta) {
  const storageKey = records_storage_key(meta);
  const data = read_records_patient_all(ctx, storageKey);
  const fetched = meta.fetched || {};
  const metaStorage = firstStorageText(meta, meta?.source_row || {});
  const metaDischargeTime = recordsFirstDateText(
    meta.discharge_time,
    records_discharge_time_from_row(meta?.source_row || {}, ''),
    meta?.source_row?.['Thời gian ra viện'],
    meta?.source_row?.['Ngày ra viện']
  );
  const discharge = data.discharge && typeof data.discharge === 'object'
    ? {
        ...data.discharge,
        ...(data.discharge.so_luu_tru ? {} : (metaStorage ? { so_luu_tru: metaStorage } : {})),
        ...(recordsFirstDateText(
          data.discharge.raw_time,
          [data.discharge.gio_ra, data.discharge.ngay_ra].filter(Boolean).join(' '),
          data.discharge.ngay_ra
        ) ? {} : (metaDischargeTime ? { raw_time: metaDischargeTime } : {})),
      }
    : data.discharge;
  const storageNo = firstStorageText(discharge, meta, meta?.source_row || {});
  const missing = RECORDS_CHECK_FILES.filter(fileKey => !recordsCheckPayloadUsable(fileKey, fileKey === 'discharge' ? discharge : data[fileKey]));
  const present = RECORDS_CHECK_FILES.filter(fileKey => Boolean(data[fileKey]));
  const file_statuses = Object.fromEntries(RECORDS_CHECK_FILES.map(fileKey => [
    fileKey,
    recordsCheckFileStatus(fileKey, fileKey === 'discharge' ? discharge : data[fileKey], fetched[fileKey] || data[fileKey]?._meta?.fetched_at || null),
  ]));
  const dischargeDate = recordsFirstDateText(
    meta.discharge_time,
    discharge?.raw_time,
    [discharge?.gio_ra, discharge?.ngay_ra].filter(Boolean).join(' '),
    discharge?.ngay_ra,
    meta?.source_row?.discharge_time,
    meta?.source_row?.['Thời gian ra viện'],
    meta?.source_row?.['Ngày ra viện']
  );
  const badDischargeDate = recordsHasBadDischargeDate({ ...meta, discharge, source_row: meta?.source_row || {} });
  const dischargeFetchStatus = payloadFetchStatus(discharge);
  const confirmedNotDischarged = Boolean(discharge && dischargeFetchStatus === 'empty' && !dischargeDate);
  const missingStorage = Boolean(recordsCheckPayloadUsable('discharge', discharge) && recordsCheckPayloadUsable('cls', data.cls) && !storageNo);
  const missingDischargeDate = Boolean(recordsCheckPayloadUsable('discharge', discharge) && !dischargeDate);
  const dataComplete = missing.length === 0 && !missingStorage && !missingDischargeDate && !badDischargeDate && !meta.fetch_error;
  const data_state = present.length === 0 ? 'not_started' : (dataComplete ? 'complete' : 'partial');
  return {
    ma_bn: meta.ma_bn || '',
    ho_ten: meta.ho_ten || '',
    phong: meta.phong || '',
    department: meta.department || '',
    admission_time: meta.admission_time || '',
    discharge_time: dischargeDate || meta.discharge_time || '',
    inpatient_status: meta.inpatient_status || 'Hoàn tất',
    scope: 'discharge',
    scope_label: 'Kiểm hồ sơ ra viện',
    so_luu_tru: storageNo,
    storage_no: storageNo,
    workflow_tags: meta.workflow_tags || ['DISCHARGE'],
    active: meta.active !== false,
    stale: Boolean(meta.stale),
    case_key: storageKey,
    encounter_key: meta.encounter_key || storageKey,
    storage_key: storageKey,
    noitruid: meta.noitruid || '',
    episode_id: meta.episode_id || meta.tiepnhanid || '',
    tiepnhanid: meta.tiepnhanid || '',
    source_row: meta.source_row || {},
    last_seen_at: meta.last_seen_at || '',
    checked: Boolean(meta.checked),
    checked_at: meta.checked_at || null,
    fetched,
    data_complete: dataComplete,
    data_state,
    missing_storage: missingStorage,
    bad_discharge_date: badDischargeDate,
    not_discharged: confirmedNotDischarged,
    has_started_fetch: data_state !== 'not_started',
    missing_files: missing,
    present_files: present,
    file_statuses,
    status_label: dataComplete
      ? 'Đủ dữ liệu'
      : (confirmedNotDischarged ? 'Chưa ra viện' : 'Thiếu dữ liệu'),
    status_tone: dataComplete ? 'green' : (confirmedNotDischarged ? 'gray' : (present.length ? 'amber' : 'gray')),
    fetch_error: meta.fetch_error || null,
    fetch_error_raw: meta.fetch_error || null,
    fetch_error_active: Boolean(meta.fetch_error),
    fetch_error_at: meta.fetch_error_at || null,
    fetch_attempt_count: Number(meta.fetch_attempt_count || 0) || 0,
    fetch_failure_count: Number(meta.fetch_failure_count || 0) || 0,
    last_fetch_attempt_at: meta.last_fetch_attempt_at || null,
    last_fetch_success_at: meta.last_fetch_success_at || null,
    next_retry_at: meta.next_retry_at || null,
    has_profile: false,
    has_discharge: Boolean(data.discharge),
    has_billing: false,
    has_bed_days: false,
    has_surgery: false,
    has_order_history: Boolean(data.order_history),
    has_cls: Boolean(data.cls),
    profile: null,
    discharge,
    billing: null,
    bed_days: null,
    surgery: null,
    order_history: data.order_history,
    cls: data.cls,
  };
}

function recordsDateSortNumber(value) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  if (!text) return Number.NEGATIVE_INFINITY;
  let m = text.match(/(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{4})/);
  if (m) {
    const time = text.match(/(\d{1,2})[:h](\d{1,2})/);
    const hh = time?.[1] ? String(time[1]).padStart(2, '0') : '00';
    const mm = time?.[2] ? String(time[2]).padStart(2, '0') : '00';
    return Number(`${m[3]}${String(m[2]).padStart(2, '0')}${String(m[1]).padStart(2, '0')}${hh}${mm}`);
  }
  m = text.match(/(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{1,2}))?/);
  if (m) {
    const hh = m[4] ? String(m[4]).padStart(2, '0') : '00';
    const mm = m[5] ? String(m[5]).padStart(2, '0') : '00';
    return Number(`${m[1]}${String(m[2]).padStart(2, '0')}${String(m[3]).padStart(2, '0')}${hh}${mm}`);
  }
  return Number.NEGATIVE_INFINITY;
}

function sortRecordCardsByAdmissionNewest(a, b) {
  const adm = recordsDateSortNumber(b.admission_time || b.profile?.ngay_vao_vien || b.discharge?.ngay_vao) - recordsDateSortNumber(a.admission_time || a.profile?.ngay_vao_vien || a.discharge?.ngay_vao);
  if (adm) return adm;
  const dis = recordsDateSortNumber(b.discharge_time || b.discharge?.ngay_ra || b.discharge?.raw_time) - recordsDateSortNumber(a.discharge_time || a.discharge?.ngay_ra || a.discharge?.raw_time);
  if (dis) return dis;
  return String(a.ho_ten || '').localeCompare(String(b.ho_ten || ''), 'vi') || String(a.case_key || '').localeCompare(String(b.case_key || ''), 'vi');
}

function recordsStorageIdentity(value) {
  const raw = String(value ?? '').replace(/\\/g, '/').replace(/\s+/g, '').trim().toUpperCase();
  if (!raw) return '';
  const parts = raw.split('/').map(part => part.trim()).filter(Boolean);
  if (parts.length >= 2) {
    return parts.map(part => {
      if (/^\d+$/.test(part)) return String(Number(part));
      return recordsAliasText(part).replace(/[^a-z0-9]/g, '').toUpperCase();
    }).filter(Boolean).join('/');
  }
  return recordsAliasText(raw).replace(/[^a-z0-9]/g, '').toUpperCase();
}

function recordsCardPersonIdentity(card = {}) {
  const name = recordsAliasText(card.ho_ten || card?.source_row?.ho_ten || card?.source_row?.['Họ tên'] || '');
  if (name) return `name::${name}`;
  const maBn = normId(card.ma_bn || card?.source_row?.ma_bn || '');
  return maBn ? `patient::${maBn}` : '';
}

function recordsCardSourceKeys(card = {}) {
  const values = [
    ...(Array.isArray(card.source_case_keys) ? card.source_case_keys : []),
    card.case_key,
    card.storage_key,
    card.encounter_key,
  ];
  return [...new Set(values.map(records_storage_key).filter(Boolean))];
}

function recordsClsRows(payload) {
  if (!payload || typeof payload !== 'object') return [];
  if (Array.isArray(payload.results)) return payload.results;
  if (Array.isArray(payload.rows)) return payload.rows;
  return [];
}

function selectRecordsClsPayload(payloads = []) {
  // Các dòng EMR trùng số lưu trữ vẫn là cùng một người bệnh. Không cộng,
  // không hợp nhất danh sách XQ/CT/MRI giữa các dòng vì sẽ làm tăng số lượng.
  // Tự động chọn nguyên bộ CĐHA đầy đủ nhất và giữ nguyên số đếm của bộ đó.
  const list = payloads.filter(payload => payload && typeof payload === 'object');
  if (!list.length) return null;
  const payloadScore = payload => {
    const rows = recordsClsRows(payload).length;
    const counts = payload?.counts && typeof payload.counts === 'object' ? payload.counts : {};
    const countTotal = ['xq', 'ct', 'mri'].reduce((sum, key) => sum + Math.max(0, Number(counts[key] || 0)), 0);
    const status = payloadFetchStatus(payload);
    return (recordsCheckPayloadUsable('cls', payload) ? 10000 : 0)
      + (status === 'ok' ? 3000 : (status === 'empty' || status === 'no_results_popup' ? 500 : 0))
      + (rows * 100)
      + (countTotal * 10);
  };
  const selected = [...list]
    .map((payload, index) => ({ payload, index, score: payloadScore(payload) }))
    .sort((a, b) => b.score - a.score || a.index - b.index)[0].payload;
  return {
    ...selected,
    ...(Array.isArray(selected.results) ? { results: [...selected.results] } : {}),
    ...(Array.isArray(selected.rows) ? { rows: [...selected.rows] } : {}),
    ...(selected.counts && typeof selected.counts === 'object' ? { counts: { ...selected.counts } } : {}),
    _merged_duplicate_storage: list.length > 1,
    _merged_source_count: list.length,
    _duplicate_storage_cls_policy: 'single_patient_single_payload',
  };
}

function recordsCardScore(card = {}) {
  return (card.data_complete ? 10000 : 0)
    + (recordsCheckPayloadUsable('discharge', card.discharge) ? 2000 : 0)
    + (recordsCheckPayloadUsable('cls', card.cls) ? 1500 : 0)
    + (firstStorageText(card.discharge || {}, card || {}) ? 500 : 0)
    + (recordsClsRows(card.cls).length * 5)
    + (card.checked ? 50 : 0)
    + Math.max(0, recordsDateSortNumber(card.discharge_time || card?.discharge?.raw_time || card?.discharge?.ngay_ra) / 1e12);
}

function recordsDateTextFromCards(cards, getter, newest = false) {
  const values = cards.map(getter).map(value => String(value || '').trim()).filter(Boolean);
  if (!values.length) return '';
  values.sort((a, b) => recordsDateSortNumber(a) - recordsDateSortNumber(b));
  return newest ? values[values.length - 1] : values[0];
}

function mergeRecordsCheckCardGroup(cards = [], storageIdentity = '', personIdentity = '') {
  if (cards.length <= 1) return cards[0] || null;
  const ordered = [...cards].sort((a, b) => recordsCardScore(b) - recordsCardScore(a) || sortRecordCardsByAdmissionNewest(a, b));
  const canonical = ordered[0];
  const sourceCaseKeys = [...new Set(cards.flatMap(recordsCardSourceKeys))];
  const storage = firstStorageText(canonical.discharge || {}, canonical || {})
    || cards.map(card => firstStorageText(card.discharge || {}, card || {})).find(Boolean)
    || '';
  const admissionTime = recordsDateTextFromCards(cards, card => card.admission_time || card?.discharge?.ngay_vao, false);
  const dischargeTime = recordsDateTextFromCards(cards, card => card.discharge_time || card?.discharge?.raw_time || [card?.discharge?.gio_ra, card?.discharge?.ngay_ra].filter(Boolean).join(' ') || card?.discharge?.ngay_ra, true);
  const cls = selectRecordsClsPayload(ordered.map(card => card.cls));
  const dischargeCandidates = cards.filter(card => card.discharge && typeof card.discharge === 'object')
    .sort((a, b) => {
      const usable = Number(recordsCheckPayloadUsable('discharge', b.discharge)) - Number(recordsCheckPayloadUsable('discharge', a.discharge));
      if (usable) return usable;
      return recordsDateSortNumber(b.discharge_time || b?.discharge?.raw_time || b?.discharge?.ngay_ra) - recordsDateSortNumber(a.discharge_time || a?.discharge?.raw_time || a?.discharge?.ngay_ra);
    });
  const selectedDischarge = dischargeCandidates[0]?.discharge || canonical.discharge || null;
  const discharge = selectedDischarge && typeof selectedDischarge === 'object'
    ? {
        ...selectedDischarge,
        ...(recordsFirstDateText(
          selectedDischarge.raw_time,
          [selectedDischarge.gio_ra, selectedDischarge.ngay_ra].filter(Boolean).join(' '),
          selectedDischarge.ngay_ra
        ) ? {} : (dischargeTime ? { raw_time: dischargeTime } : {})),
      }
    : selectedDischarge;
  const mergedFetched = {};
  for (const fileKey of RECORDS_CHECK_FILES) {
    const times = cards.map(card => card?.fetched?.[fileKey]).filter(Boolean).sort();
    mergedFetched[fileKey] = times[times.length - 1] || null;
  }
  const dischargeUsable = recordsCheckPayloadUsable('discharge', discharge);
  const clsUsable = recordsCheckPayloadUsable('cls', cls);
  const badDischargeDate = recordsHasBadDischargeDate({ admission_time: admissionTime, discharge_time: dischargeTime, discharge, source_row: canonical.source_row || {} });
  const missingStorage = Boolean(dischargeUsable && clsUsable && !storage);
  const missingDischargeDate = Boolean(dischargeUsable && !dischargeTime);
  const hasFetchError = cards.some(card => Boolean(card.fetch_error));
  const dataComplete = dischargeUsable && clsUsable && Boolean(storage) && Boolean(dischargeTime) && !badDischargeDate && !hasFetchError;
  const missingFiles = [];
  if (!dischargeUsable) missingFiles.push('discharge');
  if (!clsUsable) missingFiles.push('cls');
  const presentFiles = [];
  if (discharge) presentFiles.push('discharge');
  if (cls) presentFiles.push('cls');
  const checkedCards = cards.filter(card => card.checked);
  const checkedAt = checkedCards.map(card => card.checked_at).filter(Boolean).sort()[0] || null;
  const departments = [...new Set(cards.map(card => String(card.department || '').trim()).filter(Boolean))];
  const errors = [...new Set(cards.map(card => String(card.fetch_error || '').trim()).filter(Boolean))];
  const latestAttempt = cards.map(card => card.last_fetch_attempt_at).filter(Boolean).sort().at(-1) || null;
  const latestSuccess = cards.map(card => card.last_fetch_success_at).filter(Boolean).sort().at(-1) || null;
  const nextRetry = cards.map(card => card.next_retry_at).filter(Boolean).sort().at(-1) || null;
  const attemptCount = cards.reduce((sum, card) => sum + Math.max(0, Number(card.fetch_attempt_count || 0)), 0);
  const failureCount = cards.reduce((sum, card) => sum + Math.max(0, Number(card.fetch_failure_count || 0)), 0);
  const mergedKey = `storage::${storageIdentity}::${stableHashText(personIdentity || recordsCardPersonIdentity(canonical) || storageIdentity)}`;
  return {
    ...canonical,
    merged_key: mergedKey,
    merged_from_duplicate_storage: true,
    duplicate_storage_count: cards.length,
    source_case_keys: sourceCaseKeys,
    source_ma_bn: [...new Set(cards.map(card => normId(card.ma_bn)).filter(Boolean))],
    so_luu_tru: storage,
    storage_no: storage,
    admission_time: admissionTime || canonical.admission_time || '',
    discharge_time: dischargeTime || canonical.discharge_time || '',
    department: departments.join(' → ') || canonical.department || '',
    discharge,
    cls,
    fetched: mergedFetched,
    checked: checkedCards.length > 0,
    checked_at: checkedAt,
    data_complete: dataComplete,
    data_state: presentFiles.length === 0 ? 'not_started' : (dataComplete ? 'complete' : 'partial'),
    missing_storage: missingStorage,
    bad_discharge_date: badDischargeDate,
    not_discharged: Boolean(discharge && payloadFetchStatus(discharge) === 'empty' && !dischargeTime),
    has_started_fetch: presentFiles.length > 0,
    missing_files: missingFiles,
    present_files: presentFiles,
    file_statuses: {
      discharge: recordsCheckFileStatus('discharge', discharge, mergedFetched.discharge),
      cls: recordsCheckFileStatus('cls', cls, mergedFetched.cls),
    },
    status_label: dataComplete ? 'Đủ dữ liệu' : (discharge && payloadFetchStatus(discharge) === 'empty' && !dischargeTime ? 'Chưa ra viện' : 'Thiếu dữ liệu'),
    status_tone: dataComplete ? 'green' : (discharge && payloadFetchStatus(discharge) === 'empty' && !dischargeTime ? 'gray' : (presentFiles.length ? 'amber' : 'gray')),
    fetch_error: errors.join('; ') || null,
    fetch_error_raw: errors.join('; ') || null,
    fetch_error_active: errors.length > 0,
    fetch_error_at: cards.map(card => card.fetch_error_at).filter(Boolean).sort().at(-1) || null,
    fetch_attempt_count: attemptCount,
    fetch_failure_count: failureCount,
    last_fetch_attempt_at: latestAttempt,
    last_fetch_success_at: latestSuccess,
    next_retry_at: nextRetry,
    has_discharge: Boolean(discharge),
    has_cls: Boolean(cls),
  };
}

function mergeRecordsCheckCardsByStorage(cards = []) {
  const groups = new Map();
  const singles = [];
  for (const card of cards) {
    const storage = firstStorageText(card?.discharge || {}, card || {}, card?.source_row || {});
    const storageIdentity = recordsStorageIdentity(storage);
    const personIdentity = recordsCardPersonIdentity(card);
    if (!storageIdentity || !personIdentity) {
      singles.push(card);
      continue;
    }
    const key = `${storageIdentity}::${personIdentity}`;
    if (!groups.has(key)) groups.set(key, { storageIdentity, personIdentity, cards: [] });
    groups.get(key).cards.push(card);
  }
  const merged = [...singles];
  for (const group of groups.values()) {
    merged.push(mergeRecordsCheckCardGroup(group.cards, group.storageIdentity, group.personIdentity));
  }
  return merged.filter(Boolean).sort(sortRecordCardsByAdmissionNewest);
}

function sortRecordsMetasForFetch(metas) {
  return [...(Array.isArray(metas) ? metas : [])].sort((a, b) => {
    const aAttempts = Math.max(0, Number(a.fetch_attempt_count || 0));
    const bAttempts = Math.max(0, Number(b.fetch_attempt_count || 0));
    if (Boolean(aAttempts) !== Boolean(bAttempts)) return aAttempts ? 1 : -1;

    const now = Date.now();
    const aRetry = Date.parse(String(a.next_retry_at || '')) || 0;
    const bRetry = Date.parse(String(b.next_retry_at || '')) || 0;
    const aCooling = aRetry > now;
    const bCooling = bRetry > now;
    if (aCooling !== bCooling) return aCooling ? 1 : -1;

    const aFailures = Math.max(0, Number(a.fetch_failure_count || 0));
    const bFailures = Math.max(0, Number(b.fetch_failure_count || 0));
    if (aFailures !== bFailures) return aFailures - bFailures;

    const aLast = Date.parse(String(a.last_fetch_attempt_at || '')) || 0;
    const bLast = Date.parse(String(b.last_fetch_attempt_at || '')) || 0;
    if (aLast !== bLast) return aLast - bLast;

    const adm = recordsDateSortNumber(b.admission_time || b.source_row?.admission_time || b.source_row?.['Thời gian vào khoa'] || b.source_row?.['Ngày vào viện']) - recordsDateSortNumber(a.admission_time || a.source_row?.admission_time || a.source_row?.['Thời gian vào khoa'] || a.source_row?.['Ngày vào viện']);
    if (adm) return adm;
    const dis = recordsDateSortNumber(b.discharge_time || b.source_row?.discharge_time || b.source_row?.['Thời gian ra viện'] || b.source_row?.['Ngày ra viện']) - recordsDateSortNumber(a.discharge_time || a.source_row?.discharge_time || a.source_row?.['Thời gian ra viện'] || a.source_row?.['Ngày ra viện']);
    if (dis) return dis;
    return String(a.ho_ten || '').localeCompare(String(b.ho_ten || ''), 'vi') || String(records_storage_key(a)).localeCompare(String(records_storage_key(b)), 'vi');
  });
}

function rotateRecordsMetasFromCursor(metas, cursorKey = '') {
  const sorted = sortRecordsMetasForFetch(metas);
  const cursor = records_storage_key(cursorKey);
  if (!cursor) return sorted;
  const idx = sorted.findIndex(meta => records_storage_key(meta) === cursor || records_storage_key(meta?.case_key) === cursor || records_storage_key(meta?.encounter_key) === cursor);
  if (idx <= 0) return sorted;
  return sorted.slice(idx).concat(sorted.slice(0, idx));
}

function recordsStorageForPrint(value) {
  const raw = String(value ?? '').replace(/\s+/g, ' ').trim();
  if (!raw) return '';
  const parts = raw.split('/').map(part => part.trim()).filter(Boolean);
  if (parts.length >= 2 && /^\d+$/.test(parts[1])) return String(Number(parts[1]));
  const nums = raw.match(/\d{4,}/g) || [];
  if (nums.length) {
    const longest = nums.sort((a, b) => b.length - a.length)[0];
    return longest.replace(/^0+/, '') || '0';
  }
  return raw;
}

function recordsStorageKind(value) {
  const raw = String(value ?? '').trim().toUpperCase();
  if (/(^|\/)BT(\/|$)/.test(raw) || /BINH\s*THUONG|BÌNH\s*THƯỜNG/i.test(raw)) return 'BT';
  if (/(^|\/)TN(\/|$)/.test(raw) || /TAI\s*NAN|TAI\s*NẠN|TAI\s*NẠN/i.test(raw)) return 'TN';
  return 'KHAC';
}


function recordsCheckedAliases(index) {
  const checked = index?.checked && typeof index.checked === 'object' && !Array.isArray(index.checked) ? index.checked : {};
  const out = new Set(Object.entries(checked).filter(([, value]) => value?.checked).map(([key]) => records_storage_key(key)).filter(Boolean));
  for (const [key, meta] of Object.entries(index?.patients || {})) {
    if (meta?.checked) {
      out.add(records_storage_key(key));
      out.add(records_storage_key(meta));
    }
  }
  return [...out].filter(Boolean);
}

function normalizeRecordsPdfRows(inputRows) {
  const rows = (Array.isArray(inputRows) ? inputRows : [])
    .filter(row => row && typeof row === 'object')
    .map(row => ({
      record_id: String(row.record_id || row.case_key || '').replace(/\s+/g, ' ').trim(),
      aliases: Array.isArray(row.aliases) ? row.aliases.map(value => String(value || '').trim()).filter(Boolean) : [],
      ho_ten: String(row.ho_ten || row.name || '').replace(/\s+/g, ' ').trim(),
      ma_bn: String(row.ma_bn || row.patient_id || '').replace(/\s+/g, ' ').trim(),
      so_luu_tru: String(row.so_luu_tru || row.storage || '').replace(/\s+/g, ' ').trim(),
      so_luu_tru_in: String(row.so_luu_tru_in || recordsStorageForPrint(row.so_luu_tru || row.storage || '')).replace(/\s+/g, ' ').trim(),
      storage_kind: String(row.storage_kind || recordsStorageKind(row.so_luu_tru || row.storage || '')).trim(),
      xq: Number(row.xq || row.so_xq || 0),
      mri: Number(row.mri || row.so_mri || 0),
      ct: Number(row.ct || row.so_ct || 0),
      // Hồ sơ cũ/PDF nội bộ không có các trường dưới đây -> in ô trống, không suy đoán.
      discharge_date: String(row.discharge_date || row.ngay_ra_vien || '').trim(),
      handover_deadline: String(row.handover_deadline || '').trim(),
      ksd_status: String(row.ksd_status || '').trim(),
      gpb_status: String(row.gpb_status || '').trim(),
      cover_note: String(row.cover_note || '').replace(/\s+/g, ' ').trim(),
      delivered_by: String(row.delivered_by || '').trim(),
    }))
    .filter(row => row.ho_ten || row.ma_bn || row.so_luu_tru);

  const rank = { BT: 0, TN: 1, KHAC: 2 };
  rows.sort((a, b) => {
    const ra = rank[a.storage_kind] ?? 9;
    const rb = rank[b.storage_kind] ?? 9;
    if (ra !== rb) return ra - rb;
    const na = Number(a.so_luu_tru_in || 0);
    const nb = Number(b.so_luu_tru_in || 0);
    if (Number.isFinite(na) && Number.isFinite(nb) && na !== nb) return na - nb;
    return a.ho_ten.localeCompare(b.ho_ten, 'vi');
  });
  return rows;
}

function recordsSubmissionDateLabel(value) {
  const date = normalizeRecordsSubmissionDate(value);
  if (!date) return '';
  const [year, month, day] = date.split('-');
  return `${day}/${month}/${year}`;
}

function recordsPdfUniqueStamp() {
  const now = new Date();
  const date = now.toISOString().slice(0, 10).replace(/-/g, '');
  const time = now.toISOString().slice(11, 23).replace(/[:.]/g, '');
  return `${date}_${time}_${crypto.randomUUID().slice(0, 6)}`;
}

async function createRecordsCheckPdf(ctx, inputRows, options = {}) {
  const rows = normalizeRecordsPdfRows(inputRows);
  if (!rows.length) throw new Error('Không có hồ sơ để xuất PDF.');

  const printDir = path.join(records_check_persistent_dir(ctx), 'print');
  try { fs.mkdirSync(printDir, { recursive: true }); } catch (_) {}
  const stamp = recordsPdfUniqueStamp();
  const prefix = safeFilePart(options.prefix || 'kiem_ho_so');
  const inputPath = path.join(printDir, `${prefix}_${stamp}.json`);
  const outName = `${prefix}_${stamp}.pdf`;
  const outPath = path.join(printDir, outName);
  writeJsonAtomic(inputPath, {
    generated_at: new Date().toISOString(),
    title: String(options.title || 'DANH SÁCH KIỂM HỒ SƠ ĐÃ KIỂM').trim(),
    subtitle: String(options.subtitle || '').trim(),
    delivered_by: String(options.delivered_by || '').trim(),
    rows,
  });

  const result = await runScript('records_check_print_pdf.py', ['--input', inputPath, '--out', outPath], { runtimeDir: ctx.dir });
  if (result.spawnError) throw new Error('Không khởi động được Python tạo PDF: ' + result.spawnError);
  if (result.killedByTimeout) throw new Error('Timeout khi tạo PDF kiểm hồ sơ.');
  if (result.code !== 0 || !fs.existsSync(outPath)) throw new Error(fmtPyError('Python lỗi khi tạo PDF kiểm hồ sơ.', result));
  try { if (fs.existsSync(inputPath)) fs.rmSync(inputPath, { force: true }); } catch (_) {}
  return { rows, outName, outPath, url: `/api/hchanh/records-check/print-pdf/${encodeURIComponent(outName)}` };
}

function recordsFirstDateText(...values) {
  for (const value of values) {
    const text = String(value ?? '').replace(/\s+/g, ' ').trim();
    if (text) return text;
  }
  return '';
}

// Chuyển text ngày/giờ ra viện (nhiều định dạng EMR khác nhau) sang ISO có múi
// giờ Việt Nam (+07:00, không có DST) để tính hạn 48 giờ. hasTime=false nghĩa
// là nguồn chỉ có NGÀY, không có giờ thật — bắt buộc phải biết rõ điều này để
// không tự bịa giờ giả cho hạn bàn giao.
function recordsDischargeDateTimeInfo(text) {
  const raw = String(text ?? '').trim();
  if (!raw) return { iso: null, hasTime: false };
  const pad2 = v => String(v).padStart(2, '0');

  const withTime = raw.match(/(\d{1,2})[:h](\d{2})\s+(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})/);
  if (withTime) {
    const [, hh, mm, dd, mo, yy] = withTime;
    return { iso: `${yy}-${pad2(mo)}-${pad2(dd)}T${pad2(hh)}:${mm}:00+07:00`, hasTime: true };
  }
  const isoWithTime = raw.match(/^(\d{4})-(\d{1,2})-(\d{1,2})[T ](\d{1,2}):(\d{2})/);
  if (isoWithTime) {
    const [, yy, mo, dd, hh, mm] = isoWithTime;
    return { iso: `${yy}-${pad2(mo)}-${pad2(dd)}T${pad2(hh)}:${mm}:00+07:00`, hasTime: true };
  }
  const dateOnly = raw.match(/(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})/);
  if (dateOnly) {
    const [, dd, mo, yy] = dateOnly;
    return { iso: `${yy}-${pad2(mo)}-${pad2(dd)}T00:00:00+07:00`, hasTime: false };
  }
  const isoDateOnly = raw.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (isoDateOnly) {
    const [, yy, mo, dd] = isoDateOnly;
    return { iso: `${yy}-${pad2(mo)}-${pad2(dd)}T00:00:00+07:00`, hasTime: false };
  }
  return { iso: null, hasTime: false };
}

function recordsHasBadDischargeDate(cardOrMeta) {
  const admission = recordsFirstDateText(
    cardOrMeta?.admission_time,
    cardOrMeta?.profile?.ngay_vao_vien,
    cardOrMeta?.profile?.ngay_vao,
    cardOrMeta?.discharge?.ngay_vao,
    cardOrMeta?.source_row?.admission_time,
    cardOrMeta?.source_row?.['Thời gian vào khoa'],
    cardOrMeta?.source_row?.['Ngày vào viện']
  );
  const discharge = recordsFirstDateText(
    cardOrMeta?.discharge_time,
    cardOrMeta?.profile?.ngay_ra_vien,
    cardOrMeta?.profile?.ngay_ra,
    cardOrMeta?.discharge?.raw_time,
    [cardOrMeta?.discharge?.gio_ra, cardOrMeta?.discharge?.ngay_ra].filter(Boolean).join(' '),
    cardOrMeta?.discharge?.ngay_ra,
    cardOrMeta?.source_row?.discharge_time,
    cardOrMeta?.source_row?.['Thời gian ra viện'],
    cardOrMeta?.source_row?.['Ngày ra viện']
  );
  const adm = recordsDateSortNumber(admission);
  const dis = recordsDateSortNumber(discharge);
  return Number.isFinite(adm) && Number.isFinite(dis) && adm > 0 && dis > 0 && dis < adm;
}

function records_check_job_path(ctx) {
  return path.join(records_check_persistent_dir(ctx), 'records_check_job.json');
}

function read_records_check_job(ctx) {
  const job = readJsonSafe(records_check_job_path(ctx), null);
  if (!job || typeof job !== 'object') return null;
  // Migrate tác vụ stale của bản cũ: trước đây chỉ giữ current_key nhưng chưa có
  // resume_key, nên lần chạy mới dễ quay lại từ đầu.
  if (!job.running && job.stale && job.current_key && !job.resume_key) {
    return write_records_check_job(ctx, {
      ...job,
      resume_key: job.current_key,
      message: job.message || 'Tác vụ cũ đã dừng; lần chạy sau tiếp tục từ vị trí đã lưu.',
    });
  }
  if (job.running) {
    // Nếu server đã restart thì job nền cũ chắc chắn không còn chạy trong process hiện tại.
    // Đánh dấu dừng để UI không bị khóa nút lấy dữ liệu sau khi npm start lại.
    if (!job.server_pid || Number(job.server_pid) !== process.pid) {
      return write_records_check_job(ctx, {
        ...job,
        running: false,
        stale: true,
        stop_requested: false,
        resume_key: job.current_key || job.resume_key || '',
        finished_at: job.finished_at || new Date().toISOString(),
        message: job.current_key
          ? `Tác vụ cũ đã dừng do server khởi động lại; lần chạy sau sẽ tiếp tục từ ${job.current_name || job.current_ma_bn || 'ca đang dở'}.`
          : 'Tác vụ cũ đã dừng do server đã khởi động lại.',
      });
    }
    if (job.updatedAt) {
      const ageMs = Date.now() - Date.parse(job.updatedAt);
      if (Number.isFinite(ageMs) && ageMs > 6 * 60 * 60 * 1000) {
        return write_records_check_job(ctx, {
          ...job,
          running: false,
          stale: true,
          stop_requested: false,
          resume_key: job.current_key || job.resume_key || '',
          finished_at: job.finished_at || new Date().toISOString(),
          message: 'Tác vụ cũ đã quá lâu, tự đánh dấu dừng; lần chạy sau tiếp tục từ vị trí đã lưu.',
        });
      }
    }
  }
  return job;
}

function write_records_check_job(ctx, job) {
  const data = { ...(job || {}), updatedAt: new Date().toISOString() };
  writeJsonAtomic(records_check_job_path(ctx), data);
  return data;
}

function start_records_check_job(ctx, payload = {}) {
  const job = {
    id: payload.id || `${Date.now()}_${Math.random().toString(16).slice(2)}`,
    type: payload.type || 'fetch_batch',
    running: true,
    done: 0,
    total: Number(payload.total || 0),
    current_key: '',
    current_ma_bn: '',
    current_name: '',
    resume_key: payload.resume_key || payload.resumeKey || '',
    resumed_from_key: payload.resume_key || payload.resumeKey || '',
    started_at: new Date().toISOString(),
    finished_at: null,
    server_pid: process.pid,
    stop_requested: false,
    stopped: false,
    message: payload.message || 'Đang lấy dữ liệu kiểm hồ sơ',
  };
  return write_records_check_job(ctx, job);
}

function update_records_check_job(ctx, patch = {}) {
  const current = read_records_check_job(ctx) || {};
  return write_records_check_job(ctx, { ...current, ...patch });
}

function finish_records_check_job(ctx, patch = {}) {
  const current = read_records_check_job(ctx) || {};
  const stopped = Boolean(patch.stopped || current.stop_requested || current.stopped);
  return write_records_check_job(ctx, {
    ...current,
    ...patch,
    running: false,
    current_key: stopped ? (patch.current_key ?? current.current_key ?? '') : '',
    current_ma_bn: stopped ? (patch.current_ma_bn ?? current.current_ma_bn ?? '') : '',
    current_name: stopped ? (patch.current_name ?? current.current_name ?? '') : '',
    resume_key: stopped ? (patch.resume_key || current.current_key || current.resume_key || '') : '',
    finished_at: new Date().toISOString(),
  });
}

function request_stop_records_check_job(ctx, message = 'Đã yêu cầu dừng lấy dữ liệu kiểm hồ sơ.') {
  const current = readJsonSafe(records_check_job_path(ctx), null) || {};
  return write_records_check_job(ctx, {
    ...current,
    running: false,
    stop_requested: true,
    stopped: true,
    stopped_at: new Date().toISOString(),
    resume_key: current.current_key || current.resume_key || '',
    finished_at: current.finished_at || new Date().toISOString(),
    message,
  });
}

function records_check_stop_requested(ctx) {
  const job = readJsonSafe(records_check_job_path(ctx), null);
  return Boolean(job && (job.stop_requested || job.stopped));
}

function recordsCheckMissingFilesForMeta(ctx, meta) {
  const card = buildRecordsCheckCard(ctx, meta);
  if (meta?.fetch_error || card?.fetch_error) return [...RECORDS_CHECK_FILES];
  const missing = [];
  const storage = firstStorageText(card?.discharge || {}, card || {}, meta || {}, meta?.source_row || {});
  const badDischargeDate = recordsHasBadDischargeDate({ ...(card || {}), source_row: meta?.source_row || {} });
  // Nếu ngày ra lấy được nhỏ hơn ngày vào, lấy lại riêng màn Ra Khoa.
  // Trước đây các ca này đã có discharge/CLS nên backend bỏ qua, UI cập nhật xong
  // vẫn giữ nguyên trạng thái.
  const dischargeUsable = recordsCheckPayloadUsable('discharge', card?.discharge);
  const clsUsable = recordsCheckPayloadUsable('cls', card?.cls);
  const dischargeDate = recordsFirstDateText(card?.discharge_time, card?.discharge?.raw_time, [card?.discharge?.gio_ra, card?.discharge?.ngay_ra].filter(Boolean).join(' '), card?.discharge?.ngay_ra);
  if (!dischargeUsable || !storage || badDischargeDate || !dischargeDate) missing.push('discharge');
  if (!clsUsable) missing.push('cls');
  return Array.from(new Set(missing));
}

function recordsDateDmy(value) {
  const parsed = parseDateForRecords(value);
  if (!parsed) return '';
  return `${String(parsed.getDate()).padStart(2, '0')}/${String(parsed.getMonth() + 1).padStart(2, '0')}/${parsed.getFullYear()}`;
}

function recordsFetchRangeForMeta(meta = {}, fallbackFrom = '', fallbackTo = '') {
  const source = meta?.source_row && typeof meta.source_row === 'object' ? meta.source_row : {};
  const admission = recordsFirstDateText(
    meta.admission_time,
    source.admission_time,
    source.thoi_gian_vao_khoa,
    source['Thời gian vào khoa'],
    source['Ngày vào viện'],
    fallbackFrom
  );
  const discharge = recordsFirstDateText(
    meta.discharge_time,
    records_discharge_time_from_row(source, ''),
    source['Thời gian ra viện'],
    source['Ngày ra viện'],
    fallbackTo,
    admission
  );
  const date_from = recordsDateDmy(admission) || recordsDateDmy(fallbackFrom) || String(fallbackFrom || '').trim();
  let date_to = recordsDateDmy(discharge) || recordsDateDmy(fallbackTo) || String(fallbackTo || date_from).trim();
  const fromDate = parseDateForRecords(date_from);
  const toDate = parseDateForRecords(date_to);
  if (fromDate && toDate && toDate < fromDate) {
    const fallbackEnd = recordsDateDmy(fallbackTo);
    const fallbackEndDate = parseDateForRecords(fallbackEnd);
    date_to = fallbackEndDate && fallbackEndDate >= fromDate ? fallbackEnd : date_from;
  }
  return { date_from, date_to: date_to || date_from };
}

async function fetch_records_check_case(ctx, records_meta, options = {}) {
  const storage_key = records_storage_key(records_meta);
  const ma_bn = normId(records_meta?.ma_bn);
  if (!storage_key || !ma_bn) throw new Error('Thiếu mã BN hoặc case_key kiểm hồ sơ.');

  const requestedDateFrom = String(options.date_from || '').trim();
  const requestedDateTo = String(options.date_to || requestedDateFrom).trim();
  // CĐHA phải được đếm trong toàn bộ đợt điều trị của đúng dòng, không dùng riêng
  // ngày đang chọn trên giao diện. Khoảng UI chỉ là dự phòng khi dòng scan thiếu ngày.
  const episodeRange = recordsFetchRangeForMeta(records_meta, requestedDateFrom, requestedDateTo);
  const date_from = episodeRange.date_from;
  const date_to = episodeRange.date_to;
  const headless = Boolean(options.headless);
  const inpatient_status = 'Hoàn tất';
  const scope = 'discharge';
  const requestedFiles = Array.isArray(options.files_to_fetch)
    ? options.files_to_fetch.map(x => String(x || '').trim()).filter(x => RECORDS_CHECK_FILES.includes(x))
    : null;
  const files_to_fetch = requestedFiles && requestedFiles.length
    ? requestedFiles
    : recordsCheckMissingFilesForMeta(ctx, records_meta);
  if (!files_to_fetch.length) {
    clear_records_fetch_error(ctx, storage_key);
    appendActivity(ctx, { kind: 'records_check.fetch_background.skip_complete', ma_bn, case_key: storage_key });
    return { ma_bn, case_key: storage_key, saved: [], skipped: true, file_failures: [] };
  }
  mark_records_fetch_attempt(ctx, storage_key);
  const storage_safe = safeFilePart(storage_key);
  const input_path = path.join(hchanh_dir(ctx), `fetch_input_${storage_safe}.json`);
  const out_path = path.join(hchanh_dir(ctx), `fetch_output_${storage_safe}.json`);
  const patient_row = { ...(records_meta?.source_row || {}) };

  writeJsonAtomic(input_path, {
    ...(patient_row || {}),
    ma_bn,
    ho_ten: records_meta.ho_ten || patient_row?.['Họ tên'] || patient_row?.ho_ten || '',
    phong: records_meta.phong || patient_row?.Vi_Tri || '',
    date_from,
    date_to,
    scope,
    files: files_to_fetch,
    inpatient_status,
    ...(headless ? { headless: true } : {}),
    records_check: true,
    case_key: storage_key,
    encounter_key: records_meta.encounter_key || storage_key,
    noitruid: records_meta.noitruid || patient_row?.noitruid || '',
    record_doctor_url: records_meta.record_doctor_url || patient_row?.record_doctor_url || patient_row?.doctor_url || '',
    record_nursing_url: records_meta.record_nursing_url || patient_row?.record_nursing_url || patient_row?.nursing_url || '',
  });

  const args = ['--input', input_path, '--out', out_path, '--scope', scope, '--files', files_to_fetch.join(',')];
  if (date_from) args.push('--from', date_from);
  if (date_to) args.push('--to', date_to);
  args.push('--status', inpatient_status);
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

  if (result.spawnError) throw new Error('Không khởi động được Python: ' + result.spawnError);
  if (result.killedByTimeout) throw new Error('Timeout khi lấy dữ liệu kiểm hồ sơ.');
  if (result.code !== 0) throw new Error(fmtPyError('Python lỗi khi lấy dữ liệu kiểm hồ sơ.', result));

  const output = readJsonSafe(out_path, null);
  if (!output || typeof output !== 'object') throw new Error('Worker không trả về dữ liệu.');

  const saved = [];
  const file_failures = [];
  for (const file_key of files_to_fetch) {
    if (output[file_key] === undefined) {
      file_failures.push(missingFetchOutputInfo(file_key));
      continue;
    }
    const payload = output[file_key];
    write_records_patient_file(ctx, storage_key, file_key, payload);
    mark_records_file_fetched(ctx, storage_key, file_key);
    if (file_key === 'discharge') update_records_storage_from_discharge(ctx, storage_key, payload);
    saved.push(file_key);
    const info = normalizeFetchOutputInfo(file_key, payload);
    if (TECHNICAL_FETCH_STATUSES.has(info.status)) file_failures.push(info);
  }

  try { if (fs.existsSync(input_path)) fs.rmSync(input_path, { force: true }); } catch (_) {}
  try { if (fs.existsSync(out_path)) fs.rmSync(out_path, { force: true }); } catch (_) {}

  if (file_failures.length) {
    const msg = file_failures.map(x => `${x.label}: ${x.status_label}${x.error ? ` (${x.error})` : ''}`).join('; ');
    mark_records_fetch_error(ctx, storage_key, msg);
  } else {
    clear_records_fetch_error(ctx, storage_key);
  }
  appendActivity(ctx, { kind: 'records_check.fetch_background.success', ma_bn, case_key: storage_key, saved, file_failures });
  return { ma_bn, case_key: storage_key, saved, file_failures };
}

// item.record_id/item.aliases trong kho nộp hồ sơ là case_key THÔ (không có
// tiền tố "key::" như alias dùng để lưu dấu "Đã kiểm"). Trước đây hàm này lọc
// qua recordsCheckedAliasesForState (chỉ giữ alias có tiền tố "key::") nên
// itemAliases luôn rỗng và không bao giờ khớp — sửa lại so khớp trực tiếp trên
// case_key thô, đồng thời dựng map 1 lần cho cả dashboard thay vì quét lại
// toàn bộ batch/item cho từng hồ sơ (tránh O(số hồ sơ × số hồ sơ đã nộp)).
function buildRecordsSubmittedAtIndex(submissionDashboard) {
  const map = new Map();
  for (const batch of Array.isArray(submissionDashboard?.batches) ? submissionDashboard.batches : []) {
    if (!batch?.submitted_at) continue;
    for (const item of Array.isArray(batch?.items) ? batch.items : []) {
      const effectiveStatus = String(item?.effective_status || item?.status || '').trim().toLowerCase();
      if (effectiveStatus !== 'submitted') continue;
      const keys = [item?.record_id, ...(Array.isArray(item?.aliases) ? item.aliases : [])]
        .map(records_storage_key).filter(Boolean);
      for (const key of keys) {
        if (!map.has(key)) map.set(key, batch.submitted_at);
      }
    }
  }
  return map;
}

function recordsSubmittedAtForKeys(submittedAtIndex, rawKeys) {
  for (const key of (Array.isArray(rawKeys) ? rawKeys : []).map(records_storage_key).filter(Boolean)) {
    const hit = submittedAtIndex.get(key);
    if (hit) return hit;
  }
  return null;
}

// Gắn thêm 3 nhóm trạng thái độc lập cho 1 hồ sơ (spec mục 6): KSĐ/GPB, hạn
// bàn giao 48 giờ + trạng thái nộp, và trạng thái hồ sơ giấy — không gộp chung
// vào 1 trạng thái duy nhất, và không suy đoán KSĐ/GPB khi adapter chưa có nguồn.
function enrichRecordsCheckCard(card, submittedAtIndex) {
  const ksdGpb = getKsdGpbStatus({ discharge: card.discharge, cls: card.cls });
  const dischargeInfo = recordsDischargeDateTimeInfo(card.discharge_time);
  const rawKeys = [card.case_key, card.merged_key, card.storage_key, ...(Array.isArray(card.source_case_keys) ? card.source_case_keys : [])];
  const handedOverAt = recordsSubmittedAtForKeys(submittedAtIndex, rawKeys);
  const handover = computeHandover({
    dischargedAtIso: dischargeInfo.iso,
    dischargeHasTime: dischargeInfo.hasTime,
    handedOverAt,
  });
  const checklist = card.paper_checklist || normalizePaperChecklist(null);
  const paperStatus = paperRecordStatus(checklist, ksdGpb);
  const readiness = submissionReadiness({
    hasDischargeDate: Boolean(card.discharge_time),
    hasStorage: Boolean(card.so_luu_tru || card.storage_no),
    checklist,
    ksdGpb,
  });

  let submissionState = 'not_ready';
  if (handedOverAt) submissionState = handover.state === 'submitted_late' ? 'submitted_late' : 'submitted_on_time';
  else if (handover.state === 'overdue') submissionState = 'overdue';
  else if (readiness.ready) submissionState = 'ready';

  card.ksd_gpb = ksdGpb;
  card.handover = handover;
  card.paper_status = paperStatus;
  card.paper_checklist = checklist;
  card.submission_ready = readiness.ready;
  card.submission_missing = readiness.missing;
  card.submission_state = submissionState;
  card.cover_note_suggestion = coverNoteSuggestion(ksdGpb);
  return card;
}

function buildRecordsCheckDashboard(ctx) {
  const index = read_records_check_index(ctx);
  ensureRecordsCheckedAliases(index);
  const recoveredFromPdf = recoverRecordsCheckedFromLatestPdf(ctx, index);
  const reconciledLegacy = reconcileRecordsLegacyDuplicates(ctx, index);
  const metas = Object.values(index.patients || {}).filter(meta => meta && meta.active !== false);
  const checkedMap = index.checked && typeof index.checked === 'object' && !Array.isArray(index.checked) ? index.checked : {};
  let recoveredChecked = false;
  const rawPatients = metas
    .map(meta => {
      try {
        const card = buildRecordsCheckCard(ctx, meta);
        const key = card.case_key || card.storage_key || '';
        const aliases = recordsIdentityAliases(meta, key);
        const checkedState = resolveRecordsCheckedState(index, aliases, [key]);
        if (checkedState?.checked) {
          const checkedAt = checkedState.checked_at || card.checked_at || meta.checked_at || new Date().toISOString();
          card.checked = true;
          card.checked_at = checkedAt;
          if (!checkedMap[key]?.checked || !meta.checked) {
            checkedMap[key] = { checked: true, checked_at: checkedAt, changed_at: checkedState.changed_at || checkedAt };
            meta.checked = true;
            meta.checked_at = checkedAt;
            setRecordsCheckedAliasState(index, aliases, true, checkedState.changed_at || checkedAt, checkedAt);
            recoveredChecked = true;
          }
        } else if (checkedState && checkedState.checked === false) {
          // Tombstone bỏ kiểm là nguồn chính xác hơn meta/index cũ. Xóa cờ cũ để
          // checked_map không tự bật lại sau reload.
          card.checked = false;
          card.checked_at = null;
          if (meta.checked || checkedMap[key]) {
            meta.checked = false;
            meta.checked_at = null;
            delete checkedMap[key];
            recoveredChecked = true;
          }
        }
        // "Đã kiểm hồ sơ giấy" (mục 1/7 của checklist) dùng map index.checked/
        // checked_aliases riêng (đã xử lý ở trên, có khóa/tombstone khi hồ sơ đã
        // nộp); 6 mục còn lại dùng map index.checklist/checklist_aliases. Gộp lại
        // thành một object checklist đầy đủ cho frontend.
        card.paper_checklist = {
          ...resolveRecordsChecklistState(index, aliases, [key]),
          checked: Boolean(card.checked),
          checked_at: card.checked_at || null,
        };
        return card;
      }
      catch (err) {
        console.error(`[RECORDS_CHECK/dashboard] Lỗi build card ${meta.ma_bn || meta.case_key}:`, err.message);
        return null;
      }
    })
    .filter(Boolean);

  const submissionDashboardForLookup = buildRecordsSubmissionDashboard(records_check_persistent_dir(ctx));
  const submittedAtIndex = buildRecordsSubmittedAtIndex(submissionDashboardForLookup);
  const patients = mergeRecordsCheckCardsByStorage(rawPatients).map(card => enrichRecordsCheckCard(card, submittedAtIndex));

  if (recoveredChecked || reconciledLegacy || recoveredFromPdf) write_records_check_index(ctx, index);
  const visibleCheckedMap = visibleRecordsCheckedMap(index, metas);

  return {
    status: 'ok',
    version: 2,
    generatedAt: new Date().toISOString(),
    indexUpdatedAt: index.updatedAt || null,
    storagePath: records_check_persistent_dir(ctx),
    checked_map: visibleCheckedMap,
    scanInfo: index.lastScan || null,
    job: read_records_check_job(ctx),
    counts: {
      total: patients.length,
      all_indexed: Object.keys(index.patients || {}).length,
      source_rows: rawPatients.length,
      duplicate_rows_merged: Math.max(0, rawPatients.length - patients.length),
      stale: Object.values(index.patients || {}).filter(p => p && p.active === false).length,
      completed: patients.length,
      with_storage: patients.filter(p => String(p?.discharge?.so_luu_tru || p?.so_luu_tru || '').trim()).length,
      has_discharge: patients.filter(p => p.has_discharge).length,
      has_order_history: patients.filter(p => p.has_order_history).length,
      has_cls: patients.filter(p => p.has_cls).length,
    },
    total: patients.length,
    patients,
  };
}
// ── Bản nháp nhập VTYT hàng loạt ────────────────────────────────────────────
// Lưu theo session để người dùng tải lại trang vẫn tiếp tục đúng dữ liệu đang sửa.

function hchanh_vtyt_draft_path(ctx) {
  const dir = hchanh_dir(ctx);
  try { fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); } catch (_) {}
  return path.join(dir, 'vtyt_batch_draft.json');
}

function sanitizeHchanhVtytDraft(raw) {
  const value = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const patients = Array.isArray(value.patients) ? value.patients.slice(0, 250) : [];
  const jobs = Array.isArray(value.jobs) ? value.jobs.slice(0, 5000) : [];
  const safeJobs = jobs.map(job => {
    const row = job && typeof job === 'object' ? job : {};
    return {
      ...row,
      ma_bn: String(row.ma_bn || '').replace(/\D+/g, '').slice(0, 12),
      ngay_lam: String(row.ngay_lam || '').slice(0, 20),
      supplies: Array.isArray(row.supplies) ? row.supplies.slice(0, 150).map(item => ({
        ...(item && typeof item === 'object' ? item : {}),
        code: String(item?.code || '').slice(0, 80),
        name: String(item?.name || '').slice(0, 300),
        searchKeyword: String(item?.searchKeyword || item?.name || '').slice(0, 300),
        required_quantity: Math.max(0, Number(item?.required_quantity || 0) || 0),
        existing_quantity: Math.max(0, Number(item?.existing_quantity || 0) || 0),
        missing_quantity: Math.max(0, Number(item?.missing_quantity || 0) || 0),
        input_quantity: Math.max(0, Number(item?.input_quantity || 0) || 0),
        selected: item?.selected !== false,
        manual: item?.manual === true,
        reasons: Array.isArray(item?.reasons) ? item.reasons.slice(0, 30).map(v => String(v || '').slice(0, 500)) : [],
        warnings: Array.isArray(item?.warnings) ? item.warnings.slice(0, 20).map(v => String(v || '').slice(0, 500)) : [],
      })) : [],
      drugs: Array.isArray(row.drugs) ? row.drugs.slice(0, 300) : [],
      orders: Array.isArray(row.orders) ? row.orders.slice(0, 300) : [],
      warnings: Array.isArray(row.warnings) ? row.warnings.slice(0, 100).map(v => String(v || '').slice(0, 800)) : [],
      reviewed: row.reviewed === true,
    };
  });
  return {
    version: 1,
    created_at: String(value.created_at || new Date().toISOString()).slice(0, 80),
    updated_at: new Date().toISOString(),
    precheck_token: String(value.precheck_token || '').slice(0, 400),
    precheck_expires_at: String(value.precheck_expires_at || '').slice(0, 80),
    selected_patient_ids: Array.isArray(value.selected_patient_ids)
      ? value.selected_patient_ids.slice(0, 250).map(v => String(v || '').replace(/\D+/g, '').slice(0, 12)).filter(Boolean)
      : [],
    patient_dates: value.patient_dates && typeof value.patient_dates === 'object' && !Array.isArray(value.patient_dates)
      ? Object.fromEntries(Object.entries(value.patient_dates).slice(0, 250).map(([key, dates]) => [
          String(key || '').replace(/\D+/g, '').slice(0, 12),
          Array.isArray(dates) ? dates.slice(0, 366).map(v => String(v || '').slice(0, 20)).filter(Boolean) : [],
        ]).filter(([key]) => key))
      : {},
    patients,
    jobs: safeJobs,
    failed: value.failed && typeof value.failed === 'object' && !Array.isArray(value.failed) ? value.failed : {},
    input_result: value.input_result && typeof value.input_result === 'object' ? value.input_result : null,
  };
}

router.get('/hchanh/vtyt-draft', handleRoute((_req, res, ctx) => {
  const draft = readJsonSafe(hchanh_vtyt_draft_path(ctx), null);
  return res.json({ status: 'ok', draft: draft && typeof draft === 'object' ? draft : null });
}));

router.post('/hchanh/vtyt-draft', handleRoute((req, res, ctx) => {
  const rawDraft = req.body?.draft || req.body || {};
  const target = hchanh_vtyt_draft_path(ctx);
  const current = readJsonSafe(target, null);
  const incomingUpdated = Date.parse(String(rawDraft?.updated_at || '')) || 0;
  const currentUpdated = Date.parse(String(current?.updated_at || '')) || 0;
  if (current && currentUpdated > incomingUpdated) {
    return res.json({ status: 'ok', message: 'Bỏ qua bản nháp cũ hơn.', draft: current, ignored_stale: true });
  }
  const draft = sanitizeHchanhVtytDraft(rawDraft);
  writeJsonAtomic(target, draft);
  try { fs.chmodSync(target, 0o600); } catch (_) {}
  appendActivity(ctx, {
    kind: 'hchanh.vtyt_draft.save',
    patient_count: draft.patients.length,
    job_count: draft.jobs.length,
  });
  return res.json({ status: 'ok', message: 'Đã lưu bản nháp VTYT.', draft });
}));

router.delete('/hchanh/vtyt-draft', handleRoute((_req, res, ctx) => {
  const target = hchanh_vtyt_draft_path(ctx);
  try { fs.unlinkSync(target); } catch (err) { if (err?.code !== 'ENOENT') throw err; }
  appendActivity(ctx, { kind: 'hchanh.vtyt_draft.clear' });
  return res.json({ status: 'ok', message: 'Đã xóa bản nháp VTYT.' });
}));

// ── GET /api/hchanh/index ─────────────────────────────────────────────────────
// Trả về danh sách BN trong index + trạng thái fetch.

router.get('/hchanh/index', handleRoute((_req, res, ctx) => {
  const index = read_index(ctx);
  const patients = Object.values(index.patients || {});
  const activeCount = patients.filter(p => p && p.active !== false).length;
  const staleCount = patients.filter(p => p && p.active === false).length;
  return res.json({
    status: 'ok',
    version: HCHANH_DATA_VERSION,
    updatedAt: index.updatedAt,
    total: patients.length,
    active_count: activeCount,
    stale_count: staleCount,
    lastSync: index.lastSync || null,
    patients,
  });
}));

// ── POST /api/hchanh/sync ─────────────────────────────────────────────────────
// Đồng bộ danh sách BN từ raw/sorted vào hchanh/index.
// Gọi sau khi scan xong hoặc khi mở tab Hành chánh.
// Body: { patients: [...] }  hoặc không cần body — tự đọc từ SORTED_PATH.

router.post('/hchanh/sync', handleRoute((req, res, ctx) => {
  // Ưu tiên body nếu UI gửi lên; nếu không thì đọc đúng dữ liệu đã quét trong session.
  // Fallback thêm patients.json v2 để Hành chánh tách riêng nhưng vẫn bám nguồn scan ban đầu.
  const rows = readRowsForHchanhSync(ctx, req.body?.patients);

  const index = sync_index_from_patients(ctx, rows);
  const patients = Object.values(index.patients || {});

  appendActivity(ctx, { kind: 'hchanh.sync', count: patients.length });
  const activeCount = patients.filter(p => p && p.active !== false).length;
  const staleCount = patients.filter(p => p && p.active === false).length;
  return res.json({
    status: 'ok',
    message: `Đã đồng bộ ${activeCount} người bệnh đang nằm khoa vào danh sách hành chánh.`,
    total: patients.length,
    active_count: activeCount,
    stale_count: staleCount,
    updatedAt: index.updatedAt,
  });
}));

// ── POST /api/hchanh/fetch ────────────────────────────────────────────────────
// Fetch dữ liệu 1 BN theo scope.
// Body: { ma_bn, scope?, files? }
//   scope: "discharge" | "daily" | "admission" | "surgery"
//          Nếu không truyền, tự resolve từ workflow_tags trong index.
//   files: ["billing", "bed_days"]
//          Nếu truyền, chỉ fetch những file được chỉ định (lấy lẻ).

router.post('/hchanh/fetch', async (req, res) => {
  const ctx    = getRuntimePaths(req);
  const ma_bn  = normId(req.body?.ma_bn || req.body?.patientId);
  const date_from = String(req.body?.date_from || req.body?.dateFrom || '').trim();
  const date_to   = String(req.body?.date_to   || req.body?.dateTo   || date_from).trim();
  const inpatient_status = String(req.body?.inpatient_status || req.body?.inpatientStatus || req.body?.status || '').trim();
  const requested_case_key = String(req.body?.case_key || req.body?.caseKey || req.body?.encounter_key || req.body?.encounterKey || '').trim();
  const records_check = Boolean(req.body?.records_check || req.body?.recordsCheck || requested_case_key);
  const headless = boolFromBody(
    req.body?.headless ?? req.body?.hidden ?? req.body?.run_hidden ?? req.body?.runHidden,
    records_check ? true : false
  );

  if (!ma_bn) return res.status(400).json({ status: 'error', message: 'Thiếu mã bệnh nhân (ma_bn).' });

  // Xác định scope. Với Kiểm hồ sơ, lưu dữ liệu theo từng dòng/lượt Hoàn tất, không lưu chung theo mã BN.
  const index   = read_index(ctx);
  let records_meta = null;
  let patient_meta = index.patients[ma_bn] || {};
  let storage_key = ma_bn;
  if (records_check) {
    const rcIndex = read_records_check_index(ctx);
    records_meta = (requested_case_key && rcIndex.patients?.[requested_case_key]) ||
      Object.values(rcIndex.patients || {}).find(meta => meta && meta.active !== false && meta.ma_bn === ma_bn) || null;
    if (!records_meta) {
      return res.status(404).json({ status: 'error', message: 'Không tìm thấy dòng kiểm hồ sơ tương ứng. Hãy quét lại danh sách Hoàn tất.' });
    }
    patient_meta = records_meta;
    storage_key = records_storage_key(records_meta);
  }
  const raw_scope = String(req.body?.scope || patient_meta.scope_default || 'daily');
  const scope   = FETCH_SCOPES[raw_scope] ? raw_scope : 'daily';
  const scope_def = FETCH_SCOPES[scope];

  // Xác định files cần fetch: có thể chỉ định lẻ qua body.files
  const requested_files = Array.isArray(req.body?.files) ? req.body.files : null;
  const files_to_fetch = requested_files
    ? requested_files.filter(f => scope_def.files.includes(f))
    : scope_def.files;

  if (!files_to_fetch.length) {
    return res.status(400).json({ status: 'error', message: 'Không có file nào cần fetch cho scope này.' });
  }

  try {
    await enqueueHeavy(ctx.sid, async () => {
      // Chuẩn bị input cho Python worker
      const storage_safe = safeFilePart(records_check ? storage_key : ma_bn);
      const input_path = path.join(hchanh_dir(ctx), `fetch_input_${storage_safe}.json`);
      const out_path   = path.join(hchanh_dir(ctx), `fetch_output_${storage_safe}.json`);

      // Lấy thông tin BN từ đúng dòng scan. Với Kiểm hồ sơ ưu tiên source_row đã lưu khi quét Hoàn tất,
      // vì trong đó có link/noitruid của đúng lượt điều trị.
      const sorted_rows = readJsonSafe(ctx.SORTED_PATH, []) || readJsonSafe(ctx.RAW_PATH, []);
      const patient_row = records_check
        ? { ...(records_meta?.source_row || {}) }
        : (Array.isArray(sorted_rows)
          ? sorted_rows.find(r => normId(r?.ma_bn || r?.['Mã BN'] || r?.['Mã YT']) === ma_bn)
          : null);

      writeJsonAtomic(input_path, {
        ...(patient_row || {}),
        ma_bn,
        ho_ten:    patient_meta.ho_ten || patient_row?.['Họ tên'] || patient_row?.ho_ten || '',
        phong:     patient_meta.phong  || patient_row?.Vi_Tri || '',
        date_from: date_from || '',
        date_to:   date_to   || '',
        scope,
        files: files_to_fetch,
        ...(inpatient_status ? { inpatient_status } : {}),
        ...(headless ? { headless: true } : {}),
        ...(records_check ? {
          records_check: true,
          case_key: storage_key,
          encounter_key: patient_meta.encounter_key || storage_key,
          noitruid: patient_meta.noitruid || patient_row?.noitruid || '',
          record_doctor_url: patient_meta.record_doctor_url || patient_row?.record_doctor_url || patient_row?.doctor_url || '',
          record_nursing_url: patient_meta.record_nursing_url || patient_row?.record_nursing_url || patient_row?.nursing_url || '',
        } : {}),
      });

      if (records_check) mark_records_fetch_attempt(ctx, storage_key);

      const args = [
        '--input', input_path,
        '--out',   out_path,
        '--scope', scope,
        '--files', files_to_fetch.join(','),
      ];
      if (date_from) args.push('--from', date_from);
      if (date_to)   args.push('--to',   date_to);
      if (inpatient_status) args.push('--status', inpatient_status);
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

      if (result.spawnError) {
        const message = 'Không khởi động được Python: ' + result.spawnError;
        if (records_check) mark_records_fetch_error(ctx, storage_key, message);
        return res.status(500).json({ status: 'error', message });
      }
      if (result.killedByTimeout) {
        const message = 'Timeout khi lấy dữ liệu hành chánh.';
        if (records_check) mark_records_fetch_error(ctx, storage_key, message);
        return res.status(504).json({ status: 'error', message });
      }
      if (result.code !== 0) {
        records_check ? mark_records_fetch_error(ctx, storage_key, fmtPyError('Python lỗi khi lấy dữ liệu hành chánh.', result)) : mark_fetch_error(ctx, ma_bn, fmtPyError('Python lỗi khi lấy dữ liệu hành chánh.', result));
        return res.status(500).json({ status: 'error', message: fmtPyError('Python lỗi khi lấy dữ liệu hành chánh.', result) });
      }

      // Đọc output và lưu từng file
      const output = readJsonSafe(out_path, null);
      if (!output || typeof output !== 'object') {
        records_check ? mark_records_fetch_error(ctx, storage_key, 'Worker không trả về dữ liệu.') : mark_fetch_error(ctx, ma_bn, 'Worker không trả về dữ liệu.');
        return res.status(500).json({ status: 'error', message: 'Worker không trả về dữ liệu.' });
      }

      const saved = [];
      const file_failures = [];
      const file_attention = [];
      for (const file_key of files_to_fetch) {
        if (output[file_key] === undefined) {
          file_failures.push(missingFetchOutputInfo(file_key));
          continue;
        }
        const payload = output[file_key];
        if (records_check) {
          write_records_patient_file(ctx, storage_key, file_key, payload);
          mark_records_file_fetched(ctx, storage_key, file_key);
          if (file_key === 'discharge') update_records_storage_from_discharge(ctx, storage_key, payload);
        } else {
          write_patient_file(ctx, storage_key, file_key, payload);
        }
        saved.push(file_key);

        const info = normalizeFetchOutputInfo(file_key, payload);
        if (TECHNICAL_FETCH_STATUSES.has(info.status)) file_failures.push(info);
        else if (ATTENTION_FETCH_STATUSES.has(info.status)) file_attention.push(info);
      }

      // Dọn file tạm
      try { if (fs.existsSync(input_path)) fs.rmSync(input_path, { force: true }); } catch (_) {}
      try { if (fs.existsSync(out_path))   fs.rmSync(out_path,   { force: true }); } catch (_) {}

      const saved_files = saved.map(key => ({
        key,
        label: hchanh_file_label(key),
        file: `${hchanh_file_stem(key)}.json`,
      }));
      const missing_files = files_to_fetch
        .filter(f => !saved.includes(f))
        .map(key => ({ key, label: hchanh_file_label(key), file: `${hchanh_file_stem(key)}.json` }));

      // Nếu còn lỗi kỹ thuật ở từng file thì giữ trạng thái lỗi máy;
      // nếu chỉ là empty/partial thì không xem là lỗi Python, để dashboard hiển thị “Cần xử lý”.
      const check_after = records_check
        ? {
            missing: RECORDS_CHECK_FILES.filter(f => !read_records_patient_file(ctx, storage_key, f)),
            present: RECORDS_CHECK_FILES.filter(f => Boolean(read_records_patient_file(ctx, storage_key, f))),
            scope,
            files_required: RECORDS_CHECK_FILES,
          }
        : check_missing_files(ctx, ma_bn, scope);
      if (file_failures.length) {
        const msg = file_failures.map(x => `${x.label}: ${x.status_label}${x.error ? ` (${x.error})` : ''}`).join('; ');
        records_check ? mark_records_fetch_error(ctx, storage_key, msg) : mark_fetch_error(ctx, ma_bn, msg);
      } else if (!check_after.missing.length) {
        records_check ? clear_records_fetch_error(ctx, storage_key) : clear_fetch_error(ctx, ma_bn);
      }

      appendActivity(ctx, { kind: records_check ? 'records_check.fetch.success' : 'hchanh.fetch.success', ma_bn, case_key: records_check ? storage_key : undefined, scope, saved, file_attention, file_failures });
      const suffix = file_failures.length
        ? ` Có ${file_failures.length} mục lỗi kỹ thuật.`
        : (file_attention.length ? ` Có ${file_attention.length} mục cần xử lý nội dung.` : '');
      return res.json({
        status: 'ok',
        message: `Đã lấy dữ liệu hành chánh cho ${ma_bn}: ${saved_files.map(x => x.label).join(', ')}.${suffix}`,
        ma_bn,
        ...(records_check ? { case_key: storage_key } : {}),
        scope,
        saved,
        saved_files,
        attention_files: file_attention,
        machine_error_files: file_failures,
        missing: files_to_fetch.filter(f => !saved.includes(f)),
        missing_files,
      });
    });
  } catch (err) {
    console.error('[HCHANH/fetch]', err);
    if (!res.headersSent) res.status(500).json({ status: 'error', message: String(err.message || err) });
  }
});


// ── POST /api/hchanh/open-bed-edit ───────────────────────────────────────────
// Mở Chrome để sửa buồng/giường thủ công trong EMR.
// Luồng: con mắt điều dưỡng → Chăm sóc → Buồng giường → Sửa thông tin.
// Chạy detached để API trả về ngay, Chrome vẫn mở cho người dùng sửa trực tiếp.

router.post('/hchanh/open-bed-edit', handleRoute((req, res, ctx) => {
  const ma_bn = normId(req.body?.ma_bn || req.body?.patientId);
  const date_to = String(req.body?.date_to || req.body?.dateTo || '').trim();
  if (!ma_bn) return res.status(400).json({ status: 'error', message: 'Thiếu mã bệnh nhân (ma_bn).' });

  const scriptPath = path.join(WORKER_DIR, 'hchanh_open_bed_edit.py');
  if (!fs.existsSync(scriptPath)) {
    return res.status(500).json({ status: 'error', message: 'Thiếu script worker/hchanh_open_bed_edit.py.' });
  }

  const logDir = path.join(ctx.dir, 'logs');
  try { fs.mkdirSync(logDir, { recursive: true }); } catch (_) {}
  const stamp = new Date().toISOString().replace(/[:.]/g, '').replace('T', '_').slice(0, 15);
  const logPath = path.join(logDir, `hchanh_bed_edit_${safeFilePart(ma_bn)}_${stamp}.log`);
  const outFd = fs.openSync(logPath, 'a');

  const runtimeConfigPath = path.join(ctx.dir, 'config.json');
  const runtimeDv2Path = path.join(ctx.dir, 'd_v2.json');
  const appConfigPath = fs.existsSync(runtimeConfigPath)
    ? runtimeConfigPath
    : path.join(path.resolve(__dirname, '../..'), 'config', 'config.json');
  const dV2ConfigPath = fs.existsSync(runtimeDv2Path)
    ? runtimeDv2Path
    : path.join(path.resolve(__dirname, '../..'), 'config', 'd_v2.json');

  const args = ['-X', 'utf8', '-u', scriptPath, '--ma-bn', ma_bn, '--keep-open-sec', '3600'];
  if (date_to) args.push('--date-to', date_to);

  const child = spawn(PYTHON_BIN, args, {
    cwd: ctx.dir,
    detached: true,
    stdio: ['ignore', outFd, outFd],
    windowsHide: false,
    env: {
      ...process.env,
      PYTHONUTF8: '1',
      PYTHONIOENCODING: 'utf-8',
      PYTHONPATH: process.env.PYTHONPATH ? `${WORKER_DIR}${path.delimiter}${process.env.PYTHONPATH}` : WORKER_DIR,
      APP_CONFIG_PATH: appConfigPath,
      D_V2_CONFIG_PATH: dV2ConfigPath,
      WORKER_RUNTIME_DIR: ctx.dir,
    },
  });
  child.unref();
  try { fs.closeSync(outFd); } catch (_) {}

  appendActivity(ctx, { kind: 'hchanh.bed_edit.open', ma_bn, logPath });
  return res.json({
    status: 'ok',
    message: `Đã mở Chrome để sửa giường cho BN ${ma_bn}.`,
    ma_bn,
    logPath,
  });
}));


// ── POST /api/hchanh/print-billing ──────────────────────────────────────────
// Lưu PDF "Bảng kê chi phí nội trú_Dọc(CV6556)" cho 1 BN.
// Body: { ma_bn, ho_ten?, date_to? }

router.post('/hchanh/print-billing', async (req, res) => {
  const ctx = getRuntimePaths(req);
  const ma_bn = normId(req.body?.ma_bn || req.body?.patientId);
  const ho_ten = String(req.body?.ho_ten || req.body?.name || '').trim();
  const date_to = String(req.body?.date_to || req.body?.dateTo || '').trim();
  const selected_dates = normalizeDischargePrintDates([
    ...(Array.isArray(req.body?.selected_dates) ? req.body.selected_dates : []),
    date_to,
  ]);
  if (!ma_bn) return res.status(400).json({ status: 'error', message: 'Thiếu mã bệnh nhân (ma_bn).' });
  if (!selected_dates.length) {
    return res.status(400).json({ status: 'error', message: 'Chưa chọn ngày ra viện cần in.' });
  }

  const validationIndex = read_index(ctx);
  const validationMeta = validationIndex.patients[ma_bn] || {};
  const validationRow = {
    ...(validationMeta?.source_row && typeof validationMeta.source_row === 'object' ? validationMeta.source_row : {}),
    ...validationMeta,
    ...req.body,
  };
  const actualDischargeDate = dischargeDateFromRow(validationRow);
  if (!dischargeDateMatchesSelection(validationRow, selected_dates)) {
    return res.status(400).json({
      status: 'error',
      message: actualDischargeDate
        ? `Người bệnh ra viện ngày ${actualDischargeDate}, không đúng ngày đang chọn (${selected_dates.join(', ')}). Chưa in để tránh nhầm ca.`
        : `Không xác định được ngày ra viện của người bệnh. Chưa in để tránh nhầm ca.`,
      selected_dates,
      actual_discharge_date: actualDischargeDate,
    });
  }

  try {
    await enqueueHeavy(ctx.sid, async () => {
      const printDir = path.join(hchanh_dir(ctx), 'printed_billing');
      fs.mkdirSync(printDir, { recursive: true });
      const out_path = path.join(hchanh_dir(ctx), `print_billing_${safeFilePart(ma_bn)}_${Date.now()}.json`);

      const index = read_index(ctx);
      const meta = index.patients[ma_bn] || {};
      const resolvedName = ho_ten || meta.ho_ten || '';

      const args = [
        '--ma-bn', ma_bn,
        '--ho-ten', resolvedName,
        '--out-dir', printDir,
        '--out', out_path,
      ];
      if (date_to) args.push('--date-to', date_to);

      let result;
      try {
        result = await runScript('hchanh_print_billing_pdf.py', args, {
          onSpawn: killFn => registerCancel(ctx.sid, killFn),
          runtimeDir: ctx.dir,
        });
      } finally {
        unregisterCancel(ctx.sid);
      }

      const output = readJsonSafe(out_path, null);
      try { if (fs.existsSync(out_path)) fs.rmSync(out_path, { force: true }); } catch (_) {}

      if (result.spawnError) return res.status(500).json({ status: 'error', message: 'Không khởi động được Python: ' + result.spawnError });
      if (result.killedByTimeout) return res.status(504).json({ status: 'error', message: 'Timeout khi in/lưu bảng kê.' });
      if (result.code !== 0) {
        const msg = output?.message || fmtPyError('Python lỗi khi in/lưu bảng kê.', result);
        return res.status(500).json({ status: 'error', message: msg, ...(output || {}) });
      }
      if (!output || output.status !== 'ok' || !output.file_name) {
        return res.status(500).json({ status: 'error', message: 'Worker chưa trả về file bảng kê hợp lệ.' });
      }

      appendActivity(ctx, { kind: 'hchanh.print_billing.success', ma_bn, file_name: output.file_name });
      return res.json({
        status: 'ok',
        message: output.message || `Đã lưu bảng kê cho BN ${ma_bn}.`,
        ma_bn,
        file_name: output.file_name,
        size_bytes: output.size_bytes || 0,
        download_url: `/api/hchanh/printed-billing/${encodeURIComponent(output.file_name)}`,
      });
    });
  } catch (err) {
    console.error('[HCHANH/print-billing]', err);
    if (!res.headersSent) res.status(500).json({ status: 'error', message: String(err.message || err) });
  }
});


// ── POST /api/hchanh/print-discharge-bundle ─────────────────────────────────
// Tổng hợp bộ phiếu in ra viện bệnh phòng cho 1 BN.
// Body: { ma_bn, ho_ten?, date_to? }

router.post('/hchanh/print-discharge-bundle', async (req, res) => {
  const ctx = getRuntimePaths(req);
  const ma_bn = normId(req.body?.ma_bn || req.body?.patientId);
  const ho_ten = String(req.body?.ho_ten || req.body?.name || '').trim();
  const date_to = String(req.body?.date_to || req.body?.dateTo || '').trim();
  const selected_dates = normalizeDischargePrintDates([
    ...(Array.isArray(req.body?.selected_dates) ? req.body.selected_dates : []),
    date_to,
  ]);
  if (!ma_bn) return res.status(400).json({ status: 'error', message: 'Thiếu mã bệnh nhân (ma_bn).' });
  if (!selected_dates.length) {
    return res.status(400).json({ status: 'error', message: 'Chưa chọn ngày ra viện cần in.' });
  }

  const validationIndex = read_index(ctx);
  const validationMeta = validationIndex.patients[ma_bn] || {};
  const validationRow = {
    ...(validationMeta?.source_row && typeof validationMeta.source_row === 'object' ? validationMeta.source_row : {}),
    ...validationMeta,
    ...req.body,
  };
  const actualDischargeDate = dischargeDateFromRow(validationRow);
  if (!dischargeDateMatchesSelection(validationRow, selected_dates)) {
    return res.status(400).json({
      status: 'error',
      message: actualDischargeDate
        ? `Người bệnh ra viện ngày ${actualDischargeDate}, không đúng ngày đang chọn (${selected_dates.join(', ')}). Chưa in để tránh nhầm ca.`
        : 'Không xác định được ngày ra viện của người bệnh. Chưa in để tránh nhầm ca.',
      selected_dates,
      actual_discharge_date: actualDischargeDate,
    });
  }

  try {
    await enqueueHeavy(ctx.sid, async () => {
      const printDir = path.join(ROOT_DIR, 'in');
      fs.mkdirSync(printDir, { recursive: true });
      const out_path = path.join(hchanh_dir(ctx), `print_discharge_bundle_${safeFilePart(ma_bn)}_${Date.now()}.json`);

      const index = read_index(ctx);
      const meta = index.patients[ma_bn] || {};
      const resolvedName = ho_ten || meta.ho_ten || '';

      const args = [
        '--ma-bn', ma_bn,
        '--ho-ten', resolvedName,
        '--out-dir', printDir,
        '--out', out_path,
      ];
      if (date_to) args.push('--date-to', date_to);

      let result;
      try {
        result = await runScript('ward_print_discharge_bundle.py', args, {
          onSpawn: killFn => registerCancel(ctx.sid, killFn),
          runtimeDir: ctx.dir,
        });
      } finally {
        unregisterCancel(ctx.sid);
      }

      const output = readJsonSafe(out_path, null);
      try { if (fs.existsSync(out_path)) fs.rmSync(out_path, { force: true }); } catch (_) {}

      if (result.spawnError) return res.status(500).json({ status: 'error', message: 'Không khởi động được Python: ' + result.spawnError });
      if (result.killedByTimeout) return res.status(504).json({ status: 'error', message: 'Timeout khi tổng hợp file in ra viện.' });

      // Worker trả code 8 khi đã tạo file nhưng một vài phiếu rời lỗi; vẫn cho người dùng tải file đã ghép.
      const partialOk = output && output.status === 'partial' && output.file_name;
      if (result.code !== 0 && !partialOk) {
        const msg = output?.message || fmtPyError('Python lỗi khi tổng hợp file in ra viện.', result);
        return res.status(500).json({ status: 'error', message: msg, ...(output || {}) });
      }
      if (!output || !['ok', 'partial'].includes(output.status) || !output.file_name) {
        return res.status(500).json({ status: 'error', message: 'Worker chưa trả về file tổng hợp hợp lệ.' });
      }

      appendActivity(ctx, { kind: 'ward.print_discharge_bundle.success', ma_bn, file_name: output.file_name, status: output.status });
      return res.json({
        status: output.status,
        message: output.message || `Đã tạo file tổng hợp in ra viện cho BN ${ma_bn}.`,
        ma_bn,
        file_name: output.file_name,
        size_bytes: output.size_bytes || 0,
        downloaded: Array.isArray(output.downloaded) ? output.downloaded : [],
        failures: Array.isArray(output.failures) ? output.failures : [],
        print_dir: output.print_dir || printDir,
        patient_dir: output.patient_dir || '',
        bundle_path: output.bundle_path || '',
        download_url: `/api/hchanh/discharge-bundle/${encodeURIComponent(output.file_name)}`,
      });
    });
  } catch (err) {
    console.error('[HCHANH/print-discharge-bundle]', err);
    if (!res.headersSent) res.status(500).json({ status: 'error', message: String(err.message || err) });
  }
});

// ── POST /api/hchanh/print-discharge-bundle-batch ───────────────────────────
// Tổng hợp bộ phiếu in ra viện cho nhiều BN xuất viện, sau đó ghép chung 1 PDF.
// Body: { patients: [{ ma_bn, ho_ten? }], date_to? }

router.post('/hchanh/print-discharge-bundle-batch', async (req, res) => {
  const ctx = getRuntimePaths(req);
  const rows = Array.isArray(req.body?.patients) ? req.body.patients : [];
  const date_to = String(req.body?.date_to || req.body?.dateTo || '').trim();
  const selected_dates = normalizeDischargePrintDates([
    ...(Array.isArray(req.body?.selected_dates) ? req.body.selected_dates : []),
    date_to,
  ]);

  if (!selected_dates.length) {
    return res.status(400).json({ status: 'error', message: 'Chưa chọn ngày ra viện cần in.' });
  }

  const validationIndex = read_index(ctx);
  const requestedIds = new Set();
  const seen = new Set();
  const patients = [];
  const excludedById = new Map();
  for (const row of rows) {
    const ma_bn = normId(row?.ma_bn || row?.patientId || row?.id);
    if (!ma_bn) continue;
    requestedIds.add(ma_bn);
    if (seen.has(ma_bn)) continue;

    const meta = validationIndex.patients[ma_bn] || {};
    const mergedRow = {
      ...(meta?.source_row && typeof meta.source_row === 'object' ? meta.source_row : {}),
      ...meta,
      ...(row && typeof row === 'object' ? row : {}),
    };
    const actualDischargeDate = dischargeDateFromRow(mergedRow);
    if (!dischargeDateMatchesSelection(mergedRow, selected_dates)) {
      excludedById.set(ma_bn, {
        ma_bn,
        ho_ten: String(row?.ho_ten || row?.name || meta?.ho_ten || '').trim(),
        actual_discharge_date: actualDischargeDate,
        selected_dates,
        reason: actualDischargeDate ? 'Sai ngày ra viện' : 'Chưa xác định được ngày ra viện',
      });
      continue;
    }

    seen.add(ma_bn);
    excludedById.delete(ma_bn);
    patients.push({
      ma_bn,
      ho_ten: String(row?.ho_ten || row?.name || meta?.ho_ten || '').trim(),
      so_phong: String(row?.so_phong || row?.room || row?.Vi_Tri || '').trim(),
      ngay_ra_vien: actualDischargeDate,
      ngay_ra_vien_date: actualDischargeDate,
    });
  }
  const excludedWrongDate = [...excludedById.values()].filter(item => !seen.has(item.ma_bn));

  if (!requestedIds.size) {
    return res.status(400).json({ status: 'error', message: 'Không có bệnh xuất viện nào để tổng hợp in.' });
  }
  if (requestedIds.size > 100) {
    return res.status(400).json({ status: 'error', message: 'Một lần chỉ nên tổng hợp tối đa 100 người bệnh.' });
  }
  if (!patients.length) {
    return res.status(400).json({
      status: 'error',
      message: `Không có người bệnh nào ra viện đúng ngày ${selected_dates.join(', ')}. Chưa tạo file in.`,
      selected_dates,
      requested_count: requestedIds.size,
      excluded_wrong_date_count: excludedWrongDate.length,
      excluded_wrong_date: excludedWrongDate,
    });
  }

  try {
    await enqueueHeavy(ctx.sid, async () => {
      const printDir = path.join(ROOT_DIR, 'in');
      fs.mkdirSync(printDir, { recursive: true });
      const index = read_index(ctx);
      const patientResults = [];
      const patientFailures = [];
      const mergeFiles = [];

      for (let i = 0; i < patients.length; i += 1) {
        const item = patients[i];
        const meta = index.patients[item.ma_bn] || {};
        const resolvedName = item.ho_ten || meta.ho_ten || '';
        const out_path = path.join(hchanh_dir(ctx), `print_discharge_bundle_${safeFilePart(item.ma_bn)}_${Date.now()}_${i}.json`);
        const args = [
          '--ma-bn', item.ma_bn,
          '--ho-ten', resolvedName,
          '--out-dir', printDir,
          '--out', out_path,
        ];
        if (date_to) args.push('--date-to', date_to);

        let result;
        try {
          result = await runScript('ward_print_discharge_bundle.py', args, {
            onSpawn: killFn => registerCancel(ctx.sid, killFn),
            runtimeDir: ctx.dir,
          });
        } finally {
          unregisterCancel(ctx.sid);
        }

        const output = readJsonSafe(out_path, null);
        try { if (fs.existsSync(out_path)) fs.rmSync(out_path, { force: true }); } catch (_) {}

        const partialOk = output && output.status === 'partial' && output.file_name;
        const ok = output && ['ok', 'partial'].includes(output.status) && output.file_name && output.bundle_path;
        if (result.spawnError) {
          patientFailures.push({ ma_bn: item.ma_bn, ho_ten: resolvedName, message: 'Không khởi động được Python: ' + result.spawnError });
          continue;
        }
        if (result.killedByTimeout) {
          patientFailures.push({ ma_bn: item.ma_bn, ho_ten: resolvedName, message: 'Timeout khi tổng hợp file in ra viện.' });
          continue;
        }
        if (result.code !== 0 && !partialOk) {
          patientFailures.push({ ma_bn: item.ma_bn, ho_ten: resolvedName, message: output?.message || fmtPyError('Python lỗi khi tổng hợp file in ra viện.', result) });
          continue;
        }
        if (!ok) {
          patientFailures.push({ ma_bn: item.ma_bn, ho_ten: resolvedName, message: output?.message || 'Worker chưa trả về file tổng hợp hợp lệ.' });
          continue;
        }

        patientResults.push({
          ma_bn: item.ma_bn,
          ho_ten: resolvedName,
          status: output.status,
          file_name: output.file_name,
          bundle_path: output.bundle_path,
          size_bytes: output.size_bytes || 0,
          failures: Array.isArray(output.failures) ? output.failures : [],
        });
        mergeFiles.push({
          ma_bn: item.ma_bn,
          ho_ten: resolvedName,
          label: `${item.ma_bn} ${resolvedName}`.trim(),
          path: output.bundle_path,
        });
      }

      if (!mergeFiles.length) {
        return res.status(500).json({
          status: 'error',
          message: 'Không tạo được bộ PDF nào để ghép chung.',
          patient_count: patients.length,
          requested_count: requestedIds.size,
          excluded_wrong_date_count: excludedWrongDate.length,
          excluded_wrong_date: excludedWrongDate,
          selected_dates,
          success_count: 0,
          failed_count: patientFailures.length,
          failures: patientFailures,
        });
      }

      const stamp = new Date().toISOString().replace(/[-:T.Z]/g, '').slice(0, 14);
      const finalName = `IN_RA_VIEN_TAT_CA_${stamp}.pdf`;
      const finalPath = path.join(printDir, finalName);
      const mergeInputPath = path.join(hchanh_dir(ctx), `merge_discharge_bundles_${Date.now()}.json`);
      const mergeOutputPath = path.join(hchanh_dir(ctx), `merge_discharge_bundles_${Date.now()}.out.json`);
      writeJsonAtomic(mergeInputPath, {
        blank_between_patients: true,
        files: mergeFiles,
      });

      let mergeResult;
      try {
        mergeResult = await runScript('merge_pdf_files.py', ['--input', mergeInputPath, '--out', finalPath, '--out-json', mergeOutputPath], {
          onSpawn: killFn => registerCancel(ctx.sid, killFn),
          runtimeDir: ctx.dir,
        });
      } finally {
        unregisterCancel(ctx.sid);
      }
      const mergeOutput = readJsonSafe(mergeOutputPath, null);
      try { if (fs.existsSync(mergeInputPath)) fs.rmSync(mergeInputPath, { force: true }); } catch (_) {}
      try { if (fs.existsSync(mergeOutputPath)) fs.rmSync(mergeOutputPath, { force: true }); } catch (_) {}

      const mergePartialOk = mergeOutput && mergeOutput.status === 'partial' && mergeOutput.file_name;
      if (mergeResult.spawnError) return res.status(500).json({ status: 'error', message: 'Không khởi động được Python ghép PDF: ' + mergeResult.spawnError });
      if (mergeResult.killedByTimeout) return res.status(504).json({ status: 'error', message: 'Timeout khi ghép PDF chung.' });
      if (mergeResult.code !== 0 && !mergePartialOk) {
        return res.status(500).json({
          status: 'error',
          message: mergeOutput?.message || fmtPyError('Python lỗi khi ghép PDF chung.', mergeResult),
          patient_count: patients.length,
          requested_count: requestedIds.size,
          excluded_wrong_date_count: excludedWrongDate.length,
          excluded_wrong_date: excludedWrongDate,
          selected_dates,
          success_count: patientResults.length,
          failed_count: patientFailures.length,
          failures: patientFailures,
        });
      }
      if (!mergeOutput || !['ok', 'partial'].includes(mergeOutput.status) || !mergeOutput.file_name) {
        return res.status(500).json({ status: 'error', message: 'Worker ghép PDF chưa trả về file tổng hợp hợp lệ.' });
      }

      const status = (patientFailures.length || mergeOutput.status === 'partial') ? 'partial' : 'ok';
      appendActivity(ctx, { kind: 'ward.print_discharge_bundle_batch.success', file_name: mergeOutput.file_name, status, patient_count: patients.length, requested_count: requestedIds.size, excluded_wrong_date_count: excludedWrongDate.length, selected_dates, success_count: patientResults.length });
      return res.json({
        status,
        message: status === 'ok'
          ? `Đã tạo file in chung cho ${patientResults.length} BN ra viện đúng ngày ${selected_dates.join(', ')}.`
          : `Đã tạo file in chung cho ${patientResults.length}/${patients.length} BN ra viện đúng ngày; có ${patientFailures.length} BN lỗi.`,
        patient_count: patients.length,
        requested_count: requestedIds.size,
        excluded_wrong_date_count: excludedWrongDate.length,
        excluded_wrong_date: excludedWrongDate,
        selected_dates,
        success_count: patientResults.length,
        failed_count: patientFailures.length,
        file_name: mergeOutput.file_name,
        size_bytes: mergeOutput.size_bytes || 0,
        total_pages: mergeOutput.total_pages || 0,
        inserted_blank_pages: mergeOutput.inserted_blank_pages || 0,
        print_dir: printDir,
        bundle_path: mergeOutput.bundle_path || finalPath,
        patient_results: patientResults,
        failures: patientFailures.concat(Array.isArray(mergeOutput.failures) ? mergeOutput.failures : []),
        merge_order: Array.isArray(mergeOutput.merged) ? mergeOutput.merged : [],
        download_url: `/api/hchanh/discharge-bundle/${encodeURIComponent(mergeOutput.file_name)}`,
      });
    });
  } catch (err) {
    console.error('[HCHANH/print-discharge-bundle-batch]', err);
    if (!res.headersSent) res.status(500).json({ status: 'error', message: String(err.message || err) });
  }
});


// ── GET /api/hchanh/discharge-bundle/:fileName ──────────────────────────────
// Tải file PDF tổng hợp đã lưu trong thư mục /in cùng cấp chương trình.

router.get('/hchanh/discharge-bundle/:fileName', handleRoute((req, res, _ctx) => {
  const fileName = path.basename(String(req.params.fileName || '').trim());
  if (!fileName || !fileName.toLowerCase().endsWith('.pdf') || fileName.includes('..')) {
    return res.status(400).json({ status: 'error', message: 'Tên file tổng hợp không hợp lệ.' });
  }
  const printDir = path.join(ROOT_DIR, 'in');
  const filePath = path.join(printDir, fileName);
  if (!filePath.startsWith(printDir) || !fs.existsSync(filePath)) {
    return res.status(404).json({ status: 'error', message: 'Không tìm thấy file tổng hợp trong thư mục in.' });
  }
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(fileName)}`);
  return res.sendFile(filePath);
}));

// ── GET /api/hchanh/printed-billing/:fileName ───────────────────────────────
// Tải lại file PDF bảng kê đã lưu trong session hiện tại.

router.get('/hchanh/printed-billing/:fileName', handleRoute((req, res, ctx) => {
  const fileName = path.basename(String(req.params.fileName || '').trim());
  if (!fileName || !fileName.toLowerCase().endsWith('.pdf') || fileName.includes('..')) {
    return res.status(400).json({ status: 'error', message: 'Tên file bảng kê không hợp lệ.' });
  }
  const printDir = path.join(hchanh_dir(ctx), 'printed_billing');
  const filePath = path.join(printDir, fileName);
  if (!filePath.startsWith(printDir) || !fs.existsSync(filePath)) {
    return res.status(404).json({ status: 'error', message: 'Không tìm thấy file bảng kê trong phiên hiện tại.' });
  }
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(fileName)}`);
  return res.sendFile(filePath);
}));

// ── GET /api/hchanh/patient/:ma_bn ───────────────────────────────────────────
// Đọc toàn bộ dữ liệu đã fetch của 1 BN.

router.get('/hchanh/patient/:ma_bn', handleRoute((req, res, ctx) => {
  const ma_bn = normId(req.params.ma_bn);
  if (!ma_bn) return res.status(400).json({ status: 'error', message: 'Thiếu mã bệnh nhân.' });

  const index  = read_index(ctx);
  const meta   = index.patients[ma_bn];
  if (!meta) return res.status(404).json({ status: 'error', message: 'Người bệnh không có trong danh sách hành chánh.' });

  const data   = read_patient_all(ctx, ma_bn);
  const scope  = meta.scope_default || 'daily';
  const check  = check_missing_files(ctx, ma_bn, scope);

  return res.json({
    status: 'ok',
    ma_bn,
    meta,
    scope,
    data_complete: check.missing.length === 0,
    missing_files: check.missing,
    data,
  });
}));

// ── GET /api/hchanh/dashboard ─────────────────────────────────────────────────
// Build dashboard từ dữ liệu trong hchanh/ (không đọc data/).

router.get('/hchanh/dashboard', handleRoute((_req, res, ctx) => {
  return res.json(buildHchanh_Dashboard(ctx));
}));


// ── Kiểm hồ sơ: quét danh sách Hoàn tất độc lập ─────────────────────────────

// Hồ sơ đã chốt nộp là dữ liệu lịch sử đã khóa. Dùng chung cho dấu "Đã kiểm" và
// checklist hồ sơ giấy (bác sĩ/điều dưỡng/trưởng khoa ký, note bìa): không ai
// được sửa âm thầm sau khi KHTH đã nhận, kể cả qua request trực tiếp hay UI cũ.
// rawCaseKeys: case_key THÔ (không tiền tố), khớp trực tiếp với item.record_id/
// item.aliases trong kho nộp hồ sơ (cũng lưu case_key thô). Trước đây hàm này
// nhận vào alias đã lọc qua recordsCheckedAliasesForState (chỉ giữ dạng
// "key::..." dùng riêng cho việc lưu dấu "Đã kiểm"), nên không bao giờ khớp
// được với case_key thô của kho nộp hồ sơ — khóa "hồ sơ đã nộp" vì vậy chưa
// từng có tác dụng ở phía backend (chỉ có cảnh báo phía giao diện).
function findRecordsSubmissionLockMatches(ctx, rawCaseKeys) {
  const targetKeys = new Set((Array.isArray(rawCaseKeys) ? rawCaseKeys : []).map(records_storage_key).filter(Boolean));
  if (!targetKeys.size) return [];
  const submissionDashboard = buildRecordsSubmissionDashboard(records_check_persistent_dir(ctx));
  const submittedMatches = [];
  for (const batch of Array.isArray(submissionDashboard?.batches) ? submissionDashboard.batches : []) {
    const batchSubmitted = Boolean(batch?.locked || batch?.batch_status === 'submitted' || batch?.status === 'submitted');
    if (!batchSubmitted) continue;
    for (const item of Array.isArray(batch?.items) ? batch.items : []) {
      const effectiveStatus = String(item?.effective_status || '').trim().toLowerCase();
      const itemStatus = String(item?.status || '').trim().toLowerCase();
      if (effectiveStatus && effectiveStatus !== 'submitted') continue;
      if (!effectiveStatus && itemStatus !== 'active' && itemStatus !== 'submitted') continue;
      const itemKeys = [item?.record_id, ...(Array.isArray(item?.aliases) ? item.aliases : [])]
        .map(records_storage_key).filter(Boolean);
      if (!itemKeys.some(key => targetKeys.has(key))) continue;
      submittedMatches.push({
        submission_date: String(batch?.submission_date || batch?.id || '').trim(),
        record_id: String(item?.record_id || '').trim(),
      });
    }
  }
  return submittedMatches;
}

router.post('/hchanh/records-check/checked', handleRoute((req, res, ctx) => {
  const requested = Array.isArray(req.body?.case_keys || req.body?.caseKeys)
    ? (req.body.case_keys || req.body.caseKeys)
    : [req.body?.case_key || req.body?.caseKey || req.body?.encounter_key || req.body?.encounterKey];
  const caseKeys = [...new Set(requested.map(records_storage_key).filter(Boolean))];
  if (!caseKeys.length) return res.status(400).json({ status: 'error', message: 'Thiếu case_key.' });

  const checked = boolFromBody(req.body?.checked, false);
  const index = read_records_check_index(ctx);
  ensureRecordsCheckedAliases(index);
  const changedAt = new Date().toISOString();
  const targetAliases = new Set();

  for (const caseKey of caseKeys) {
    const meta = index.patients?.[caseKey];
    for (const alias of recordsIdentityAliases(meta || {}, caseKey)) targetAliases.add(alias);
  }
  const safeTargetAliases = recordsCheckedAliasesForState([...targetAliases]);

  const submittedMatches = findRecordsSubmissionLockMatches(ctx, caseKeys);
  if (submittedMatches.length) {
    const submissionDate = submittedMatches[0].submission_date;
    return res.status(423).json({
      status: 'locked',
      message: `Hồ sơ đã nộp${submissionDate ? ` ngày ${recordsSubmissionDateLabel(submissionDate)}` : ''}; dấu “Đã kiểm” đã được khóa để tránh thao tác nhầm.`,
      submission_date: submissionDate,
      locked_records: submittedMatches,
    });
  }

  let checkedAt = changedAt;
  if (checked) {
    // Giữ nguyên thời điểm tích đầu tiên, kể cả key hồ sơ đã đổi sau lần quét.
    const existingEvents = [];
    for (const caseKey of caseKeys) {
      if (index.checked?.[caseKey]?.checked) existingEvents.push(index.checked[caseKey]);
    }
    for (const alias of safeTargetAliases) {
      if (index.checked_aliases?.[alias]?.checked) existingEvents.push(index.checked_aliases[alias]);
    }
    existingEvents.sort((a, b) => recordsCheckedEventTime(a) - recordsCheckedEventTime(b));
    checkedAt = existingEvents[0]?.checked_at || changedAt;

    for (const caseKey of caseKeys) {
      index.checked[caseKey] = { checked: true, checked_at: checkedAt, changed_at: changedAt };
      const meta = index.patients?.[caseKey];
      if (meta) {
        meta.checked = true;
        meta.checked_at = checkedAt;
      }
    }
    setRecordsCheckedAliasState(index, safeTargetAliases, true, changedAt, checkedAt);
  } else {
    // Bỏ tích là thao tác duy nhất được phép xóa dấu. Ghi tombstone theo bí danh
    // và xóa cả key cũ/key mới cùng một lượt để lần scan sau không tự bật lại.
    setRecordsCheckedAliasState(index, safeTargetAliases, false, changedAt);
    for (const caseKey of caseKeys) delete index.checked[caseKey];

    for (const [patientKey, meta] of Object.entries(index.patients || {})) {
      const aliases = recordsCheckedAliasesForState(recordsIdentityAliases(meta || {}, patientKey));
      if (!aliasesIntersect(safeTargetAliases, aliases)) continue;
      delete index.checked[patientKey];
      if (meta && typeof meta === 'object') {
        meta.checked = false;
        meta.checked_at = null;
      }
    }
    for (const storedKey of Object.keys(index.checked || {})) {
      if (aliasesIntersect(safeTargetAliases, recordsCheckedAliasesForState(recordsAliasesFromCaseKey(storedKey)))) delete index.checked[storedKey];
    }
    checkedAt = null;
  }

  write_records_check_index(ctx, index);
  return res.json({
    status: 'ok',
    case_key: caseKeys[0],
    case_keys: caseKeys,
    checked,
    checked_at: checkedAt,
    storage: records_check_index_path(ctx),
  });
}));

const PAPER_CHECKLIST_PATCH_FIELDS = ['doctor_signed', 'nurse_signed', 'head_signed', 'cover_note_done', 'note'];

router.post('/hchanh/records-check/paper-checklist', handleRoute((req, res, ctx) => {
  const requested = Array.isArray(req.body?.case_keys || req.body?.caseKeys)
    ? (req.body.case_keys || req.body.caseKeys)
    : [req.body?.case_key || req.body?.caseKey || req.body?.encounter_key || req.body?.encounterKey];
  const caseKeys = [...new Set(requested.map(records_storage_key).filter(Boolean))];
  if (!caseKeys.length) return res.status(400).json({ status: 'error', message: 'Thiếu case_key.' });

  const rawPatch = req.body?.patch && typeof req.body.patch === 'object' ? req.body.patch : {};
  const patch = {};
  for (const field of PAPER_CHECKLIST_PATCH_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(rawPatch, field)) patch[field] = rawPatch[field];
  }
  if (!Object.keys(patch).length) return res.status(400).json({ status: 'error', message: 'Không có mục checklist nào để cập nhật.' });

  const actor = String(req.body?.actor || req.body?.by || '').trim().slice(0, 200);
  const index = read_records_check_index(ctx);
  ensureRecordsCheckedAliases(index);
  ensureRecordsChecklistAliases(index);
  const changedAt = new Date().toISOString();
  const targetAliases = new Set();
  for (const caseKey of caseKeys) {
    const meta = index.patients?.[caseKey];
    for (const alias of recordsIdentityAliases(meta || {}, caseKey)) targetAliases.add(alias);
  }
  const safeTargetAliases = recordsCheckedAliasesForState([...targetAliases]);

  const submittedMatches = findRecordsSubmissionLockMatches(ctx, caseKeys);
  if (submittedMatches.length) {
    const submissionDate = submittedMatches[0].submission_date;
    return res.status(423).json({
      status: 'locked',
      message: `Hồ sơ đã nộp${submissionDate ? ` ngày ${recordsSubmissionDateLabel(submissionDate)}` : ''}; checklist hồ sơ giấy đã được khóa để tránh thao tác nhầm. Nếu phát hiện sai sót, ghi nhận ở mục "Sai sót sau bàn giao".`,
      submission_date: submissionDate,
      locked_records: submittedMatches,
    });
  }

  index.checklist = asPlainObject(index.checklist);
  let latestChecklist = null;
  for (const caseKey of caseKeys) {
    const current = resolveRecordsChecklistState(index, recordsIdentityAliases(index.patients?.[caseKey] || {}, caseKey), [caseKey]);
    const next = applyPaperChecklistPatch(current, patch, actor, changedAt);
    index.checklist[caseKey] = next;
    setRecordsChecklistAliasState(index, recordsIdentityAliases(index.patients?.[caseKey] || {}, caseKey), next, changedAt);
    latestChecklist = next;
  }

  write_records_check_index(ctx, index);
  return res.json({
    status: 'ok',
    case_keys: caseKeys,
    checklist: latestChecklist,
  });
}));

router.get('/hchanh/records-check/dashboard', handleRoute((_req, res, ctx) => {
  return res.json(buildRecordsCheckDashboard(ctx));
}));

async function refreshRecordsCheckGoogleSheetCache(ctx, config) {
  const previousCache = read_records_check_google_sheet_cache(ctx);
  const result = await fetchGoogleSheetRecords({
    ...config,
    source_file: config.source_file_resolved,
    allow_public: ALLOW_PUBLIC_GOOGLE_SHEET,
  });
  const fetchedAt = new Date().toISOString();
  const changes = compareGoogleSheetRecords(previousCache.records, result.records);
  const changeText = changes.unchanged
    ? 'Không phát hiện thay đổi so với lần đồng bộ trước.'
    : `Thêm ${changes.added}, cập nhật ${changes.updated}, bỏ ${changes.removed}.`;
  const payload = {
    status: 'ok',
    enabled: true,
    source_type: result.source_type || (config.source_file_resolved ? 'local_csv' : 'google_sheet_public'),
    source_file_name: config.source_file_resolved ? path.basename(config.source_file_resolved) : '',
    spreadsheet_url: String(config.spreadsheet_url || ''),
    sheet_gid: String(result.gid || config.sheet_gid || '0'),
    source_etag: result.etag || '',
    source_last_modified: result.last_modified || '',
    source_cache_control: result.cache_control || '',
    content_hash: result.content_hash || '',
    downloaded_at: result.downloaded_at || fetchedAt,
    fetched_at: fetchedAt,
    stale: false,
    count: result.records.length,
    records: result.records,
    changes,
    write_enabled: Boolean(config.write_configured),
    write_configured: Boolean(config.write_configured),
    message: `Đã tải mới ${result.records.length} hồ sơ từ Google Sheet. ${changeText}`,
  };
  writeJsonAtomic(records_check_google_sheet_cache_path(ctx), payload);
  return payload;
}

router.get('/hchanh/records-check/google-sheet', handleRoute((_req, res, ctx) => {
  const config = read_records_check_google_sheet_config();
  const cache = read_records_check_google_sheet_cache(ctx);
  return res.json({
    ...cache,
    enabled: Boolean(config.enabled),
    source_type: config.source_file_resolved ? 'local_csv' : (config.spreadsheet_url ? 'google_sheet_public' : 'none'),
    source_configured: Boolean(config.source_file_resolved || config.spreadsheet_url),
    source_file_name: config.source_file_resolved ? path.basename(config.source_file_resolved) : '',
    public_sheet_blocked: Boolean(config.public_sheet_blocked),
    security_warning: config.public_sheet_blocked ? 'Google Sheet công khai đang bị khóa bởi chính sách bảo mật.' : '',
    spreadsheet_url: String(config.spreadsheet_url || ''),
    sheet_gid: String(config.sheet_gid || '0'),
    auto_sync_on_open: config.auto_sync_on_open === true,
    write_enabled: Boolean(config.write_configured),
    write_configured: Boolean(config.write_configured),
    write_config_error: String(config.write_config_error || ''),
    write_missing_token: Boolean(config.write_web_app_url && !GOOGLE_SHEET_WRITE_TOKEN),
  });
}));

router.post('/hchanh/records-check/google-sheet/sync', async (req, res) => {
  let ctx;
  let allowStaleFallback = true;
  try {
    ctx = getRuntimePaths(req);
    allowStaleFallback = req.body?.allow_stale_fallback !== false;
    const config = read_records_check_google_sheet_config();
    if (!config.enabled) {
      return res.json({ status: 'ok', enabled: false, records: [], count: 0, message: 'Liên kết Google Sheet đang tắt trong cấu hình.' });
    }
    if (config.public_sheet_blocked) {
      return res.status(403).json({ status: 'error', message: 'Google Sheet công khai đang bị khóa. Hãy dùng CSV nội bộ hoặc bật EMR_ALLOW_PUBLIC_GOOGLE_SHEET sau khi được phê duyệt.' });
    }
    if (!config.source_file_resolved && !String(config.spreadsheet_url || '').trim()) {
      return res.status(400).json({ status: 'error', message: 'Chưa cấu hình nguồn CSV kiểm hồ sơ.' });
    }
    if (config.source_file_resolved && !fs.existsSync(config.source_file_resolved)) {
      return res.status(400).json({ status: 'error', message: `Không tìm thấy file CSV nội bộ: ${path.basename(config.source_file_resolved)}` });
    }

    const payload = await refreshRecordsCheckGoogleSheetCache(ctx, config);
    appendActivity(ctx, { kind: 'records_check.google_sheet.sync', count: payload.records.length, fetched_at: payload.fetched_at });
    return res.json(payload);
  } catch (err) {
    console.error('[HCHANH/records-check/google-sheet/sync]', err);
    const message = String(err.message || err);
    const cache = ctx ? read_records_check_google_sheet_cache(ctx) : null;
    if (allowStaleFallback && cache && Array.isArray(cache.records) && cache.records.length) {
      return res.json({
        ...cache,
        status: 'ok',
        stale: true,
        warning: message,
        message: `Không tải được Google Sheet; đang dùng dữ liệu đã lưu (${cache.records.length} hồ sơ).`,
      });
    }
    return res.status(502).json({
      status: 'error',
      message: `Không tải được dữ liệu mới từ Google Sheet: ${message}`,
      stale: true,
      cached_count: Number(cache?.count || 0),
      cached_fetched_at: String(cache?.fetched_at || ''),
    });
  }
});

router.post('/hchanh/records-check/google-sheet/update-row', async (req, res) => {
  let ctx;
  try {
    ctx = getRuntimePaths(req);
    const config = read_records_check_google_sheet_config();
    if (!config.enabled) return res.status(400).json({ status: 'error', message: 'Liên kết Google Sheet đang tắt trong cấu hình.' });
    if (config.source_file_resolved) return res.status(400).json({ status: 'error', message: 'Nguồn hiện tại là CSV nội bộ nên không thể ghi trực tiếp lên Google Sheet.' });
    if (config.public_sheet_blocked) return res.status(403).json({ status: 'error', message: 'Google Sheet công khai đang bị khóa bởi chính sách bảo mật.' });
    if (!String(config.spreadsheet_url || '').trim()) return res.status(400).json({ status: 'error', message: 'Chưa cấu hình link Google Sheet.' });
    if (config.write_config_error) return res.status(400).json({ status: 'error', message: config.write_config_error });
    if (!config.write_web_app_url) return res.status(503).json({ status: 'error', message: 'Chưa cấu hình URL Web app Google Apps Script để sửa Sheet.' });
    if (!GOOGLE_SHEET_WRITE_TOKEN) return res.status(503).json({ status: 'error', message: 'Chưa cấu hình EMR_GOOGLE_SHEET_WRITE_TOKEN trên server.' });

    const rowNumber = Number.parseInt(String(req.body?.row_number || req.body?.rowNumber || ''), 10);
    if (!Number.isInteger(rowNumber) || rowNumber < 2 || rowNumber > 1000000) {
      return res.status(400).json({ status: 'error', message: 'Số dòng Google Sheet không hợp lệ.' });
    }
    const updatesRaw = req.body?.updates && typeof req.body.updates === 'object' ? req.body.updates : {};
    const updates = {};
    if (Object.prototype.hasOwnProperty.call(updatesRaw, 'storage_raw')) updates.storage_raw = String(updatesRaw.storage_raw ?? '').trim().slice(0, 120);
    if (Object.prototype.hasOwnProperty.call(updatesRaw, 'patient_name')) updates.patient_name = String(updatesRaw.patient_name ?? '').replace(/\s+/g, ' ').trim().slice(0, 180);
    if (!Object.keys(updates).length) return res.status(400).json({ status: 'error', message: 'Chưa có trường nào cần cập nhật.' });

    const expectedRaw = req.body?.expected && typeof req.body.expected === 'object' ? req.body.expected : {};
    const expected = {
      timestamp: String(expectedRaw.timestamp || '').trim().slice(0, 120),
      storage_raw: String(expectedRaw.storage_raw || '').trim().slice(0, 120),
      patient_name: String(expectedRaw.patient_name || '').replace(/\s+/g, ' ').trim().slice(0, 180),
    };
    const info = extractSpreadsheetInfo(config.spreadsheet_url, config.sheet_gid);
    const writeResult = await postJsonToGoogleAppsScript(config.write_web_app_url, {
      token: GOOGLE_SHEET_WRITE_TOKEN,
      action: 'update_records_check_row',
      spreadsheet_id: info.spreadsheet_id,
      sheet_gid: info.gid,
      row_number: rowNumber,
      expected,
      updates,
    }, { timeoutMs: Number(config.write_timeout_ms || config.timeout_ms || 20000) });

    const sheet = await refreshRecordsCheckGoogleSheetCache(ctx, config);
    appendActivity(ctx, {
      kind: 'records_check.google_sheet.update_row',
      row_number: rowNumber,
      changed_fields: Object.keys(updates),
      resolved_row_number: Number(writeResult.row_number || rowNumber),
    });
    return res.json({
      status: 'ok',
      message: String(writeResult.message || `Đã cập nhật dòng ${writeResult.row_number || rowNumber} trên Google Sheet.`),
      updated: writeResult,
      sheet,
    });
  } catch (err) {
    console.error('[HCHANH/records-check/google-sheet/update-row]', err);
    return res.status(502).json({ status: 'error', message: String(err.message || err) });
  }
});

router.get('/hchanh/records-check/submissions', handleRoute((_req, res, ctx) => {
  return res.json(buildRecordsSubmissionDashboard(records_check_persistent_dir(ctx)));
}));

// Điều kiện "Sẵn sàng nộp" (spec mục 8) không chỉ là dấu "Đã kiểm" — còn cần đủ
// ngày ra viện, số lưu trữ, chữ ký bác sĩ/điều dưỡng/trưởng khoa, và note bìa
// nếu đang nợ KSĐ/GPB. Trả về đúng dạng khóa thô (không prefix) để khớp
// record.aliases/source_case_keys mà frontend đã gửi lên.
function recordsSubmissionReadyAliases(ctx) {
  const dashboard = buildRecordsCheckDashboard(ctx);
  const out = new Set();
  for (const card of dashboard.patients || []) {
    if (!card?.submission_ready) continue;
    const keys = [card.case_key, card.merged_key, card.storage_key, ...(Array.isArray(card.source_case_keys) ? card.source_case_keys : [])];
    for (const key of keys) {
      const safe = records_storage_key(key);
      if (safe) out.add(safe);
    }
  }
  return [...out];
}

router.post('/hchanh/records-check/submissions/add', handleRoute((req, res, ctx) => {
  const submissionDate = req.body?.submission_date || req.body?.submissionDate || req.body?.date;
  const records = Array.isArray(req.body?.records) ? req.body.records : [];
  const result = addRecordsSubmission(
    records_check_persistent_dir(ctx),
    submissionDate,
    records,
    recordsSubmissionReadyAliases(ctx)
  );
  appendActivity(ctx, {
    kind: 'records_check.submission.add',
    submission_date: normalizeRecordsSubmissionDate(submissionDate),
    added: result.added.length,
    skipped: result.skipped.length,
  });
  return res.json({
    status: 'ok',
    message: `Đã thêm ${result.added.length} hồ sơ vào ngày nộp ${recordsSubmissionDateLabel(submissionDate)}.`,
    added: result.added.length,
    skipped: result.skipped,
    dashboard: result.dashboard,
  });
}));

router.post('/hchanh/records-check/submissions/submit', handleRoute((req, res, ctx) => {
  const batchId = req.body?.batch_id || req.body?.batchId || req.body?.submission_date || req.body?.date;
  const deliveredBy = String(req.body?.delivered_by || req.body?.deliveredBy || '').trim();
  const receivedBy = String(req.body?.received_by || req.body?.receivedBy || '').trim();
  let result = submitRecordsSubmissionBatch(
    records_check_persistent_dir(ctx),
    batchId,
    req.body?.note || req.body?.submission_note || '',
    deliveredBy,
    receivedBy
  );

  // Chụp lại trạng thái KSĐ/GPB + hồ sơ giấy tại đúng thời điểm bàn giao, cho
  // từng hồ sơ vừa chốt — không đổi ngược khi dữ liệu gốc thay đổi về sau.
  if (!result.already_submitted) {
    const dashboardNow = buildRecordsCheckDashboard(ctx);
    const snapshotsByAlias = {};
    for (const card of dashboardNow.patients || []) {
      const snap = {
        ksd_status: card.ksd_gpb?.ksd?.status || '',
        gpb_status: card.ksd_gpb?.gpb?.status || '',
        paper_status_label: card.paper_status?.label || '',
        note: card.paper_checklist?.note || '',
      };
      const keys = [card.case_key, card.merged_key, card.storage_key, ...(Array.isArray(card.source_case_keys) ? card.source_case_keys : [])];
      for (const key of keys) {
        const safe = records_storage_key(key);
        if (safe) snapshotsByAlias[safe] = snap;
      }
    }
    result = { ...result, dashboard: captureRecordsSubmissionHandoverSnapshots(records_check_persistent_dir(ctx), batchId, snapshotsByAlias) };
  }

  appendActivity(ctx, {
    kind: 'records_check.submission.submit',
    submission_date: normalizeRecordsSubmissionDate(batchId),
    count: result.count,
    already_submitted: Boolean(result.already_submitted),
    delivered_by: deliveredBy,
    received_by: receivedBy,
  });
  return res.json({
    status: 'ok',
    message: result.already_submitted
      ? `Đợt nộp ngày ${recordsSubmissionDateLabel(batchId)} đã được chốt trước đó.`
      : `Đã chốt ${result.count} hồ sơ là đã nộp ngày ${recordsSubmissionDateLabel(batchId)}.`,
    count: result.count,
    already_submitted: Boolean(result.already_submitted),
    dashboard: result.dashboard,
  });
}));

router.post('/hchanh/records-check/submissions/discrepancy', handleRoute((req, res, ctx) => {
  const batchId = req.body?.batch_id || req.body?.batchId || req.body?.submission_date || req.body?.date;
  const itemId = String(req.body?.item_id || req.body?.itemId || '').trim();
  const result = addRecordsSubmissionDiscrepancy(records_check_persistent_dir(ctx), batchId, itemId, {
    content: req.body?.content,
    reported_by: req.body?.reported_by || req.body?.reportedBy,
    related_people: req.body?.related_people || req.body?.relatedPeople,
    resolution: req.body?.resolution,
  });
  appendActivity(ctx, {
    kind: 'records_check.submission.discrepancy',
    submission_date: normalizeRecordsSubmissionDate(batchId),
    item_id: itemId,
  });
  return res.json({
    status: 'ok',
    message: 'Đã ghi nhận sai sót sau bàn giao.',
    discrepancy: result.discrepancy,
    dashboard: result.dashboard,
  });
}));

router.post('/hchanh/records-check/submissions/returned', handleRoute((req, res, ctx) => {
  const batchId = req.body?.batch_id || req.body?.batchId || req.body?.submission_date || req.body?.date;
  const itemIds = req.body?.item_ids || req.body?.itemIds || [];
  const result = markRecordsSubmissionReturned(
    records_check_persistent_dir(ctx),
    batchId,
    itemIds,
    req.body?.note || req.body?.return_note || ''
  );
  appendActivity(ctx, {
    kind: 'records_check.submission.returned',
    submission_date: normalizeRecordsSubmissionDate(batchId),
    count: result.changed.length,
  });
  return res.json({
    status: 'ok',
    message: `Đã đánh dấu ${result.changed.length} hồ sơ bị trả về. Có thể chọn lại để nộp vào ngày khác.`,
    changed: result.changed.length,
    dashboard: result.dashboard,
  });
}));

router.post('/hchanh/records-check/submissions/remove', handleRoute((req, res, ctx) => {
  const batchId = req.body?.batch_id || req.body?.batchId || req.body?.submission_date || req.body?.date;
  const itemIds = req.body?.item_ids || req.body?.itemIds || [];
  const result = removeRecordsSubmissionItems(records_check_persistent_dir(ctx), batchId, itemIds);
  appendActivity(ctx, {
    kind: 'records_check.submission.remove',
    submission_date: normalizeRecordsSubmissionDate(batchId),
    count: result.changed.length,
  });
  return res.json({
    status: 'ok',
    message: `Đã bỏ ${result.changed.length} hồ sơ khỏi đợt nộp chưa khóa.`,
    changed: result.changed.length,
    dashboard: result.dashboard,
  });
}));

router.post('/hchanh/records-check/submissions/export-pdf', async (req, res) => {
  const ctx = getRuntimePaths(req);
  try {
    ensureSessionAssets(ctx.dir, ROOT_DIR);
    const batchId = normalizeRecordsSubmissionDate(req.body?.batch_id || req.body?.batchId || req.body?.submission_date || req.body?.date);
    if (!batchId) return res.status(400).json({ status: 'error', message: 'Ngày nộp hồ sơ không hợp lệ.' });

    const merged = updateRecordsSubmissionBatchForExport(
      records_check_persistent_dir(ctx),
      batchId,
      Array.isArray(req.body?.rows) ? req.body.rows : []
    );
    const batch = merged.batch;
    const rows = (batch?.items || [])
      .filter(item => item.status !== 'removed')
      .map(item => ({
        record_id: item.record_id,
        aliases: item.aliases,
        ...(item.snapshot || {}),
      }));
    if (!rows.length) return res.status(400).json({ status: 'error', message: 'Ngày nộp này chưa có hồ sơ để xuất PDF.' });

    const dateLabel = recordsSubmissionDateLabel(batchId);
    const prefix = `nop_ho_so_${batchId.replace(/-/g, '')}`;
    const deliveredBy = String(req.body?.delivered_by || req.body?.deliveredBy || batch?.delivered_by || '').trim();
    const pdf = await createRecordsCheckPdf(ctx, rows, {
      prefix,
      title: `DANH SÁCH NỘP HỒ SƠ NGÀY ${dateLabel}`,
      subtitle: `Tổng số: ${rows.length} hồ sơ`,
      delivered_by: deliveredBy,
    });
    const dashboard = markRecordsSubmissionBatchExported(records_check_persistent_dir(ctx), batchId, pdf.outName);
    appendActivity(ctx, { kind: 'records_check.submission.export_pdf', submission_date: batchId, count: rows.length, file_name: pdf.outName });
    return res.json({ status: 'ok', count: rows.length, file_name: pdf.outName, url: pdf.url, dashboard });
  } catch (err) {
    console.error('[HCHANH/records-check/submissions/export-pdf]', err);
    if (!res.headersSent) res.status(500).json({ status: 'error', message: String(err.message || err) });
  }
});

router.post('/hchanh/records-check/export-pdf', async (req, res) => {
  const ctx = getRuntimePaths(req);
  try {
    ensureSessionAssets(ctx.dir, ROOT_DIR);
    const pdf = await createRecordsCheckPdf(ctx, Array.isArray(req.body?.rows) ? req.body.rows : [], {
      prefix: 'kiem_ho_so',
      title: 'DANH SÁCH KIỂM HỒ SƠ ĐÃ KIỂM',
    });
    appendActivity(ctx, { kind: 'records_check.export_pdf', count: pdf.rows.length, file_name: pdf.outName });
    return res.json({ status: 'ok', count: pdf.rows.length, file_name: pdf.outName, url: pdf.url });
  } catch (err) {
    console.error('[HCHANH/records-check/export-pdf]', err);
    const message = String(err.message || err);
    const status = /Không có hồ sơ/.test(message) ? 400 : 500;
    if (!res.headersSent) res.status(status).json({ status: 'error', message });
  }
});

router.get('/hchanh/records-check/print-pdf/:fileName', handleRoute((req, res, ctx) => {
  const fileName = path.basename(String(req.params.fileName || '').trim());
  if (!fileName || !fileName.toLowerCase().endsWith('.pdf') || fileName.includes('..')) {
    return res.status(400).json({ status: 'error', message: 'Tên file PDF không hợp lệ.' });
  }
  const printDir = path.join(records_check_persistent_dir(ctx), 'print');
  const filePath = path.join(printDir, fileName);
  if (!filePath.startsWith(printDir) || !fs.existsSync(filePath)) {
    return res.status(404).json({ status: 'error', message: 'Không tìm thấy PDF kiểm hồ sơ.' });
  }
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(fileName)}`);
  return res.sendFile(filePath);
}));

router.post('/hchanh/records-check/stop', handleRoute((_req, res, ctx) => {
  const cancelled = cancelSession(ctx.sid);
  const job = request_stop_records_check_job(ctx, cancelled ? 'Đã dừng tác vụ kiểm hồ sơ đang chạy.' : 'Đã xóa trạng thái tác vụ kiểm hồ sơ đang treo.');
  appendActivity(ctx, { kind: 'records_check.fetch_background.stop', cancelled });
  return res.json({ status: 'ok', cancelled, job, message: job.message });
}));

router.post('/hchanh/records-check/fetch-batch', async (req, res) => {
  const ctx = getRuntimePaths(req);
  const date_from = String(req.body?.date_from || req.body?.dateFrom || '').trim();
  const date_to = String(req.body?.date_to || req.body?.dateTo || date_from).trim();
  const headless = boolFromBody(req.body?.headless ?? req.body?.hidden ?? req.body?.run_hidden ?? req.body?.runHidden, true);
  const forceRefresh = boolFromBody(req.body?.force_refresh ?? req.body?.forceRefresh, false);
  const requestedKeys = Array.isArray(req.body?.case_keys || req.body?.caseKeys)
    ? (req.body.case_keys || req.body.caseKeys).map(records_storage_key).filter(Boolean)
    : [];
  const maxItemsRaw = Number(req.body?.max_items ?? req.body?.maxItems ?? req.body?.limit ?? 0);
  const maxItems = Number.isFinite(maxItemsRaw) && maxItemsRaw > 0 ? Math.floor(maxItemsRaw) : 0;

  try {
    ensureSessionAssets(ctx.dir, ROOT_DIR);
    const existingJob = read_records_check_job(ctx);
    if (existingJob?.running) {
      return res.status(409).json({ status: 'error', message: 'Đang có tác vụ kiểm hồ sơ chạy nền. Hãy chờ tác vụ hiện tại hoàn tất.', job: existingJob });
    }

    const index = read_records_check_index(ctx);
    let metas = Object.values(index.patients || {}).filter(meta => meta && meta.active !== false);
    if (requestedKeys.length) {
      const keySet = new Set(requestedKeys);
      metas = metas.filter(meta => keySet.has(records_storage_key(meta)));
    } else {
      metas = metas.filter(meta => {
        const card = buildRecordsCheckCard(ctx, meta);
        return !card?.data_complete;
      });
    }
    const resumeCursor = existingJob?.resume_key || existingJob?.current_key || '';
    metas = rotateRecordsMetasFromCursor(metas, resumeCursor);
    // Khi giao diện đã gửi case_keys cụ thể, mỗi key tương ứng đúng một dòng nguồn.
    // Giới hạn đã được áp dụng ở giao diện nên không cắt thêm lần nữa.
    if (maxItems > 0 && !requestedKeys.length) metas = metas.slice(0, maxItems);

    if (!metas.length) {
      return res.json({ status: 'ok', message: 'Không có lượt hồ sơ cần cập nhật.', job: read_records_check_job(ctx), total: 0 });
    }

    const job = start_records_check_job(ctx, { total: metas.length, resume_key: resumeCursor, message: `Đang lấy dữ liệu kiểm hồ sơ: 0/${metas.length}` });
    res.json({ status: 'ok', message: `Đã bắt đầu ${forceRefresh ? 'cập nhật đầy đủ' : 'lấy dữ liệu thiếu'} cho ${metas.length} dòng hồ sơ.`, job, total: metas.length, force_refresh: forceRefresh });

    setImmediate(() => {
      enqueueHeavy(ctx.sid, async () => {
        let done = 0;
        let failed = 0;
        for (let metaIndex = 0; metaIndex < metas.length; metaIndex += 1) {
          const meta = metas[metaIndex];
          if (records_check_stop_requested(ctx)) break;
          const caseKey = records_storage_key(meta);
          update_records_check_job(ctx, {
            running: true,
            done,
            total: metas.length,
            current_key: caseKey,
            current_ma_bn: meta.ma_bn || '',
            current_name: meta.ho_ten || '',
            resume_key: caseKey,
            message: `Đang lấy ${done + 1}/${metas.length}: ${meta.ho_ten || meta.ma_bn || caseKey}`,
          });
          try {
            const missingFiles = recordsCheckMissingFilesForMeta(ctx, meta);
            const filesToFetch = forceRefresh ? [...RECORDS_CHECK_FILES] : missingFiles;
            if (!filesToFetch.length) {
              appendActivity(ctx, { kind: 'records_check.fetch_background.skip_complete', ma_bn: meta.ma_bn || '', case_key: caseKey });
            } else {
              const fetchResult = await fetch_records_check_case(ctx, meta, { date_from, date_to, headless, files_to_fetch: filesToFetch });
              if (Array.isArray(fetchResult?.file_failures) && fetchResult.file_failures.length) failed += 1;
            }
          } catch (err) {
            if (records_check_stop_requested(ctx)) break;
            failed += 1;
            mark_records_fetch_error(ctx, caseKey, String(err.message || err));
            appendActivity(ctx, { kind: 'records_check.fetch_background.error', ma_bn: meta.ma_bn || '', case_key: caseKey, message: String(err.message || err) });
          } finally {
            done += 1;
            if (!records_check_stop_requested(ctx)) {
              const nextMeta = metas[metaIndex + 1] || null;
              update_records_check_job(ctx, {
                done,
                total: metas.length,
                current_key: '',
                current_ma_bn: '',
                current_name: '',
                resume_key: nextMeta ? records_storage_key(nextMeta) : '',
                failed,
                message: `Đã lấy ${done}/${metas.length}${failed ? ` · lỗi ${failed}` : ''}`,
              });
            }
          }
        }
        if (records_check_stop_requested(ctx)) {
          finish_records_check_job(ctx, { done, total: metas.length, failed, stopped: true, stop_requested: false, message: `Đã dừng lấy dữ liệu kiểm hồ sơ tại ${done}/${metas.length}${failed ? ` · lỗi ${failed}` : ''}` });
        } else {
          finish_records_check_job(ctx, { done, total: metas.length, failed, message: `Hoàn tất lấy dữ liệu kiểm hồ sơ: ${done}/${metas.length}${failed ? ` · lỗi ${failed}` : ''}` });
        }
      }).catch(err => {
        console.error('[HCHANH/records-check/fetch-batch/background]', err);
        finish_records_check_job(ctx, { message: `Tác vụ kiểm hồ sơ dừng do lỗi: ${String(err.message || err)}` });
      });
    });
  } catch (err) {
    console.error('[HCHANH/records-check/fetch-batch]', err);
    if (!res.headersSent) res.status(500).json({ status: 'error', message: String(err.message || err) });
  }
});

router.post('/hchanh/records-check/scan-completed', async (req, res) => {
  const ctx = getRuntimePaths(req);
  const headless = boolFromBody(
    req.body?.headless ?? req.body?.hidden ?? req.body?.run_hidden ?? req.body?.runHidden,
    true
  );
  try {
    ensureSessionAssets(ctx.dir, ROOT_DIR);
    await enqueueHeavy(ctx.sid, async () => {
      const out_path = path.join(hchanh_dir(ctx), `records_check_completed_raw_${Date.now()}.json`);
      const date_from = String(req.body?.date_from || req.body?.dateFrom || '').trim();
      const date_to = String(req.body?.date_to || req.body?.dateTo || date_from).trim();
      const scanArgs = ['--out', out_path, '--status', 'Hoàn tất'];
      if (date_from) scanArgs.push('--date-from', date_from);
      if (date_to) scanArgs.push('--date-to', date_to);
      if (headless) scanArgs.push('--headless');
      let result;
      try {
        result = await runWorker('scan', scanArgs, {
          onSpawn: killFn => registerCancel(ctx.sid, killFn),
          runtimeDir: ctx.dir,
        });
      } finally {
        unregisterCancel(ctx.sid);
      }

      if (result.spawnError)      return res.status(500).json({ status: 'error', message: `Không khởi động được Python: ${result.spawnError}` });
      if (result.killedByTimeout) return res.status(504).json({ status: 'error', message: 'Timeout khi quét danh sách Hoàn tất.' });
      if (result.code !== 0)      return res.status(500).json({ status: 'error', message: fmtPyError('Python lỗi khi quét danh sách Hoàn tất.', result) });

      const rawRows = readJsonSafe(out_path, []);
      const scannedRows = Array.isArray(rawRows) ? rawRows.map(row => ({ ...(row || {}), inpatient_status: 'Hoàn tất', trang_thai: 'Hoàn tất', 'Trạng thái': 'Hoàn tất' })) : [];
      const rows = filter_records_rows_by_range(scannedRows, date_from, date_to);
      const index = sync_records_check_index_from_rows(ctx, rows, { scanned_count: scannedRows.length, date_from, date_to });
      const dashboard = buildRecordsCheckDashboard(ctx);
      appendActivity(ctx, { kind: 'records_check.scan_completed.success', count: rows.length, scanned_count: scannedRows.length, active_count: dashboard?.counts?.total || 0 });
      try { if (fs.existsSync(out_path)) fs.rmSync(out_path, { force: true }); } catch (_) {}

      return res.json({
        status: 'ok',
        message: `Đã quét lại danh sách Hoàn tất: ${dashboard?.counts?.total || 0} ca.`,
        count: rows.length,
        scanned_count: scannedRows.length,
        active_count: dashboard?.counts?.total || 0,
        indexUpdatedAt: index.updatedAt,
        scanInfo: index.lastScan || null,
        dashboard,
      });
    });
  } catch (err) {
    console.error('[HCHANH/records-check/scan-completed]', err);
    if (!res.headersSent) res.status(500).json({ status: 'error', message: String(err.message || err) });
  }
});

// ── Tickets ───────────────────────────────────────────────────────────────────

router.get('/hchanh/tickets', handleRoute((_req, res, ctx) => {
  return res.json({ status: 'ok', ...readTicketStore(ctx) });
}));

router.post('/hchanh/ticket', handleRoute((req, res, ctx) => {
  const ma_bn = normId(req.body?.ma_bn || req.body?.patientId);
  if (!ma_bn) return res.status(400).json({ status: 'error', message: 'Thiếu mã bệnh nhân.' });
  const index = read_index(ctx);
  const meta  = index.patients[ma_bn];
  if (!meta) return res.status(404).json({ status: 'error', message: 'Người bệnh không có trong danh sách hành chánh.' });

  const data = read_patient_all(ctx, ma_bn);
  return res.json(upsertTicket(ctx, ma_bn, meta, data, {
    doctor: req.body?.doctor,
    note:   req.body?.note,
    issues: req.body?.issues,
  }));
}));

router.patch('/hchanh/ticket/:ticketId', handleRoute((req, res, ctx) => {
  const result = updateTicket(ctx, req.params.ticketId, req.body || {});
  if (result.status === 'error') return res.status(404).json(result);
  return res.json(result);
}));

// ── Snapshots ─────────────────────────────────────────────────────────────────

router.post('/hchanh/snapshot/:kind', handleRoute((req, res, ctx) => {
  const kind = req.params.kind === 'afternoon' ? 'afternoon' : 'morning';
  return res.json({ status: 'ok', snapshot: createSnapshot(ctx, kind) });
}));

router.get('/hchanh/snapshot', handleRoute((_req, res, ctx) => {
  return res.json({
    status: 'ok',
    morning:   readSnapshot(ctx, 'morning'),
    afternoon: readSnapshot(ctx, 'afternoon'),
  });
}));

// ── Xóa dữ liệu ──────────────────────────────────────────────────────────────

router.post('/hchanh/clear-patient', handleRoute((req, res, ctx) => {
  const ma_bn = normId(req.body?.ma_bn || req.body?.patientId);
  if (!ma_bn) return res.status(400).json({ status: 'error', message: 'Thiếu mã bệnh nhân.' });
  return res.json({ status: 'ok', ...clear_patient_data(ctx, ma_bn) });
}));

router.post('/hchanh/clear', handleRoute((_req, res, ctx) => {
  return res.json(clear_all_hchanh_data(ctx));
}));

module.exports = router;

// ── E: In/export phiếu sửa cho BS ────────────────────────────────────────────
// GET /api/hchanh/ticket/:ticketId/print  → trả về HTML in được
// GET /api/hchanh/export/issues           → CSV/JSON tất cả vấn đề cần xử lý

router.get('/hchanh/ticket/:ticketId/print', handleRoute((req, res, ctx) => {
  const key = normId(req.params.ticketId);
  const store = readTicketStore(ctx);
  let ticket = store.tickets.find(t => t.ticketId === key || t.ma_bn === key || t.patientId === key);

  // Fallback: nếu UI giữ link cũ nhưng ticket chưa lưu/đã mất, vẫn dựng phiếu tạm từ dữ liệu hiện tại của BN.
  // Cách này tránh lỗi trắng `Không tìm thấy phiếu` khi điều dưỡng cần in nhanh danh sách cần sửa.
  if (!ticket) {
    const index = read_index(ctx);
    const meta = index.patients[key];
    if (meta) {
      const { buildPatientCard } = require('../services/hchanh/dashboard');
      const card = buildPatientCard(ctx, meta, null);
      const issues = (card.issues || []).filter(i => i.severity !== 'info');
      ticket = {
        ticketId: `HC-TEMP-${key}`,
        ma_bn: key,
        ho_ten: meta.ho_ten || card.ho_ten || '',
        phong: meta.phong || card.phong || '',
        status: 'TEMP',
        issues,
        note: 'Phiếu tạm dựng từ dữ liệu hành chánh hiện tại.',
        createdAt: new Date().toISOString(),
      };
    }
  }

  if (!ticket) return res.status(404).json({ status:'error', message:'Không tìm thấy phiếu sửa hoặc mã bệnh nhân trong phiên hiện tại.' });

  const issues = (ticket.issues || []).filter(i => i.severity !== 'info');
  const html = buildTicketPrintHtml(ticket, issues);
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  return res.send(html);
}));

// F: Nghiệm thu lại 1 BN sau khi BS sửa
// POST /api/hchanh/rescan  { ma_bn }
// → fetch lại các file có issues → chạy QA lại → cập nhật ticket status

router.post('/hchanh/rescan', async (req, res) => {
  const ctx   = getRuntimePaths(req);
  const ma_bn = normId(req.body?.ma_bn || req.body?.patientId);
  if (!ma_bn) return res.status(400).json({ status:'error', message:'Thiếu mã bệnh nhân.' });

  try {
    await enqueueHeavy(ctx.sid, async () => {
      const index = read_index(ctx);
      const meta  = index.patients[ma_bn];
      if (!meta) return res.status(404).json({ status:'error', message:'BN không có trong danh sách hành chánh.' });

      const scope       = meta.scope_default || 'daily';
      const scope_def   = FETCH_SCOPES[scope] || FETCH_SCOPES.daily;
      const fetched     = meta.fetched || {};
      // Chỉ re-fetch các file đã từng fetch (không fetch file chưa bao giờ lấy)
      const files_to_refetch = scope_def.files.filter(f => fetched[f]);

      if (!files_to_refetch.length)
        return res.json({ status:'ok', message:'Chưa có dữ liệu để nghiệm thu.', ma_bn });

      const input_path = path.join(hchanh_dir(ctx), `fetch_input_${safeFilePart(ma_bn)}.json`);
      const out_path   = path.join(hchanh_dir(ctx), `fetch_output_${safeFilePart(ma_bn)}.json`);
      const sorted = readJsonSafe(ctx.SORTED_PATH, []) || readJsonSafe(ctx.RAW_PATH, []);
      const row = Array.isArray(sorted)
        ? sorted.find(r => normId(r?.ma_bn || r?.['Mã BN'] || r?.['Mã YT']) === ma_bn) || {}
        : {};

      writeJsonAtomic(input_path, { ma_bn, ...row, scope, files: files_to_refetch });
      const args = ['--input', input_path, '--out', out_path, '--scope', scope, '--files', files_to_refetch.join(',')];

      let result;
      try {
        result = await runScript('hchanh_fetch.py', args, {
          onSpawn: k => registerCancel(ctx.sid, k), runtimeDir: ctx.dir,
        });
      } finally { unregisterCancel(ctx.sid); }

      if (result.code !== 0)
        return res.status(500).json({ status:'error', message: fmtPyError('Lỗi khi nghiệm thu.', result) });

      const output = readJsonSafe(out_path, null);
      const file_failures = [];
      const file_attention = [];
      if (output && typeof output === 'object') {
        for (const fk of files_to_refetch) {
          if (output[fk] !== undefined) {
            const payload = output[fk];
            write_patient_file(ctx, ma_bn, fk, payload);
            const info = normalizeFetchOutputInfo(fk, payload);
            if (TECHNICAL_FETCH_STATUSES.has(info.status)) file_failures.push(info);
            else if (ATTENTION_FETCH_STATUSES.has(info.status)) file_attention.push(info);
          }
        }
      }
      if (file_failures.length) {
        mark_fetch_error(ctx, ma_bn, file_failures.map(x => `${x.label}: ${x.status_label}${x.error ? ` (${x.error})` : ''}`).join('; '));
      } else {
        clear_fetch_error(ctx, ma_bn);
      }
      try { if (fs.existsSync(input_path)) fs.rmSync(input_path, {force:true}); } catch(_){}
      try { if (fs.existsSync(out_path))   fs.rmSync(out_path,   {force:true}); } catch(_){}

      // Rebuild dashboard card và cập nhật ticket
      const { buildPatientCard } = require('../services/hchanh/dashboard');
      const data   = require('../hchanh_data_contract').read_patient_all(ctx, ma_bn);
      const store  = readTicketStore(ctx);
      const ticket = store.tickets.find(t => t.ma_bn === ma_bn && !['VERIFIED','CLOSED','NO_ISSUE'].includes(t.status));
      const card   = buildPatientCard(ctx, meta, ticket || null);

      // Nếu không còn issues → tự động đóng ticket
      const open_issues = (card.issues || []).filter(i => i.severity !== 'info');
      if (ticket && !open_issues.length) {
        updateTicket(ctx, ticket.ticketId, { status: 'VERIFIED' });
      }

      appendActivity(ctx, { kind:'hchanh.rescan.success', ma_bn, issues: open_issues.length, file_attention, file_failures });
      return res.json({
        status: 'ok', ma_bn,
        message: file_failures.length
          ? `Còn ${file_failures.length} lỗi kỹ thuật sau nghiệm thu.`
          : (open_issues.length
            ? `Còn ${open_issues.length} vấn đề sau nghiệm thu.`
            : 'Không còn vấn đề — đã tự động nghiệm thu phiếu sửa.'),
        issues_remaining: open_issues.length,
        attention_files: file_attention,
        machine_error_files: file_failures,
        ticket_auto_verified: (ticket && !open_issues.length && !file_failures.length) || false,
        card,
      });
    });
  } catch(err) {
    if (!res.headersSent) res.status(500).json({ status:'error', message: String(err.message||err) });
  }
});

// G2: In danh sách xếp phòng — chỉ thông tin xếp chỗ, nhóm theo phòng
// GET /api/hchanh/print-ward-list

router.get('/hchanh/print-ward-list', handleRoute((_req, res, ctx) => {
  const { buildHchanh_Dashboard } = require('../services/hchanh/dashboard');
  const dashboard = buildHchanh_Dashboard(ctx);
  const html = buildWardListPrintHtml(dashboard.patients || []);
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  return res.send(html);
}));

// G: Export danh sách vấn đề theo người phụ trách
// GET /api/hchanh/export/issues?format=json|csv&owner=BS|DD

router.get('/hchanh/export/issues', handleRoute((req, res, ctx) => {
  const { buildHchanh_Dashboard } = require('../services/hchanh/dashboard');
  const dashboard = buildHchanh_Dashboard(ctx);
  const format    = String(req.query?.format || 'json').toLowerCase();
  const owner_filter = String(req.query?.owner || '').toLowerCase();

  const rows = [];
  for (const card of (dashboard.patients || [])) {
    for (const issue of (card.issues || []).filter(i => i.severity !== 'info')) {
      if (owner_filter && !issue.owner?.toLowerCase().includes(owner_filter)) continue;
      rows.push({
        ma_bn:    card.ma_bn,
        ho_ten:   card.ho_ten,
        phong:    card.phong,
        scope:    card.scope,
        severity: issue.severity,
        group:    issue.group,
        code:     issue.code,
        title:    issue.title,
        detail:   issue.detail,
        action:   issue.action,
        owner:    issue.owner,
      });
    }
  }

  if (format === 'csv') {
    const headers = ['ma_bn','ho_ten','phong','scope','severity','group','code','title','detail','action','owner'];
    const csv = rowsToCsv(headers, rows).trimEnd();
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="hchanh_issues_${new Date().toISOString().slice(0,10)}.csv"`);
    return res.send('\uFEFF' + csv); // BOM for Excel UTF-8
  }

  return res.json({ status:'ok', total: rows.length, rows });
}));

// ── Helper: build HTML phiếu sửa để in ────────────────────────────────────────

function buildTicketPrintHtml(ticket, issues) {
  const now = new Date().toLocaleString('vi-VN');
  const safe = escapeHtml;
  const safeDate = (value) => value ? new Date(value).toLocaleString('vi-VN') : '—';
  const rows = issues.map(i => {
    const isError = i.severity === 'error';
    const detail = i.detail
      ? `<br><small style="color:#666">${safe(i.detail)}</small>`
      : '';
    return `
    <tr>
      <td>${safe(i.group || '')}</td>
      <td style="color:${isError ? '#c0392b' : '#e67e22'};font-weight:600">${isError ? 'Lỗi' : 'Cảnh báo'}</td>
      <td><strong>${safe(i.title || '')}</strong>${detail}</td>
      <td style="color:#2980b9">${safe(i.action || '')}</td>
      <td>${safe(i.owner || '')}</td>
    </tr>`;
  }).join('');

  return `<!DOCTYPE html><html lang="vi"><head><meta charset="UTF-8">
<title>Phiếu sửa hồ sơ − ${safe(ticket.ho_ten || ticket.ma_bn)}</title>
<style>
  body{font-family:Arial,sans-serif;font-size:12px;margin:20px;color:#222}
  h2{font-size:15px;margin-bottom:4px}
  .meta{color:#555;margin-bottom:14px;font-size:11px}
  table{width:100%;border-collapse:collapse;margin-top:10px}
  th{background:#f0f0f0;padding:6px 8px;text-align:left;border:1px solid #ccc;font-size:11px}
  td{padding:5px 8px;border:1px solid #ddd;vertical-align:top;font-size:11px}
  .footer{margin-top:24px;font-size:10px;color:#888;border-top:1px solid #ddd;padding-top:8px}
  @media print{.no-print{display:none}}
</style></head><body>
<button class="no-print" type="button" style="margin-bottom:12px;padding:6px 16px;cursor:pointer">Dùng Ctrl+P để in</button>
<h2>PHIẾU SỬA HỒ SƠ BỆNH ÁN</h2>
<div class="meta">
  <strong>Người bệnh:</strong> ${safe(ticket.ho_ten || '—')} · Mã BN: ${safe(ticket.ma_bn || '—')} · Phòng: ${safe(ticket.phong || '—')}<br>
  <strong>Mã phiếu:</strong> ${safe(ticket.ticketId || '—')} · Tạo lúc: ${safe(safeDate(ticket.createdAt))}<br>
  <strong>Ghi chú:</strong> ${safe(ticket.note || '—')} · Bác sĩ phụ trách: ${safe(ticket.doctor || '—')}
</div>
<table>
  <thead><tr><th>Nhóm</th><th>Mức độ</th><th>Vấn đề</th><th>Hành động cần làm</th><th>Phụ trách</th></tr></thead>
  <tbody>${rows || '<tr><td colspan="5" style="text-align:center;color:#888">Không có vấn đề nào.</td></tr>'}</tbody>
</table>
<div class="footer">In lúc: ${safe(now)} · Hệ thống EMR Dashboard</div>
</body></html>`;
}

// ── Helper: build HTML danh sách xếp phòng để in ──────────────────────────────
// Đơn giản tối đa, gói gọn trong 1 trang A4: chia nhiều cột, mỗi phòng 1 khối nhỏ.

function buildWardListPrintHtml(patients) {
  const safe = escapeHtml;
  const today = new Date().toLocaleDateString('vi-VN');

  const rooms = new Map(); // phong → [patients]
  for (const p of patients) {
    const key = String(p.phong || '').trim() || '(chưa xếp)';
    if (!rooms.has(key)) rooms.set(key, []);
    rooms.get(key).push(p);
  }

  const roomKeys = [...rooms.keys()].sort((a, b) => {
    if (a === '(chưa xếp)') return 1;
    if (b === '(chưa xếp)') return -1;
    return a.localeCompare(b, 'vi', { numeric: true });
  });

  const sections = roomKeys.map(room => {
    const names = rooms.get(room)
      .map(p => p.ho_ten || '—')
      .sort((a, b) => String(a).localeCompare(String(b), 'vi'));
    const items = names.map(name => `<li>${safe(name)}</li>`).join('');
    return `<div class="room"><div class="room-head">${safe(room)}</div><ul>${items}</ul></div>`;
  }).join('');

  return `<!DOCTYPE html><html lang="vi"><head><meta charset="UTF-8">
<title>Danh sách xếp phòng</title>
<style>
  @page{size:A4;margin:10mm}
  *{box-sizing:border-box}
  body{font-family:Arial,sans-serif;margin:0;color:#111}
  .head{display:flex;justify-content:space-between;align-items:baseline;
    border-bottom:1.5px solid #111;padding-bottom:3px;margin-bottom:10px}
  .head h1{font-size:14px;margin:0}
  .head span{font-size:10px;color:#555}
  .cols{column-count:3;column-gap:8mm}
  .room{break-inside:avoid-column;page-break-inside:avoid;margin-bottom:12px}
  .room-head{font-weight:700;font-size:11px;margin-bottom:4px}
  ul{margin:0;padding-left:0;list-style:none}
  li{font-size:10px;line-height:1.7}
  .no-print{margin-bottom:10px;padding:6px 16px;cursor:pointer}
  @media print{.no-print{display:none}}
</style></head><body>
<button class="no-print" type="button">Dùng Ctrl+P để in</button>
<div class="head"><h1>DANH SÁCH XẾP PHÒNG</h1><span>${safe(today)} · ${roomKeys.length} phòng · ${patients.length} BN</span></div>
<div class="cols">${sections || '<div style="color:#888">Không có bệnh nhân nào.</div>'}</div>
</body></html>`;
}
