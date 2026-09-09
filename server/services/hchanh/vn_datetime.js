// server/services/hchanh/vn_datetime.js
// Tiện ích thuần xử lý ngày/giờ kiểu Việt Nam dùng chung cho QA hành chánh
// (discharge_qa.js) và tiền giám định BHYT (bhyt_pre_audit.js).
// Không phụ thuộc session/EMR/express — có thể unit test độc lập.

'use strict';

function text(v, fb = '') { return String(v ?? '').replace(/\s+/g, ' ').trim() || fb; }

function parseVNDateTime(value) {
  const raw = text(value);
  if (!raw) return null;

  // ISO nội bộ: 2026-05-21T10:54:00 hoặc 2026-05-21 10:54
  const iso = raw.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T\s](\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
  if (iso) {
    const yy = Number(iso[1]);
    const mo = Number(iso[2]);
    const dd = Number(iso[3]);
    const hh = Number(iso[4] || 0);
    const mm = Number(iso[5] || 0);
    const ss = Number(iso[6] || 0);
    if (yy && mo && dd) return new Date(Date.UTC(yy, mo - 1, dd, hh, mm, ss, 0));
  }

  // Nhận: "00:42 16-05-2026", "13:00 01/06/2026", "21/05/2026", "... (Thứ 2)"
  const m = raw.match(/(?:(\d{1,2}):(\d{2})\s*)?(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})/);
  if (!m) return null;
  const hh = Number(m[1] || 0);
  const mm = Number(m[2] || 0);
  const dd = Number(m[3]);
  const mo = Number(m[4]);
  const yy = Number(m[5]);
  if (!dd || !mo || !yy) return null;
  return new Date(Date.UTC(yy, mo - 1, dd, hh, mm, 0, 0));
}

function firstParsedDateTime(values) {
  for (const v of (Array.isArray(values) ? values : [])) {
    const d = parseVNDateTime(v);
    if (d) return d;
  }
  return null;
}

function dateOnlyUTC(d) {
  if (!(d instanceof Date) || Number.isNaN(d.getTime())) return null;
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

function addDaysUTC(d, days) {
  const x = dateOnlyUTC(d);
  if (!x) return null;
  x.setUTCDate(x.getUTCDate() + Number(days || 0));
  return x;
}

function diffDaysUTC(a, b) {
  const da = dateOnlyUTC(a), db = dateOnlyUTC(b);
  if (!da || !db) return 0;
  return Math.round((db.getTime() - da.getTime()) / 86400000);
}

function dateKeyUTC(d) {
  const x = dateOnlyUTC(d);
  if (!x) return '';
  const y = x.getUTCFullYear();
  const m = String(x.getUTCMonth() + 1).padStart(2, '0');
  const day = String(x.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function fmtDateUTC(d) {
  const x = dateOnlyUTC(d);
  if (!x) return '';
  return `${String(x.getUTCDate()).padStart(2, '0')}/${String(x.getUTCMonth() + 1).padStart(2, '0')}/${x.getUTCFullYear()}`;
}

function fmtDateTimeUTC(d) {
  if (!(d instanceof Date) || Number.isNaN(d.getTime())) return '';
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')} ${String(d.getUTCDate()).padStart(2, '0')}/${String(d.getUTCMonth() + 1).padStart(2, '0')}/${d.getUTCFullYear()}`;
}

function addMinutesUTC(d, minutes) {
  if (!(d instanceof Date) || Number.isNaN(d.getTime())) return null;
  return new Date(d.getTime() + Number(minutes || 0) * 60000);
}

function addExactDaysUTC(d, days) {
  if (!(d instanceof Date) || Number.isNaN(d.getTime())) return null;
  return new Date(d.getTime() + Number(days || 0) * 86400000);
}

function minDateUTC(...items) {
  const vals = items.filter(d => d instanceof Date && !Number.isNaN(d.getTime()));
  if (!vals.length) return null;
  return vals.reduce((a, b) => a.getTime() <= b.getTime() ? a : b);
}

function maxDateUTC(...items) {
  const vals = items.filter(d => d instanceof Date && !Number.isNaN(d.getTime()));
  if (!vals.length) return null;
  return vals.reduce((a, b) => a.getTime() >= b.getTime() ? a : b);
}

function positiveInterval(start, end) {
  return start instanceof Date && end instanceof Date && !Number.isNaN(start.getTime()) && !Number.isNaN(end.getTime()) && end.getTime() > start.getTime();
}

function intervalOverlapMs(aStart, aEnd, bStart, bEnd) {
  const st = Math.max(aStart?.getTime?.() ?? NaN, bStart?.getTime?.() ?? NaN);
  const en = Math.min(aEnd?.getTime?.() ?? NaN, bEnd?.getTime?.() ?? NaN);
  return Number.isFinite(st) && Number.isFinite(en) ? Math.max(0, en - st) : 0;
}

function intervalIncludesInstant(itv, instant) {
  return itv?.start instanceof Date && itv?.end instanceof Date && instant instanceof Date &&
    itv.start.getTime() <= instant.getTime() && instant.getTime() < itv.end.getTime();
}

function fmtIntervalUTC(start, endExclusive) {
  if (!positiveInterval(start, endExclusive)) return '';
  const displayEnd = addMinutesUTC(endExclusive, -1) || endExclusive;
  return `${fmtDateTimeUTC(start)} → ${fmtDateTimeUTC(displayEnd)}`;
}

function fmtDateKey(key) {
  const m = String(key || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : text(key);
}

function isSameOrAfterDate(a, b) { return dateOnlyUTC(a)?.getTime() >= dateOnlyUTC(b)?.getTime(); }
function isBeforeDate(a, b) { return dateOnlyUTC(a)?.getTime() < dateOnlyUTC(b)?.getTime(); }

function dateFromSurgeryRow(row) {
  // Ưu tiên ngày trong danh sách PT. Một số màn hình chi tiết có thể giữ thời gian popup/field khác gây lệch.
  return parseVNDateTime(row?.thoi_gian)
      || parseVNDateTime(row?.ngay)
      || parseVNDateTime(row?.tg_ylenh)
      || parseVNDateTime(row?.detail?.ngay)
      || parseVNDateTime(row?.detail?.bat_dau)
      || parseVNDateTime(row?.bat_dau);
}

module.exports = {
  parseVNDateTime,
  firstParsedDateTime,
  dateOnlyUTC,
  addDaysUTC,
  diffDaysUTC,
  dateKeyUTC,
  fmtDateUTC,
  fmtDateTimeUTC,
  addMinutesUTC,
  addExactDaysUTC,
  minDateUTC,
  maxDateUTC,
  positiveInterval,
  intervalOverlapMs,
  intervalIncludesInstant,
  fmtIntervalUTC,
  fmtDateKey,
  isSameOrAfterDate,
  isBeforeDate,
  dateFromSurgeryRow,
};
