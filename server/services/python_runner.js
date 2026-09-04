// server/services/python_runner.js — Spawn & quản lý Python subprocess

'use strict';

const { spawn } = require('child_process');
const path       = require('path');
const fs         = require('fs');

const { PY_TIMEOUT_MS, ROOT_DIR, WORKER_DIR } = require('../constants');

// ── Tìm Python binary ─────────────────────────────────────────────────────────

function resolvePythonBin() {
  if (process.env.PYTHON_BIN) return process.env.PYTHON_BIN;
  const candidates = [
    path.join(ROOT_DIR, '.venv', 'Scripts', 'python.exe'),
    path.join(ROOT_DIR, '.venv', 'bin', 'python'),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return process.platform === 'win32' ? 'python' : 'python3';
}

const PYTHON_BIN = resolvePythonBin();

// ── Spawn Python với timeout & kill ──────────────────────────────────────────

/**
 * @param {string[]} args - argv cho Python
 * @param {object}   opts
 * @param {string}   [opts.cwd]       - working directory (default: ROOT_DIR)
 * @param {number}   [opts.timeoutMs] - timeout (default: PY_TIMEOUT_MS)
 * @param {Function} [opts.onSpawn]   - gọi với killFn ngay khi process spawn xong
 * @param {object}   [opts.extraEnv]  - env vars bổ sung
 */
function runPython(args, { cwd, timeoutMs, onSpawn, extraEnv = {}, runtimeDir } = {}) {
  return new Promise((resolve) => {
    const effectiveCwd = cwd || ROOT_DIR;
    const runtimeConfigPath = runtimeDir ? path.join(runtimeDir, 'config.json') : '';
    const runtimeDv2Path = runtimeDir ? path.join(runtimeDir, 'd_v2.json') : '';
    const appConfigPath = runtimeConfigPath && fs.existsSync(runtimeConfigPath)
      ? runtimeConfigPath
      : path.join(ROOT_DIR, 'config', 'config.json');
    const dV2ConfigPath = runtimeDv2Path && fs.existsSync(runtimeDv2Path)
      ? runtimeDv2Path
      : path.join(ROOT_DIR, 'config', 'd_v2.json');
    const py = spawn(PYTHON_BIN, ['-X', 'utf8', ...args], {
      shell: false,
      windowsHide: true,
      cwd: effectiveCwd,
      env: {
        ...process.env,
        PYTHONUTF8:         '1',
        PYTHONIOENCODING:   'utf-8',
        SE_AVOID_STATS:     'true',
        // Cho phép worker/ import lẫn nhau bất kể cwd
        PYTHONPATH:         process.env.PYTHONPATH ? `${WORKER_DIR}${path.delimiter}${process.env.PYTHONPATH}` : WORKER_DIR,
        APP_CONFIG_PATH:    appConfigPath,
        D_V2_CONFIG_PATH:   dV2ConfigPath,
        WORKER_RUNTIME_DIR: runtimeDir || '',
        ...extraEnv,
      },
    });

    let resolved        = false;
    let killedByTimeout = false;
    const stderrLines   = []; // Giữ tối đa STDERR_KEEP dòng cuối, đã lọc nhạy cảm

    const STDERR_KEEP = 30;

    // Lọc dòng chứa thông tin nhạy cảm trước khi ghi log hoặc đưa vào stderrTail.
    // Áp dụng cho cả stdout/stderr vì worker có thể vô tình print thông tin nhạy cảm.
    function isSensitiveLine(line) {
      const low = line.toLowerCase();
      return low.includes('password') || low.includes('mat_khau') ||
             low.includes('token')    || low.includes('secret')   ||
             low.includes('username') || low.includes('ten_tai_khoan') ||
             low.includes('authorization') || low.includes('cookie') ||
             low.includes('set-cookie');
    }

    function redactSensitiveLine(line, label = 'log') {
      return isSensitiveLine(line) ? `[redacted sensitive ${label} line]` : line;
    }

    const safeResolve = (val) => { if (!resolved) { resolved = true; resolve(val); } };

    if (typeof onSpawn === 'function') {
      onSpawn(() => {
        try { py.kill('SIGTERM'); } catch (_) {}
        setTimeout(() => { try { py.kill('SIGKILL'); } catch (_) {} }, 3000);
      });
    }

    const timer = setTimeout(() => {
      killedByTimeout = true;
      try { py.kill('SIGTERM'); } catch (_) {}
      setTimeout(() => { try { py.kill('SIGKILL'); } catch (_) {} }, 3000);
    }, Math.max(5_000, timeoutMs || PY_TIMEOUT_MS));

    py.stdout.on('data', d => {
      const safeLines = [];
      for (const line of d.toString().split('\n')) {
        const l = line.trimEnd();
        if (!l) continue;
        safeLines.push(redactSensitiveLine(l, 'stdout'));
      }
      if (safeLines.length) console.log(safeLines.map(l => `[PY] ${l}`).join('\n'));
    });
    py.stderr.on('data', d => {
      const text = d.toString();
      const safeLines = [];
      // Gom stderr vào buffer, lọc dòng nhạy cảm trước khi log và trả về UI.
      for (const line of text.split('\n')) {
        const l = line.trimEnd();
        if (!l) continue;
        const safe = redactSensitiveLine(l, 'stderr');
        safeLines.push(safe);
        stderrLines.push(safe);
        if (stderrLines.length > STDERR_KEEP) stderrLines.shift();
      }
      if (safeLines.length) console.error(safeLines.map(l => `[PY ERR] ${l}`).join('\n'));
    });

    py.on('error', err => {
      clearTimeout(timer);
      console.error(`[PY SPAWN ERROR] ${err.message} (bin=${PYTHON_BIN})`);
      safeResolve({ code: -1, killedByTimeout: false, spawnError: err.message, stderrTail: [] });
    });

    py.on('close', code => {
      clearTimeout(timer);
      safeResolve({ code: Number(code ?? -1), killedByTimeout, stderrTail: stderrLines.slice(-20) });
    });
  });
}


function argForLog(arg) {
  const value = String(arg || '');
  if (!value) return '';
  if (/password|pass|token|secret|cookie|authorization/i.test(value)) return '[hidden]';
  if (/\.(json|pdf|png|html?|log|jsonl)$/i.test(value) || value.includes('.runtime')) return '[file]';
  if (value.length > 120) return value.slice(0, 117) + '...';
  return value;
}

function argsForLog(args = []) {
  return (Array.isArray(args) ? args : []).map(argForLog).join(' ');
}

// ── Wrappers đặc thù ──────────────────────────────────────────────────────────

/**
 * Format message lỗi Python để trả về API response.
 * Kèm theo tối đa MAX_LINES dòng stderr cuối (đã lọc nhạy cảm).
 * Không kèm nếu result không có stderrTail hoặc rỗng.
 */
function fmtPyError(baseMsg, result, { maxLines = 15 } = {}) {
  const tail = Array.isArray(result?.stderrTail) ? result.stderrTail : [];
  if (!tail.length) return baseMsg;
  const snippet = tail.slice(-maxLines).join('\n');
  return `${baseMsg}\n\nLog (${tail.length} dòng cuối):\n${snippet}`;
}

/** Chạy main_worker.py với subcommand (scan / details). */
function runWorker(cmd, args, opts = {}) {
  const workerPath = path.join(WORKER_DIR, 'main_worker.py');
  if (!fs.existsSync(workerPath)) throw new Error('Thiếu file main_worker.py trong worker/');
  console.log(`>>> [NODE] Worker: ${cmd} ${argsForLog(args)}`);
  return runPython(['-u', workerPath, cmd, ...args], {
    timeoutMs: PY_TIMEOUT_MS,
    onSpawn:   opts.onSpawn,
    runtimeDir: opts.runtimeDir,
  });
}

/** Chạy một script Python cụ thể trong worker/. */
function runScript(scriptName, args = [], opts = {}) {
  const scriptPath = path.join(WORKER_DIR, scriptName);
  if (!fs.existsSync(scriptPath)) throw new Error(`Thiếu script: worker/${scriptName}`);
  console.log(`>>> [NODE] Script: ${scriptName} ${argsForLog(args)}`);
  return runPython(['-u', scriptPath, ...args], {
    timeoutMs: PY_TIMEOUT_MS,
    cwd:       opts.cwd,
    onSpawn:   opts.onSpawn,
    runtimeDir: opts.runtimeDir,
  });
}

module.exports = { runPython, runWorker, runScript, fmtPyError, PYTHON_BIN };
