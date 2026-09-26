// Chia thuốc trong ngày thành việc của Người làm bệnh phòng / Người trực.
//
// Mốc giờ của khoa:
// - Ca làm: 07:00–11:00 và 13:00–17:00.
// - Trực ngày làm: 11:00–13:00 (trực trưa) và 17:00 → 07:00 sáng hôm sau.
// - Trực ngày nghỉ: 24 giờ, nhưng thuốc sáng (cữ 07:00–10:59) và thuốc uống cả
//   ngày của người bệnh cũ đã được người trực hôm trước làm sẵn.
// - "Thuốc sáng" là các cữ đầu tiên trong ngày: 07:00–10:59.
//
// Giờ của một dòng thuốc được quy về "phút tính từ 00:00 ngày đang xem":
// cữ 00:00–06:59 của đêm được extractTimes gắn sang ngày hôm sau nên cộng 1440.

import { addDaysDmy, parseDmy, rowMinutes } from './reportUtils.js';
import { routeReportMode } from '../../config/routes.js';

const DAY = 24 * 60;
export const SHIFT = {
  dayStart: 7 * 60,
  morningEnd: 11 * 60,
  noonEnd: 13 * 60,
  workEnd: 17 * 60,
};

const WORK_WINDOWS = [[SHIFT.dayStart, SHIFT.morningEnd], [SHIFT.noonEnd, SHIFT.workEnd]];
const DUTY_WINDOWS_WORKDAY = [[SHIFT.morningEnd, SHIFT.noonEnd], [SHIFT.workEnd, DAY + SHIFT.dayStart]];
const DUTY_WINDOWS_RESTDAY = [[SHIFT.morningEnd, DAY + SHIFT.dayStart]];
const EARLY_TOMORROW = [[DAY, DAY + SHIFT.dayStart]];

function inWindows(t, windows) {
  return t != null && windows.some(([a, b]) => t >= a && t < b);
}

// Phút tính từ 00:00 ngày `date`; null nếu không rõ giờ hoặc ngoài 2 ngày.
export function absMinutes(row, date) {
  const m = rowMinutes(row);
  if (!Number.isFinite(m) || m >= 9999) return null;
  if (row?.date === date) return m;
  if (row?.date === addDaysDmy(date, 1)) return m + DAY;
  return null;
}

export function isOral(row) {
  return routeReportMode(row?.route) === 'daily';
}

// Tiêm/truyền/đường khác cần làm theo cữ (không tính thuốc uống, thuốc ngưng/trả).
export function isNonOralAction(row) {
  // Làm theo cữ: tiêm, truyền, SE, khí dung, đường chưa rõ (bảng chuẩn config/routes.json).
  return row?.route !== 'Ngưng/Trả' && routeReportMode(row?.route || 'Khác') === 'dose';
}

// Người bệnh ra viện trong ngày: sau giờ ra viện không còn cữ nào để làm.
export function isAfterDischarge(row, date, currentMinutes, isToday) {
  // null/'' nghĩa là không ra viện trong ngày (Number(null) = 0 sẽ ẩn nhầm mọi cữ).
  if (row?.dischargeCutoffMinutes == null || row.dischargeCutoffMinutes === '') return false;
  const cutoff = Number(row?.dischargeCutoffMinutes);
  return Number.isFinite(cutoff) && row?.date === date && isToday && currentMinutes > cutoff;
}

// Y lệnh không rõ giờ của người bệnh ra viện trong ngày: không chứng minh được
// là sau giờ hành chánh nên không đưa vào phần bàn giao/soạn cho ca trực.
export function isUnknownTimeOnDischargeDay(row) {
  return Boolean(row?.noTime && row?.dischargeCutoffMinutes != null);
}

export function isWeekend(dmy) {
  const d = parseDmy(dmy);
  return Boolean(d) && (d.getDay() === 0 || d.getDay() === 6);
}

// "08:12 26/09/2026" hoặc "26/09/2026 08:12" → phút tính từ 00:00 ngày `date`.
export function admissionMinutes(value, date) {
  const s = String(value || '');
  const t = s.match(/(\d{1,2})[:h](\d{2})/);
  const d = s.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (!t || !d) return null;
  const dmy = `${d[1].padStart(2, '0')}/${d[2].padStart(2, '0')}/${d[3]}`;
  const m = Number(t[1]) * 60 + Number(t[2]);
  if (dmy === date) return m;
  if (dmy === addDaysDmy(date, 1)) return m + DAY;
  return null;
}

// Người bệnh mới vào trong tua trực → người trực phải phát thuốc uống.
export function isAdmittedDuringDuty(admissionValue, date, todayRest) {
  const t = admissionMinutes(admissionValue, date);
  if (t == null) return false;
  if (todayRest) return t >= SHIFT.dayStart && t < DAY + SHIFT.dayStart;
  return inWindows(t, DUTY_WINDOWS_WORKDAY);
}

function sortByTime(rows, date) {
  return [...rows].sort((a, b) => (absMinutes(a, date) ?? 99999) - (absMinutes(b, date) ?? 99999)
    || String(a.room || '').localeCompare(String(b.room || ''), 'vi', { numeric: true })
    || String(a.patientName || '').localeCompare(String(b.patientName || ''), 'vi'));
}

function patientKeyOf(row) {
  return String(row?.patientId || row?.patientName || '').trim();
}

/**
 * Lập danh sách việc cho một vai trò.
 * @param {object} o
 * @param {string} o.date ngày đang xem (dd/mm/yyyy)
 * @param {Array} o.rows dòng thuốc của ngày đang xem (đã gồm cữ 00–07h đêm)
 * @param {Array} o.nextDayRows dòng thuốc theo y lệnh ngày mai
 * @param {'work'|'duty'} o.role
 * @param {boolean} o.todayRest hôm nay là ngày nghỉ
 * @param {boolean} o.tomorrowRest ngày mai là ngày nghỉ
 * @param {number} o.nowMinutes giờ hiện tại (phút từ 00:00)
 * @param {boolean} o.isToday ngày đang xem là hôm nay
 * @param {Set<string>} o.newPatientKeys người bệnh mới vào trong tua trực
 */
export function buildDutyPlan({ date, rows = [], nextDayRows = [], role, todayRest, tomorrowRest, nowMinutes, isToday, newPatientKeys = new Set() }) {
  const nextDate = addDaysDmy(date, 1);
  const alive = rows.filter(row => !isAfterDischarge(row, date, nowMinutes, isToday));
  const actions = alive.filter(isNonOralAction);
  const notPast = row => !isToday || (absMinutes(row, date) ?? 0) >= nowMinutes;

  const myWindows = role === 'work' ? WORK_WINDOWS : (todayRest ? DUTY_WINDOWS_RESTDAY : DUTY_WINDOWS_WORKDAY);
  // Trực ngày nghỉ: thuốc sáng của người bệnh cũ đã làm từ hôm trước, nhưng người bệnh
  // mới vào trong tua trực thì chưa ai làm → người trực làm cả cữ 07:00–10:59 của họ.
  const newPatientMorning = row => role === 'duty' && todayRest && newPatientKeys.has(patientKeyOf(row))
    && inWindows(absMinutes(row, date), [[SHIFT.dayStart, SHIFT.morningEnd]]);
  const inMyShift = actions.filter(row => inWindows(absMinutes(row, date), myWindows) || newPatientMorning(row));
  const mine = sortByTime(inMyShift.filter(notPast), date);
  const past = sortByTime(inMyShift.filter(row => !notPast(row)), date);
  const noTime = actions.filter(row => row.noTime && row.date === date && !isUnknownTimeOnDischargeDay(row));

  const todayOral = alive.filter(row => isOral(row) && row.date === date);

  if (role === 'work') {
    const handover = sortByTime(actions.filter(row => inWindows(absMinutes(row, date), DUTY_WINDOWS_WORKDAY)), date);
    return { mine, past, noTime, oral: todayOral, handover };
  }

  // Cữ rạng sáng mai (00:00–06:59) tách riêng thành mục "Trước 7h sáng mai".
  const beforeMidnight = row => (absMinutes(row, date) ?? 0) < DAY;
  const plan = {
    mine: mine.filter(beforeMidnight),
    past: past.filter(beforeMidnight),
    earlyTomorrow: sortByTime(actions.filter(row => inWindows(absMinutes(row, date), EARLY_TOMORROW) && notPast(row)), date),
    noTime,
    // Ngày làm: người làm đã phát thuốc uống cả ngày; ngày nghỉ: đã phát trước cho người bệnh cũ.
    oral: todayOral.filter(row => newPatientKeys.has(patientKeyOf(row))),
  };
  if (tomorrowRest) {
    const tomorrow = nextDayRows.filter(row => row.date === nextDate);
    plan.nextMorning = sortByTime(tomorrow.filter(row => {
      if (!isNonOralAction(row)) return false;
      const m = rowMinutes(row);
      return m >= SHIFT.dayStart && m < SHIFT.morningEnd;
    }), nextDate);
    plan.nextOral = tomorrow.filter(isOral);
  }
  return plan;
}
