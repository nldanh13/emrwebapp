// server/routes/medication_catalog.js
// Quản lý danh mục thuốc (config/medication_catalog.json) — tên chuẩn, alias,
// hàm lượng/thể tích mặc định — dùng để worker suy luận khi EMR chỉ ghi tên thuốc.
// GET    /api/medication-catalog          → đọc toàn bộ danh mục
// POST   /api/medication-catalog          → thêm thuốc mới
// PATCH  /api/medication-catalog/:key     → sửa thuốc đã có (key = canonical)
// DELETE /api/medication-catalog/:key     → xoá thuốc

'use strict';

const router = require('express').Router();
const path   = require('path');

const { readJsonSafe, writeJsonAtomic } = require('../utils/file');
const { getRuntimePaths } = require('../services/session');
const { appendActivity } = require('../services/activity_logger');

const CATALOG_PATH = path.join(__dirname, '..', '..', 'config', 'medication_catalog.json');

function loadCatalog() {
  const data = readJsonSafe(CATALOG_PATH, null);
  if (!data || typeof data !== 'object') throw new Error(`Không đọc được ${CATALOG_PATH}`);
  if (!Array.isArray(data.medications)) data.medications = [];
  return data;
}

function saveCatalog(data) {
  data._updated = new Date().toISOString().slice(0, 10);
  writeJsonAtomic(CATALOG_PATH, data);
}

function keyOf(med) {
  return String(med?.canonical || '').trim();
}

function normalizeStringList(value) {
  if (Array.isArray(value)) return value.map(x => String(x || '').trim()).filter(Boolean);
  if (typeof value === 'string') return value.split(',').map(x => x.trim()).filter(Boolean);
  return [];
}

function pruneEmpty(med) {
  for (const k of Object.keys(med)) {
    const v = med[k];
    if (v === '' || v === undefined || v === null || (Array.isArray(v) && !v.length)) delete med[k];
  }
  return med;
}

// GET /api/medication-catalog
router.get('/medication-catalog', (req, res) => {
  try {
    const data = loadCatalog();
    return res.json({ status: 'ok', medications: data.medications.map(med => ({ ...med, key: keyOf(med) })) });
  } catch (e) {
    return res.status(500).json({ status: 'error', message: String(e.message) });
  }
});

// POST /api/medication-catalog — thêm thuốc mới
router.post('/medication-catalog', (req, res) => {
  try {
    const ctx = getRuntimePaths(req);
    const body = req.body || {};
    const canonical = String(body.canonical || '').trim();
    if (!canonical) return res.status(400).json({ status: 'error', message: 'Cần nhập tên chuẩn (canonical).' });

    const data = loadCatalog();
    if (data.medications.some(m => keyOf(m).toLowerCase() === canonical.toLowerCase())) {
      return res.status(409).json({ status: 'error', message: `Đã có thuốc với tên chuẩn "${canonical}".` });
    }

    const volumeRaw = body.default_volume_ml;
    const volumeNum = Number(volumeRaw);
    const med = pruneEmpty({
      canonical,
      aliases: normalizeStringList(body.aliases),
      semantic_aliases: normalizeStringList(body.semantic_aliases),
      category: String(body.category || '').trim(),
      default_route: String(body.default_route || '').trim(),
      default_route_text: String(body.default_route_text || '').trim(),
      default_volume_ml: (volumeRaw === '' || volumeRaw == null || !Number.isFinite(volumeNum)) ? undefined : volumeNum,
      default_rate: String(body.default_rate ?? '').trim(),
      default_rate_text: String(body.default_rate_text || '').trim(),
      schedule_rule: String(body.schedule_rule || '').trim(),
    });

    data.medications.push(med);
    saveCatalog(data);
    appendActivity(ctx, { kind: 'medication_catalog.create', canonical });
    return res.json({ status: 'ok', medication: { ...med, key: canonical } });
  } catch (e) {
    return res.status(500).json({ status: 'error', message: String(e.message) });
  }
});

// PATCH /api/medication-catalog/:key — sửa thuốc đã có
router.patch('/medication-catalog/:key', (req, res) => {
  try {
    const ctx = getRuntimePaths(req);
    const { key } = req.params;
    const data = loadCatalog();
    const idx = data.medications.findIndex(m => keyOf(m) === key);
    if (idx === -1) return res.status(404).json({ status: 'error', message: `Không tìm thấy thuốc: ${key}` });

    const body = req.body || {};
    const med = { ...data.medications[idx] };

    if (body.canonical !== undefined) {
      const nextCanonical = String(body.canonical || '').trim();
      if (!nextCanonical) return res.status(400).json({ status: 'error', message: 'Tên chuẩn không được để trống.' });
      const clashes = data.medications.some((m, i) => i !== idx && keyOf(m).toLowerCase() === nextCanonical.toLowerCase());
      if (clashes) return res.status(409).json({ status: 'error', message: `Đã có thuốc với tên chuẩn "${nextCanonical}".` });
      med.canonical = nextCanonical;
    }
    if (body.aliases !== undefined) med.aliases = normalizeStringList(body.aliases);
    if (body.semantic_aliases !== undefined) med.semantic_aliases = normalizeStringList(body.semantic_aliases);
    if (body.category !== undefined) med.category = String(body.category || '').trim();
    if (body.default_route !== undefined) med.default_route = String(body.default_route || '').trim();
    if (body.default_route_text !== undefined) med.default_route_text = String(body.default_route_text || '').trim();
    if (body.default_volume_ml !== undefined) {
      if (body.default_volume_ml === '' || body.default_volume_ml === null) {
        delete med.default_volume_ml;
      } else {
        const n = Number(body.default_volume_ml);
        if (Number.isFinite(n)) med.default_volume_ml = n;
      }
    }
    if (body.default_rate !== undefined) med.default_rate = String(body.default_rate ?? '').trim();
    if (body.default_rate_text !== undefined) med.default_rate_text = String(body.default_rate_text || '').trim();
    if (body.schedule_rule !== undefined) med.schedule_rule = String(body.schedule_rule || '').trim();

    data.medications[idx] = pruneEmpty(med);
    saveCatalog(data);
    appendActivity(ctx, { kind: 'medication_catalog.update', key, canonical: med.canonical });
    return res.json({ status: 'ok', medication: { ...data.medications[idx], key: keyOf(data.medications[idx]) } });
  } catch (e) {
    return res.status(500).json({ status: 'error', message: String(e.message) });
  }
});

// DELETE /api/medication-catalog/:key
router.delete('/medication-catalog/:key', (req, res) => {
  try {
    const ctx = getRuntimePaths(req);
    const { key } = req.params;
    const data = loadCatalog();
    const idx = data.medications.findIndex(m => keyOf(m) === key);
    if (idx === -1) return res.status(404).json({ status: 'error', message: `Không tìm thấy thuốc: ${key}` });
    data.medications.splice(idx, 1);
    saveCatalog(data);
    appendActivity(ctx, { kind: 'medication_catalog.delete', key });
    return res.json({ status: 'ok', key });
  } catch (e) {
    return res.status(500).json({ status: 'error', message: String(e.message) });
  }
});

module.exports = router;
