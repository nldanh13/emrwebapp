// server/services/diagnostics.js — Lightweight runtime health/diagnostics

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const { CONFIG_PATH, RUNTIME_ROOT, APP_TOKEN, HOST, PY_TIMEOUT_MS } = require('../constants');
const { getRuntimePaths } = require('./session');
const { getQueueStatus } = require('./task_queue');
const { writeFileAtomic, safeUnlink, readJsonSafe } = require('../utils/file');

function commandExists(command) {
  const checker = process.platform === 'win32' ? 'where' : 'command';
  const args = process.platform === 'win32' ? [command] : ['-v', command];
  const result = spawnSync(checker, args, { stdio: 'ignore', shell: process.platform !== 'win32', timeout: 2000 });
  return result.status === 0;
}

function resolvePythonBin() {
  const envPy = String(process.env.PYTHON_BIN || process.env.PYTHON || '').trim();
  if (envPy) return envPy;
  const root = path.resolve(__dirname, '..', '..');
  const candidates = [
    path.join(root, '.venv', 'Scripts', 'python.exe'),
    path.join(root, '.venv', 'bin', 'python'),
  ];
  for (const c of candidates) if (fs.existsSync(c)) return c;
  if (commandExists('python')) return 'python';
  if (commandExists('python3')) return 'python3';
  return process.platform === 'win32' ? 'python' : 'python3';
}

function checkWritable(dir) {
  const file = path.join(dir, `.health_${process.pid}_${Date.now()}.tmp`);
  try {
    writeFileAtomic(file, 'ok');
    safeUnlink(file);
    return { ok: true };
  } catch (err) {
    return { ok: false, message: String(err.message || err) };
  }
}

function checkPython() {
  const python = resolvePythonBin();
  const result = spawnSync(python, ['-c', 'import sys; print(sys.version.split()[0])'], {
    encoding: 'utf8',
    timeout: 3000,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.error) return { ok: false, python, message: result.error.message };
  if (result.status !== 0) return { ok: false, python, message: (result.stderr || '').trim() || `exit ${result.status}` };
  return { ok: true, python, version: String(result.stdout || '').trim() };
}

function checkPythonImport(moduleName) {
  const python = resolvePythonBin();
  const result = spawnSync(python, ['-c', `import ${moduleName}; print("ok")`], {
    encoding: 'utf8',
    timeout: 3000,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.error) return { ok: false, message: result.error.message };
  return { ok: result.status === 0, message: result.status === 0 ? 'ok' : ((result.stderr || '').trim() || `exit ${result.status}`) };
}

function configStatus() {
  const exists = fs.existsSync(CONFIG_PATH);
  if (!exists) return { ok: false, exists: false, message: 'Chưa có config/config.json.' };
  const cfg = readJsonSafe(CONFIG_PATH, null);
  if (!cfg || typeof cfg !== 'object') return { ok: false, exists: true, message: 'config/config.json không đọc được JSON.' };
  const hasCredentialKey = Object.keys(cfg).some(k => /user|username|ten_tai_khoan|password|mat_khau|mật khẩu/i.test(k));
  return { ok: true, exists: true, has_credential_keys: hasCredentialKey };
}

function runtimeDataStatus(ctx) {
  const files = {
    raw: ctx.RAW_PATH,
    sorted: ctx.SORTED_PATH,
    orders: ctx.FINAL_PATH,
    processed: ctx.PROCESSED_PATH,
    care_done: ctx.CARE_DONE_PATH,
    infusions_done: ctx.INFUSIONS_DONE_PATH,
    procedures_done: ctx.PROCEDURES_DONE_PATH,
    vtyt_done: ctx.VTYT_DONE_PATH,
  };
  const out = {};
  for (const [key, file] of Object.entries(files)) {
    try {
      if (!fs.existsSync(file)) { out[key] = { exists: false }; continue; }
      const st = fs.statSync(file);
      const data = readJsonSafe(file, null);
      out[key] = {
        exists: true,
        size_kb: Math.round(st.size / 1024),
        modified: st.mtimeMs,
        count: Array.isArray(data) ? data.length : (data && typeof data === 'object' ? Object.keys(data).length : 0),
      };
    } catch (err) {
      out[key] = { exists: false, error: String(err.message || err) };
    }
  }
  return out;
}

function chromeStatus() {
  const candidates = process.platform === 'win32'
    ? ['chrome', 'chrome.exe', 'chromium', 'chromium.exe']
    : ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser'];
  const found = candidates.find(commandExists) || '';
  return { ok: Boolean(found), command: found || null };
}

function buildDiagnostics(req, { detailed = false } = {}) {
  const ctx = getRuntimePaths(req);
  const runtimeWritable = checkWritable(RUNTIME_ROOT);
  const sessionWritable = checkWritable(ctx.dir);
  const python = detailed ? checkPython() : { ok: true, skipped: true };
  const selenium = detailed ? checkPythonImport('selenium') : { ok: true, skipped: true };
  const chrome = detailed ? chromeStatus() : { ok: true, skipped: true };
  const cfg = configStatus();

  const checks = {
    server: { ok: true, node: process.version, platform: process.platform, pid: process.pid },
    security: {
      ok: HOST === '127.0.0.1' || HOST === 'localhost' || HOST === '::1' || Boolean(APP_TOKEN),
      host: HOST,
      app_token_enabled: Boolean(APP_TOKEN),
    },
    config: cfg,
    runtime_writable: runtimeWritable,
    session_writable: sessionWritable,
    python,
    selenium,
    chrome,
  };

  const required = [checks.server, checks.security, checks.config, checks.runtime_writable, checks.session_writable];
  if (detailed) required.push(checks.python, checks.selenium, checks.chrome);
  const ok = required.every(x => x && x.ok);

  return {
    status: ok ? 'ok' : 'degraded',
    checked_at: new Date().toISOString(),
    session: ctx.sid,
    checks,
    queue: getQueueStatus(),
    runtime: detailed ? runtimeDataStatus(ctx) : undefined,
    limits: detailed ? { py_timeout_ms: PY_TIMEOUT_MS, memory_mb: Math.round(os.totalmem() / 1024 / 1024) } : undefined,
  };
}

module.exports = { buildDiagnostics, resolvePythonBin, commandExists };
