// server/routes/vtyt_catalog.js
// Quản lý catalog VTYT — đọc, vô hiệu hóa, thay thế mã VTYT
// GET  /api/vtyt-catalog          → đọc toàn bộ catalog
// PATCH /api/vtyt-catalog/:key    → cập nhật 1 item (disabled, override_code, override_name)
// POST /api/vtyt-catalog/reset/:key → reset về mặc định

'use strict';

const router = require('express').Router();
const path   = require('path');

const { readJsonSafe, writeJsonAtomic } = require('../utils/file');
const { getRuntimePaths } = require('../services/session');
const { appendActivity } = require('../services/activity_logger');

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

module.exports = router;
