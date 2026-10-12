// server/routes/sick_leave.js — /api/sick-leave-state
//
// Chỉ lưu trạng thái "đã nộp / chưa nộp" hồ sơ nghỉ ốm (nội trú xuất viện +
// ngoại trú) mà tab "Nghỉ ốm" tự lọc từ dữ liệu đã có sẵn trong app. Không
// tự động nộp lên Cổng Dịch vụ công BHXH — đó là hệ thống ngoài, khác tài
// khoản đăng nhập, cần làm ở bước sau khi có ảnh chụp/mô tả giao diện cổng.

'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const router = require('express').Router();

const { getRuntimePaths } = require('../services/session');
const { runScript, fmtPyError } = require('../services/python_runner');
const { readJsonSafe, writeJsonAtomic, safeUnlink } = require('../utils/file');
const { ROOT_DIR } = require('../constants');
const { forwardToTool, isBhytToolRunning, waitForLaunch } = require('../services/bhyt_tool');
// GET/POST /sick-leave-import dùng chung 1 path — áp riêng heavyTaskLimiter (spawn Python)
// chỉ cho POST ở đây, thay vì đăng ký cả path vào HEAVY_TASK_ROUTES trong index.js
// (sẽ giới hạn nhầm cả GET đọc lại, vốn chỉ đọc file JSON đã lưu).
const { heavyTaskLimiter } = require('../middleware/rate_limit');

function getStatePath(req) {
  const ctx = getRuntimePaths(req);
  return path.join(ctx.dir, 'sick_leave_state.json');
}

function getImportPath(req) {
  const ctx = getRuntimePaths(req);
  return path.join(ctx.dir, 'sick_leave_import.json');
}

function cleanKey(key) {
  return String(key || '').trim().slice(0, 260);
}

const BHYT_STATUSES = new Set(['previewed', 'success', 'error']);

// Số liệu bổ sung tay trước khi nhập Cổng BHYT (vd. Số KCB): chỉ chuỗi ngắn, khoá dạng tên field.
function normalizeBhytFields(value) {
  const out = {};
  if (!value || typeof value !== 'object') return out;
  for (const [k, v] of Object.entries(value).slice(0, 40)) {
    if (!/^[a-z_]{1,40}$/.test(k)) continue;
    const text = String(v ?? '').trim().slice(0, 300);
    if (text) out[k] = text;
  }
  return out;
}

function normalizeEntryState(value) {
  const v = value && typeof value === 'object' ? value : {};
  const out = {
    submitted: Boolean(v.submitted),
    note: String(v.note || '').slice(0, 600),
    updated_at: String(v.updated_at || '').slice(0, 40),
  };
  // Kết quả nhập Cổng BHYT từ tab Nghỉ ốm (src/components/BhytPortalLinkPanel.jsx).
  const fields = normalizeBhytFields(v.bhyt_fields);
  if (Object.keys(fields).length) out.bhyt_fields = fields;
  if (BHYT_STATUSES.has(v.bhyt_status)) {
    out.bhyt_status = v.bhyt_status;
    out.bhyt_message = String(v.bhyt_message || '').slice(0, 600);
    out.bhyt_at = String(v.bhyt_at || '').slice(0, 40);
  }
  return out;
}

function normalizeState(body) {
  const input = body && typeof body === 'object' ? body : {};
  const sourceEntries = input.entries && typeof input.entries === 'object' ? input.entries : {};
  const entries = {};
  for (const [rawKey, rawValue] of Object.entries(sourceEntries)) {
    const key = cleanKey(rawKey);
    if (!key) continue;
    entries[key] = normalizeEntryState(rawValue);
  }
  return {
    version: 1,
    updated_at: new Date().toISOString(),
    entries,
  };
}

// GET /api/sick-leave-state
router.get('/sick-leave-state', (req, res) => {
  const saved = readJsonSafe(getStatePath(req), { version: 1, entries: {} });
  const normalized = normalizeState(saved);
  normalized.updated_at = saved?.updated_at || '';
  return res.json({ status: 'ok', ...normalized });
});

// POST /api/sick-leave-state
router.post('/sick-leave-state', (req, res) => {
  const next = normalizeState(req.body || {});
  try {
    writeJsonAtomic(getStatePath(req), next);
    return res.json({ status: 'ok', ...next });
  } catch (err) {
    return res.status(500).json({ status: 'error', message: `Không ghi được sick_leave_state.json: ${err.message || err}` });
  }
});

// GET /api/sick-leave-import — bản danh sách BHXH đã nhập gần nhất (đọc lại khi mở tab).
router.get('/sick-leave-import', (req, res) => {
  const saved = readJsonSafe(getImportPath(req), null);
  return res.json({ status: 'ok', import: saved });
});

// POST /api/sick-leave-import — nhập file .xlsx BHXH gửi (2 sheet Ngoại trú/Nội trú).
// Chỉ đọc/lưu lại danh sách để hiển thị và đối chiếu trong app; không tự tìm/ghi gì lên EMR.
router.post('/sick-leave-import', heavyTaskLimiter, async (req, res) => {
  const ctx = getRuntimePaths(req);
  const body = req.body || {};
  const rawBase64 = String(body?.excel?.base64 || body?.base64 || '').trim();
  if (!rawBase64) return res.status(400).json({ status: 'error', message: 'Chưa có file Excel để nhập.' });
  if (rawBase64.length > 8 * 1024 * 1024) return res.status(400).json({ status: 'error', message: 'File Excel quá lớn (tối đa ~8MB).' });

  const stamp = Date.now();
  const inputPath = path.join(ctx.dir, `sick_leave_import_input_${stamp}.xlsx`);
  const outputPath = path.join(ctx.dir, `sick_leave_import_output_${stamp}.json`);
  try {
    const base64Data = rawBase64.includes(',') ? rawBase64.slice(rawBase64.indexOf(',') + 1) : rawBase64;
    fs.writeFileSync(inputPath, Buffer.from(base64Data, 'base64'));
  } catch (err) {
    return res.status(400).json({ status: 'error', message: `Không đọc được file đã tải lên: ${err.message || err}` });
  }

  try {
    const result = await runScript('parse_bhxh_sick_leave_list.py', [inputPath, outputPath], { runtimeDir: ctx.dir });
    if (result.spawnError) return res.status(500).json({ status: 'error', message: `Không khởi động được Python: ${result.spawnError}` });
    if (result.killedByTimeout) return res.status(504).json({ status: 'error', message: 'Timeout khi đọc file Excel.' });

    const parsed = readJsonSafe(outputPath, null);
    if (!parsed || parsed.status !== 'ok') {
      return res.status(500).json({ status: 'error', message: parsed?.message || fmtPyError('Không đọc được file Excel.', result) });
    }

    const saved = {
      version: 1,
      imported_at: new Date().toISOString(),
      filename: String(body?.excel?.filename || body?.filename || '').slice(0, 200),
      outpatient: Array.isArray(parsed.outpatient) ? parsed.outpatient : [],
      inpatient: Array.isArray(parsed.inpatient) ? parsed.inpatient : [],
    };
    writeJsonAtomic(getImportPath(req), saved);
    return res.json({ status: 'ok', ...saved, message: parsed.message, unknown_sheets: parsed.unknown_sheets || [] });
  } catch (err) {
    return res.status(500).json({ status: 'error', message: String(err.message || err) });
  } finally {
    safeUnlink(inputPath);
    safeUnlink(outputPath);
  }
});

// POST /api/sick-leave-import/delete-row — xoá 1 dòng khỏi danh sách BHXH đã
// nhập (nhập nhầm file, dòng lỗi...). Xoá theo index trong mảng đã lưu, vì
// dữ liệu BHXH không có cột nào đảm bảo là khoá duy nhất ổn định để tra theo.
router.post('/sick-leave-import/delete-row', (req, res) => {
  const body = req.body || {};
  const type = body.type === 'inpatient' || body.type === 'outpatient' ? body.type : null;
  const index = Number.isInteger(body.index) ? body.index : -1;
  if (!type || index < 0) {
    return res.status(400).json({ status: 'error', message: 'Thiếu type ("outpatient"/"inpatient") hoặc index hợp lệ.' });
  }

  const saved = readJsonSafe(getImportPath(req), null);
  if (!saved || !Array.isArray(saved[type])) {
    return res.status(404).json({ status: 'error', message: 'Chưa có danh sách BHXH đã nhập.' });
  }
  if (index >= saved[type].length) {
    return res.status(400).json({ status: 'error', message: 'Index không hợp lệ (danh sách đã đổi, hãy tải lại trang).' });
  }

  const next = { ...saved, [type]: saved[type].filter((_, i) => i !== index), updated_at: new Date().toISOString() };
  try {
    writeJsonAtomic(getImportPath(req), next);
    return res.json({ status: 'ok', ...next });
  } catch (err) {
    return res.status(500).json({ status: 'error', message: `Không ghi được sick_leave_import.json: ${err.message || err}` });
  }
});

// ── POST /api/sick-leave-launch-bhyt-tool ───────────────────────────────────
// Tự khởi động tools/bhyt_selenium_app (Flask/Selenium, cổng 5005) giùm người
// dùng khi bấm nút "Mở công cụ nhập cổng BHXH" — khỏi phải tự tay chạy
// start.bat mỗi lần. Chỉ spawn khi venv của tool đó đã có sẵn (lần đầu vẫn
// cần tự chạy start.bat 1 lần để cài thư viện — không tự ý cài hộ ở đây vì
// có thể mất nhiều phút và cần mạng, không phù hợp gọi trong 1 request).
// Chạy trên cùng máy với browser của người dùng — vì cổng BHYT bắt CAPTCHA/
// OTP, tool đó bắt buộc mở Chrome hiển thị ngay trên máy đang thao tác.
const BHYT_TOOL_DIR = path.join(ROOT_DIR, 'tools', 'bhyt_selenium_app');

function bhytToolPythonBin() {
  const candidates = process.platform === 'win32'
    ? [path.join(BHYT_TOOL_DIR, '.venv', 'Scripts', 'python.exe')]
    : [path.join(BHYT_TOOL_DIR, '.venv', 'bin', 'python')];
  return candidates.find(p => fs.existsSync(p)) || '';
}

router.post('/sick-leave-launch-bhyt-tool', async (req, res) => {
  if (await isBhytToolRunning()) {
    return res.json({ status: 'ok', already_running: true });
  }

  const pythonBin = bhytToolPythonBin();
  if (!pythonBin) {
    return res.status(400).json({
      status: 'error',
      message: 'tools/bhyt_selenium_app chưa được cài lần đầu trên máy này — mở thư mục đó, nhấp đúp start.bat 1 lần để cài thư viện, rồi thử lại.',
    });
  }

  const logFile = path.join(BHYT_TOOL_DIR, 'runtime', 'launch.log');
  let logStart = 0;
  let child;
  try {
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    try { logStart = fs.statSync(logFile).size; } catch (_) { logStart = 0; }
    const logFd = fs.openSync(logFile, 'a');
    child = spawn(pythonBin, ['app.py'], {
      cwd: BHYT_TOOL_DIR,
      detached: true,
      stdio: ['ignore', logFd, logFd],
      windowsHide: true,
      env: { ...process.env, PYTHONUNBUFFERED: '1', PYTHONIOENCODING: 'utf-8' },
    });
    fs.closeSync(logFd);
    child.unref();
  } catch (err) {
    return res.status(500).json({ status: 'error', message: `Không khởi động được công cụ nhập cổng BHXH: ${err.message || err}` });
  }

  // Chờ công cụ lắng nghe; tắt ngay thì báo lý do đọc từ phần log của lần khởi động này.
  const result = await waitForLaunch({
    child,
    isRunning: () => isBhytToolRunning(),
    readLog: () => {
      try { return fs.readFileSync(logFile).subarray(logStart).toString('utf8'); } catch (_) { return ''; }
    },
  });
  if (!result.ok) return res.status(503).json({ status: 'error', message: result.message });
  return res.json({ status: 'ok', already_running: false });
});

// ── /api/bhyt-tool/* → công cụ nhập cổng BHXH ────────────────────────────────
// Tab Nghỉ ốm gọi công cụ qua đây thay vì gọi thẳng 127.0.0.1:5005 từ trình duyệt: một đường duy
// nhất, lỗi tiếng Việt, đường có mật khẩu không mở ra trình duyệt. Xem server/services/bhyt_tool.js.
router.all(/^\/bhyt-tool(\/api\/.+)$/, async (req, res) => {
  const r = await forwardToTool({ method: req.method, path: req.params[0], body: req.body });
  return res.status(r.status).json(r.body);
});

// ── Tài khoản cổng BHXH + đăng nhập chỉ bằng CAPTCHA ─────────────────────────
// Lưu một lần (secrets/bhyt_portal_account.json); mỗi lần nhập người dùng chỉ gõ CAPTCHA.
const { publicBhytPortalAccount, readBhytPortalAccount, saveBhytPortalAccount } = require('../utils/bhyt_portal_account');
const { loginWithCaptcha } = require('../services/bhyt_portal_login');
const { getSecret } = require('../services/secret_store');

/** Tài khoản EMR cho công cụ đọc giấy: bác sĩ đã chọn, hoặc tài khoản EMR chung. */
function bhytToolEmrAccount(req, accountName) {
  if (accountName) {
    const { withDoctorAccount } = require('./clinic');
    const acc = withDoctorAccount({ account_name: accountName }, req);
    return { username: acc.username, password: acc.password, label: acc.account_doctor || accountName };
  }
  const username = getSecret('emr_username');
  const password = getSecret('emr_password');
  if (!username || !password) throw new Error('Chưa có tài khoản EMR chung. Khai ở Thiết lập tài khoản, hoặc chọn bác sĩ ở "Tài khoản cổng BHXH".');
  return { username, password, label: 'tài khoản EMR chung' };
}

router.get('/sick-leave-bhyt-account', (_req, res) => {
  res.json({ status: 'ok', account: publicBhytPortalAccount() });
});

router.post('/sick-leave-bhyt-account', (req, res) => {
  try {
    return res.json({ status: 'ok', account: saveBhytPortalAccount(req.body || {}) });
  } catch (err) {
    return res.status(400).json({ status: 'error', message: String(err.message || err) });
  }
});

router.post('/sick-leave-bhyt-login', async (req, res) => {
  try {
    const account = readBhytPortalAccount();
    const out = await loginWithCaptcha({
      captcha: req.body?.captcha,
      account,
      resolveEmr: () => bhytToolEmrAccount(req, account.emr_account_name),
    });
    return res.json({ status: 'ok', ...out });
  } catch (err) {
    return res.status(400).json({ status: 'error', message: String(err.message || err) });
  }
});

module.exports = router;
module.exports.normalizeState = normalizeState;
