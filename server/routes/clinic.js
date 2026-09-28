// server/routes/clinic.js — phần Phòng khám còn giữ lại (tab Phòng khám đang được làm lại).
//   POST /api/clinic/preview    đọc danh sách Khám bệnh (worker clinic_outpatient.py) — tab Nghỉ ốm dùng.
//   GET  /api/clinic/care-draft đọc bản nháp chăm sóc phòng khám cũ — tab Nghỉ ốm lấy danh sách ngoại trú.
//   /api/clinic/monitor/*       theo dõi Danh sách Khám bệnh liên tục (worker clinic_monitor.py, chỉ đọc).

'use strict';

const router = require('express').Router();
const fs = require('fs');
const path = require('path');

const { getRuntimePaths } = require('../services/session');
const { enqueueHeavy, registerCancel, unregisterCancel } = require('../services/task_queue');
const { runPython, runScript, fmtPyError } = require('../services/python_runner');
const { WORKER_DIR } = require('../constants');
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

// ── Theo dõi Danh sách Khám bệnh ─────────────────────────────────────────────
// Một tiến trình Python chạy nền cho mỗi phiên dữ liệu, giữ Chrome đăng nhập sẵn
// và tự đọc lại danh sách theo chu kỳ. Không đi qua hàng đợi tác vụ nặng vì
// chạy liên tục hàng giờ; chỉ đọc, không ghi EMR. Mật khẩu chỉ nằm trong file
// yêu cầu tạm, worker đọc xong xoá ngay.

const MONITOR_MAX_RUNTIME_MS = 14 * 60 * 60 * 1000;
const monitors = new Map(); // sid -> { running, kill, stopTimer }

function monitorPaths(ctx) {
  return {
    state: path.join(ctx.dir, 'clinic_monitor_state.json'),
    control: path.join(ctx.dir, 'clinic_monitor_control.json'),
    request: path.join(ctx.dir, `clinic_monitor_request_${Date.now()}.json`),
  };
}

function sanitizeMonitorRequest(body = {}) {
  const username = String(body.username || '').trim().slice(0, 120);
  const password = String(body.password || '');
  const loginUrl = String(body.loginUrl || '').trim().slice(0, 500);
  const listUrl = String(body.listUrl || '').trim().slice(0, 1000);
  const interval = Number.parseInt(body.intervalMinutes, 10);
  if (!username) throw new Error('Thiếu tài khoản EMR.');
  if (!password) throw new Error('Thiếu mật khẩu EMR.');
  if (!/^https?:\/\//i.test(loginUrl)) throw new Error('URL đăng nhập EMR không hợp lệ.');
  if (!/^https?:\/\//i.test(listUrl)) throw new Error('URL Danh sách Khám bệnh không hợp lệ.');
  return {
    username, password, loginUrl, listUrl,
    intervalMinutes: Number.isFinite(interval) ? Math.min(Math.max(interval, 1), 60) : 3,
    headless: body.headless !== false,
  };
}

// Gộp vào file điều khiển (không ghi đè) để lệnh làm mới không xoá cân nặng đã nhập.
function writeControl(ctx, data) {
  const file = monitorPaths(ctx).control;
  const current = readJsonSafe(file, {}) || {};
  writeJsonAtomic(file, { ...current, ...data, at: Date.now() });
}

function monitorStatePayload(ctx) {
  const entry = monitors.get(ctx.sid);
  const state = readJsonSafe(monitorPaths(ctx).state, null);
  const running = Boolean(entry?.running);
  const payload = state && typeof state === 'object' ? state : { status: 'idle', rows: [], summary: null };
  if (!running && ['starting', 'running', 'error'].includes(payload.status)) payload.status = 'stopped';
  return { ...payload, running, exit_message: entry?.exitMessage || '' };
}

router.post('/clinic/monitor/start', async (req, res) => {
  const ctx = getRuntimePaths(req);
  let payload;
  try {
    payload = sanitizeMonitorRequest(req.body || {});
  } catch (err) {
    return res.status(400).json({ status: 'error', message: String(err.message || err) });
  }
  const existing = monitors.get(ctx.sid);
  if (existing?.running) {
    return res.status(409).json({ status: 'error', message: 'Đang theo dõi rồi. Dừng trước khi bắt đầu lại.' });
  }
  const paths = monitorPaths(ctx);
  writeJsonAtomic(paths.request, payload);
  try { fs.chmodSync(paths.request, 0o600); } catch (_) {}
  writeJsonAtomic(paths.control, { at: Date.now() });
  safeUnlink(paths.state);

  const entry = { running: true, kill: null, exitMessage: '' };
  monitors.set(ctx.sid, entry);
  appendActivity(ctx, { kind: 'workflow.clinic.monitor.start', interval_minutes: payload.intervalMinutes, headless: payload.headless });

  runPython(['-u', path.join(WORKER_DIR, 'clinic_monitor.py'), 'monitor', paths.request, paths.state, paths.control], {
    timeoutMs: MONITOR_MAX_RUNTIME_MS,
    runtimeDir: ctx.dir,
    onSpawn: (killFn) => { entry.kill = killFn; },
  }).then((result) => {
    entry.running = false;
    if (entry.stopTimer) clearTimeout(entry.stopTimer);
    safeUnlink(paths.request);
    if (result.spawnError) entry.exitMessage = `Không khởi động được Python: ${result.spawnError}`;
    else if (result.killedByTimeout) entry.exitMessage = 'Đã tự dừng sau 14 giờ theo dõi.';
    else if (result.code !== 0 && !entry.stopRequested) entry.exitMessage = fmtPyError('Theo dõi phòng khám bị dừng do lỗi.', result);
    appendActivity(ctx, { kind: 'workflow.clinic.monitor.exit', code: result.code, message: entry.exitMessage });
  });

  return res.json({ status: 'ok', message: 'Đã bắt đầu theo dõi Danh sách Khám bệnh.' });
});

router.post('/clinic/monitor/stop', (req, res) => {
  const ctx = getRuntimePaths(req);
  const entry = monitors.get(ctx.sid);
  if (!entry?.running) return res.json({ status: 'ok', message: 'Không có theo dõi nào đang chạy.' });
  entry.stopRequested = true;
  writeControl(ctx, { stop: true });
  // Worker đóng Chrome gọn gàng trong vài giây; quá hạn thì buộc dừng.
  entry.stopTimer = setTimeout(() => { if (entry.running && entry.kill) entry.kill(); }, 20_000);
  appendActivity(ctx, { kind: 'workflow.clinic.monitor.stop' });
  return res.json({ status: 'ok', message: 'Đang dừng theo dõi.' });
});

router.post('/clinic/monitor/refresh', (req, res) => {
  const ctx = getRuntimePaths(req);
  if (!monitors.get(ctx.sid)?.running) {
    return res.status(409).json({ status: 'error', message: 'Chưa bắt đầu theo dõi.' });
  }
  writeControl(ctx, { refresh: Date.now() });
  return res.json({ status: 'ok' });
});

// Người dùng bấm "Hoàn tất các người bệnh đã sẵn sàng": worker hoàn tất khám những người
// có BHYT, xử trí Cho về, dịch vụ đã xong — mỗi người được kiểm tra lại ngay trước khi thao tác.
router.post('/clinic/monitor/complete', (req, res) => {
  const ctx = getRuntimePaths(req);
  if (!monitors.get(ctx.sid)?.running) {
    return res.status(409).json({ status: 'error', message: 'Chưa bắt đầu theo dõi.' });
  }
  writeControl(ctx, { completeNow: Date.now() });
  appendActivity(ctx, { kind: 'workflow.clinic.monitor.complete_requested' });
  return res.json({ status: 'ok', message: 'Đang hoàn tất các người bệnh đã sẵn sàng.' });
});

// Cân nặng thật do người dùng nhập cho 1 người bệnh (điều dưỡng cân xong gõ vào).
router.post('/clinic/monitor/weight', (req, res) => {
  const ctx = getRuntimePaths(req);
  if (!monitors.get(ctx.sid)?.running) {
    return res.status(409).json({ status: 'error', message: 'Chưa bắt đầu theo dõi.' });
  }
  const khambenhid = String(req.body?.khambenhid || '').trim();
  const kg = Number(String(req.body?.kg ?? '').replace(',', '.'));
  if (!/^[A-Za-z0-9-]{1,64}$/.test(khambenhid)) {
    return res.status(400).json({ status: 'error', message: 'Mã khám bệnh không hợp lệ.' });
  }
  if (!Number.isFinite(kg) || kg < 1 || kg > 300) {
    return res.status(400).json({ status: 'error', message: 'Cân nặng phải từ 1 đến 300 kg.' });
  }
  const current = readJsonSafe(monitorPaths(ctx).control, {}) || {};
  const weights = { ...(current.weights && typeof current.weights === 'object' ? current.weights : {}), [khambenhid]: Math.round(kg * 10) / 10 };
  writeControl(ctx, { weights, refresh: Date.now() });
  appendActivity(ctx, { kind: 'workflow.clinic.monitor.weight', kg: weights[khambenhid] });
  return res.json({ status: 'ok', message: `Đã ghi nhận ${weights[khambenhid]} kg.` });
});

router.get('/clinic/monitor/state', (req, res) => {
  const ctx = getRuntimePaths(req);
  return res.json({ status: 'ok', monitor: monitorStatePayload(ctx) });
});

module.exports = router;
