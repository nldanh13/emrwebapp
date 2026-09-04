const ROUTE_FILTERS = [
  { id: 'TMC',  label: 'TMC' },
  { id: 'TTM',  label: 'TTM' },
  { id: 'TB',   label: 'TB' },
  { id: 'TDD',  label: 'TDD' },
  { id: 'Khác', label: 'Khác' },
];

const TIME_GROUPS = [
  { id: 'all', label: 'Tất cả mốc' },
  { id: 'morning', label: 'Sáng', range: '07:00–13:00' },
  { id: 'afternoon', label: 'Chiều', range: '13:00–18:00' },
  { id: 'night20', label: 'Tối 20h', range: '18:00–21:00' },
  { id: 'night22', label: 'Tối 22h', range: '21:00–00:00' },
  { id: 'earlyNext', label: 'Ngày mai <07:00', range: '00:00–07:00' },
  { id: 'other', label: 'Ngoài khung' },
];

const GROUP_ORDER = {
  morning: 1,
  afternoon: 2,
  night20: 3,
  night22: 4,
  earlyNext: 5,
  other: 6,
};

const WEEKDAY_KEYS = ['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday'];
const EMPTY_SHIFT = { admin: [], work: [], oncall: [] };

const DUTY_WINDOW = {
  workStart: 7 * 60,
  workEnd: 17 * 60,
  morningEnd: 13 * 60,
};

// Giờ riêng = cữ thuốc dễ bị sót vì không đi cùng khung giờ thuốc chung.
// Không đánh dấu các cữ truyền TTM nối tiếp nhau vì đó là một chuỗi truyền liên tục.
const SEPARATED_HOUR_GAP_MINUTES = 120;
const COMMON_SLOT_MIN_PATIENTS = 2;
const Q6_SCHEDULE_MINUTES = [0, 6 * 60, 12 * 60, 18 * 60];
const Q6_TOLERANCE_MINUTES = 20;
const Q6_MIN_MATCHES = 3;
const EARLY_ISOLATED_END_MINUTES = 7 * 60;
const CONTINUOUS_INFUSION_GAP_MINUTES = 150;

// Ưu tiên hiển thị trong phiếu: dịch truyền để gần nhau, sau đó tới thuốc đúng giờ khác.
// Thuốc uống được loại khỏi báo cáo ca trực vì có thể phát/soạn riêng theo cữ.
const ROUTE_PRIORITY = { TTM: 1, TMC: 2, TB: 3, TDD: 4, Khác: 5, 'Ngưng/Trả': 6 };

function stripVN(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D');
}

function todayDmy() {
  const d = new Date();
  return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`;
}

function parseDmy(value) {
  const m = String(value || '').match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) return null;
  const day = Number(m[1]);
  const month = Number(m[2]);
  const year = Number(m[3]);
  const d = new Date(year, month - 1, day);
  if (Number.isNaN(d.getTime())) return null;
  if (d.getFullYear() !== year || d.getMonth() !== month - 1 || d.getDate() !== day) return null;
  return d;
}

function addDaysDmy(value, days) {
  const d = parseDmy(value);
  if (!d) return '';
  d.setDate(d.getDate() + Number(days || 0));
  return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`;
}

function toIsoDate(value) {
  const s = String(value || '').trim();
  if (!s) return '';
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (!m) return '';
  let y = Number(m[3]);
  if (y < 100) y += 2000;
  return `${y}-${String(m[2]).padStart(2, '0')}-${String(m[1]).padStart(2, '0')}`;
}

function weekdayKeyFromIso(iso) {
  const [y, m, d] = String(iso || '').split('-').map(Number);
  if (!y || !m || !d) return '';
  const dt = new Date(y, m - 1, d);
  return WEEKDAY_KEYS[(dt.getDay() + 6) % 7];
}

function cloneShift(dayValue) {
  const src = dayValue && typeof dayValue === 'object' ? dayValue : EMPTY_SHIFT;
  return {
    admin: Array.isArray(src.admin) ? src.admin.filter(Boolean).map(String) : [],
    work: Array.isArray(src.work) ? src.work.filter(Boolean).map(String) : [],
    oncall: Array.isArray(src.oncall) ? src.oncall.filter(Boolean).map(String) : [],
  };
}

function normalizeScheduleShape(input) {
  const src = input && typeof input === 'object' ? input : {};
  const out = { days: {}, Default: cloneShift(src.Default) };
  for (const key of WEEKDAY_KEYS) out[key] = cloneShift(src[key]);
  const daysSrc = src.days && typeof src.days === 'object' ? src.days : {};
  for (const [rawKey, rawValue] of Object.entries(daysSrc)) {
    const iso = toIsoDate(rawKey);
    if (iso) out.days[iso] = cloneShift(rawValue);
  }
  return out;
}

function firstNonEmptyDay(...items) {
  for (const item of items) {
    const v = cloneShift(item);
    if (v.admin.length || v.work.length || v.oncall.length) return v;
  }
  return cloneShift(EMPTY_SHIFT);
}

function getDaySchedule(schedule, dmy) {
  const sched = normalizeScheduleShape(schedule);
  const iso = toIsoDate(dmy);
  if (!iso) return cloneShift(EMPTY_SHIFT);
  // Một override theo ngày, kể cả cố ý để rỗng, phải thắng lịch thứ/Default.
  // Nếu fallback vì override rỗng, ngày nghỉ đặc biệt sẽ bị gán nhầm người trực.
  if (Object.prototype.hasOwnProperty.call(sched.days || {}, iso)) {
    return cloneShift(sched.days[iso]);
  }
  return firstNonEmptyDay(sched[weekdayKeyFromIso(iso)], sched.Default);
}

function dayTypeOf(dayCfg) {
  const d = cloneShift(dayCfg);
  if ((d.admin.length || d.work.length) && d.oncall.length) return 'admin';
  if (!d.admin.length && !d.work.length && d.oncall.length) return 'oncall_only';
  if ((d.admin.length || d.work.length) && !d.oncall.length) return 'work_only';
  return 'empty';
}

function firstName(list) {
  return Array.isArray(list) && list.length ? String(list[0] || '').trim() : '';
}

function normalizeDate(raw) {
  const s = String(raw || '').trim();
  const m1 = s.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (m1) return `${m1[1].padStart(2, '0')}/${m1[2].padStart(2, '0')}/${m1[3]}`;
  const m2 = s.match(/(\d{1,2})-(\d{1,2})-(\d{4})/);
  if (m2) return `${m2[1].padStart(2, '0')}/${m2[2].padStart(2, '0')}/${m2[3]}`;
  return '';
}

function normalizeTime(raw) {
  const s = String(raw || '').trim();
  // 1) HH:MM
  const m1 = s.match(/(\d{1,2}):(\d{2})/);
  if (m1) return `${m1[1].padStart(2, '0')}:${m1[2]}`;
  // 2) Hh[MM] — ví dụ: 8h00, 8h30, 8h  (\b hậu tố OK vì h/số đều là ASCII word char)
  const m2 = s.match(/\b(\d{1,2})h(\d{2})?\b/i);
  if (m2) return `${m2[1].padStart(2, '0')}:${String(m2[2] || '00').padStart(2, '0')}`;
  // 3) H giờ [MM] — KHÔNG dùng \b cuối vì 'ờ' là Unicode non-ASCII.
  //    JS regex coi ký tự này là non-word nên \b luôn fail sau 'giờ'
  //    → chuỗi '8 giờ' không match, hiển thị 'Chưa rõ giờ' sai.
  const m3 = s.match(/\b(\d{1,2})\s*gi[ờo](?:\s*(\d{2}))?/i);
  if (m3) return `${m3[1].padStart(2, '0')}:${String(m3[2] || '00').padStart(2, '0')}`;
  return '';
}

function timeToMinutes(time) {
  const m = String(time || '').match(/^(\d{2}):(\d{2})$/);
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

function extractTimes(item, recordDate) {
  const out = [];
  const seen = new Set();

  const push = (time, date, noTime = false) => {
    if (noTime) {
      const key = `—|${recordDate}|notime`;
      if (!seen.has(key)) {
        seen.add(key);
        out.push({ time: '—', date: recordDate, hour: null, noTime: true });
      }
      return;
    }

    const t = normalizeTime(time);
    if (!t) return;
    const hh = Number(t.slice(0, 2));
    const d = date || (hh < 7 ? addDaysDmy(recordDate, 1) : recordDate);
    const key = `${t}|${d}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ time: t, date: d, hour: hh });
  };

  // Một số dòng có tg_bat_dau và đồng thời gio_dung/lich_dung chứa nhiều cữ.
  // Bản cũ hễ có tg_bat_dau là return ngay, làm các giờ còn lại không hiện trên báo cáo.
  const fullStart = String(item?.tg_bat_dau || '').trim();
  if (fullStart) {
    const t = normalizeTime(fullStart);
    const d = normalizeDate(fullStart) || recordDate;
    if (t) push(t, d);
  }

  const timeFields = [
    item?.gio_dung, item?.lich_dung, item?.thoi_gian_dung, item?.gio,
    item?.time, item?.times, item?.thoi_gian, item?.schedule,
  ];

  for (const value of timeFields) {
    const raw = Array.isArray(value) ? value.join(', ') : String(value || '').trim();
    if (!raw) continue;
    const matches = raw.match(/\b\d{1,2}:\d{2}\b|\b\d{1,2}h(?:\d{2})?\b|\b\d{1,2}\s*gi[ờo](?:\s*\d{2})?/gi) || [];
    matches.forEach(x => push(x, recordDate));
  }

  if (!out.length) push('', recordDate, true);
  return out;
}

export {
  ROUTE_FILTERS, TIME_GROUPS, GROUP_ORDER, WEEKDAY_KEYS, EMPTY_SHIFT, DUTY_WINDOW,
  SEPARATED_HOUR_GAP_MINUTES, COMMON_SLOT_MIN_PATIENTS, Q6_SCHEDULE_MINUTES, Q6_TOLERANCE_MINUTES,
  Q6_MIN_MATCHES, EARLY_ISOLATED_END_MINUTES, CONTINUOUS_INFUSION_GAP_MINUTES, ROUTE_PRIORITY,
  stripVN, todayDmy, parseDmy, addDaysDmy, toIsoDate, weekdayKeyFromIso,
  cloneShift, normalizeScheduleShape, firstNonEmptyDay, getDaySchedule, dayTypeOf, firstName,
  normalizeDate, normalizeTime, timeToMinutes, extractTimes,
};
