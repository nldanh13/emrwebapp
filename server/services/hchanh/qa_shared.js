// server/services/hchanh/qa_shared.js
// Tiện ích QA dùng chung giữa discharge_qa.js (QA hành chánh) và bhyt_pre_audit.js
// (tiền giám định BHYT) — tách ra để hai module không phải require lẫn nhau.

'use strict';

const fs   = require('fs');
const path = require('path');

function safeArray(v)   { return Array.isArray(v) ? v : []; }
function text(v, fb='') { return String(v ?? '').replace(/\s+/g, ' ').trim() || fb; }
function normText(v) {
  return String(v ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/đ/g, 'd').replace(/Đ/g, 'D').toLowerCase().replace(/\s+/g, ' ').trim();
}

// ── Load config/hchanh/qa_rules.json ──────────────────────────────────────────

let _cache = null, _cacheTime = 0;
function loadQaRules() {
  const now = Date.now();
  if (_cache && now - _cacheTime < 30000) return _cache;
  try {
    const p = path.join(__dirname, '..', '..', '..', 'config', 'hchanh', 'qa_rules.json');
    if (fs.existsSync(p)) { _cache = JSON.parse(fs.readFileSync(p, 'utf-8')); _cacheTime = now; return _cache; }
  } catch (e) { console.warn('[QA] Không đọc qa_rules.json:', e.message); }
  return {};
}

// ── Trích xuất CLS từ billing ─────────────────────────────────────────────────
// Từ billing.rows: lọc nhóm CDHA, XN, Thăm dò chức năng — chỉ xét dòng BHYT.

function extractClsFromBilling(billing) {
  const CLS_LOAI = ['chẩn đoán hình ảnh', 'xét nghiệm', 'thăm dò chức năng',
                    'giải phẫu bệnh', 'vi sinh', 'tinh dịch đồ', 'cận lâm sàng'];
  const rows = safeArray(billing?.rows);
  return rows.filter(r => {
    const loai = normText(r.loai_yc || '');
    return CLS_LOAI.some(k => loai.includes(normText(k)));
  }).map(r => ({
    name:    text(r.name),
    loai_yc: text(r.loai_yc),
    pg:      r.payment_group || 'unknown',
    don_gia: Number(r.don_gia || 0),
  }));
}

module.exports = { loadQaRules, extractClsFromBilling };
