export const WEEKDAY_KEYS = ['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday'];
export const DAY_KEYS     = [...WEEKDAY_KEYS, 'Default'];
export const DAY_VI       = { Monday:'Thứ 2', Tuesday:'Thứ 3', Wednesday:'Thứ 4', Thursday:'Thứ 5', Friday:'Thứ 6', Saturday:'Thứ 7', Sunday:'Chủ nhật', Default:'Mặc định' };
export const EMPTY_SHIFT  = { admin: [], work: [], oncall: [] };

// Lịch điều dưỡng phòng khám — chỉ dùng slot "work" để lưu danh sách ĐD trực PK ngày đó.
// Shape giống EMPTY_SHIFT để tái dùng cloneShift / normalizeScheduleShape.
export const EMPTY_CLINIC_SHIFT = { admin: [], work: [], oncall: [] };

/** Lấy lịch PK của 1 ngày (iso) hoặc thứ từ clinicSchedule. Trả mảng tên ĐD. */
export function getClinicNursesForDay(clinicSchedule, isoOrKey) {
  const sched = normalizeScheduleShape(clinicSchedule || {});
  let day;
  if (isoOrKey === 'Default') {
    day = cloneShift(sched.Default);
  } else {
    const iso = toIsoDate(isoOrKey) || isoOrKey;
    const weekKey = iso && /^\d{4}-\d{2}-\d{2}$/.test(iso) ? weekdayKeyFromIso(iso) : null;
    // Ưu tiên: ngày cụ thể → theo thứ → Default
    day = firstNonEmptyDay(sched.days?.[iso], weekKey ? sched[weekKey] : null, sched.Default);
  }
  return Array.isArray(day?.work) ? day.work : [];
}

export function pad2(n) {
  return String(n).padStart(2, '0');
}

export function toIsoDate(value) {
  const s = String(value || '').trim();
  if (!s) return '';
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (!m) return '';
  let y = Number(m[3]);
  if (y < 100) y += 2000;
  return `${y}-${pad2(m[2])}-${pad2(m[1])}`;
}

export function todayIso() {
  const d = new Date();
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

export function addDaysIso(iso, amount) {
  const [y, m, d] = String(iso || todayIso()).split('-').map(Number);
  const dt = new Date(y, (m || 1) - 1, d || 1);
  dt.setDate(dt.getDate() + amount);
  return `${dt.getFullYear()}-${pad2(dt.getMonth() + 1)}-${pad2(dt.getDate())}`;
}

export function buildDateRange(fromIso, toIso) {
  const from = toIsoDate(fromIso) || todayIso();
  let to = toIsoDate(toIso) || addDaysIso(from, 6);
  if (new Date(`${to}T00:00:00`) < new Date(`${from}T00:00:00`)) to = from;
  const out = [];
  let cur = from;
  for (let i = 0; i < 62; i += 1) {
    out.push(cur);
    if (cur === to) break;
    cur = addDaysIso(cur, 1);
  }
  return out;
}

export function formatDmy(iso) {
  const [y, m, d] = String(iso || '').split('-');
  return y && m && d ? `${d}/${m}/${y}` : '';
}

export function weekdayKeyFromIso(iso) {
  const [y, m, d] = String(iso || '').split('-').map(Number);
  const dt = new Date(y, (m || 1) - 1, d || 1);
  return WEEKDAY_KEYS[(dt.getDay() + 6) % 7];
}

export function weekdayLabelFromIso(iso) {
  return DAY_VI[weekdayKeyFromIso(iso)] || '';
}

export function cloneShift(dayValue) {
  const src = dayValue && typeof dayValue === 'object' ? dayValue : EMPTY_SHIFT;
  return {
    admin: Array.isArray(src.admin) ? [...src.admin] : [],
    work: Array.isArray(src.work) ? [...src.work] : [],
    oncall: Array.isArray(src.oncall) ? [...src.oncall] : [],
  };
}

export function normalizeScheduleShape(input) {
  const src = input && typeof input === 'object' ? input : {};
  const out = { days: {} };
  for (const key of DAY_KEYS) out[key] = cloneShift(src[key]);

  const daysSrc = src.days && typeof src.days === 'object' ? src.days : {};
  for (const [rawKey, rawValue] of Object.entries(daysSrc)) {
    const iso = toIsoDate(rawKey);
    if (iso) out.days[iso] = cloneShift(rawValue);
  }
  return out;
}

export function firstNonEmptyDay(...items) {
  for (const item of items) {
    const v = cloneShift(item);
    if ((v.admin?.length || 0) || (v.work?.length || 0) || (v.oncall?.length || 0)) return v;
  }
  return cloneShift(EMPTY_SHIFT);
}

export function getDaySchedule(schedule, key) {
  const sched = normalizeScheduleShape(schedule);
  if (key === 'Default') return cloneShift(sched.Default);
  const iso = toIsoDate(key);
  if (!iso) return cloneShift(EMPTY_SHIFT);
  return firstNonEmptyDay(sched.days?.[iso], sched[weekdayKeyFromIso(iso)], sched.Default);
}

export function setDateSchedule(schedule, iso, value) {
  const sched = normalizeScheduleShape(schedule);
  return {
    ...sched,
    days: {
      ...(sched.days || {}),
      [iso]: cloneShift(value),
    },
  };
}

export function filterNameFromShift(dayValue, name) {
  const v = cloneShift(dayValue);
  return {
    admin: v.admin.filter(n => n !== name),
    work: v.work.filter(n => n !== name),
    oncall: v.oncall.filter(n => n !== name),
  };
}
