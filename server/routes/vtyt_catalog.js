// server/routes/vtyt_catalog.js
// Quản lý catalog VTYT — đọc, vô hiệu hóa, thay thế mã VTYT
// GET  /api/vtyt-catalog          → đọc toàn bộ catalog
// PATCH /api/vtyt-catalog/:key    → cập nhật 1 item (disabled, override_code, override_name)
// POST /api/vtyt-catalog/reset/:key → reset về mặc định
// POST /api/vtyt-catalog/scan-emr   → dò danh mục VTYT đang có trên EMR (chỉ đọc)
// GET  /api/vtyt-catalog/emr-scan   → kết quả dò gần nhất

'use strict';

const router = require('express').Router();
const path   = require('path');

const { readJsonSafe, writeJsonAtomic, safeUnlink } = require('../utils/file');
const { getRuntimePaths, ensureSessionAssets } = require('../services/session');
const { appendActivity } = require('../services/activity_logger');
const { ROOT_DIR } = require('../constants');
const { runScript, fmtPyError } = require('../services/python_runner');
const { enqueueHeavy, registerCancel, unregisterCancel } = require('../services/task_queue');

const DICT_PATH = path.join(__dirname, '..', '..', 'config', 'vtyt_dictionary.json');

function loadDict() {
  const dict = readJsonSafe(DICT_PATH, null);
  if (!dict) throw new Error(`Không đọc được ${DICT_PATH}`);
  return dict;
}

function saveDict(dict) {
  dict._updated = new Date().toISOString().slice(0, 10);
  writeJsonAtomic(DICT_PATH, dict);
}

// GET /api/vtyt-catalog
router.get('/vtyt-catalog', (req, res) => {
  try {
    const dict    = loadDict();
    const catalog = dict.catalog || {};
    const items   = Object.entries(catalog)
      .filter(([k]) => k !== '_comment')
      .map(([key, item]) => ({
        key,
        code:          item.override_code  || item.code,
        name:          item.override_name  || item.name,
        original_code: item.code,
        original_name: item.name,
        searchKeyword: item.searchKeyword,
        disabled:      item.disabled === true,
        overridden:    Boolean(item.override_code),
        aliases:       item.aliases || [],
      }));
    return res.json({ status: 'ok', items });
  } catch (e) {
    return res.status(500).json({ status: 'error', message: String(e.message) });
  }
});

// PATCH /api/vtyt-catalog/:key
// Body: { disabled?: bool, override_code?: string, override_name?: string }
router.patch('/vtyt-catalog/:key', (req, res) => {
  try {
    const ctx = getRuntimePaths(req);
    const { key }  = req.params;
    const dict     = loadDict();
    const item     = dict.catalog[key];
    if (!item) return res.status(404).json({ status: 'error', message: `Không tìm thấy key: ${key}` });

    const { disabled, override_code, override_name } = req.body || {};

    if (disabled !== undefined) item.disabled = Boolean(disabled);

    if (override_code !== undefined) {
      if (override_code === '' || override_code === null) {
        // Reset về mặc định
        delete item.override_code;
        delete item.override_name;
      } else {
        item.override_code = String(override_code).trim();
        if (override_name) item.override_name = String(override_name).trim();
      }
    }

    saveDict(dict);
    appendActivity(ctx, { kind: 'vtyt_catalog.update', key, disabled: item.disabled === true, overridden: Boolean(item.override_code) });
    return res.json({
      status: 'ok',
      key,
      item: {
        key,
        code:          item.override_code || item.code,
        name:          item.override_name || item.name,
        original_code: item.code,
        disabled:      item.disabled === true,
        overridden:    Boolean(item.override_code),
      },
    });
  } catch (e) {
    return res.status(500).json({ status: 'error', message: String(e.message) });
  }
});

// POST /api/vtyt-catalog/reset/:key → xóa override, bật lại
router.post('/vtyt-catalog/reset/:key', (req, res) => {
  try {
    const ctx = getRuntimePaths(req);
    const { key } = req.params;
    const dict    = loadDict();
    const item    = dict.catalog[key];
    if (!item) return res.status(404).json({ status: 'error', message: `Không tìm thấy key: ${key}` });

    delete item.disabled;
    delete item.override_code;
    delete item.override_name;
    saveDict(dict);
    appendActivity(ctx, { kind: 'vtyt_catalog.reset', key });
    return res.json({ status: 'ok', key, message: 'Đã reset về mặc định.' });
  } catch (e) {
    return res.status(500).json({ status: 'error', message: String(e.message) });
  }
});

// Kết quả dò nằm cạnh file dữ liệu phân loại: worker input_vtyt.py đọc cùng chỗ
// để đối chiếu mã trước khi nhập.
function emrScanPath(ctx) {
  return path.join(path.dirname(ctx.PROCESSED_PATH), 'vtyt_emr_catalog.json');
}

// POST /api/vtyt-catalog/scan-emr  Body: { ma_bn, queries?: string[] }
router.post('/vtyt-catalog/scan-emr', async (req, res) => {
  const ctx = getRuntimePaths(req);
  const maBn = String(req.body?.ma_bn || '').trim();
  if (!/^[0-9A-Za-z._-]{3,40}$/.test(maBn)) {
    return res.status(400).json({ status: 'error', message: 'Cần mã người bệnh đang nằm khoa để mở popup VTYT.' });
  }
  const queries = (Array.isArray(req.body?.queries) ? req.body.queries : [])
    .map(q => String(q || '').trim().slice(0, 40))
    .filter(Boolean)
    .slice(0, 40);
  const outPath = emrScanPath(ctx);
  try {
    ensureSessionAssets(ctx.dir, ROOT_DIR);
    await enqueueHeavy(ctx.sid, async () => {
      let result;
      try {
        result = await runScript('vtyt_emr_catalog_scan.py', [maBn, outPath, ...queries], {
          onSpawn: killFn => registerCancel(ctx.sid, killFn),
          runtimeDir: ctx.dir,
        });
      } finally {
        unregisterCancel(ctx.sid);
        safeUnlink(`${outPath}.session.json`);
      }
      if (result.spawnError)      return res.status(500).json({ status: 'error', message: `Không khởi động được Python: ${result.spawnError}` });
      if (result.killedByTimeout) return res.status(504).json({ status: 'error', message: 'Timeout khi dò danh mục VTYT trên EMR.' });
      const report = readJsonSafe(outPath, null);
      if (report?.status === 'ok') {
        appendActivity(ctx, { kind: 'vtyt_catalog.scan_emr', count: report.count || 0 });
        return res.json({ status: 'ok', report });
      }
      return res.status(500).json({ status: 'error', message: report?.message || fmtPyError('Python lỗi khi dò danh mục VTYT.', result) });
    });
  } catch (err) {
    if (!res.headersSent) res.status(500).json({ status: 'error', message: String(err.message || err) });
  }
});

// GET /api/vtyt-catalog/emr-scan
router.get('/vtyt-catalog/emr-scan', (req, res) => {
  const ctx = getRuntimePaths(req);
  const report = readJsonSafe(emrScanPath(ctx), null);
  return res.json({ status: 'ok', report: report?.status === 'ok' ? report : null });
});

module.exports = router;
