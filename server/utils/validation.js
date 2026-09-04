// server/utils/validation.js — Validators & date/key helpers

'use strict';

/** Kiểm tra chuỗi có đúng định dạng dd/mm/yyyy hay không. */
function isValidDmy(s) {
  const m = String(s || '').trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) return false;
  const [, dd, mm, yyyy] = m.map(Number);
  if (yyyy < 2000 || yyyy > 2100) return false;
  if (mm < 1 || mm > 12) return false;
  const maxDay = new Date(yyyy, mm, 0).getDate();
  return dd >= 1 && dd <= maxDay;
}

/** Parse "dd/mm/yyyy" hoặc "dd-mm-yyyy" thành timestamp (ms). 0 nếu không parse được. */
function parseDmy(s) {
  if (!s) return 0;
  const dmy = normalizeDmy(s);
  const m = String(dmy || '').match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) return 0;
  return new Date(Number(m[3]), Number(m[2]) - 1, Number(m[1])).getTime();
}

/** Clamp giá trị giờ vào [0, 23], trả về defVal nếu không phải số. */
function clampHour(x, defVal) {
  const n = Number.parseInt(String(x ?? ''), 10);
  if (!Number.isFinite(n)) return defVal;
  return Math.min(23, Math.max(0, n));
}

/** Chuẩn hoá ngày về dd/mm/yyyy. Nhận cả yyyy-mm-dd để đọc dữ liệu v2/ISO. */
function normalizeDmy(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  let m = raw.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/);
  if (m) {
    const yyyy = Number(m[1]);
    const mm = Number(m[2]);
    const dd = Number(m[3]);
    if (isValidDateParts(yyyy, mm, dd)) return `${String(dd).padStart(2, '0')}/${String(mm).padStart(2, '0')}/${yyyy}`;
    return '';
  }
  m = raw.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{2,4})$/);
  if (m) {
    const dd = Number(m[1]);
    const mm = Number(m[2]);
    let yyyy = Number(m[3]);
    if (yyyy < 100) yyyy += 2000;
    if (isValidDateParts(yyyy, mm, dd)) return `${String(dd).padStart(2, '0')}/${String(mm).padStart(2, '0')}/${yyyy}`;
    return '';
  }
  return '';
}

function isValidDateParts(yyyy, mm, dd) {
  if (!Number.isInteger(yyyy) || !Number.isInteger(mm) || !Number.isInteger(dd)) return false;
  if (yyyy < 2000 || yyyy > 2100 || mm < 1 || mm > 12) return false;
  const maxDay = new Date(yyyy, mm, 0).getDate();
  return dd >= 1 && dd <= maxDay;
}

function dmyToIso(value) {
  const dmy = normalizeDmy(value);
  const m = dmy.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  return m ? `${m[3]}-${m[2]}-${m[1]}` : '';
}

function isoToDmy(value) {
  return normalizeDmy(value);
}

/** Key duy nhất cho done-state/patient-day nội bộ: "ma_bn::yyyy-mm-dd". */
function doneKey(id, ngay_lam) {
  const cleanId = String(id || '').trim();
  const isoDate = dmyToIso(ngay_lam);
  const cleanDate = isoDate || String(ngay_lam || '').trim();
  return cleanDate ? `${cleanId}::${cleanDate}` : cleanId;
}

/** Các key tương thích khi đọc dữ liệu cũ: ISO là chính, DMY là alias. */
function doneKeyAliases(id, ngay_lam) {
  const cleanId = String(id || '').trim();
  const raw = String(ngay_lam || '').trim();
  if (!cleanId) return [];
  const dmy = normalizeDmy(raw);
  const iso = dmyToIso(raw);
  const out = [];
  if (iso) out.push(`${cleanId}::${iso}`);
  if (dmy) out.push(`${cleanId}::${dmy}`);
  if (raw && !out.includes(`${cleanId}::${raw}`)) out.push(`${cleanId}::${raw}`);
  if (!out.length) out.push(cleanId);
  return [...new Set(out)];
}

/** Chuẩn hoá session id để chặn path traversal và ký tự ngoài whitelist. */
function sanitizeSessionId(input) {
  const raw = String(input || '').trim();
  if (!raw) return 'default';
  if (raw.includes('/') || raw.includes('\\') || raw.includes('..')) return 'default';
  const sanitized = raw.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 60);
  if (!sanitized) return 'default';
  return sanitized;
}

module.exports = {
  isValidDmy,
  parseDmy,
  clampHour,
  normalizeDmy,
  dmyToIso,
  isoToDmy,
  doneKey,
  doneKeyAliases,
  sanitizeSessionId,
};
