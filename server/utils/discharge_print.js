'use strict';

function pad2(value) {
  return String(Number(value)).padStart(2, '0');
}

function validDateParts(day, month, year) {
  const d = Number(day);
  const m = Number(month);
  const y = Number(year);
  if (!Number.isInteger(d) || !Number.isInteger(m) || !Number.isInteger(y)) return false;
  if (y < 2000 || y > 2200 || m < 1 || m > 12 || d < 1 || d > 31) return false;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

function normalizeDischargePrintDate(value) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (!text) return '';

  let match = text.match(/(?:^|\D)(\d{1,2})[\/-](\d{1,2})[\/-](\d{4})(?:\D|$)/);
  if (match && validDateParts(match[1], match[2], match[3])) {
    return `${pad2(match[1])}/${pad2(match[2])}/${match[3]}`;
  }

  match = text.match(/(?:^|\D)(\d{4})[\/-](\d{1,2})[\/-](\d{1,2})(?:\D|$)/);
  if (match && validDateParts(match[3], match[2], match[1])) {
    return `${pad2(match[3])}/${pad2(match[2])}/${match[1]}`;
  }
  return '';
}

function normalizeDischargePrintDates(values) {
  const list = Array.isArray(values) ? values : [values];
  return [...new Set(list.map(normalizeDischargePrintDate).filter(Boolean))];
}

function dischargeDateFromRow(row) {
  if (!row || typeof row !== 'object') return '';
  const candidates = [
    row.ngay_ra_vien_date,
    row.ngay_ra_vien,
    row.discharge_date,
    row.discharge_time,
    row.raw_discharge_time,
    row.ngay_ra,
    row['Ngày ra viện'],
    row['Thời gian ra viện'],
  ];
  for (const value of candidates) {
    const normalized = normalizeDischargePrintDate(value);
    if (normalized) return normalized;
  }
  return '';
}

function dischargeDateMatchesSelection(row, selectedDates) {
  const actual = dischargeDateFromRow(row);
  const allowed = new Set(normalizeDischargePrintDates(selectedDates));
  return Boolean(actual && allowed.size && allowed.has(actual));
}

module.exports = {
  normalizeDischargePrintDate,
  normalizeDischargePrintDates,
  dischargeDateFromRow,
  dischargeDateMatchesSelection,
};
