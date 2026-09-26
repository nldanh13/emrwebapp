import { describe, test, expect } from 'vitest';
import { buildDutyPlan, isAdmittedDuringDuty, admissionMinutes } from './dutyPlan.js';

const D = '25/09/2026'; // Thứ 6
const N = '26/09/2026'; // Thứ 7

let seq = 0;
function row(time, route, extra = {}) {
  const hh = Number(time.slice(0, 2));
  return {
    id: `r${seq++}`, time, date: extra.date || (hh < 7 ? N : D), route,
    drugName: extra.drug || `${route} ${time}`, patientId: extra.pid || 'BN1', patientName: 'A', room: 'P01',
    noTime: false, quantity: 1, unit: 'ống', ...extra,
  };
}
const names = rows => rows.map(r => `${r.time} ${r.route}`);

const rows = [
  row('08:00', 'TMC'), row('10:30', 'TTM'), row('12:00', 'TB'), row('14:00', 'TMC'),
  row('17:00', 'TTM'), row('20:00', 'TMC'), row('02:00', 'TB'), row('06:30', 'TMC'),
  row('08:00', 'Uống'), row('20:00', 'Uống'),
];
const nextDayRows = [
  row('08:00', 'TMC', { date: N }), row('10:00', 'TTM', { date: N }), row('11:00', 'TMC', { date: N }),
  row('14:00', 'TMC', { date: N }), row('08:00', 'Uống', { date: N }),
];
const base = { date: D, rows, nextDayRows, isToday: false, nowMinutes: 0, newPatientKeys: new Set() };

describe('Người làm bệnh phòng', () => {
  const plan = buildDutyPlan({ ...base, role: 'work', todayRest: false, tomorrowRest: false });
  test('chỉ làm các cữ 07–11 và 13–17', () => {
    expect(names(plan.mine)).toEqual(['08:00 TMC', '10:30 TTM', '14:00 TMC']);
  });
  test('thuốc uống phát cả ngày', () => {
    expect(names(plan.oral)).toEqual(['08:00 Uống', '20:00 Uống']);
  });
  test('bàn giao trực trưa 11–13 và 17h → 7h sáng mai', () => {
    expect(names(plan.handover)).toEqual(['12:00 TB', '17:00 TTM', '20:00 TMC', '02:00 TB', '06:30 TMC']);
  });
  test('không ra viện (giờ ra viện rỗng) thì không ẩn cữ nào', () => {
    const withNull = rows.map(r => ({ ...r, dischargeCutoffMinutes: null }));
    const now = buildDutyPlan({ ...base, rows: withNull, role: 'work', todayRest: false, tomorrowRest: false, isToday: true, nowMinutes: 6 * 60 });
    expect(names(now.mine)).toEqual(['08:00 TMC', '10:30 TTM', '14:00 TMC']);
  });
  test('ra viện 13:00: sau giờ ra viện không còn cữ hôm nay', () => {
    const out = rows.map(r => ({ ...r, dischargeCutoffMinutes: 13 * 60 }));
    const now = buildDutyPlan({ ...base, rows: out, role: 'work', todayRest: false, tomorrowRest: false, isToday: true, nowMinutes: 14 * 60 });
    expect(now.mine).toEqual([]);
  });
  test('đang xem hôm nay: cữ đã qua giờ bị tách ra', () => {
    const now = buildDutyPlan({ ...base, role: 'work', todayRest: false, tomorrowRest: false, isToday: true, nowMinutes: 9 * 60 });
    expect(names(now.mine)).toEqual(['10:30 TTM', '14:00 TMC']);
    expect(names(now.past)).toEqual(['08:00 TMC']);
  });
});

describe('Người trực ngày làm (T6)', () => {
  test('mai nghỉ: làm thuốc sáng mai 07–11 và phát thuốc uống ngày mai', () => {
    const plan = buildDutyPlan({ ...base, role: 'duty', todayRest: false, tomorrowRest: true });
    expect(names(plan.mine)).toEqual(['12:00 TB', '17:00 TTM', '20:00 TMC']);
    expect(names(plan.earlyTomorrow)).toEqual(['02:00 TB', '06:30 TMC']);
    expect(names(plan.nextMorning)).toEqual(['08:00 TMC', '10:00 TTM']);
    expect(names(plan.nextOral)).toEqual(['08:00 Uống']);
  });
  test('mai không nghỉ: chỉ báo cữ trước 7h, không soạn thuốc sáng mai', () => {
    const plan = buildDutyPlan({ ...base, role: 'duty', todayRest: false, tomorrowRest: false });
    expect(names(plan.earlyTomorrow)).toEqual(['02:00 TB', '06:30 TMC']);
    expect(plan.nextMorning).toBeUndefined();
  });
  test('thuốc uống chỉ cho người bệnh mới vào trong tua trực', () => {
    const plan = buildDutyPlan({ ...base, role: 'duty', todayRest: false, tomorrowRest: false, newPatientKeys: new Set(['BN9']),
      rows: [...rows, row('20:00', 'Uống', { pid: 'BN9' })] });
    expect(plan.oral.map(r => r.patientId)).toEqual(['BN9']);
  });
});

describe('Người trực ngày nghỉ (T7)', () => {
  test('bỏ thuốc sáng 07–11 (đã làm hôm trước), còn lại như bệnh phòng', () => {
    const plan = buildDutyPlan({ ...base, role: 'duty', todayRest: true, tomorrowRest: false });
    expect(names(plan.mine)).toEqual(['12:00 TB', '14:00 TMC', '17:00 TTM', '20:00 TMC']);
  });
});

describe('Người bệnh mới vào trong tua trực', () => {
  test('ngày làm: 11–13 và từ 17h', () => {
    expect(isAdmittedDuringDuty(`12:10 ${D}`, D, false)).toBe(true);
    expect(isAdmittedDuringDuty(`09:00 ${D}`, D, false)).toBe(false);
    expect(isAdmittedDuringDuty(`18:30 ${D}`, D, false)).toBe(true);
    expect(isAdmittedDuringDuty(`03:00 ${N}`, D, false)).toBe(true);
  });
  test('ngày nghỉ: cả ngày từ 07h', () => {
    expect(isAdmittedDuringDuty(`09:00 ${D}`, D, true)).toBe(true);
    expect(isAdmittedDuringDuty(`06:00 ${D}`, D, true)).toBe(false);
  });
  test('đọc được cả "ngày giờ" lẫn "giờ ngày"', () => {
    expect(admissionMinutes(`${D} 08:12`, D)).toBe(8 * 60 + 12);
  });
});
