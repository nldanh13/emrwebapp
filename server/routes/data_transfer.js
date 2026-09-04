// server/routes/data_transfer.js — /api/export-data, /api/import-data

'use strict';

const router = require('express').Router();
const fs     = require('fs');
const path   = require('path');

const { getRuntimePaths, clearSessionDerivedState } = require('../services/session');
const { readLatestActivity, redactLogText, appendActivity } = require('../services/activity_logger');
const { ensureDir, nowFileStamp, writeJsonAtomic } = require('../utils/file');
const {
  DATA_CONTRACT_VERSION,
  RUNTIME_FILE_SPECS,
  buildManifest,
  canonicalBundleNameForCtxKey,
  legacyBundleNamesForCtxKey,
} = require('../data_contract');

function buildBundleFileMap() {
  const map = {};
  for (const spec of Object.values(RUNTIME_FILE_SPECS)) {
    // Export/import các dữ liệu chính và schema v2; state tiến độ không nằm trong bundle trao đổi dữ liệu.
    if (!['RAW_PATH', 'SORTED_PATH', 'FINAL_PATH', 'PROCESSED_PATH', 'PATIENTS_PATH', 'BOARD_STATE_PATH', 'ORDER_DAYS_PATH', 'CLASSIFIED_DAYS_PATH', 'WARNINGS_PATH', 'INDEXES_PATH'].includes(spec.ctxKey)) continue;
    const canonical = spec.canonical.replace(/\\/g, '/');
    map[canonical] = spec.ctxKey;
    for (const legacy of (spec.legacy || [])) map[legacy] = spec.ctxKey;
  }
  return map;
}

/** Map tên file ↔ field trong bundle. Nhận cả tên chuẩn mới và tên cũ để tương thích. */
const BUNDLE_FILES = buildBundleFileMap();
const VALID_BUNDLE_KEYS = new Set(Object.keys(BUNDLE_FILES));
const MAX_IMPORT_ITEMS_PER_FILE = 5000;
const MAX_IMPORT_BYTES_PER_FILE = 10 * 1024 * 1024; // 10MB mỗi file trong bundle
const DANGEROUS_JSON_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

function hasDangerousJsonKey(value, depth = 0) {
  if (!value || typeof value !== 'object' || depth > 20) return false;
  if (Array.isArray(value)) return value.some(item => hasDangerousJsonKey(item, depth + 1));
  for (const [key, child] of Object.entries(value)) {
    if (DANGEROUS_JSON_KEYS.has(key)) return true;
    if (hasDangerousJsonKey(child, depth + 1)) return true;
  }
  return false;
}

function countBundleItems(value) {
  if (Array.isArray(value)) return value.length;
  if (value && typeof value === 'object') return Object.keys(value).length;
  return 0;
}

/** Kiểm tra bundle import hợp lệ. Trả về chuỗi lỗi, hoặc null nếu OK. */
function validateBundle(bundle) {
  if (!bundle || typeof bundle !== 'object' || Array.isArray(bundle))
    return '"bundle" phải là object JSON.';
  const keys = Object.keys(bundle).filter(k => k !== 'manifest.json' && k !== 'manifest');
  if (keys.length === 0)
    return '"bundle" rỗng — không có file nào để nhập.';
  for (const k of keys) {
    if (!VALID_BUNDLE_KEYS.has(k))
      return `Khóa không hợp lệ trong bundle: "${k}". Chỉ chấp nhận tên chuẩn hoặc tên cũ: ${[...VALID_BUNDLE_KEYS].join(', ')}.`;
    const v = bundle[k];
    if (hasDangerousJsonKey(v))
      return `"${k}" chứa khóa JSON nguy hiểm (__proto__/prototype/constructor).`;
    if (v === null || (typeof v !== 'object'))
      return `"${k}" phải là object hoặc array, nhận được: ${typeof v}.`;

    const itemCount = countBundleItems(v);
    if (itemCount > MAX_IMPORT_ITEMS_PER_FILE)
      return `"${k}" có ${itemCount} dòng/mục, vượt giới hạn ${MAX_IMPORT_ITEMS_PER_FILE}.`;

    let byteSize = 0;
    try { byteSize = Buffer.byteLength(JSON.stringify(v), 'utf8'); } catch (_) { byteSize = MAX_IMPORT_BYTES_PER_FILE + 1; }
    if (byteSize > MAX_IMPORT_BYTES_PER_FILE)
      return `"${k}" quá lớn (${Math.ceil(byteSize / 1024 / 1024)}MB), giới hạn ${Math.floor(MAX_IMPORT_BYTES_PER_FILE / 1024 / 1024)}MB mỗi file.`;
  }
  return null;
}

// GET /api/export-data — Tải về bundle JSON dữ liệu session theo tên file chuẩn mới.
router.get('/export-data', (req, res) => {
  const ctx = getRuntimePaths(req);

  const specs = Object.values(RUNTIME_FILE_SPECS)
    .filter(spec => ['RAW_PATH', 'SORTED_PATH', 'FINAL_PATH', 'PROCESSED_PATH', 'PATIENTS_PATH', 'BOARD_STATE_PATH', 'ORDER_DAYS_PATH', 'CLASSIFIED_DAYS_PATH', 'WARNINGS_PATH', 'INDEXES_PATH'].includes(spec.ctxKey))
    .filter(spec => fs.existsSync(ctx[spec.ctxKey]));

  if (specs.length === 0) {
    return res.status(404).json({ status: 'error', message: 'Chưa có dữ liệu để xuất.' });
  }

  const bundle = {
    'manifest.json': {
      ...buildManifest(ctx),
      schema: DATA_CONTRACT_VERSION,
      export_format: 'canonical_bundle',
    },
  };

  for (const spec of specs) {
    const name = canonicalBundleNameForCtxKey(spec.ctxKey);
    try { bundle[name] = JSON.parse(fs.readFileSync(ctx[spec.ctxKey], 'utf-8')); }
    catch (err) { console.error(`[EXPORT] ${name}:`, err.message); }
  }

  const filename = `emr_data_bundle_${nowFileStamp()}.json`;
  appendActivity(ctx, { kind: 'workflow.export_data', file_count: specs.length });
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(JSON.stringify(bundle, null, 2));
});

// POST /api/import-data — Nhập bundle JSON vào session, nhận cả tên chuẩn mới và tên cũ.
router.post('/import-data', (req, res) => {
  const ctx    = getRuntimePaths(req);
  const bundle = req.body?.bundle;

  const bundleError = validateBundle(bundle);
  if (bundleError) {
    return res.status(400).json({ status: 'error', message: bundleError });
  }

  const imported = [];
  const errors   = [];
  const importedCtxKeys = new Set();

  for (const [name, value] of Object.entries(bundle || {})) {
    if (name === 'manifest.json' || name === 'manifest') continue;
    const key = BUNDLE_FILES[name];
    if (!key || importedCtxKeys.has(key)) continue;
    try {
      ensureDir(path.dirname(ctx[key]));
      writeJsonAtomic(ctx[key], value);
      importedCtxKeys.add(key);
      imported.push({
        name: canonicalBundleNameForCtxKey(key) || name,
        accepted_as: name,
        legacy_names: legacyBundleNamesForCtxKey(key),
        count: Array.isArray(value) ? value.length : '?',
      });
    } catch (err) {
      errors.push({ name, error: err.message });
    }
  }

  if (imported.length === 0) {
    return res.status(400).json({ status: 'error', message: errors[0]?.error || 'Không nhận ra file nào trong bundle.' });
  }

  // Bundle trao đổi chỉ chứa dữ liệu chính, không chứa trạng thái đã nhập/đã kiểm.
  // Vì vậy phải xoá state dẫn xuất của session hiện tại để tránh hiển thị nhầm "đã làm"
  // từ bộ dữ liệu cũ sau khi import bộ dữ liệu khác.
  clearSessionDerivedState(ctx, { clearReports: true });
  appendActivity(ctx, { kind: 'workflow.import_data', imported_count: imported.length, error_count: errors.length });

  return res.json({ status: 'ok', schema: DATA_CONTRACT_VERSION, imported, errors });
});


// GET /api/session-logs — Liệt kê log files trong session + nội dung scan_history
router.get('/session-logs', (req, res) => {
  const ctx = getRuntimePaths(req);
  const logsDir = ctx.LOGS_DIR;

  // Danh sách file debug (HTML/PNG từ Selenium, JSON snapshot scan)
  let files = [];
  try {
    if (fs.existsSync(logsDir)) {
      files = fs.readdirSync(logsDir)
        .filter(f => /\.(html|png|json|log|jsonl)$/i.test(f))
        .map(f => {
          try {
            const st = fs.statSync(path.join(logsDir, f));
            return { name: f, size_kb: Math.round(st.size / 1024), mtime: st.mtimeMs };
          } catch (_) { return { name: f, size_kb: 0, mtime: 0 }; }
        })
        .sort((a, b) => b.mtime - a.mtime)
        .slice(0, 50); // tối đa 50 file mới nhất
    }
  } catch (_) {}

  // Nội dung scan_history.log (100 dòng cuối)
  let scanHistory = '';
  try {
    const histPath = path.join(logsDir, 'scan_history.log');
    if (fs.existsSync(histPath)) {
      const raw = fs.readFileSync(histPath, 'utf-8');
      const lines = raw.split('\n');
      scanHistory = redactLogText(lines.slice(-100).join('\n').trim());
    }
  } catch (_) {}

  let activityLog = '';
  try { activityLog = readLatestActivity(ctx, 200); } catch (_) {}

  return res.json({ files, scan_history: scanHistory, activity_log: activityLog });
});

module.exports = router;
