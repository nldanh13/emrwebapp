export function parseVNDateTime(value) {
  const s = String(value || '').trim();
  const match = s.match(/^(\d{2}):(\d{2})\s+(\d{2})\/(\d{2})\/(\d{4})$/);
  if (!match) return null;
  const [, hh, mm, dd, mo, yyyy] = match;
  return new Date(Number(yyyy), Number(mo) - 1, Number(dd), Number(hh), Number(mm));
}

export function formatVNDateTime(date, hour = null, minute = null) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return '';
  const d = new Date(date);
  if (hour !== null) d.setHours(hour, minute || 0, 0, 0);
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())} ${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}`;
}

export function addDays(date, days) {
  const d = new Date(date);
  d.setDate(d.getDate() + Number(days || 0));
  return d;
}

export function diffCalendarDays(from, to) {
  if (!from || !to) return null;
  const a = new Date(from.getFullYear(), from.getMonth(), from.getDate());
  const b = new Date(to.getFullYear(), to.getMonth(), to.getDate());
  return Math.round((b - a) / 86400000);
}

export function inclusiveTreatmentDays(from, to) {
  const diff = diffCalendarDays(from, to);
  if (diff === null || diff < 0) return null;
  return Math.max(diff, 1);
}
