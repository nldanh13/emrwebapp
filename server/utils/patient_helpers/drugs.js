'use strict';

const path = require('path');
const { readJsonSafe } = require('../file');

// Tên hiển thị chuẩn: Danh mục thuốc (trường ten_hien_thi) trước, rồi kiến thức sẵn có
// config/medication_builtin.json. Trước đây đọc d_v2.json mục 1 + 6.
const ROOT = path.resolve(__dirname, '../../..');
const _BUILTIN_PATH = path.join(ROOT, 'config', 'medication_builtin.json');
const _CATALOG_PATH = path.join(ROOT, 'config', 'medication_catalog.json');

function extractDose(ten) {
  if (!ten) return '';
  // Bắt "số + đơn vị" kèm cả nồng độ dạng /ml hoặc /100ml
  // Ví dụ: "1g", "1g/100ml", "10mg/ml", "40mg/2ml"
  const m = String(ten).match(/([\d.]+\s*(?:mg|mcg|g|mmol|ui|iu)(?:\/(?:\d+\s*)?ml)?)/i);
  if (!m) return '';
  const raw = m[1];
  // Chỉ bỏ thể tích khi có số trước ml: "1g/100ml" → "1g"
  // Giữ nguyên nồng độ không có số: "10mg/ml" → "10mg/ml"
  return raw.replace(/([\d.]+\s*(?:mg|mcg|g|mmol|ui|iu))\/(\d+)\s*ml/i, '$1').trim();
}

/**
 * Tra cứu tên hiển thị chuẩn cho thuốc dựa trên từ điển đồng nghĩa.
 * Trả về tên đầy đủ "Tên Hàmlượng" hoặc null nếu không tìm thấy.
 */
function normKey(text) {
  return String(text || '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/gi, 'D')
    .toUpperCase().replace(/[^A-Z0-9%]+/g, ' ').trim();
}

// Khớp NGUYÊN TỪ (không khớp "NATRI" trong "Diclofenac natri" của cụm khác, không khớp ngược).
function hasWord(haystack, alias) {
  const a = normKey(alias);
  return Boolean(a) && ` ${haystack} `.includes(` ${a} `);
}

function displayGroups() {
  const builtin = readJsonSafe(_BUILTIN_PATH, {}) || {};
  const groups = ((builtin.ten_hien_thi_chuan || {}).nhom || []).filter(g => g && g.ten);
  const catalog = ((readJsonSafe(_CATALOG_PATH, {}) || {}).medications || [])
    .filter(m => m && String(m.ten_hien_thi || '').trim())
    .map(m => ({ ten: String(m.ten_hien_thi).trim(), ham_luong_mac_dinh: '', aliases: [m.canonical, ...(m.aliases || [])].filter(Boolean) }));
  return [...catalog, ...groups];
}

/**
 * Tra cứu tên hiển thị chuẩn cho thuốc. Chỉ xét phần tên thuốc trước dấu "+" (phần sau là dung
 * môi pha: "VANCOMYCIN 1G + Natri clorid 0.9%" không được thành "Natri clorid").
 * Trả về "Tên Hàmlượng" hoặc null nếu không có trong từ điển.
 */
function resolveCanonicalDrugName(ten) {
  if (!ten) return null;
  try {
    const drugPart = String(ten)
      .replace(/^\(\s*TT\s*\)\s*/i, '')
      .replace(/\s+\d+\s*(?:túi|lọ|ống|chai|viên)\s*$/i, '')
      .split('+')[0];
    const needle = normKey(drugPart);
    if (!needle) return null;
    for (const group of displayGroups()) {
      if (!(group.aliases || []).some(alias => hasWord(needle, alias))) continue;
      // ham_luong_mac_dinh là nguồn chân lý khi được đặt (tránh "1g" vs "10mg/ml" không nhất quán),
      // trừ thể tích chai/túi: tên ghi "500ml" thì không được hiện thành "100ml" mặc định.
      const nameVolume = (drugPart.match(/(\d+(?:[.,]\d+)?)\s*ml\b/i) || [])[1];
      const defaultIsVolume = /^\d+(?:[.,]\d+)?\s*ml$/i.test(String(group.ham_luong_mac_dinh || '').trim());
      const dose = (defaultIsVolume && nameVolume) ? `${nameVolume}ml` : (group.ham_luong_mac_dinh || extractDose(drugPart));
      return dose ? `${group.ten} ${dose}` : group.ten;
    }
  } catch (_) {}
  return null;
}


function buildDrugSearchName(raw) {
  let base = String(raw || '').trim();
  if (!base) return '';
  base = base.replace(/^\(\s*TT\s*\)\s*/i, '').trim();
  base = base.split('+')[0].trim();
  const tokens = base.split(/\s+/).filter(Boolean);
  const kept = [];
  for (const token of tokens) {
    if (/\d/.test(token) && /(mg|mcg|g|gram|ml|%|ui|iu)/i.test(token)) break;
    kept.push(token);
  }
  return (kept.join(' ').trim() || base).trim();
}

/**
 * Tên thuốc hiển thị ra UI — áp dụng cùng logic chuẩn hoá như ReportTab:
 * - Ưu tiên hoạt chất khi tên thương mại không chứa hàm lượng
 * - Bỏ tiền tố (TT) text (badge riêng đã hiển thị)
 * - Bỏ số lượng nhúng trong tên ("1túi", "2lọ")
 * - Bỏ thể tích khỏi hàm lượng ("1g/100ml" → "1g")
 * - Capitalize chữ đầu
 */
function buildDrugDisplayName(item = {}) {
  const hasDose = /\d/.test(String(item.ten_hien_thi || item.ten_thuoc || ''));
  const raw = String(
    (!hasDose && item.hoat_chat) || item.ten_hien_thi || item.ten_thuoc || item.hoat_chat || ''
  ).trim();
  if (!raw) return '';

  // 1. Tra từ điển tên chuẩn — ưu tiên nhất
  const canonical = resolveCanonicalDrugName(raw);
  if (canonical) {
    return item.tu_tuc ? `(TT) ${canonical}` : canonical;
  }

  // 2. Fallback: chuẩn hoá tên gốc
  const name = raw
    .replace(/^\(\s*TT\s*\)\s*/i, '')
    .replace(/\s+\d+\s*(?:túi|lọ|ống|chai|viên)\s*$/i, '')
    .replace(/([\d.]+\s*(?:mg|mcg|g|mmol|ui|iu))\/\d+\s*ml\b/gi, '$1')
    .trim();
  const normalized = name.charAt(0).toUpperCase() + name.slice(1);
  return item.tu_tuc && !/^\(\s*TT\s*\)/i.test(normalized) ? `(TT) ${normalized}` : normalized;
}

module.exports = { extractDose, resolveCanonicalDrugName, buildDrugSearchName, buildDrugDisplayName };
