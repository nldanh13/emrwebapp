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

module.exports = { csvEscape, rowsToCsv, guardCsvFormula };
