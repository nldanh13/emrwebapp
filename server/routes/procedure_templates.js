// server/routes/procedure_templates.js
// Mẫu thủ thuật – phẫu thuật theo DVKT (tab "Mẫu thủ thuật – PT"). Worker phòng khám đọc cùng file
// (worker/procedure_templates.py) để chọn mẫu theo tên DVKT lúc nhập thủ thuật / kết thúc mổ.
// GET /api/procedure-templates → danh sách mẫu (chưa sửa lần nào thì là mẫu mặc định)
// PUT /api/procedure-templates → lưu cả danh sách (tab tự lưu sau mỗi lần sửa)

'use strict';

const router = require('express').Router();
const path = require('path');
const crypto = require('crypto');

const { readJsonSafe, writeJsonAtomic } = require('../utils/file');
const { getRuntimePaths } = require('../services/session');
const { appendActivity } = require('../services/activity_logger');
const { CONFIG_DIR } = require('../constants');

const TEMPLATES_PATH = path.join(CONFIG_DIR, 'procedure_templates.json');
const DEFAULT_PATH = path.join(CONFIG_DIR, 'procedure_templates.default.json');
const MAX_TEMPLATES = 300;

const KINDS = new Set(['thu_thuat', 'phau_thuat']);
const PERFORMERS = new Set(['dieu_duong', 'bac_si']);
const SCOPES = new Set(['all', 'bhyt', 'vien_phi']);

const line = (value, max) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
const block = (value, max) => String(value ?? '').replace(/\r\n?/g, '\n').trim().slice(0, max);

function keywordsOf(value) {
  const parts = Array.isArray(value) ? value : String(value ?? '').split(/[,;\n]/);
  const seen = new Set();
  const out = [];
  for (const part of parts) {
    const key = line(part, 120);
    if (key && !seen.has(key.toLowerCase())) {
      seen.add(key.toLowerCase());
      out.push(key);
    }
  }
  return out.slice(0, 30);
}

function sanitizeTemplate(raw = {}) {
  const kind = KINDS.has(raw.kind) ? raw.kind : 'thu_thuat';
  const minutes = Number.parseInt(raw.minutes, 10);
  return {
    id: String(raw.id || crypto.randomUUID()).trim().replace(/[^a-zA-Z0-9._-]/g, '-').slice(0, 80),
    kind,
    name: line(raw.name, 160),
    keywords: keywordsOf(raw.keywords),
    performer: PERFORMERS.has(raw.performer) ? raw.performer : (kind === 'phau_thuat' ? 'bac_si' : 'dieu_duong'),
    minutes: Number.isFinite(minutes) ? Math.min(Math.max(minutes, 1), 240) : (kind === 'phau_thuat' ? 15 : 10),
    anesthesia: line(raw.anesthesia, 120),
    position: line(raw.position, 120),
    emr_template: line(raw.emr_template, 200),
    phuong_phap: line(raw.phuong_phap, 200),
    mo_ta: block(raw.mo_ta, 4000),
    report: block(raw.report, 8000),
    dan_do: block(raw.dan_do, 4000),
    applies_to: SCOPES.has(raw.applies_to) ? raw.applies_to : 'all',
    auto: raw.auto !== false,
    enabled: raw.enabled !== false,
    note: line(raw.note, 500),
  };
}

function sanitizeTemplates(list) {
  if (!Array.isArray(list)) throw new Error('Dữ liệu mẫu không đúng dạng danh sách. Tải lại trang rồi sửa lại.');
  if (list.length > MAX_TEMPLATES) throw new Error(`Tối đa ${MAX_TEMPLATES} mẫu. Xoá bớt mẫu không dùng rồi lưu lại.`);
  const seen = new Set();
  return list.map((raw) => {
    const tpl = sanitizeTemplate(raw && typeof raw === 'object' ? raw : {});
    while (seen.has(tpl.id)) tpl.id = `${tpl.id}-${crypto.randomBytes(2).toString('hex')}`;
    seen.add(tpl.id);
    return tpl;
  });
}

function loadTemplates(file = TEMPLATES_PATH, defaultFile = DEFAULT_PATH) {
  const current = readJsonSafe(file, null);
  if (current && Array.isArray(current.templates)) {
    return { templates: sanitizeTemplates(current.templates), updated_at: current.updated_at || '', is_default: false };
  }
  const defaults = readJsonSafe(defaultFile, null) || {};
  return { templates: sanitizeTemplates(defaults.templates || []), updated_at: '', is_default: true };
}

function saveTemplates(list, file = TEMPLATES_PATH) {
  const data = { version: 1, updated_at: new Date().toISOString(), templates: sanitizeTemplates(list) };
  writeJsonAtomic(file, data);
  return data;
}

router.get('/procedure-templates', (_req, res) => {
  try {
    return res.json({ status: 'ok', ...loadTemplates() });
  } catch (e) {
    return res.status(500).json({ status: 'error', message: `Không đọc được mẫu thủ thuật – PT: ${e.message}` });
  }
});

router.put('/procedure-templates', (req, res) => {
  let saved;
  try {
    saved = saveTemplates((req.body || {}).templates);
  } catch (e) {
    return res.status(400).json({ status: 'error', message: String(e.message || e) });
  }
  appendActivity(getRuntimePaths(req), { kind: 'procedure_templates.save', count: saved.templates.length });
  return res.json({ status: 'ok', templates: saved.templates, updated_at: saved.updated_at, is_default: false });
});

module.exports = router;
module.exports.sanitizeTemplates = sanitizeTemplates;
module.exports.loadTemplates = loadTemplates;
module.exports.saveTemplates = saveTemplates;
