'use strict';

const path = require('path');
const { readJsonSafe } = require('../file');

const _THUOC_PATH = path.resolve(__dirname, '../../../config/d_v2.json');

/**
 * Trích hàm lượng từ tên thuốc: "paracetamol 1g/100ml" → "1g", "10mg/ml" → "10mg/ml"
 * Trả về chuỗi hàm lượng hoặc "" nếu không tìm thấy.
 */
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
function resolveCanonicalDrugName(ten) {
  if (!ten) return null;
  try {
    const cfg      = readJsonSafe(_THUOC_PATH, {});
    const synonyms = cfg['1_TU_DIEN_DONG_NGHIA'] || {};
    const display  = cfg['6_TEN_HIEN_THI_CHUAN']  || {};

    const needle = ten
      .replace(/^\(\s*TT\s*\)\s*/i, '')
      .replace(/\s+\d+\s*(?:túi|lọ|ống|chai|viên)\s*$/i, '')
      .toUpperCase()
      .trim();

    for (const [canonicalKey, aliases] of Object.entries(synonyms)) {
      if (!Array.isArray(aliases)) continue;
      const matched = aliases.some(alias =>
        needle.includes(alias.toUpperCase()) || alias.toUpperCase().includes(needle)
      );
      if (!matched) continue;

      const entry = display[canonicalKey];
      if (!entry) continue;

      const baseName = typeof entry === 'object' ? entry.ten : entry;
      if (!baseName) continue;

      // ham_luong_mac_dinh trong config là nguồn chân lý khi được đặt
      // → luôn dùng nó, không trích từ tên gốc (tránh "1g" vs "10mg/ml" không nhất quán)
      const configDose = typeof entry === 'object' ? entry.ham_luong_mac_dinh || '' : '';
      const dose = configDose || extractDose(ten);
      return dose ? `${baseName} ${dose}` : baseName;
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
