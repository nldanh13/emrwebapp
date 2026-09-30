// server/utils/csv.js — CSV export helpers with Excel formula-injection guard.
'use strict';

const FORMULA_PREFIX_RE = /^[\s\t\r\n]*[=+\-@]/;

function guardCsvFormula(value) {
  const s = String(value ?? '');
  return FORMULA_PREFIX_RE.test(s) ? `'${s}` : s;
}

function csvEscape(value) {
  const s = guardCsvFormula(value);
  return /[",\n\r;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function rowsToCsv(columns, rows) {
  const header = columns.map(csvEscape).join(',');
  const body = rows.map(row => columns.map(col => csvEscape(row?.[col] ?? '')).join(',')).join('\n');
  return `${header}\n${body}${body ? '\n' : ''}`;
}

// CSV lưu trữ nội bộ (dữ liệu chuẩn hóa, không mở bằng Excel): KHÔNG chèn dấu ' chống
// công thức, nếu không số âm (-3.5, -6 ngày) và kết quả "+"/"-" bị đổi thành chuỗi.
// Chỉ file người dùng tải về mới dùng rowsToCsv (có chặn công thức).
function csvEscapeRaw(value) {
  const s = String(value ?? '');
  return /[",\n\r;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function rowsToCsvRaw(columns, rows) {
  const header = columns.map(csvEscapeRaw).join(',');
  const body = rows.map(row => columns.map(col => csvEscapeRaw(row?.[col] ?? '')).join(',')).join('\n');
  return `${header}\n${body}${body ? '\n' : ''}`;
}

module.exports = { csvEscape, rowsToCsv, rowsToCsvRaw, guardCsvFormula };
