// server/services/clinic_patient_sync.js — Chép trạng thái theo dõi Phòng khám (clinic_monitor_state.json)
// sang Kho người bệnh: mỗi người trên Danh sách Khám bệnh là 1 lượt khám, kèm chi tiết màn khám và
// các thao tác hệ thống đã làm. Trước đây file trạng thái bị ghi đè mỗi chu kỳ nên không còn lịch sử.

'use strict';

const patientDb = require('./patient_db');

const lastSynced = new Map(); // sid -> dấu của lần chép gần nhất

function stateMark(state) {
  const log = Array.isArray(state?.action_log) ? state.action_log : [];
  return `${state?.updated_at || ''}|${log.length}|${log[log.length - 1]?.at || ''}`;
}

/**
 * @param {object} state  nội dung clinic_monitor_state.json
 * @param {{ sid?: string, force?: boolean }} opts
 * @returns {{ ok: boolean, skipped?: boolean, visits?: number, new_scans?: number, actions?: number, errors?: number, message?: string }}
 */
function syncClinicState(state, { sid = 'default', force = false } = {}) {
  if (!patientDb.available()) return { ok: false, message: patientDb.unavailableReason() };
  if (!state || typeof state !== 'object' || !Array.isArray(state.rows)) return { ok: true, skipped: true };
  const mark = stateMark(state);
  if (!force && lastSynced.get(sid) === mark) return { ok: true, skipped: true };
  const now = state.updated_at || new Date().toISOString();
  let visits = 0;
  let newScans = 0;
  let actions = 0;
  let errors = 0;
  for (const row of state.rows) {
    try {
      const res = patientDb.recordClinicVisit(row, { now });
      if (res.saved) visits += 1;
      newScans += res.new_scans || 0;
    } catch (err) {
      errors += 1;
      console.warn(`[patient_db] Không ghi được lượt khám: ${err.message}`);
    }
  }
  for (const entry of Array.isArray(state.action_log) ? state.action_log : []) {
    if (!entry?.ma_bn) continue;
    try {
      if (patientDb.recordAction(entry).saved) actions += 1;
    } catch (err) {
      errors += 1;
    }
  }
  if (!errors) lastSynced.set(sid, mark);
  return { ok: true, visits, new_scans: newScans, actions, errors };
}

module.exports = { syncClinicState };
