'use strict';

const OVERNIGHT_HOURS = new Set([0, 5, 6]);


function normalizeGio(raw) {
  const s = String(raw || '').trim();
  if (!s) return '';
  const m1 = s.match(/(\d{1,2}):(\d{2})/);
  if (m1) return `${m1[1].padStart(2, '0')}:${m1[2]}`;
  const m2 = s.match(/(\d{1,2})[hH](\d{2})/);
  if (m2) return `${m2[1].padStart(2, '0')}:${m2[2]}`;
  const m3 = s.match(/^(\d{1,2})\s*gi[ờo]/i);
  if (m3) return `${m3[1].padStart(2, '0')}:00`;
  return s;
}

/**
 * Trích giờ (số nguyên 0–23) từ chuỗi bất kỳ.
 * Trả về null nếu không parse được.
 */
function parseHourFromText(raw) {
  const s = String(raw || '').trim();
  if (!s) return null;
  const hhmm = normalizeGio(s);
  const m1 = hhmm.match(/^(\d{2}):(\d{2})$/);
  if (m1) return Number(m1[1]);
  const m2 = s.match(/\b(\d{1,2})\s*gi[ờo]\b/i);
  if (m2) return Number(m2[1]);
  const m3 = s.match(/\b(\d{1,2})h(?:\d{2})?\b/i);
  if (m3) return Number(m3[1]);
  return null;
}

function resolveHour(raw, fallbackHour = null) {
  const hour = parseHourFromText(raw);
  return Number.isFinite(hour) ? hour : fallbackHour;
}

function formatHourLabel(hour) {
  if (!Number.isFinite(hour)) return '—';
  return `${String(hour).padStart(2, '0')}:00`;
}

// ── DateTime ──────────────────────────────────────────────────────────────────

function parseDateTime(raw) {
  const s = String(raw || '').trim();
  if (!s) return null;
  // "HH:MM DD/MM/YYYY"
  const m1 = s.match(/(\d{1,2}):(\d{2})\s+(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (m1) {
    const [, hh, mm, dd, mo, yyyy] = m1;
    return new Date(Number(yyyy), Number(mo) - 1, Number(dd), Number(hh), Number(mm), 0, 0);
  }
  // "DD/MM/YYYY HH:MM"
  const m2 = s.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2})/);
  if (m2) {
    const [, dd, mo, yyyy, hh, mm] = m2;
    return new Date(Number(yyyy), Number(mo) - 1, Number(dd), Number(hh), Number(mm), 0, 0);
  }
  return null;
}

function formatDateTimeDisplay(raw) {
  const dt = parseDateTime(raw);
  if (!dt) return String(raw || '').trim();
  const dd   = String(dt.getDate()).padStart(2, '0');
  const mm   = String(dt.getMonth() + 1).padStart(2, '0');
  const yyyy = dt.getFullYear();
  const hh   = String(dt.getHours()).padStart(2, '0');
  const mi   = String(dt.getMinutes()).padStart(2, '0');
  return `${dd}/${mm}/${yyyy} ${hh}:${mi}`;
}

function sortByDateTimeAsc(a, b) {
  const da = parseDateTime(a);
  const db = parseDateTime(b);
  if (da && db) return da - db;
  if (da) return -1;
  if (db) return 1;
  return String(a || '').localeCompare(String(b || ''));
}

// ── Timeline sort ─────────────────────────────────────────────────────────────

function timelineSortValue(raw) {
  const s = String(raw || '').trim();
  if (!s) return Number.MAX_SAFE_INTEGER - 1;
  if (/^y lệnh$/i.test(s)) return -1;
  const m = s.match(/^(\d{1,2}):(\d{2})$/);
  if (m) return Number(m[1]) * 60 + Number(m[2]);
  const hour = parseHourFromText(s);
  if (Number.isFinite(hour)) return hour * 60;
  if (s === '—') return Number.MAX_SAFE_INTEGER;
  return Number.MAX_SAFE_INTEGER - 2;
}

module.exports = { OVERNIGHT_HOURS, normalizeGio, parseHourFromText, resolveHour, formatHourLabel, parseDateTime, formatDateTimeDisplay, sortByDateTimeAsc, timelineSortValue };
