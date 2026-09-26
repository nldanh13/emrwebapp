// server/routes/clinic.js — phần Phòng khám còn giữ lại (tab Phòng khám đang được làm lại).
//   POST /api/clinic/preview    đọc danh sách Khám bệnh (worker clinic_outpatient.py) — tab Nghỉ ốm dùng.
//   GET  /api/clinic/care-draft đọc bản nháp chăm sóc phòng khám cũ — tab Nghỉ ốm lấy danh sách ngoại trú.

'use strict';

const router = require('express').Router();
const path = require('path');

const { getRuntimePaths } = require('../services/session');
const { enqueueHeavy, registerCancel, unregisterCancel } = require('../services/task_queue');
const { runScript, fmtPyError } = require('../services/python_runner');
const { appendActivity } = require('../services/activity_logger');
const { writeJsonAtomic, readJsonSafe, safeUnlink, safeFilePart } = require('../utils/file');

function sanitizeClinicSchedule(raw = {}) {
  const obj = raw && typeof raw === 'object' ? raw : {};
  const role = String(obj.defaultRole || 'nurse').trim().toLowerCase();
  const legacyDoctor = String(obj.doctorName || '').trim();
  const afternoonStartHour = String(obj.afternoonStartHour || '12').replace(/\D+/g, '').slice(0, 2) || '12';
  return {
    doctorName: legacyDoctor.slice(0, 120),
    doctorMorningName: String(obj.doctorMorningName || legacyDoctor || '').trim().slice(0, 120),
    doctorAfternoonName: String(obj.doctorAfternoonName || legacyDoctor || '').trim().slice(0, 120),
    nurseName: String(obj.nurseName || '').trim().slice(0, 120),
    defaultRole: role === 'doctor' ? 'doctor' : 'nurse',
    afternoonStartHour,
    doctorKeywords: String(obj.doctorKeywords || '').trim().slice(0, 600),
    nurseKeywords: String(obj.nurseKeywords || '').trim().slice(0, 600),
    procedureTemplateName: String(obj.procedureTemplateName || '').trim().slice(0, 160),
    procedureDurationMinutes: String(obj.procedureDurationMinutes || '').trim().slice(0, 8),
  };
}

const CLINIC_PREVIEW_MODES = new Set(['today', 'missed', 'date_range']);

function sanitizeClinicRequest(body = {}) {
  const rawMode = String(body.mode || 'missed').trim();
  const mode = CLINIC_PREVIEW_MODES.has(rawMode) ? rawMode : 'missed';
  const username = String(body.username || '').trim();
  const password = String(body.password || '');
  const loginUrl = String(body.loginUrl || '').trim();
  const listUrl = String(body.listUrl || '').trim();
  const manualCodes = String(body.manualCodes || '').trim();
  // "date_range" = tìm mù ngoại trú theo khoảng ngày (giống cơ chế đã có cho nội trú);
  // để Python tự phân tích định dạng ngày (iso hoặc dd/mm/yyyy), ở đây chỉ chặn chuỗi rác.
  const dateFrom = String(body.dateFrom || '').trim().slice(0, 20);
  const dateTo = String(body.dateTo || '').trim().slice(0, 20);
  const headless = body.headless !== false;
  const clinicSchedule = sanitizeClinicSchedule(body.clinicSchedule || body.clinic_schedule || {});
  const excel = body.excel && typeof body.excel === 'object' ? {
    filename: String(body.excel.filename || 'clinic_targets.xlsx').replace(/[\\/]/g, '_').slice(0, 120),
    base64: String(body.excel.base64 || ''),
  } : null;

  if (!username) throw new Error('Thiếu tài khoản phòng khám.');
  if (!password) throw new Error('Thiếu mật khẩu phòng khám.');
  if (!loginUrl) throw new Error('Thiếu URL đăng nhập phòng khám.');
  if (!listUrl) throw new Error('Thiếu URL Danh sách Khám bệnh.');
  if (excel?.base64 && excel.base64.length > 8 * 1024 * 1024) throw new Error('File Excel quá lớn.');
  if (mode === 'date_range' && !dateFrom) throw new Error('Thiếu khoảng ngày để tìm (dateFrom).');

  return { mode, username, password, loginUrl, listUrl, manualCodes, dateFrom, dateTo, headless, excel, clinicSchedule };
}

function redactForAudit(payload = {}) {
  return {
    mode: payload.mode,
    username: payload.username ? '[set]' : '',
    password: payload.password ? '[set]' : '',
    loginUrl: payload.loginUrl ? '[set]' : '',
    listUrl: payload.listUrl ? '[set]' : '',
    manualCodeCount: String(payload.manualCodes || '').split(/[\s,;]+/).filter(Boolean).length,
    dateFrom: payload.dateFrom || '',
    dateTo: payload.dateTo || '',
    excel: payload.excel?.filename || '',
    hasExcel: Boolean(payload.excel?.base64),
    headless: payload.headless,
    clinicSchedule: {
      doctorMorningName: payload.clinicSchedule?.doctorMorningName ? '[set]' : '',
      doctorAfternoonName: payload.clinicSchedule?.doctorAfternoonName ? '[set]' : '',
      nurseName: payload.clinicSchedule?.nurseName ? '[set]' : '',
      defaultRole: payload.clinicSchedule?.defaultRole || '',
    },
  };
}

router.post('/clinic/preview', async (req, res) => {
  const ctx = getRuntimePaths(req);
  let reqPath = '';
  let outPath = '';
  try {
    const payload = sanitizeClinicRequest(req.body || {});
    const stamp = `${Date.now()}_${safeFilePart(payload.mode)}`;
    reqPath = path.join(ctx.dir, `clinic_request_${stamp}.json`);
    outPath = path.join(ctx.dir, `clinic_preview_${stamp}.json`);
    writeJsonAtomic(reqPath, payload);

    appendActivity(ctx, { kind: 'workflow.clinic.preview.start', request: redactForAudit(payload) });

    const result = await enqueueHeavy(ctx.sid, async () => {
      try {
        return await runScript('clinic_outpatient.py', ['preview', reqPath, outPath], {
          runtimeDir: ctx.dir,
          onSpawn: (killFn) => registerCancel(ctx.sid, killFn),
        });
      } finally {
        unregisterCancel(ctx.sid);
      }
    });

    safeUnlink(reqPath);

    const fail = (statusCode, message) => {
      safeUnlink(outPath);
      return res.status(statusCode).json({ status: 'error', message });
    };
    if (result.spawnError) return fail(500, `Không khởi động được Python: ${result.spawnError}`);
    if (result.killedByTimeout) return fail(504, 'Timeout khi đọc Phòng khám');
    if (result.code !== 0) return fail(500, fmtPyError('Python lỗi khi đọc Phòng khám.', result));

    const data = readJsonSafe(outPath, null);
    safeUnlink(outPath);
    if (!data) return res.status(500).json({ status: 'error', message: 'Không đọc được kết quả Phòng khám.' });

    appendActivity(ctx, {
      kind: 'workflow.clinic.preview.success',
      mode: data.mode,
      rows: Array.isArray(data.rows) ? data.rows.length : 0,
      target_count: data.target_count || 0,
      summary: data.summary || {},
    });
    return res.json(data);
  } catch (err) {
    safeUnlink(reqPath);
    safeUnlink(outPath);
    try { appendActivity(ctx, { kind: 'workflow.clinic.preview.error', message: String(err.message || err) }); } catch (_) {}
    return res.status(500).json({ status: 'error', message: String(err.message || err) });
  }
});

// Bản nháp lưu theo session tại .runtime/sessions/<session-id>/clinic_care_draft.json.
const CLINIC_CARE_DRAFT_FILE = 'clinic_care_draft.json';

function clinicCareDraftPath(ctx) {
  return path.join(ctx.dir, CLINIC_CARE_DRAFT_FILE);
}

router.get('/clinic/care-draft', (req, res) => {
  const ctx = getRuntimePaths(req);
  const draft = readJsonSafe(clinicCareDraftPath(ctx), null);
  return res.json({ status: 'ok', draft: draft && typeof draft === 'object' ? draft : null });
});

module.exports = router;
