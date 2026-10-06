'use strict';

// Kiểm tra tính toàn vẹn của dữ liệu thu thập trước/sau Chuẩn hóa.
// Mục tiêu: không biến "không thấy/không kiểm" thành "không có" và không để
// các dòng PT lỗi ngày/Raw JSON bị loại âm thầm khỏi bảng chuẩn hóa.

const fs = require('fs');
const path = require('path');
const { readCsvTable } = require('./table_io');
const { readJsonSafe, writeJsonAtomic } = require('../utils/file');

const REPORT_FILE = 'collection_integrity.json';

function clean(value) {
  return String(value ?? '').trim();
}

function hasDate(value) {
  const text = clean(value);
  return /\b\d{1,2}[/-]\d{1,2}[/-]\d{4}\b/.test(text)
    || /\b\d{4}-\d{1,2}-\d{1,2}\b/.test(text);
}

function parseRawJson(value) {
  const text = clean(value);
  if (!text) return { ok: false, empty: true, value: null };
  try {
    const parsed = JSON.parse(text);
    return { ok: Boolean(parsed && typeof parsed === 'object'), empty: false, value: parsed };
  } catch (_) {
    return { ok: false, empty: false, value: null };
  }
}

function surgeryProgressSummary(runDir) {
  const progress = readJsonSafe(path.join(runDir, 'hchanh_auto_progress.json'), {}) || {};
  let surgeryEntries = 0;
  let pendingOrError = 0;
  let zeroRowsReportedOk = 0;
  let verifiedEmpty = 0;
  const examples = [];

  for (const [sourceKey, item] of Object.entries(progress)) {
    const status = item?.file_status?.surgery;
    if (!status || typeof status !== 'object') continue;
    surgeryEntries += 1;
    const fetchStatus = clean(status.fetch_status).toLowerCase();
    const rows = Number(status.rows) || 0;
    const reason = clean(status.reason || status.override_reason);
    const explicitlyVerified = Boolean(status.verified_empty || status.verified_lookup || status.lookup_performed);

    if (['error', 'no_url', 'no_session', 'timeout', 'pending', 'partial'].includes(fetchStatus)) {
      pendingOrError += 1;
      if (examples.length < 20) examples.push({ source_key: sourceKey, fetch_status: fetchStatus, rows, reason });
    }
    if (fetchStatus === 'empty') {
      // Entry mới của research worker: màn hình D/s Phẫu thuật đã được lookup thật
      // và trả 0 dòng. Đây mới là explicit empty có thể dùng cho QA.
      verifiedEmpty += 1;
    } else if (fetchStatus === 'ok' && rows === 0) {
      if (explicitlyVerified) verifiedEmpty += 1;
      else {
        // Worker cũ có thể trả ok+0 chỉ vì không thấy marker PT ở lịch sử y lệnh.
        // Không được coi đó là bằng chứng "không phẫu thuật".
        zeroRowsReportedOk += 1;
        if (examples.length < 20) examples.push({ source_key: sourceKey, fetch_status: fetchStatus, rows, reason: reason || 'ok_zero_unverified' });
      }
    }
  }

  return { surgery_entries: surgeryEntries, pending_or_error: pendingOrError, ok_zero_unverified: zeroRowsReportedOk, verified_empty: verifiedEmpty, examples };
}

function rawSurgerySummary(runDir) {
  const file = path.join(runDir, 'hchanh_surgery.csv');
  if (!fs.existsSync(file)) return { rows: 0, missing_full_date: 0, invalid_raw_json: 0, raw_json_empty: 0 };
  const rows = readCsvTable(file, Number.MAX_SAFE_INTEGER).rows || [];
  let missingFullDate = 0;
  let invalidRawJson = 0;
  let rawJsonEmpty = 0;

  for (const row of rows) {
    if (!hasDate(row['Ngày phẫu thuật'] || row.surgery_date || row['Ngày PT'])) missingFullDate += 1;
    const parsed = parseRawJson(row['Raw JSON'] || row.raw_json);
    if (parsed.empty) rawJsonEmpty += 1;
    else if (!parsed.ok) invalidRawJson += 1;
  }
  return { rows: rows.length, missing_full_date: missingFullDate, invalid_raw_json: invalidRawJson, raw_json_empty: rawJsonEmpty };
}

function normalizedSurgerySummary(runDir) {
  const file = path.join(runDir, 'surgery_results.csv');
  if (!fs.existsSync(file)) return { rows: 0, unmatched: 0, missing_date: 0 };
  const rows = readCsvTable(file, Number.MAX_SAFE_INTEGER).rows || [];
  let unmatched = 0;
  let missingDate = 0;
  for (const row of rows) {
    if (clean(row.encounter_match_status).toLowerCase() !== 'matched') unmatched += 1;
    if (!hasDate(row.surgery_date || row['Ngày phẫu thuật'])) missingDate += 1;
  }
  return { rows: rows.length, unmatched, missing_date: missingDate };
}

function buildCollectionIntegrityReport(runDir, { phase = 'check' } = {}) {
  const dir = path.resolve(runDir);
  const progress = surgeryProgressSummary(dir);
  const rawSurgery = rawSurgerySummary(dir);
  const normalizedSurgery = normalizedSurgerySummary(dir);
  const blocking = [];
  const warnings = [];

  if (progress.pending_or_error > 0) blocking.push({ code: 'SURGERY_COLLECTION_INCOMPLETE', count: progress.pending_or_error });
  if (progress.ok_zero_unverified > 0) blocking.push({ code: 'SURGERY_ZERO_UNVERIFIED', count: progress.ok_zero_unverified });
  if (rawSurgery.invalid_raw_json > 0) blocking.push({ code: 'SURGERY_RAW_JSON_INVALID', count: rawSurgery.invalid_raw_json });
  if (rawSurgery.missing_full_date > 0) warnings.push({ code: 'SURGERY_RAW_DATE_INCOMPLETE', count: rawSurgery.missing_full_date });
  if (normalizedSurgery.unmatched > 0) warnings.push({ code: 'SURGERY_NORMALIZED_UNMATCHED', count: normalizedSurgery.unmatched });

  const report = {
    schema_version: 1,
    generated_at: new Date().toISOString(),
    phase,
    run_dir: dir,
    ready_for_analysis: blocking.length === 0,
    blocking_count: blocking.length,
    warning_count: warnings.length,
    blocking,
    warnings,
    surgery_progress: progress,
    raw_surgery: rawSurgery,
    normalized_surgery: normalizedSurgery,
  };
  writeJsonAtomic(path.join(dir, REPORT_FILE), report);
  return report;
}

module.exports = {
  REPORT_FILE,
  hasDate,
  parseRawJson,
  surgeryProgressSummary,
  rawSurgerySummary,
  normalizedSurgerySummary,
  buildCollectionIntegrityReport,
};
