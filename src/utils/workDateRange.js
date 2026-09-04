const STORAGE_KEY = 'emr_work_date_range_v1';
const STORAGE_SAVED_AT_KEY = 'emr_work_date_range_saved_at_v1';

export function toInputDate(date = new Date()) {
  const d = date instanceof Date && !Number.isNaN(date.getTime()) ? date : new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

export function defaultWorkDateRange() {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const value = toInputDate(today);
  return { from: value, to: value };
}

export function sanitizeWorkDateRange(value) {
  const fallback = defaultWorkDateRange();
  const from = /^\d{4}-\d{2}-\d{2}$/.test(String(value?.from || '')) ? value.from : fallback.from;
  const to = /^\d{4}-\d{2}-\d{2}$/.test(String(value?.to || '')) ? value.to : from;
  return from <= to ? { from, to } : { from: to, to: from };
}

export function loadWorkDateRange() {
  const todayRange = defaultWorkDateRange();
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const savedAt = localStorage.getItem(STORAGE_SAVED_AT_KEY);
    // Mỗi ngày mở app sẽ tự quay về ngày hôm nay.
    // Nếu người dùng đã chỉnh trong cùng ngày, giữ lại khoảng đã chỉnh để tránh mất khi refresh.
    if (raw && savedAt === todayRange.from) return sanitizeWorkDateRange(JSON.parse(raw));
  } catch (_) {}
  saveWorkDateRange(todayRange);
  return todayRange;
}

export function saveWorkDateRange(range) {
  try {
    const clean = sanitizeWorkDateRange(range);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(clean));
    localStorage.setItem(STORAGE_SAVED_AT_KEY, defaultWorkDateRange().from);
  }
  catch (_) {}
}

export function inputDateToDmy(value) {
  const [yyyy, mm, dd] = String(value || '').split('-').map(Number);
  if (!yyyy || !mm || !dd) return '';
  return `${String(dd).padStart(2, '0')}/${String(mm).padStart(2, '0')}/${yyyy}`;
}

export function dmyToInputDate(value) {
  const m = String(value || '').trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) return '';
  return `${m[3]}-${String(m[2]).padStart(2, '0')}-${String(m[1]).padStart(2, '0')}`;
}

export function workDateRangeToDmy(range) {
  const clean = sanitizeWorkDateRange(range);
  return {
    dateFrom: inputDateToDmy(clean.from),
    dateTo: inputDateToDmy(clean.to),
  };
}

export function workDateRangeLabel(range) {
  const clean = sanitizeWorkDateRange(range);
  const from = inputDateToDmy(clean.from);
  const to = inputDateToDmy(clean.to);
  return from === to ? from : `${from} → ${to}`;
}
