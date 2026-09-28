// server/routes/clinic.js — phần Phòng khám còn giữ lại (tab Phòng khám đang được làm lại).
//   POST /api/clinic/preview    đọc danh sách Khám bệnh (worker clinic_outpatient.py) — tab Nghỉ ốm dùng.
//   GET  /api/clinic/care-draft đọc bản nháp chăm sóc phòng khám cũ — tab Nghỉ ốm lấy danh sách ngoại trú.
//   /api/clinic/monitor/*       theo dõi Danh sách Khám bệnh liên tục và hoàn tất khám Cho về (worker clinic_monitor.py).
//   POST /api/clinic/care-preview, /care-order-seeds, /input-care
//                               TH3 Nhập viện: tìm, gợi ý diễn biến và nhập chăm sóc (worker clinic_input_care.py).

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
const { issueInputPrecheckToken, validateAndConsumeInputPrecheckToken } = require('../services/input_precheck_tokens');

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

// ── TH3 Nhập viện: nhập chăm sóc cho người bệnh từ Khoa Khám Bệnh (worker clinic_input_care.py) ──

function normalizeClinicCareDate(value = '') {
  const text = String(value || '').trim();
  let m = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (m) return `${m[3].padStart(2, '0')}/${m[2].padStart(2, '0')}/${m[1]}`;
  m = text.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})$/);
  if (!m) return '';
  const year = m[3].length === 2 ? `20${m[3]}` : m[3];
  return `${m[1].padStart(2, '0')}/${m[2].padStart(2, '0')}/${year}`;
}

function clinicCarePrecheckTargets(payload = {}, rows = []) {
  const signatures = (Array.isArray(rows) ? rows : [])
    .filter(r => r && typeof r === 'object'
      && Boolean(r.has_nursing_link || r.nursing_url || r.noitruid)
      && Boolean(String(r.dieu_duong || payload?.clinicSchedule?.nurseName || '').trim()))
    .map(r => {
      const code = String(r.ma_bn || '').replace(/\D+/g, '').trim();
      const time = String(r.care_time_str || r.tg_vao || r.thoi_gian_vao_khoa || '').trim();
      const stayId = String(r.noitruid || '').trim();
      const department = String(r.khoa_chuyen_den || payload.targetDepartment || '').trim().toLowerCase();
      const nurse = String(r.dieu_duong || payload?.clinicSchedule?.nurseName || '').trim();
      return `${code}|${time}|${stayId}|${department}|${nurse}`;
    })
    .filter(Boolean)
    .sort();
  const schedule = payload.clinicSchedule && typeof payload.clinicSchedule === 'object'
    ? payload.clinicSchedule
    : {};
  signatures.push([
    'context',
    String(payload.loginUrl || '').trim(),
    String(payload.careListUrl || '').trim(),
    String(payload.targetDepartment || '').trim().toLowerCase(),
    String(schedule.nurseName || '').trim(),
    String(payload.careContent || '').trim(),
    'per-patient-dien-bien:v1',
    payload.needsVitals ? 'vitals:1' : 'vitals:0',
  ].join('|'));
  return {
    patientIds: signatures.sort(),
    selectedDates: payload.careDate ? [payload.careDate] : [],
  };
}

function sanitizeClinicCareRequest(body = {}, { requireRows = false } = {}) {
  const username         = String(body.username || '').trim();
  const password         = String(body.password || '');
  const loginUrl         = String(body.loginUrl || '').trim();
  const careListUrl      = String(body.careListUrl || body.care_list_url || '').trim();
  const headless         = body.headless !== false;
  const careDate         = normalizeClinicCareDate(body.careDate || body.care_date || '');
  const targetDepartment = 'Khoa Khám Bệnh';
  const clinicSchedule   = sanitizeClinicSchedule(body.clinicSchedule || body.clinic_schedule || {});
  const careContent      = String(body.careContent || '').trim().slice(0, 1000)
    || 'Hoàn tất hồ sơ nhập viện + Kính chuyển Khoa Ngoại Chấn Thương Chỉnh Hình và Thần Kinh + Hồ sơ';
  const dienBien         = String(body.dienBien || '').trim().slice(0, 1500)
    || 'Phòng khám Chấn thương chỉnh hình - Thần kinh nhận\nNgười bệnh tỉnh\nTiếp xúc tốt\nDa niêm hồng\nMạch rõ, chi ấm\nĐau vùng tổn thương\nVận động hạn chế\nTiền sử dị ứng thuốc chưa ghi nhận';
  const needsVitals      = Boolean(body.needsVitals);
  const precheckToken    = String(body.precheck_token || body.precheckToken || '').trim();

  const rawRows = Array.isArray(body.rows) ? body.rows : [];
  const rows = rawRows
    .filter(r => r && typeof r === 'object' && String(r.ma_bn || '').replace(/\D+/g, '').trim())
    .slice(0, 120)
    .map(r => ({
      ma_bn:               String(r.ma_bn || '').replace(/\D+/g, '').trim(),
      ho_ten:              String(r.ho_ten || '').trim().slice(0, 160),
      tg_vao:              String(r.tg_vao || r.thoi_gian_vao_khoa || '').trim().slice(0, 60),
      thoi_gian_vao_khoa:  String(r.thoi_gian_vao_khoa || r.tg_vao || '').trim().slice(0, 60),
      care_time_str:       String(r.care_time_str || '').trim().slice(0, 40),
      care_hour:           Number.isFinite(Number(r.care_hour)) ? Number(r.care_hour) : null,
      ngay_lam:            normalizeClinicCareDate(r.ngay_lam || '') || String(r.ngay_lam || '').trim().slice(0, 20),
      khoa_chuyen_den:     String(r.khoa_chuyen_den || '').trim().slice(0, 200),
      trang_thai:          String(r.trang_thai || '').trim().slice(0, 80),
      has_nursing_link:    Boolean(r.has_nursing_link || r.nursing_url),
      noitruid:            String(r.noitruid || '').trim().slice(0, 120),
      dieu_duong:          String(r.dieu_duong || '').trim().slice(0, 120),
      dien_bien:           String(r.dien_bien || r.dienBien || '').trim().slice(0, 1500),
      saved_for_input:     r.saved_for_input === true || r.savedForInput === true,
      source:              'inpatient_list_clinic_care',
    }));

  // Chăm sóc phòng khám dùng cùng cấu hình EMR với luồng bệnh phòng.
  // Các giá trị dưới đây chỉ là override tùy chọn; worker sẽ tự merge
  // url_login/username/password/url_inpatient_list từ config/config.json.
  if (!careDate) throw new Error('Ngày T/G vào không hợp lệ.');
  if (!targetDepartment) throw new Error('Thiếu Khoa chuyển đến cần lọc.');
  if (requireRows && !rows.length) throw new Error('Chưa có người bệnh phù hợp đã được xem trước.');
  if (requireRows && rows.some(r => !r.saved_for_input)) {
    throw new Error('Còn người bệnh chưa được lưu diễn biến để nhập.');
  }
  if (requireRows && rows.some(r => !r.dien_bien)) {
    throw new Error('Diễn biến của từng người bệnh không được để trống.');
  }

  return {
    username, password, loginUrl, careListUrl, headless,
    careDate, targetDepartment, clinicSchedule,
    careContent, dienBien, needsVitals, rows, precheckToken,
  };
}

router.post('/clinic/care-preview', async (req, res) => {
  const ctx = getRuntimePaths(req);
  let reqPath = '';
  let outPath = '';
  try {
    const payload = sanitizeClinicCareRequest(req.body || {});
    const stamp = `${Date.now()}_clinic_care_preview`;
    reqPath = path.join(ctx.dir, `clinic_care_request_${stamp}.json`);
    outPath = path.join(ctx.dir, `clinic_care_preview_${stamp}.json`);
    writeJsonAtomic(reqPath, payload);

    appendActivity(ctx, {
      kind: 'workflow.clinic.care_preview.start',
      care_date: payload.careDate,
      target_department: payload.targetDepartment,
      username: payload.username ? '[set]' : '',
    });

    const result = await enqueueHeavy(ctx.sid, async () => {
      try {
        return await runScript('clinic_input_care.py', ['preview', reqPath, outPath], {
          runtimeDir: ctx.dir,
          onSpawn: killFn => registerCancel(ctx.sid, killFn),
        });
      } finally {
        unregisterCancel(ctx.sid);
      }
    });
    safeUnlink(reqPath);

    const data = readJsonSafe(outPath, null);
    safeUnlink(outPath);
    if (result.spawnError) return res.status(500).json({ status: 'error', message: `Không khởi động được Python: ${result.spawnError}` });
    if (result.killedByTimeout) return res.status(504).json({ status: 'error', message: 'Timeout khi tìm người bệnh cần nhập chăm sóc.' });
    if (result.code !== 0 || !data || data.status === 'error') {
      return res.status(500).json({ status: 'error', message: data?.message || fmtPyError('Python lỗi khi tìm người bệnh cần chăm sóc.', result) });
    }

    const eligibleRows = (Array.isArray(data.rows) ? data.rows : [])
      .filter(r => Boolean(r?.has_nursing_link || r?.nursing_url || r?.noitruid) && Boolean(String(r?.dieu_duong || '').trim()));
    const precheck = eligibleRows.length
      ? issueInputPrecheckToken(
          ctx,
          'clinic_input_care',
          clinicCarePrecheckTargets(payload, eligibleRows),
          { checked_count: eligibleRows.length },
        )
      : {};

    appendActivity(ctx, {
      kind: 'workflow.clinic.care_preview.success',
      care_date: payload.careDate,
      target_department: payload.targetDepartment,
      rows: Array.isArray(data.rows) ? data.rows.length : 0,
      eligible_rows: eligibleRows.length,
    });
    return res.json({ ...data, ...precheck });
  } catch (err) {
    safeUnlink(reqPath);
    safeUnlink(outPath);
    try { appendActivity(ctx, { kind: 'workflow.clinic.care_preview.error', message: String(err.message || err) }); } catch (_) {}
    return res.status(500).json({ status: 'error', message: String(err.message || err) });
  }
});

function sanitizeClinicCareOrderSeedsRequest(body = {}) {
  const payload = sanitizeClinicCareRequest(body || {});
  const rows = (Array.isArray(body.rows) ? body.rows : [])
    .filter(row => row && typeof row === 'object')
    .slice(0, 120)
    .map(row => ({
      ma_bn: String(row.ma_bn || '').replace(/\D+/g, '').trim(),
      ho_ten: String(row.ho_ten || '').trim().slice(0, 160),
      tg_vao: String(row.tg_vao || row.thoi_gian_vao_khoa || '').trim().slice(0, 60),
      care_time_str: String(row.care_time_str || row.tg_vao || '').trim().slice(0, 40),
      noitruid: String(row.noitruid || '').trim().slice(0, 120),
      khoa_chuyen_den: String(row.khoa_chuyen_den || payload.targetDepartment || '').trim().slice(0, 200),
      client_key: String(row.client_key || '').trim().slice(0, 240),
    }))
    .filter(row => row.ma_bn);
  if (!rows.length) throw new Error('Không có người bệnh để lấy y lệnh đầu tiên.');
  return { ...payload, rows };
}

router.post('/clinic/care-order-seeds', async (req, res) => {
  const ctx = getRuntimePaths(req);
  let reqPath = '';
  let outPath = '';
  try {
    const payload = sanitizeClinicCareOrderSeedsRequest(req.body || {});
    const stamp = `${Date.now()}_clinic_care_order_seeds`;
    reqPath = path.join(ctx.dir, `clinic_care_order_seeds_${stamp}.json`);
    outPath = path.join(ctx.dir, `clinic_care_order_seeds_${stamp}.out.json`);
    writeJsonAtomic(reqPath, payload);

    appendActivity(ctx, {
      kind: 'workflow.clinic.care_order_seeds.start',
      care_date: payload.careDate,
      target_department: payload.targetDepartment,
      rows: payload.rows.length,
    });

    const result = await enqueueHeavy(ctx.sid, async () => {
      try {
        return await runScript('clinic_input_care.py', ['order-seeds', reqPath, outPath], {
          runtimeDir: ctx.dir,
          onSpawn: killFn => registerCancel(ctx.sid, killFn),
        });
      } finally {
        unregisterCancel(ctx.sid);
      }
    });
    safeUnlink(reqPath);

    const data = readJsonSafe(outPath, null);
    safeUnlink(outPath);
    if (result.spawnError) return res.status(500).json({ status: 'error', message: `Không khởi động được Python: ${result.spawnError}` });
    if (result.killedByTimeout) return res.status(504).json({ status: 'error', message: 'Timeout khi lấy y lệnh đầu tiên cho danh sách.' });
    if (!data) return res.status(500).json({ status: 'error', message: fmtPyError('Python không trả kết quả lấy y lệnh đầu tiên.', result) });

    appendActivity(ctx, {
      kind: 'workflow.clinic.care_order_seeds.finish',
      status: data.status || 'ok',
      succeeded: Number(data.succeeded || 0),
      failed: Number(data.failed || 0),
    });
    return res.json(data);
  } catch (err) {
    safeUnlink(reqPath);
    safeUnlink(outPath);
    try { appendActivity(ctx, { kind: 'workflow.clinic.care_order_seeds.error', message: String(err.message || err) }); } catch (_) {}
    return res.status(500).json({ status: 'error', message: String(err.message || err) });
  }
});

router.post('/clinic/input-care', async (req, res) => {
  const ctx = getRuntimePaths(req);
  let reqPath = '';
  const resultPath = path.join(ctx.dir, 'clinic_input_care_result.json');
  try {
    const payload = sanitizeClinicCareRequest(req.body || {}, { requireRows: true });
    const tokenCheck = validateAndConsumeInputPrecheckToken(
      ctx,
      'clinic_input_care',
      { ...clinicCarePrecheckTargets(payload, payload.rows), precheck_token: payload.precheckToken },
    );
    if (!tokenCheck.ok) {
      appendActivity(ctx, {
        kind: 'workflow.clinic.input_care.needs_precheck',
        rows: payload.rows.length,
        care_date: payload.careDate,
        message: tokenCheck.message,
      });
      return res.status(tokenCheck.status || 428).json({ status: 'needs_precheck', message: tokenCheck.message });
    }

    const stamp = `${Date.now()}_clinic_care_input`;
    reqPath = path.join(ctx.dir, `clinic_care_request_${stamp}.json`);
    const workerPayload = { ...payload };
    delete workerPayload.precheckToken;
    writeJsonAtomic(reqPath, workerPayload);
    safeUnlink(resultPath);

    appendActivity(ctx, {
      kind: 'workflow.clinic.input_care.start',
      rows: payload.rows.length,
      care_date: payload.careDate,
      target_department: payload.targetDepartment,
      username: payload.username ? '[set]' : '',
      needsVitals: payload.needsVitals,
    });

    const result = await enqueueHeavy(ctx.sid, async () => {
      try {
        return await runScript('clinic_input_care.py', ['input', reqPath, resultPath], {
          runtimeDir: ctx.dir,
          onSpawn: killFn => registerCancel(ctx.sid, killFn),
        });
      } finally {
        unregisterCancel(ctx.sid);
      }
    });
    safeUnlink(reqPath);

    const pyResult = readJsonSafe(resultPath, null);
    safeUnlink(resultPath);
    if (result.spawnError) return res.status(500).json({ status: 'error', message: `Không khởi động được Python: ${result.spawnError}` });
    if (result.killedByTimeout) return res.status(504).json({ status: 'error', message: 'Timeout khi nhập chăm sóc phòng khám.' });
    if (result.code !== 0 && result.code !== 2 && !pyResult) {
      return res.status(500).json({ status: 'error', message: fmtPyError('Python lỗi khi nhập chăm sóc phòng khám.', result) });
    }
    if (!pyResult) return res.status(500).json({ status: 'error', message: 'Worker không tạo được file kết quả nhập chăm sóc.' });

    const failed = pyResult?.failed && typeof pyResult.failed === 'object' ? Object.keys(pyResult.failed).length : 0;
    const succeeded = Array.isArray(pyResult?.succeeded) ? pyResult.succeeded.length : 0;
    const skipped = Number(pyResult?.summary?.skipped_count || 0);
    const status = failed ? (succeeded ? 'partial' : 'error') : 'ok';
    const message = status === 'ok'
      ? `Đã nhập chăm sóc: ${succeeded} người bệnh.${skipped ? ` Bỏ qua an toàn: ${skipped}.` : ''}`
      : `Nhập chăm sóc: ${succeeded} thành công, ${failed} lỗi.${skipped ? ` Bỏ qua an toàn: ${skipped}.` : ''}`;

    appendActivity(ctx, { kind: 'workflow.clinic.input_care.finish', status, succeeded, failed, skipped });
    return res.status(status === 'error' ? 500 : 200).json({ status, message, result: pyResult, succeeded, failed, skipped });
  } catch (err) {
    safeUnlink(reqPath);
    safeUnlink(resultPath);
    try { appendActivity(ctx, { kind: 'workflow.clinic.input_care.error', message: String(err.message || err) }); } catch (_) {}
    return res.status(500).json({ status: 'error', message: String(err.message || err) });
  }
});

module.exports = router;
