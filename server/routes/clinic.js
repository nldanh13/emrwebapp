// server/routes/clinic.js — phần Phòng khám còn giữ lại (tab Phòng khám đang được làm lại).
//   POST /api/clinic/preview    đọc danh sách Khám bệnh (worker clinic_outpatient.py) — tab Nghỉ ốm dùng.
//   GET  /api/clinic/care-draft đọc bản nháp chăm sóc phòng khám cũ — tab Nghỉ ốm lấy danh sách ngoại trú.
//   /api/clinic/monitor/*       theo dõi Danh sách Khám bệnh liên tục, hoàn tất khám Cho về và làm thủ thuật
//                               ngay khi có chỉ định (worker clinic_monitor.py).
//   GET/POST /api/clinic/sick-leave  người bệnh xin nghỉ ốm (đánh dấu ở Phòng khám, nhập cổng ở tab Nghỉ ốm).
//   POST /api/clinic/care-preview, /care-order-seeds, /input-care
//                               TH3 Nhập viện: tìm, gợi ý diễn biến và nhập chăm sóc (worker clinic_input_care.py).
//   GET/POST /api/clinic/admission-care  lưu danh sách đã tìm và nội dung 2 phiếu đã sửa, theo ngày T/G vào.

'use strict';

const router = require('express').Router();
const fs = require('fs');
const path = require('path');

const { getRuntimePaths } = require('../services/session');
const { watchScreen } = require('../services/screen_watch');
const { enqueueHeavy, registerCancel, unregisterCancel } = require('../services/task_queue');
const { runPython, runScript, fmtPyError } = require('../services/python_runner');
const { WORKER_DIR, CONFIG_PATH } = require('../constants');
const { appendActivity } = require('../services/activity_logger');
const { writeJsonAtomic, readJsonSafe, safeUnlink, safeFilePart } = require('../utils/file');
const { issueInputPrecheckToken, validateAndConsumeInputPrecheckToken } = require('../services/input_precheck_tokens');
const { syncClinicState, attachHistory } = require('../services/clinic_patient_sync');
const { readNurseEmrAccounts, findDoctorAccount } = require('../utils/nurse_emr_accounts');
const { readConfig, clinicNamesForDate, toIsoDate } = require('../utils/nurse_config');
const { markEmrLoginInUse, releaseEmrLogin } = require('../services/emr_logins_in_use');

// Đăng nhập EMR ở phòng khám bằng tài khoản bác sĩ (Thiết lập tài khoản → Tài khoản EMR → Bác sĩ
// phòng khám) thay cho gõ tài khoản/mật khẩu. Giao diện gửi account_name:
//   - '@lich': bác sĩ xếp trong Lịch phòng khám của ngày làm việc (người đầu tiên có tài khoản);
//   - tên một bác sĩ: đúng người đó.
// Máy chủ điền tài khoản và mật khẩu; mật khẩu không về trình duyệt.
const SCHEDULED_DOCTOR = '@lich';

function localTodayIso() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Bác sĩ theo lịch của ngày: { date, names, account_name } (account_name '' nếu chưa ai có tài khoản). */
function scheduledClinicDoctor(req, dateValue) {
  const date = toIsoDate(dateValue) || localTodayIso();
  let names = [];
  try { names = clinicNamesForDate(readConfig(req).clinic_nurse_schedule || {}, date, 'doctor'); } catch (_) { /* chưa có lịch */ }
  const accountName = names.find(n => findDoctorAccount(n)) || '';
  return { date, names, account_name: accountName };
}

function withDoctorAccount(body = {}, req = null, dateValue = '') {
  let accountName = String(body.account_name || body.accountName || '').trim();
  if (!accountName) return body;
  if (accountName === SCHEDULED_DOCTOR) {
    const sched = scheduledClinicDoctor(req, dateValue || body.careDate || body.care_date);
    const [y, m, d] = sched.date.split('-');
    if (!sched.names.length) throw new Error(`Lịch phòng khám ngày ${d}/${m}/${y} chưa xếp bác sĩ. Xếp ở tab Lịch làm việc, hoặc chọn một bác sĩ cụ thể.`);
    if (!sched.account_name) throw new Error(`Bác sĩ theo lịch ngày ${d}/${m}/${y} (${sched.names.join(', ')}) chưa có tài khoản EMR. Khai ở Thiết lập tài khoản → Tài khoản EMR → Bác sĩ phòng khám.`);
    accountName = sched.account_name;
  }
  const acc = findDoctorAccount(accountName);
  if (!acc) throw new Error(`Bác sĩ "${accountName}" chưa có đủ tài khoản và mật khẩu EMR. Khai ở Thiết lập tài khoản → Tài khoản EMR → Bác sĩ phòng khám.`);
  return { ...body, username: acc.username, password: acc.password, account_doctor: accountName };
}

// Danh sách bác sĩ để chọn khi đăng nhập phòng khám (tên, tên đăng nhập, không có mật khẩu), kèm bác
// sĩ theo lịch hôm nay để giao diện ghi rõ "theo lịch" là ai.
router.get('/clinic/doctor-accounts', (req, res) => {
  const doctors = readNurseEmrAccounts()
    .filter(r => r.kind === 'doctor')
    .map(r => ({ name: r.name, emr_username: r.emr_username, ready: Boolean(r.emr_username && r.emr_password) }));
  return res.json({ status: 'ok', doctors, scheduled_today: scheduledClinicDoctor(req) });
});

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

// Địa chỉ EMR: đã khai sẵn trong config/config.json (url_login, dùng chung với các màn bệnh phòng),
// nên giao diện không phải hỏi. URL Danh sách Khám bệnh không cần: worker tự dựng từ trang sau đăng
// nhập (wpid=khambenhdanhsachdraw, giữ mã phiên). Người dùng vẫn có thể gửi URL riêng để thay.
const HTTP_URL_RE = /^https?:\/\//i;

function emrUrlDefaults(cfg = readJsonSafe(CONFIG_PATH, {}) || {}) {
  const loginUrl = String(cfg.clinic_login_url || cfg.url_login || '').trim();
  const listUrl = String(cfg.clinic_list_url || process.env.EMR_CLINIC_LIST_URL || '').trim();
  return { loginUrl: HTTP_URL_RE.test(loginUrl) ? loginUrl : '', listUrl: HTTP_URL_RE.test(listUrl) ? listUrl : '' };
}

function resolveEmrUrls(body = {}, defaults = emrUrlDefaults()) {
  const loginUrl = String(body.loginUrl || '').trim().slice(0, 500) || defaults.loginUrl;
  const listUrl = String(body.listUrl || '').trim().slice(0, 1000) || defaults.listUrl;
  if (!loginUrl) throw new Error('Chưa biết địa chỉ đăng nhập EMR. Khai "url_login" trong config/config.json (như các màn bệnh phòng) rồi khởi động lại máy chủ, hoặc nhập ở Thiết lập.');
  if (!HTTP_URL_RE.test(loginUrl)) throw new Error('Địa chỉ đăng nhập EMR không hợp lệ (phải bắt đầu bằng http:// hoặc https://).');
  if (listUrl && !HTTP_URL_RE.test(listUrl)) throw new Error('URL Danh sách Khám bệnh không hợp lệ (phải bắt đầu bằng http:// hoặc https://).');
  return { loginUrl, listUrl };
}

router.get('/clinic/emr-defaults', (req, res) => {
  const d = emrUrlDefaults();
  return res.json({ status: 'ok', has_login_url: Boolean(d.loginUrl) });
});

const CLINIC_PREVIEW_MODES = new Set(['today', 'missed', 'date_range']);

function sanitizeClinicRequest(body = {}) {
  const rawMode = String(body.mode || 'missed').trim();
  const mode = CLINIC_PREVIEW_MODES.has(rawMode) ? rawMode : 'missed';
  const username = String(body.username || '').trim();
  const password = String(body.password || '');
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
  const { loginUrl, listUrl } = resolveEmrUrls(body);
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
    const payload = sanitizeClinicRequest(withDoctorAccount(req.body || {}, req));
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
// chạy liên tục hàng giờ; chỉ ghi EMR khi người dùng bấm nút. Mật khẩu chỉ nằm trong file
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

const ISO_DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
// Ngày đã qua người dùng chọn để xem lại Danh sách Khám bệnh (yyyy-mm-dd); rỗng = theo dõi hôm nay.
function pastListDate(value, today = localTodayIso()) {
  const day = String(value || '').trim();
  if (!ISO_DAY_RE.test(day) || Number.isNaN(Date.parse(day))) return '';
  return day < today ? day : '';
}

function sanitizeMonitorRequest(body = {}) {
  const username = String(body.username || '').trim().slice(0, 120);
  const password = String(body.password || '');
  const interval = Number.parseInt(body.intervalMinutes, 10);
  if (!username) throw new Error('Thiếu tài khoản EMR.');
  if (!password) throw new Error('Thiếu mật khẩu EMR.');
  const { loginUrl, listUrl } = resolveEmrUrls(body);
  return {
    username, password, loginUrl, listUrl,
    intervalMinutes: Number.isFinite(interval) ? Math.min(Math.max(interval, 1), 60) : 3,
    headless: body.headless !== false,
    autoTasks: body.autoTasks === true,
    listDate: pastListDate(body.listDate),
  };
}

// Gộp vào file điều khiển (không ghi đè) để lệnh làm mới không xoá cân nặng đã nhập.
function writeControl(ctx, data) {
  const file = monitorPaths(ctx).control;
  const current = readJsonSafe(file, {}) || {};
  writeJsonAtomic(file, { ...current, ...data, at: Date.now() });
}

// Đang xem lại ngày cũ thì chỉ đọc: chặn các lệnh thao tác trên EMR (worker cũng bỏ qua).
function rejectIfPastDay(ctx, res) {
  const day = pastListDate((readJsonSafe(monitorPaths(ctx).control, {}) || {}).listDate);
  if (!day) return false;
  const [y, m, d] = day.split('-');
  res.status(409).json({
    status: 'error',
    message: `Đang xem lại danh sách ngày ${d}/${m}/${y} nên chỉ đọc, không thao tác trên EMR. Chọn "Hôm nay" ở ô Ngày danh sách để làm việc.`,
  });
  return true;
}

// Chép từng lượt khám vào Kho người bệnh (bỏ qua nếu trạng thái chưa đổi từ lần chép trước).
function syncMonitorToPatientDb(ctx, state = readJsonSafe(monitorPaths(ctx).state, null)) {
  try {
    return syncClinicState(state, { sid: ctx.sid });
  } catch (err) {
    console.warn(`[clinic] Không chép được vào Kho người bệnh: ${err.message}`);
    return { ok: false, message: err.message };
  }
}

const PATIENT_DB_SYNC_MS = 60_000;

function monitorStatePayload(ctx) {
  const entry = monitors.get(ctx.sid);
  const state = readJsonSafe(monitorPaths(ctx).state, null);
  if (state) syncMonitorToPatientDb(ctx, state);
  const running = Boolean(entry?.running);
  const payload = state && typeof state === 'object' ? state : { status: 'idle', rows: [], summary: null };
  if (!running && ['starting', 'running', 'error'].includes(payload.status)) payload.status = 'stopped';
  let withHistory = payload;
  try {
    withHistory = attachHistory(payload, { sid: ctx.sid });
  } catch (err) {
    console.warn(`[clinic] Không đọc được lịch sử từ Kho người bệnh: ${err.message}`);
  }
  return { ...withHistory, running, exit_message: entry?.exitMessage || '' };
}

router.post('/clinic/monitor/start', async (req, res) => {
  const ctx = getRuntimePaths(req);
  let payload;
  try {
    payload = sanitizeMonitorRequest(withDoctorAccount(req.body || {}, req));
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
  writeJsonAtomic(paths.control, { at: Date.now(), listDate: payload.listDate });
  syncMonitorToPatientDb(ctx); // lần theo dõi trước: chép nốt trước khi xoá file trạng thái
  safeUnlink(paths.state);

  const entry = { running: true, kill: null, exitMessage: '' };
  monitors.set(ctx.sid, entry);
  markEmrLoginInUse(`clinic-monitor:${ctx.sid}`, payload.username, 'Đang dùng ở Phòng khám (đang theo dõi Danh sách Khám bệnh).');
  // Không cần mở màn hình Phòng khám: máy chủ tự chép lịch sử khám mỗi phút.
  entry.syncTimer = setInterval(() => syncMonitorToPatientDb(ctx), PATIENT_DB_SYNC_MS);
  if (typeof entry.syncTimer.unref === 'function') entry.syncTimer.unref();
  appendActivity(ctx, { kind: 'workflow.clinic.monitor.start', interval_minutes: payload.intervalMinutes, headless: payload.headless });

  runPython(['-u', path.join(WORKER_DIR, 'clinic_monitor.py'), 'monitor', paths.request, paths.state, paths.control], {
    timeoutMs: MONITOR_MAX_RUNTIME_MS,
    runtimeDir: ctx.dir,
    onSpawn: (killFn) => { entry.kill = killFn; },
  }).then((result) => {
    entry.running = false;
    releaseEmrLogin(`clinic-monitor:${ctx.sid}`);
    if (entry.stopTimer) clearTimeout(entry.stopTimer);
    if (entry.syncTimer) clearInterval(entry.syncTimer);
    syncMonitorToPatientDb(ctx);
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
  if (rejectIfPastDay(ctx, res)) return undefined;
  // Cuối ngày: hoàn tất cả người chưa có thuốc và chuyển khám chuyên khoa (worker liệt kê ai còn treo).
  const endOfDay = (req.body || {}).endOfDay === true;
  writeControl(ctx, { completeNow: Date.now(), endOfDay });
  appendActivity(ctx, { kind: 'workflow.clinic.monitor.complete_requested', end_of_day: endOfDay });
  return res.json({
    status: 'ok',
    message: endOfDay ? 'Đang hoàn tất cuối ngày mọi lượt khám còn lại.' : 'Đang hoàn tất các người bệnh đã sẵn sàng.',
  });
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

// TH6 Điều trị ngoại trú: nhập khoa, kết thúc mổ, tổng kết ra khoa, kết thúc điều trị cho người bệnh
// BHYT xử trí Điều trị ngoại trú — chỉ chạy khi người dùng bấm nút.
router.post('/clinic/monitor/ngoaitru', (req, res) => {
  const ctx = getRuntimePaths(req);
  if (!monitors.get(ctx.sid)?.running) {
    return res.status(409).json({ status: 'error', message: 'Chưa bắt đầu theo dõi.' });
  }
  if (rejectIfPastDay(ctx, res)) return undefined;
  writeControl(ctx, { ngoaitruNow: Date.now() });
  appendActivity(ctx, { kind: 'workflow.clinic.monitor.ngoaitru_requested' });
  return res.json({ status: 'ok', message: 'Đang làm điều trị ngoại trú cho các người bệnh.' });
});

// Việc cần làm: nhập ngay các thủ thuật đã có chỉ định (không chờ hoàn tất khám).
router.post('/clinic/monitor/tasks', (req, res) => {
  const ctx = getRuntimePaths(req);
  if (!monitors.get(ctx.sid)?.running) {
    return res.status(409).json({ status: 'error', message: 'Chưa bắt đầu theo dõi.' });
  }
  if (rejectIfPastDay(ctx, res)) return undefined;
  writeControl(ctx, { tasksNow: Date.now() });
  appendActivity(ctx, { kind: 'workflow.clinic.monitor.tasks_requested' });
  return res.json({ status: 'ok', message: 'Đang nhập các thủ thuật đã có chỉ định.' });
});

// Bật/tắt "Tự hoàn thành khi có chỉ định": worker nhập thủ thuật và soạn nháp SBBHC mỗi chu kỳ.
router.post('/clinic/monitor/auto-tasks', (req, res) => {
  const ctx = getRuntimePaths(req);
  if (!monitors.get(ctx.sid)?.running) {
    return res.status(409).json({ status: 'error', message: 'Chưa bắt đầu theo dõi.' });
  }
  const enabled = req.body?.enabled === true;
  writeControl(ctx, { autoTasks: enabled, refresh: Date.now() });
  appendActivity(ctx, { kind: 'workflow.clinic.monitor.auto_tasks', enabled });
  return res.json({
    status: 'ok',
    message: enabled ? 'Đã bật tự hoàn thành thủ thuật khi có chỉ định.' : 'Đã tắt tự hoàn thành, chỉ làm khi bấm nút.',
  });
});

// Đổi ngày của Danh sách Khám bệnh đang theo dõi: rỗng/hôm nay = theo dõi hôm nay; ngày đã qua = xem lại (chỉ đọc).
router.post('/clinic/monitor/list-date', (req, res) => {
  const ctx = getRuntimePaths(req);
  if (!monitors.get(ctx.sid)?.running) {
    return res.status(409).json({ status: 'error', message: 'Chưa bắt đầu theo dõi.' });
  }
  const raw = String(req.body?.date || '').trim();
  if (raw && !ISO_DAY_RE.test(raw)) {
    return res.status(400).json({ status: 'error', message: 'Ngày không hợp lệ. Chọn lại ngày trong ô Ngày danh sách.' });
  }
  if (raw > localTodayIso()) {
    return res.status(400).json({ status: 'error', message: 'Chưa tới ngày này nên chưa có danh sách. Chọn hôm nay hoặc một ngày đã qua.' });
  }
  const listDate = pastListDate(raw);
  writeControl(ctx, { listDate, refresh: Date.now() });
  appendActivity(ctx, { kind: 'workflow.clinic.monitor.list_date', list_date: listDate || 'today' });
  const [y, m, d] = listDate.split('-');
  return res.json({
    status: 'ok',
    list_date: listDate,
    message: listDate ? `Đang đọc danh sách ngày ${d}/${m}/${y} (chỉ xem, không thao tác trên EMR).` : 'Đang đọc danh sách hôm nay.',
  });
});

// TH4 Sổ biên bản hội chẩn: bước 1 soạn nháp (worker chỉ đọc màn khám), bước 2 lập theo nháp đã duyệt.
const BBHC_FIELDS = ['ThoiGianHoiChan', 'HopTai', 'ThuKy', 'YeuCau', 'TomTat', 'TinhTrang', 'ChanDoanTuyenDuoi',
  'TomTatBenhAn', 'NguyenNhan', 'HuongDieuTri', 'ChamSoc', 'KetLuan'];

function sanitizeBbhcDrafts(raw) {
  const out = {};
  const entries = raw && typeof raw === 'object' ? Object.entries(raw) : [];
  if (!entries.length) throw new Error('Chưa có SBBHC nào được chọn để lập.');
  if (entries.length > 60) throw new Error('Quá nhiều người bệnh trong một lần lập SBBHC.');
  for (const [khambenhid, drafts] of entries) {
    if (!/^[A-Za-z0-9-]{1,64}$/.test(khambenhid)) throw new Error('Mã khám bệnh không hợp lệ.');
    if (!Array.isArray(drafts) || !drafts.length || drafts.length > 5) throw new Error('Danh sách SBBHC của người bệnh không hợp lệ.');
    out[khambenhid] = drafts.map((d) => {
      const fields = {};
      for (const key of BBHC_FIELDS) fields[key] = String(d?.fields?.[key] ?? '').slice(0, 4000);
      return { key: String(d?.key ?? '').slice(0, 20), label: String(d?.label ?? '').slice(0, 300), fields };
    });
  }
  return out;
}

router.post('/clinic/monitor/bbhc/prepare', (req, res) => {
  const ctx = getRuntimePaths(req);
  if (!monitors.get(ctx.sid)?.running) {
    return res.status(409).json({ status: 'error', message: 'Chưa bắt đầu theo dõi.' });
  }
  if (rejectIfPastDay(ctx, res)) return undefined;
  writeControl(ctx, { bbhcPrepare: Date.now() });
  appendActivity(ctx, { kind: 'workflow.clinic.monitor.bbhc_prepare' });
  return res.json({ status: 'ok', message: 'Đang soạn nháp Sổ biên bản hội chẩn.' });
});

router.post('/clinic/monitor/bbhc/run', (req, res) => {
  const ctx = getRuntimePaths(req);
  if (!monitors.get(ctx.sid)?.running) {
    return res.status(409).json({ status: 'error', message: 'Chưa bắt đầu theo dõi.' });
  }
  if (rejectIfPastDay(ctx, res)) return undefined;
  let drafts;
  try {
    drafts = sanitizeBbhcDrafts(req.body?.drafts);
  } catch (err) {
    return res.status(400).json({ status: 'error', message: String(err.message || err) });
  }
  const count = Object.values(drafts).reduce((n, list) => n + list.length, 0);
  writeControl(ctx, { bbhcRun: Date.now(), bbhcDrafts: drafts });
  appendActivity(ctx, { kind: 'workflow.clinic.monitor.bbhc_run', patients: Object.keys(drafts).length, forms: count });
  return res.json({ status: 'ok', message: `Đang lập ${count} Sổ biên bản hội chẩn.` });
});

// In tường trình thủ thuật / phẫu thuật BHYT trong ngày đang xem (chỉ đọc EMR, xem lại ngày cũ cũng in được).
router.post('/clinic/monitor/tuongtrinh/run', (req, res) => {
  const ctx = getRuntimePaths(req);
  if (!monitors.get(ctx.sid)?.running) {
    return res.status(409).json({ status: 'error', message: 'Chưa bắt đầu theo dõi.' });
  }
  writeControl(ctx, { printReportsNow: Date.now() });
  appendActivity(ctx, { kind: 'workflow.clinic.monitor.tuongtrinh_print' });
  return res.json({ status: 'ok', message: 'Đang lấy phiếu tường trình thủ thuật, phẫu thuật BHYT trên EMR.' });
});

router.get('/clinic/monitor/tuongtrinh/pdf', (req, res) => {
  const ctx = getRuntimePaths(req);
  const state = readJsonSafe(monitorPaths(ctx).state, null);
  const file = String(state?.tuongtrinh_pdf?.file || '');
  const missing = { status: 'error', message: 'Chưa có file in tường trình. Bấm "In tường trình BHYT" trước.' };
  if (!/^clinic_tuongtrinh_\d{8}\.pdf$/.test(file)) return res.status(404).json(missing);
  const full = path.join(ctx.dir, file);
  if (!fs.existsSync(full)) return res.status(404).json(missing);
  return res.download(full, file, { dotfiles: 'allow' });
});

router.get('/clinic/monitor/bbhc/pdf', (req, res) => {
  const ctx = getRuntimePaths(req);
  const state = readJsonSafe(monitorPaths(ctx).state, null);
  const file = String(state?.bbhc_pdf?.file || '');
  if (!/^clinic_bbhc_\d{8}\.pdf$/.test(file)) return res.status(404).json({ status: 'error', message: 'Chưa có file in SBBHC.' });
  const full = path.join(ctx.dir, file);
  if (!fs.existsSync(full)) return res.status(404).json({ status: 'error', message: 'Chưa có file in SBBHC.' });
  return res.download(full, file, { dotfiles: 'allow' });
});

// Nhật ký quét của worker (clinic_trace_YYYYMMDD.jsonl, không họ tên / mã BN): ngày yêu cầu, mặc định file mới nhất.
const TRACE_FILE_RE = /^clinic_trace_(\d{8})\.jsonl$/;
function clinicTraceFile(dir, day = '') {
  const want = String(day || '').replace(/-/g, '');
  let names = [];
  try { names = fs.readdirSync(dir).filter(n => TRACE_FILE_RE.test(n)).sort(); } catch (_) { names = []; }
  if (want) return names.includes(`clinic_trace_${want}.jsonl`) ? `clinic_trace_${want}.jsonl` : '';
  return names[names.length - 1] || '';
}

router.get('/clinic/monitor/trace', (req, res) => {
  const ctx = getRuntimePaths(req);
  const file = clinicTraceFile(ctx.dir, req.query?.day);
  if (!file) {
    return res.status(404).json({ status: 'error', message: 'Chưa có nhật ký quét. Bắt đầu theo dõi Phòng khám, chờ vài chu kỳ rồi tải lại.' });
  }
  return res.download(path.join(ctx.dir, file), file, { dotfiles: 'allow' });
});

router.get('/clinic/monitor/state', (req, res) => {
  const ctx = getRuntimePaths(req);
  watchScreen({
    sid: ctx.sid, key: 'clinic-monitor', files: [monitorPaths(ctx).state],
    extra: () => { const e = monitors.get(ctx.sid); return `${e?.running ? 1 : 0}|${e?.exitMessage || ''}`; },
  });
  return res.json({ status: 'ok', monitor: monitorStatePayload(ctx) });
});

// ── Người bệnh xin nghỉ ốm (đánh dấu ở Phòng khám, cuối buổi nhập lên cổng BHXH ở tab Nghỉ ốm) ──
// Giấy chứng nhận nghỉ việc là form riêng trên EMR, danh sách khám không cho biết ai xin nghỉ,
// nên điều dưỡng đánh dấu tay. Thêm/bỏ từng người (không ghi đè cả danh sách) để hai máy cùng
// đánh dấu không mất của nhau.
const CLINIC_SICK_LEAVE_FILE = 'clinic_sick_leave.json';
const SICK_LEAVE_KEEP_DAYS = 45;

function clinicSickLeavePath(ctx) {
  return path.join(ctx.dir, CLINIC_SICK_LEAVE_FILE);
}

function readClinicSickLeave(ctx) {
  const data = readJsonSafe(clinicSickLeavePath(ctx), null);
  return data && typeof data.entries === 'object' && data.entries ? data.entries : {};
}

function sanitizeSickLeavePatient(raw = {}) {
  const text = (v, n) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
  const patient = {
    khambenhid: text(raw.khambenhid, 64),
    ma_bn: text(raw.ma_bn, 32),
    ho_ten: text(raw.ho_ten, 120),
    nam_sinh: text(raw.nam_sinh, 10),
    thoi_gian: text(raw.thoi_gian, 32),
    chan_doan: text(raw.chan_doan, 300),
  };
  if (!patient.ma_bn || !patient.ho_ten) throw new Error('Thiếu mã hoặc họ tên người bệnh.');
  if (patient.khambenhid && !/^[A-Za-z0-9-]{1,64}$/.test(patient.khambenhid)) throw new Error('Mã khám bệnh không hợp lệ.');
  const day = patient.thoi_gian.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  patient.ngay = day ? `${day[3]}-${day[2].padStart(2, '0')}-${day[1].padStart(2, '0')}` : localTodayIso();
  patient.key = patient.khambenhid || `${patient.ma_bn}:${patient.ngay}`;
  return patient;
}

function pruneSickLeave(entries) {
  const cutoff = new Date(Date.now() - SICK_LEAVE_KEEP_DAYS * 86_400_000).toISOString().slice(0, 10);
  return Object.fromEntries(Object.entries(entries).filter(([, e]) => String(e?.ngay || '') >= cutoff));
}

router.get('/clinic/sick-leave', (req, res) => {
  const ctx = getRuntimePaths(req);
  return res.json({ status: 'ok', entries: Object.values(readClinicSickLeave(ctx)) });
});

router.post('/clinic/sick-leave', (req, res) => {
  const ctx = getRuntimePaths(req);
  const action = req.body?.action === 'remove' ? 'remove' : 'add';
  let patient;
  try {
    patient = sanitizeSickLeavePatient(req.body?.patient);
  } catch (err) {
    return res.status(400).json({ status: 'error', message: String(err.message || err) });
  }
  const entries = readClinicSickLeave(ctx);
  if (action === 'remove') delete entries[patient.key];
  else entries[patient.key] = { ...(entries[patient.key] || {}), ...patient, added_at: entries[patient.key]?.added_at || new Date().toISOString() };
  writeJsonAtomic(clinicSickLeavePath(ctx), { entries: pruneSickLeave(entries), updated_at: new Date().toISOString() });
  appendActivity(ctx, { kind: `workflow.clinic.sick_leave.${action}` });
  return res.json({ status: 'ok', entries: Object.values(readClinicSickLeave(ctx)) });
});

// ── TH3 Nhập viện: nhập chăm sóc cho người bệnh từ Khoa Khám Bệnh (worker clinic_input_care.py) ──

// Danh sách đã tìm và nội dung 2 phiếu người dùng đã sửa, lưu theo ngày T/G vào để lần sau mở lại
// (chuyển tab, tải lại trang, khởi động lại máy chủ) không phải quét và sửa lại từ đầu.
const CLINIC_ADMISSION_CARE_FILE = 'clinic_admission_care.json';
const ADMISSION_CARE_KEEP_DAYS = 14;

function clinicAdmissionCarePath(ctx) {
  return path.join(ctx.dir, CLINIC_ADMISSION_CARE_FILE);
}

function readAdmissionCare(ctx) {
  const data = readJsonSafe(clinicAdmissionCarePath(ctx), null);
  return data && data.days && typeof data.days === 'object' ? data.days : {};
}

function sanitizeAdmissionCareRows(rows) {
  const text = (v, n) => String(v ?? '').trim().slice(0, n);
  return (Array.isArray(rows) ? rows : [])
    .filter(r => r && typeof r === 'object' && text(r.ma_bn, 32).replace(/\D+/g, ''))
    .slice(0, 120)
    .map(r => ({
      ma_bn: text(r.ma_bn, 32).replace(/\D+/g, ''),
      ho_ten: text(r.ho_ten, 160),
      care_time_str: text(r.care_time_str, 40),
      tg_vao: text(r.tg_vao, 60),
      noitruid: text(r.noitruid, 120),
      khoa_chuyen_den: text(r.khoa_chuyen_den, 200),
      dieu_duong: text(r.dieu_duong, 120),
      nguoi_nhan: text(r.nguoi_nhan, 120),
      thieu_tai_khoan: (Array.isArray(r.thieu_tai_khoan) ? r.thieu_tai_khoan : []).slice(0, 4).map(n => text(n, 120)),
      can_input: r.can_input === true,
      has_nursing_link: r.has_nursing_link === true,
      dien_bien: text(r.dien_bien, 1500),
      cham_soc: text(r.cham_soc, 1000),
      dien_bien_khoa: text(r.dien_bien_khoa, 1500),
      cham_soc_khoa: text(r.cham_soc_khoa, 1000),
      khoa_time_str: text(r.khoa_time_str, 40),
      vitals: Object.fromEntries(['mach', 'nhiet_do', 'huyet_ap', 'nhip_tho'].map(k => [k, text(r.vitals?.[k], 12)])),
      sheets_done: r.sheets_done && typeof r.sheets_done === 'object'
        ? { kham: r.sheets_done.kham === true, khoa: r.sheets_done.khoa === true } : null,
      skip: r.skip === true,
      pain_note: text(r.pain_note, 300),
    }));
}

function pruneAdmissionCare(days) {
  const cutoff = new Date(Date.now() - ADMISSION_CARE_KEEP_DAYS * 86_400_000).toISOString().slice(0, 10);
  return Object.fromEntries(Object.entries(days || {}).filter(([day]) => ISO_DAY_RE.test(day) && day >= cutoff));
}

router.get('/clinic/admission-care', (req, res) => {
  const ctx = getRuntimePaths(req);
  const day = String(req.query?.day || '').trim();
  if (!ISO_DAY_RE.test(day)) return res.status(400).json({ status: 'error', message: 'Ngày T/G vào không hợp lệ.' });
  const saved = readAdmissionCare(ctx)[day] || null;
  return res.json({ status: 'ok', saved });
});

router.post('/clinic/admission-care', (req, res) => {
  const ctx = getRuntimePaths(req);
  const day = String(req.body?.day || '').trim();
  if (!ISO_DAY_RE.test(day)) return res.status(400).json({ status: 'error', message: 'Ngày T/G vào không hợp lệ.' });
  const days = readAdmissionCare(ctx);
  const savedAt = new Date().toISOString();
  days[day] = { rows: sanitizeAdmissionCareRows(req.body?.rows), saved_at: savedAt };
  writeJsonAtomic(clinicAdmissionCarePath(ctx), { days: pruneAdmissionCare(days), updated_at: savedAt });
  return res.json({ status: 'ok', saved_at: savedAt });
});

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
    'two-sheets:v2',
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
    || 'Kính chuyển Khoa Chấn Thương chỉnh hình - Thần kinh nhận\nHồ sơ';
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
      // Phiếu 1 (Khoa Khám Bệnh chuyển) và phiếu 2 (Khoa nhận, có sinh hiệu người dùng nhập).
      cham_soc:            String(r.cham_soc || '').trim().slice(0, 1000),
      dien_bien_khoa:      String(r.dien_bien_khoa || '').trim().slice(0, 1500),
      cham_soc_khoa:       String(r.cham_soc_khoa || '').trim().slice(0, 1000),
      khoa_time_str:       String(r.khoa_time_str || '').trim().slice(0, 40),
      vitals:              Object.fromEntries(['mach', 'nhiet_do', 'huyet_ap', 'nhip_tho']
        .map(k => [k, String(r.vitals?.[k] || '').trim().slice(0, 12)])),
      sheets_done:         { kham: r.sheets_done?.kham === true, khoa: r.sheets_done?.khoa === true },
      saved_for_input:     r.saved_for_input === true || r.savedForInput === true,
      // Gửi đủ người đã kiểm tra lúc tìm để mã kiểm tra khớp; nhap=false (đã đủ phiếu, bỏ chọn) thì worker bỏ qua.
      nhap:                r.nhap !== false,
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
  if (requireRows && !rows.some(r => r.nhap)) throw new Error('Không có người bệnh nào cần nhập chăm sóc.');
  if (requireRows && rows.some(r => r.nhap && !r.dien_bien)) {
    throw new Error('Diễn biến của từng người bệnh không được để trống.');
  }
  if (requireRows && rows.some(r => r.nhap && ((!r.sheets_done.kham && !r.cham_soc) || (!r.sheets_done.khoa && (!r.dien_bien_khoa || !r.cham_soc_khoa))))) {
    throw new Error('Diễn biến và chăm sóc của cả 2 phiếu không được để trống.');
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
    const payload = sanitizeClinicCareRequest(withDoctorAccount(req.body || {}, req));
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
      // Đã đọc y lệnh đầu ở lần tìm trước (nội dung đã lưu): chỉ đọc lại phiếu đã có, không mở lịch sử y lệnh.
      skip_seed: row.skip_seed === true,
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
    const payload = sanitizeClinicCareOrderSeedsRequest(withDoctorAccount(req.body || {}, req));
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
    const payload = sanitizeClinicCareRequest(withDoctorAccount(req.body || {}, req), { requireRows: true });
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
module.exports.withDoctorAccount = withDoctorAccount;
module.exports.scheduledClinicDoctor = scheduledClinicDoctor;
module.exports.sanitizeSickLeavePatient = sanitizeSickLeavePatient;
module.exports.pruneSickLeave = pruneSickLeave;
module.exports.sanitizeAdmissionCareRows = sanitizeAdmissionCareRows;
module.exports.pruneAdmissionCare = pruneAdmissionCare;
module.exports.clinicTraceFile = clinicTraceFile;
module.exports.resolveEmrUrls = resolveEmrUrls;
module.exports.emrUrlDefaults = emrUrlDefaults;
module.exports.pastListDate = pastListDate;
module.exports.sanitizeMonitorRequest = sanitizeMonitorRequest;
