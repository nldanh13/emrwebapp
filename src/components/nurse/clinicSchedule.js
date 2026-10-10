// Lịch phòng khám (clinic_nurse_schedule): mỗi loại (bác sĩ 'doctor', điều dưỡng 'work') tra riêng:
// đúng ngày → theo thứ → mẫu mặc định. Cùng quy tắc với máy chủ (server/utils/nurse_config.js →
// clinicNamesForDate) và worker/clinic_input_care.py.
import { cloneShift, normalizeScheduleShape, weekdayKeyFromIso, firstNonEmptyDay } from './nurseScheduleUtils.js';

/** Tên của một loại cho một ngày, kèm nơi lấy: 'day' | 'weekday' | 'default' | ''. */
export function clinicNamesFor(schedule, key, kind) {
  const sched = normalizeScheduleShape(schedule);
  const pick = (day) => (Array.isArray(day?.[kind]) ? day[kind].filter(Boolean) : []);
  if (key === 'Default') return { names: pick(sched.Default), from: pick(sched.Default).length ? 'default' : '' };
  const exact = pick(sched.days?.[key]);
  if (exact.length) return { names: exact, from: 'day' };
  const weekly = pick(sched[weekdayKeyFromIso(key)]);
  if (weekly.length) return { names: weekly, from: 'weekday' };
  const def = pick(sched.Default);
  return { names: def, from: def.length ? 'default' : '' };
}

/** Lịch mới sau khi đặt danh sách tên của một loại cho một ngày (chỉ đổi đúng loại đó). */
export function setClinicNames(schedule, key, kind, names) {
  const sched = normalizeScheduleShape(schedule);
  const apply = (day) => {
    const next = cloneShift(day);
    if (kind === 'doctor') { if (names.length) next.doctor = [...names]; else delete next.doctor; }
    else next[kind] = [...names];
    return next;
  };
  if (key === 'Default') return { ...sched, Default: apply(sched.Default) };
  return { ...sched, days: { ...sched.days, [key]: apply(sched.days?.[key]) } };
}

/** Lịch điều dưỡng khoa của một ngày (cả ngày: đúng ngày → theo thứ → mẫu), kèm nơi lấy. */
export function nurseDayFor(schedule, key) {
  const sched = normalizeScheduleShape(schedule);
  const filled = (d) => Boolean(d && ((d.admin?.length || 0) + (d.work?.length || 0) + (d.oncall?.length || 0)));
  if (key === 'Default') return { day: cloneShift(sched.Default), from: filled(sched.Default) ? 'default' : '' };
  if (filled(sched.days?.[key])) return { day: cloneShift(sched.days[key]), from: 'day' };
  const weekly = sched[weekdayKeyFromIso(key)];
  if (filled(weekly)) return { day: cloneShift(weekly), from: 'weekday' };
  return { day: firstNonEmptyDay(sched.Default), from: filled(sched.Default) ? 'default' : '' };
}

/** Thứ Hai của tuần chứa ngày iso. */
export function weekStartIso(iso) {
  const [y, m, d] = String(iso).split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() - ((dt.getDay() + 6) % 7));
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
}

export const FROM_LABEL = { weekday: 'theo lịch thứ trong tuần', default: 'theo mẫu mặc định' };
