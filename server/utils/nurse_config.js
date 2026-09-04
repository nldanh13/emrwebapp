// server/utils/nurse_config.js — Chuẩn hoá cấu hình điều dưỡng

'use strict';

const fs = require('fs');
const path = require('path');
const { CONFIG_PATH, DAY_KEYS, DEFAULT_NURSE_LIST } = require('../constants');
const { getRuntimePaths } = require('../services/session');
const { readJsonSafe, writeJsonAtomic } = require('./file');

const WEEKDAY_KEYS = DAY_KEYS.filter(k => k !== 'Default');
const DATE_KEY_RE = /^\d{4}-\d{2}-\d{2}$/;
const SENSITIVE_CONFIG_KEY_RE = /password|pass|username|token|secret|cookie|authorization|mat_khau|mật khẩu|ten_tai_khoan/i;

// ── Chuẩn hoá tên ─────────────────────────────────────────────────────────────

function normalizeName(s) {
  return String(s || '').trim().replace(/\s+/g, ' ');
}

/**
 * Chuẩn hoá danh sách điều dưỡng:
 * - Chấp nhận mảng hoặc chuỗi phân cách bằng dấu phẩy / xuống dòng
 * - Loại bỏ trùng lặp (không phân biệt hoa thường)
 * - Sắp xếp theo bảng chữ cái tiếng Việt
 */
function normalizeNurseList(input) {
  let items = [];
  if (Array.isArray(input)) items = input;
  else if (typeof input === 'string') {
    items = input.split(/\r?\n|,/g).map(x => x.trim()).filter(Boolean);
  }

  const seen = new Set();
  const out  = [];
  for (const v of items) {
    const s   = normalizeName(v);
    const key = s.toLowerCase();
    if (!s || seen.has(key)) continue;
    seen.add(key);
    out.push(s);
  }
  out.sort((a, b) => a.localeCompare(b, 'vi'));
  return out;
}

// ── Chuẩn hoá ngày / ca trực ─────────────────────────────────────────────────

function pad2(n) {
  return String(n).padStart(2, '0');
}

function toIsoDate(value) {
  const s = String(value || '').trim();
  if (!s) return '';
  if (DATE_KEY_RE.test(s)) return s;
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (!m) return '';
  let yyyy = Number(m[3]);
  if (yyyy < 100) yyyy += 2000;
  return `${yyyy}-${pad2(m[2])}-${pad2(m[1])}`;
}

function addDaysIso(iso, amount) {
  const [y, m, d] = String(iso || '').split('-').map(Number);
  if (!y || !m || !d) return '';
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() + amount);
  return `${dt.getFullYear()}-${pad2(dt.getMonth() + 1)}-${pad2(dt.getDate())}`;
}

function isoFromDateParts(dd, mm, yyyy) {
  let y = Number(yyyy);
  if (y < 100) y += 2000;
  const d = Number(dd);
  const m = Number(mm);
  if (!d || !m || !y) return '';
  return `${y}-${pad2(m)}-${pad2(d)}`;
}

function weekdayKeyFromIso(iso) {
  const [y, m, d] = String(iso || '').split('-').map(Number);
  if (!y || !m || !d) return '';
  const dt = new Date(y, m - 1, d);
  return WEEKDAY_KEYS[(dt.getDay() + 6) % 7];
}

function normalizeShiftBucket(input) {
  return normalizeNurseList(input);
}

function normalizeDaySchedule(dayValue) {
  if (Array.isArray(dayValue) || typeof dayValue === 'string') {
    const arr = normalizeNurseList(dayValue);
    return { admin: [], work: arr.slice(0, 1), oncall: arr.slice(1) };
  }
  const src = (dayValue && typeof dayValue === 'object') ? dayValue : {};
  return {
    admin:  normalizeShiftBucket(src.admin || src.hanh_chanh || src.hanhChanh || src.administrative || src.ward_admin || src.dieu_duong_hanh_chanh || src.dd_hanh_chanh || []),
    work:   normalizeShiftBucket(src.work   || src.ca_lam  || src.caLam  || src.regular || src.day || []),
    oncall: normalizeShiftBucket(src.oncall || src.ca_truc || src.caTruc || src.night   || src.direct || []),
  };
}

function hasAnyNurse(dayCfg) {
  return !!((dayCfg?.admin?.length || 0) || (dayCfg?.work?.length || 0) || (dayCfg?.oncall?.length || 0));
}

function normalizeSchedule(input) {
  const schedule = { days: {} };
  for (const k of DAY_KEYS) schedule[k] = { admin: [], work: [], oncall: [] };

  const src = (input && typeof input === 'object') ? input : {};
  const weekly = (src.weekly && typeof src.weekly === 'object') ? src.weekly : src;

  for (const k of DAY_KEYS) schedule[k] = normalizeDaySchedule(weekly[k] || src[k]);
  if (Object.prototype.hasOwnProperty.call(src, 'default')) {
    schedule.Default = normalizeDaySchedule(src.default);
  }

  const daysSrc = (src.days && typeof src.days === 'object') ? src.days : {};
  for (const [rawKey, value] of Object.entries(daysSrc)) {
    const iso = toIsoDate(rawKey);
    if (iso) schedule.days[iso] = normalizeDaySchedule(value);
  }

  // Tương thích thêm: nếu config cũ/ngoài app lưu ngày ngay ở top-level.
  for (const [rawKey, value] of Object.entries(src)) {
    const iso = toIsoDate(rawKey);
    if (iso) schedule.days[iso] = normalizeDaySchedule(value);
  }

  return schedule;
}

function filterDayScheduleByNurseList(dayCfg, allow) {
  const v = normalizeDaySchedule(dayCfg);
  return {
    admin:  (v.admin  || []).filter(n => allow.has(normalizeName(n).toLowerCase())),
    work:   (v.work   || []).filter(n => allow.has(normalizeName(n).toLowerCase())),
    oncall: (v.oncall || []).filter(n => allow.has(normalizeName(n).toLowerCase())),
  };
}

function filterScheduleByNurseList(schedule, nurseList) {
  const allow = new Set((nurseList || []).map(n => normalizeName(n).toLowerCase()).filter(Boolean));
  const src = normalizeSchedule(schedule);
  const out = { days: {} };
  for (const k of DAY_KEYS) out[k] = filterDayScheduleByNurseList(src[k], allow);
  for (const [iso, dayCfg] of Object.entries(src.days || {})) {
    out.days[iso] = filterDayScheduleByNurseList(dayCfg, allow);
  }
  return out;
}

// ── Đọc / ghi config.json ────────────────────────────────────────────────────

function isRequestLike(input) {
  return input && typeof input === 'object' && typeof input.get === 'function';
}

function deepMergeConfig(base, override) {
  const out = { ...(base && typeof base === 'object' && !Array.isArray(base) ? base : {}) };
  const src = override && typeof override === 'object' && !Array.isArray(override) ? override : {};
  for (const [key, value] of Object.entries(src)) {
    if (value && typeof value === 'object' && !Array.isArray(value) && out[key] && typeof out[key] === 'object' && !Array.isArray(out[key])) {
      out[key] = deepMergeConfig(out[key], value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

function stripSensitiveConfigKeys(value) {
  if (!value || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(stripSensitiveConfigKeys);
  const out = {};
  for (const [key, child] of Object.entries(value)) {
    if (SENSITIVE_CONFIG_KEY_RE.test(key)) continue;
    out[key] = stripSensitiveConfigKeys(child);
  }
  return out;
}

function nurseConfigOverride(obj) {
  const src = obj && typeof obj === 'object' ? obj : {};
  return stripSensitiveConfigKeys({
    ds_dieu_duong:        src.ds_dieu_duong        || src.roster          || [],
    ten_dieu_duong:       src.ten_dieu_duong        || src.schedule        || {},
    clinic_nurse_schedule: src.clinic_nurse_schedule || src.clinicSchedule || {},
  });
}

function resolveConfigPath(input) {
  if (typeof input === 'string' && input.trim()) {
    return path.resolve(input.trim());
  }
  if (isRequestLike(input)) {
    try {
      return path.join(getRuntimePaths(input).dir, 'config.json');
    } catch (_) {}
  }
  return CONFIG_PATH;
}

function readConfig(input) {
  const configPath = resolveConfigPath(input);
  const localObj = readJsonSafe(configPath, null);
  if (isRequestLike(input) && configPath !== CONFIG_PATH) {
    const globalObj = readJsonSafe(CONFIG_PATH, {});
    return deepMergeConfig(
      (globalObj && typeof globalObj === 'object') ? globalObj : {},
      stripSensitiveConfigKeys((localObj && typeof localObj === 'object') ? localObj : {})
    );
  }
  if (localObj && typeof localObj === 'object') return localObj;
  return {};
}

function writeConfig(obj, input) {
  const configPath = resolveConfigPath(input);
  try {
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    const value = isRequestLike(input) ? nurseConfigOverride(obj || {}) : (obj || {});
    writeJsonAtomic(configPath, value);
    return true;
  } catch (err) {
    console.error(`!!! LỖI ghi ${configPath}:`, err);
    return false;
  }
}

/** Trích xuất roster + schedule đã chuẩn hoá từ config. */
function getNurseState(cfg) {
  const roster         = normalizeNurseList(cfg.ds_dieu_duong || cfg.roster || DEFAULT_NURSE_LIST);
  const scheduleRaw    = normalizeSchedule(cfg.ten_dieu_duong || cfg.schedule || {});
  const schedule       = filterScheduleByNurseList(scheduleRaw, roster);
  const clinicSchedRaw = normalizeSchedule(cfg.clinic_nurse_schedule || {});
  const clinicSchedule = filterScheduleByNurseList(clinicSchedRaw, roster);
  return { roster, schedule, clinicSchedule };
}

function firstOf(dayCfg, s) {
  const b = (dayCfg || {})[s];
  return Array.isArray(b) && b.length ? String(b[0] || '').trim() : '';
}

function firstFromDay(dayCfg, shift, allowOtherShift = true) {
  if (!dayCfg || typeof dayCfg !== 'object') return '';
  if (shift === 'admin') {
    return firstOf(dayCfg, 'admin')
        || (allowOtherShift ? (firstOf(dayCfg, 'work') || firstOf(dayCfg, 'oncall')) : '')
        || '';
  }
  if (shift === 'work') {
    return firstOf(dayCfg, 'work')
        || firstOf(dayCfg, 'admin')
        || (allowOtherShift ? firstOf(dayCfg, 'oncall') : '')
        || '';
  }
  return firstOf(dayCfg, 'oncall')
      || (allowOtherShift ? (firstOf(dayCfg, 'work') || firstOf(dayCfg, 'admin')) : '')
      || '';
}

/**
 * Xác định điều dưỡng phụ trách tại một thời điểm cụ thể.
 *
 * Ưu tiên mới:
 *   1) schedule.days[YYYY-MM-DD] đúng ngày thật
 *   2) lịch theo thứ Monday/Tuesday... để tương thích dữ liệu cũ
 *   3) Default
 *
 * Quy tắc ca:
 *   07:00-10:59  → ca làm (work)
 *   11:00-12:59  → ca trực (oncall)
 *   13:00-16:59  → ca làm (work)
 *   17:00-23:59  → ca trực (oncall)
 *   00:00-06:59  → ca trực ngày hôm trước (oncall)
 */
function getNurseByShift(timeStr, schedule, opts = {}) {
  if (!schedule || typeof schedule !== 'object') return '';

  let hour = null;
  let dateIso = '';

  if (timeStr) {
    const raw = String(timeStr).trim();
    const m1 = raw.match(/(\d{1,2}):(\d{2})\s+(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
    const m2 = raw.match(/(\d{1,2})\/(\d{1,2})\/(\d{2,4})\s+(\d{1,2}):(\d{2})/);
    if (m1) {
      hour = Number(m1[1]);
      dateIso = isoFromDateParts(m1[3], m1[4], m1[5]);
    } else if (m2) {
      hour = Number(m2[4]);
      dateIso = isoFromDateParts(m2[1], m2[2], m2[3]);
    } else {
      const m3 = raw.match(/(\d{1,2}):(\d{2})/);
      if (m3) hour = Number(m3[1]);
    }
  }

  const now = new Date();
  if (hour === null || Number.isNaN(hour)) hour = now.getHours();
  if (!dateIso) dateIso = `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`;

  let lookupIso = dateIso;
  let shift = 'oncall';
  if (hour >= 0 && hour <= 6) {
    lookupIso = addDaysIso(dateIso, -1) || dateIso;
    shift = 'oncall';
  } else if (hour >= 7 && hour <= 10) {
    shift = 'work';
  } else if (hour >= 11 && hour <= 12) {
    shift = 'oncall';
  } else if (hour >= 13 && hour <= 16) {
    shift = 'work';
  } else {
    shift = 'oncall';
  }

  const forcedShift = String(opts.forceShift || opts.nurseShiftOverride || '').trim().toLowerCase();
  if (forcedShift === 'work' || forcedShift === 'oncall' || forcedShift === 'admin') {
    shift = forcedShift;
  }

  const sched = normalizeSchedule(schedule);
  const dayKey = weekdayKeyFromIso(lookupIso);
  const exactDay = sched.days?.[lookupIso];

  // Nếu ngày cụ thể có khai báo người thì ưu tiên ngày đó.
  if (hasAnyNurse(exactDay)) {
    const n = firstFromDay(exactDay, shift, true);
    if (n) return n;
  }

  const byWeekday = sched[dayKey];
  const byDefault = sched.Default;
  return firstFromDay(byWeekday, shift, true)
      || firstFromDay(byDefault, shift, true)
      || (() => {
           for (const iso of Object.keys(sched.days || {}).sort()) {
             const n = firstOf(sched.days[iso], 'work') || firstOf(sched.days[iso], 'admin') || firstOf(sched.days[iso], 'oncall');
             if (n) return n;
           }
           for (const dk of [...WEEKDAY_KEYS, 'Default']) {
             const dc = sched[dk] || {};
             const n  = firstOf(dc, 'work') || firstOf(dc, 'admin') || firstOf(dc, 'oncall');
             if (n) return n;
           }
           return '';
         })();
}

module.exports = {
  normalizeName, normalizeNurseList,
  normalizeSchedule, filterScheduleByNurseList,
  readConfig, writeConfig, getNurseState,
  getNurseByShift,
  toIsoDate,
};
