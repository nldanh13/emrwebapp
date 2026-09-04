// server/routes/nurse.js — /api/nurse-settings (GET, POST)

'use strict';

const router = require('express').Router();
const { DAY_KEYS, DEFAULT_NURSE_LIST } = require('../constants');
const { getRuntimePaths } = require('../services/session');
const { readJsonSafe } = require('../utils/file');
const {
  normalizeNurseList, normalizeSchedule, filterScheduleByNurseList,
  readConfig, writeConfig, getNurseState,
} = require('../utils/nurse_config');

function parseDmyToTime(value) {
  const m = String(value || '').trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (!m) return Number.NaN;
  let y = Number(m[3]);
  if (y < 100) y += 2000;
  return new Date(y, Number(m[2]) - 1, Number(m[1])).getTime();
}

function collectAvailableDates(req) {
  try {
    const ctx = getRuntimePaths(req);
    const rows = readJsonSafe(ctx.PROCESSED_PATH, []);
    if (!Array.isArray(rows)) return [];
    return [...new Set(rows.map(r => String(r?.ngay_lam || '').trim()).filter(Boolean))]
      .sort((a, b) => parseDmyToTime(a) - parseDmyToTime(b));
  } catch (_) {
    return [];
  }
}

// GET /api/nurse-settings
router.get('/nurse-settings', (req, res) => {
  const cfg = readConfig(req);
  const { roster, schedule, clinicSchedule } = getNurseState(cfg);
  return res.json({ status: 'ok', roster, schedule, clinicSchedule, available_dates: collectAvailableDates(req) });
});

// POST /api/nurse-settings
router.post('/nurse-settings', (req, res) => {
  const body = req.body || {};
  const cfg  = readConfig(req);

  // Roster
  const incomingRoster = Object.prototype.hasOwnProperty.call(body, 'roster')
    ? body.roster
    : (cfg.ds_dieu_duong || cfg.roster || DEFAULT_NURSE_LIST);
  const roster = normalizeNurseList(incomingRoster || DEFAULT_NURSE_LIST);

  // Schedule — hỗ trợ nhiều tên field để tương thích ngược
  let incomingSchedule = null;
  if (Object.prototype.hasOwnProperty.call(body, 'schedule'))       incomingSchedule = body.schedule;
  else if (Object.prototype.hasOwnProperty.call(body, 'ten_dieu_duong')) incomingSchedule = body.ten_dieu_duong;
  else {
    const maybe = {};
    let hasAny  = false;
    for (const k of DAY_KEYS) {
      if (Object.prototype.hasOwnProperty.call(body, k)) { maybe[k] = body[k]; hasAny = true; }
    }
    if (Object.prototype.hasOwnProperty.call(body, 'days')) { maybe.days = body.days; hasAny = true; }
    if (hasAny) incomingSchedule = maybe;
  }

  const scheduleRaw = normalizeSchedule(incomingSchedule || cfg.ten_dieu_duong || cfg.schedule || {});
  const schedule    = filterScheduleByNurseList(scheduleRaw, roster);

  // Clinic nurse schedule
  const incomingClinic   = Object.prototype.hasOwnProperty.call(body, 'clinicSchedule') ? body.clinicSchedule : null;
  const clinicSchedRaw   = normalizeSchedule(incomingClinic || cfg.clinic_nurse_schedule || {});
  const clinicSchedule   = filterScheduleByNurseList(clinicSchedRaw, roster);

  cfg.ds_dieu_duong        = roster;
  cfg.ten_dieu_duong       = schedule;
  cfg.clinic_nurse_schedule = clinicSchedule;

  const ok = writeConfig(cfg, req);
  if (!ok) return res.status(500).json({ status: 'error', message: 'Không ghi được config.json' });
  return res.json({ status: 'ok', roster, schedule, clinicSchedule, available_dates: collectAvailableDates(req) });
});

module.exports = router;
