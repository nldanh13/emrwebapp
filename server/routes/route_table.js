// server/routes/route_table.js
// Bảng đường dùng (model duy nhất config/routes.json + phần tự cài config/routes.custom.json).
// GET /api/routes          → bảng đã gộp + phần tự cài (giao diện nạp khi mở app)
// PUT /api/routes/custom   → lưu toàn bộ phần tự cài (tab Đường dùng)

'use strict';

const router = require('express').Router();
const { writeJsonAtomic } = require('../utils/file');
const routeModel = require('../utils/routeModel');

const CODE_RE = /^[A-Z][A-Z0-9_]{0,11}$/;
const REPORT_MODES = new Set(['dose', 'daily', 'hide']);
const TONES = new Set(['green', 'blue', 'amber', 'purple', 'gray']);

function cleanText(value, max = 60) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

// Kiểm tra và làm sạch phần tự cài; ném lỗi tiếng Việt nếu sai.
function sanitizeCustom(body) {
  const list = Array.isArray(body?.routes) ? body.routes : [];
  const base = routeModel.readBase();
  const baseCodes = new Set(base.routes.map(r => r.code));
  const categories = new Set((base.categories || []).map(c => c.code));
  const seen = new Set();
  const routes = [];
  for (const raw of list) {
    const code = cleanText(raw?.code, 12).toUpperCase();
    if (!CODE_RE.test(code)) throw new Error(`Mã đường dùng "${raw?.code || ''}" không hợp lệ: dùng chữ in hoa, số, dấu gạch dưới, tối đa 12 ký tự, bắt đầu bằng chữ.`);
    if (seen.has(code)) throw new Error(`Mã đường dùng ${code} bị trùng.`);
    seen.add(code);
    const item = { code };
    const label = cleanText(raw.label);
    if (!baseCodes.has(code) && !label) throw new Error(`Đường dùng mới ${code} cần có tên.`);
    if (label) item.label = label;
    const short = cleanText(raw.short, 12);
    if (short) item.short = short;
    if (raw.category) {
      if (!categories.has(raw.category)) throw new Error(`Chuyên mục "${raw.category}" không có trong danh sách.`);
      item.category = raw.category;
    }
    if (raw.report) {
      if (!REPORT_MODES.has(raw.report)) throw new Error('Cách hiện trên báo cáo ca trực không hợp lệ.');
      item.report = raw.report;
    }
    if (raw.tone) {
      if (!TONES.has(raw.tone)) throw new Error('Màu nhãn không hợp lệ.');
      item.tone = raw.tone;
    }
    const keywords = (Array.isArray(raw.keywords) ? raw.keywords : String(raw.keywords || '').split(/[,\n]/))
      .map(k => cleanText(k, 40)).filter(Boolean);
    if (keywords.length) item.keywords = [...new Set(keywords)];
    routes.push(item);
  }
  return { version: 1, routes };
}

router.get('/routes', (req, res) => {
  try {
    return res.json({ status: 'ok', table: routeModel.ROUTE_TABLE, custom: routeModel.readCustom() });
  } catch (e) {
    return res.status(500).json({ status: 'error', message: String(e.message) });
  }
});

router.put('/routes/custom', (req, res) => {
  try {
    const custom = sanitizeCustom(req.body);
    writeJsonAtomic(routeModel.CUSTOM_FILE, custom);
    return res.json({ status: 'ok', table: routeModel.ROUTE_TABLE, custom });
  } catch (e) {
    return res.status(400).json({ status: 'error', message: String(e.message) });
  }
});

router.sanitizeCustom = sanitizeCustom;
module.exports = router;
