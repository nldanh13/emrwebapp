// server/services/hchanh_resident_worker.js
// One long-lived Python/Chrome owner per workspace, for read-only Records Check.
// Opt-in via EMR_PERSISTENT_HCHANH_WORKER=1; other routes keep existing behavior.
'use strict';

const { spawn, spawnSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const { ROOT_DIR, WORKER_DIR, PY_TIMEOUT_MS } = require('../constants');
const { PYTHON_BIN, runScript, terminateProcessTree } = require('./python_runner');
const { isDriverStackNoise, LOG_REDACT_SALT } = require('../utils/log_redact');
const { resolveDv2Path } = require('../utils/dv2_path');
const emrBridge = require('./emr_bridge');

const workers = new Map();
let globalChromeLane = Promise.resolve(); // no overlapping resident sessions across workspaces
const IDLE_MS = 2 * 60 * 1000;
const MAX_BROWSER_AGE_MS = 15 * 60 * 1000;
const MAX_PENDING = 2;
const MAX_LINE = 256 * 1024;
const stats = { launches: 0, completed: 0, failures: 0, timeouts: 0, cancelled: 0, reused: 0 };

function enabled() {
  // Read-only local Chrome only; EMR bridge and writing use unchanged runners.
  // Opt out immediately with EMR_PERSISTENT_HCHANH_WORKER=0.
  return !/^(0|false|no|off)$/i.test(String(process.env.EMR_PERSISTENT_HCHANH_WORKER ?? '').trim());
}

function killResidentTree(child) {
  if (!child || !child.pid) return;
  if (process.platform !== 'win32' && child.__residentGroup) {
    try { process.kill(-child.pid, 'SIGTERM'); } catch (_) {}
    const killTimer = setTimeout(() => {
      try { process.kill(-child.pid, 'SIGKILL'); } catch (_) {}
    }, 3000);
    killTimer.unref?.();
  } else {
    terminateProcessTree(child);
  }
}

function residentStatus() {
  const all = [...workers.values()];
  return {
    enabled: enabled(),
    mode: 'read_only_records_check',
    running_workers: all.filter(w => !!w.child).length,
    active_jobs: all.filter(w => !!w.active).length,
    queued_jobs: all.reduce((sum, w) => sum + Math.max(0, w.pending - (w.active ? 1 : 0)), 0),
    ...stats,
  };
}

// A hard stop on Node exit: Windows requires synchronous taskkill; on POSIX
// the detached process group also contains chromedriver and Chrome.
process.once('exit', () => {
  for (const worker of workers.values()) {
    const child = worker.child;
    if (!child?.pid) continue;
    if (process.platform === 'win32') {
      try {
        spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
          shell: false, windowsHide: true, stdio: 'ignore', timeout: 5000,
        });
      } catch (_) {}
    } else if (child.__residentGroup) {
      try { process.kill(-child.pid, 'SIGKILL'); } catch (_) {}
    }
  }
});

function readOnlyJob(args) {
  if (!Array.isArray(args)) return null;
  const options = {};
  const allowed = new Set(['--input', '--out', '--scope', '--files', '--status', '--batch-size', '--headless']);
  for (let i = 0; i < args.length; i += 1) {
    const key = args[i];
    if (!allowed.has(key) || Object.hasOwn(options, key)) return null;
    if (key === '--headless') {
      options[key] = true;
    } else {
      if (i + 1 >= args.length) return null;
      options[key] = String(args[++i]);
    }
  }
  if (!options['--headless'] || options['--scope'] !== 'discharge' ||
      options['--status'] !== 'Hoàn tất' ||
      options['--files'] !== 'discharge,cls' ||
      options['--batch-size'] !== '10' ||
      !options['--input'] || !options['--out']) return null;
  return {
    op: 'records_check',
    input: options['--input'],
    output: options['--out'],
    files: ['discharge', 'cls'],
    headless: true,
    status: 'Hoàn tất',
  };
}

function safeLine(line) {
  // The read-only fetcher can print patient names and fragments of EMR HTML.
  // Existing URL / patient-code redaction is insufficient for free-form names.
  // Only preserve a technical exception *type*, never the original message.
  const match = String(line || '').match(/\b([A-Za-z_][\w.]*(?:Error|Exception))\b/);
  if (match) return '[Chrome Worker] ' + match[1];
  if (/\b(WARN|WARNING)\b/i.test(String(line))) return '[Chrome Worker] Cảnh báo (đã ẩn dữ liệu)';
  return '[Chrome Worker] Nhật ký đã ẩn dữ liệu';
}

function makeEnv(runtimeDir) {
  const runtimeCfg = path.join(runtimeDir, 'config.json');
  const appConfigPath = fs.existsSync(runtimeCfg)
    ? runtimeCfg : path.join(ROOT_DIR, 'config', 'config.json');
  return {
    ...process.env,
    PYTHONUTF8: '1',
    PYTHONIOENCODING: 'utf-8',
    PYTHONPATH: process.env.PYTHONPATH
      ? WORKER_DIR + path.delimiter + process.env.PYTHONPATH : WORKER_DIR,
    APP_CONFIG_PATH: appConfigPath,
    D_V2_CONFIG_PATH: resolveDv2Path(runtimeDir),
    WORKER_RUNTIME_DIR: runtimeDir,
    LOG_REDACT_SALT,
    SE_AVOID_STATS: 'true',
  };
}

class ResidentWorker {
  constructor(runtimeDir) {
    this.runtimeDir = runtimeDir;
    this.child = null;
    this.active = null;
    this.pending = 0;
    this.chain = Promise.resolve();
    this.stdoutBuffer = '';
    this.stderrBuffer = '';
    this.stderrTail = [];
    this.idleTimer = null;
    this.retiring = null;
    this.retiringDone = null;
    this.lastStartedAt = 0;
  }

  _idleClear() {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }

  _spawn() {
    const child = spawn(PYTHON_BIN, [
      '-X', 'utf8', '-u', path.join(WORKER_DIR, 'hchanh_read_daemon.py'),
    ], {
      cwd: ROOT_DIR, shell: false, windowsHide: true,
      detached: process.platform !== 'win32',
      stdio: ['pipe', 'pipe', 'pipe'],
      env: makeEnv(this.runtimeDir),
    });
    child.__residentGroup = process.platform !== 'win32';
    this.child = child;
    this.lastStartedAt = Date.now();
    stats.launches += 1;
    this.stdoutBuffer = '';
    this.stderrBuffer = '';
    this.stderrTail = [];

    child.stdout.on('data', data => this._onStdout(child, data));
    child.stderr.on('data', data => this._onStderr(data));
    child.stdin.on('error', () => this._invalidate('Mất kết nối với Chrome Worker.'));
    child.on('error', err => this._lost(child, 'Không mở được Chrome Worker.', err.message));
    child.on('close', () => this._lost(child, 'Chrome Worker đã dừng trước khi trả kết quả.'));
    return child;
  }

  _onStderr(data) {
    this.stderrBuffer += data.toString('utf8');
    if (this.stderrBuffer.length > MAX_LINE) this.stderrBuffer = this.stderrBuffer.slice(-MAX_LINE);
    let end;
    while ((end = this.stderrBuffer.indexOf('\n')) >= 0) {
      const line = this.stderrBuffer.slice(0, end).trimEnd();
      this.stderrBuffer = this.stderrBuffer.slice(end + 1);
      if (!line || isDriverStackNoise(line)) continue;
      if (!/(ERROR|WARN|EXCEPTION|TRACEBACK|LỖI)/i.test(line)) continue;
      const safe = safeLine(line);
      // Suppress thousands of identical warnings from patient-by-patient fetch.
      if (this.stderrTail[this.stderrTail.length - 1] === safe) continue;
      this.stderrTail.push(safe);
      if (this.stderrTail.length > 20) this.stderrTail.shift();
      console.warn(safe);
    }
  }

  _onStdout(child, data) {
    if (this.child !== child) return;
    this.stdoutBuffer += data.toString('utf8');
    if (this.stdoutBuffer.length > MAX_LINE) {
      this._invalidate('Phản hồi Chrome Worker quá lớn.');
      return;
    }
    let end;
    while ((end = this.stdoutBuffer.indexOf('\n')) >= 0) {
      const line = this.stdoutBuffer.slice(0, end);
      this.stdoutBuffer = this.stdoutBuffer.slice(end + 1);
      let message;
      try { message = JSON.parse(line); } catch (_) {
        this._invalidate('Chrome Worker trả phản hồi không đúng định dạng.');
        return;
      }
      if (!this.active || message?.id !== this.active.id || !Number.isInteger(message.code)) {
        this._invalidate('Chrome Worker trả phản hồi không khớp tác vụ.');
        return;
      }
      const response = { code: message.code, killedByTimeout: false,
        stderrTail: this.stderrTail.slice(-20) };
      stats.completed += 1;
      if (message.code !== 0) stats.failures += 1;
      this._complete(response);
      if (message.code !== 0) {
        // Do not reuse a browser whose previous task ended unexpectedly.
        this._invalidate('Tác vụ trong Chrome Worker thất bại.');
      }
    }
  }

  _complete(result) {
    const active = this.active;
    if (!active) return;
    this.active = null;
    clearTimeout(active.timer);
    active.resolve(result);
  }

  _lost(child, reason, detail = '') {
    if (this.child !== child) return;
    this.child = null;
    this._idleClear();
    if (this.retiringDone) {
      const done = this.retiringDone;
      this.retiringDone = null;
      this.retiring = null;
      done();
    }
    if (workers.get(this.runtimeDir) === this && this.pending === 0) workers.delete(this.runtimeDir);
    this._complete({ code: -1, killedByTimeout: Boolean(this.active?.timedOut),
      spawnError: detail ? 'Không khởi động được Python.' : undefined, stderrTail: [...this.stderrTail, reason] });
  }

  _invalidate(reason) {
    const child = this.child;
    this._idleClear();
    if (child && !this.retiring) {
      this.retiring = new Promise(resolve => { this.retiringDone = resolve; });
    }
    if (child) killResidentTree(child);
    // Never start another Chrome until this one has actually exited.
    // No automatic replay: the last EMR request may have already completed.
    this._complete({ code: -1, killedByTimeout: Boolean(this.active?.timedOut),
      stderrTail: [...this.stderrTail, reason] });
    if (!child && workers.get(this.runtimeDir) === this && this.pending === 0) {
      workers.delete(this.runtimeDir);
    }
  }

  _scheduleIdle() {
    this._idleClear();
    if (!this.child || this.pending > 0 || this.active) return;
    const child = this.child;
    this.idleTimer = setTimeout(() => {
      if (this.child !== child || this.active || this.pending) return;
      // Wait for this Chrome to fully exit before spawning a replacement.
      // Otherwise a request arriving during idle shutdown could open two
      // simultaneous EMR sessions under the same account.
      this.retiring = new Promise(resolve => { this.retiringDone = resolve; });
      try { child.stdin.end(); } catch (_) { killResidentTree(child); }
      const force = setTimeout(() => {
        if (this.child === child) killResidentTree(child);
      }, 5000);
      force.unref?.();
    }, IDLE_MS);
    this.idleTimer.unref?.();
  }

  async shutdown() {
    this._idleClear();
    // No more commands may be enqueued after a workspace handoff starts:
    // globalChromeLane serializes the entire handoff and dispatch.
    await this.chain;
    if (!this.child) return;
    if (!this.retiring) {
      this.retiring = new Promise(resolve => { this.retiringDone = resolve; });
      const child = this.child;
      try { child.stdin.end(); } catch (_) { killResidentTree(child); }
      const force = setTimeout(() => {
        if (this.child === child) killResidentTree(child);
      }, 5000);
      force.unref?.();
    }
    await this.retiring;
  }

  run(command, { onSpawn, timeoutMs } = {}) {
    if (this.pending >= MAX_PENDING) {
      return Promise.resolve({ code: -1, stderrTail: ['Hàng đợi Chrome Worker đã đầy.'] });
    }
    this.pending += 1;
    this._idleClear();
    const execute = async () => {
      if (this.retiring) await this.retiring;
      // Rotate long-lived sessions even when the patient quota was not reached.
      // Do not keep EMR authenticated indefinitely to avoid memory growth.
      if (this.child && Date.now() - this.lastStartedAt >= MAX_BROWSER_AGE_MS) {
        const old = this.child;
        this.retiring = new Promise(resolve => { this.retiringDone = resolve; });
        try { old.stdin.end(); } catch (_) { killResidentTree(old); }
        const force = setTimeout(() => {
          if (this.child === old) killResidentTree(old);
        }, 5000);
        force.unref?.();
        await this.retiring;
      }
      if (this.child) stats.reused += 1;
      const child = this.child || this._spawn();
      const id = crypto.randomUUID();
      return new Promise(resolve => {
        const timer = setTimeout(() => {
          if (this.active?.id === id) {
            this.active.timedOut = true;
            stats.timeouts += 1;
            this._invalidate('Chrome Worker quá thời gian xử lý.');
          }
        }, Math.max(5000, timeoutMs || PY_TIMEOUT_MS));
        this.active = { id, resolve, timer, timedOut: false };
        try {
          if (typeof onSpawn === 'function') {
            onSpawn(() => {
              stats.cancelled += 1;
              this._invalidate('Đã dừng Chrome Worker theo yêu cầu.');
            });
          }
          // registerCancel can synchronously invoke kill when cancellation was
          // requested while queued. Never dispatch that cancelled job to EMR.
          if (this.active?.id !== id) return;
          child.stdin.write(JSON.stringify({ ...command, id }) + '\n');
        } catch (err) {
          this._invalidate('Không gửi được yêu cầu tới Chrome Worker.');
        }
      });
    };
    const response = this.chain.then(execute, execute);
    this.chain = response.catch(() => {}).finally(() => {
      this.pending = Math.max(0, this.pending - 1);
      if (this.pending === 0) this._scheduleIdle();
    });
    return response;
  }
}

function runRecordsCheckBatch(args, opts = {}) {
  const bridgeEnv = emrBridge.workerEnv();
  const command = readOnlyJob(args);
  const runtimeDir = opts.runtimeDir ? path.resolve(opts.runtimeDir) : '';
  if (!enabled() || !command ||
      !runtimeDir || bridgeEnv.EMR_BRIDGE_URL || process.env.EMR_BRIDGE_URL) {
    return runScript('hchanh_fetch.py', args, opts);
  }
  // Only one resident Chrome on the Node host. Even separate workspaces can
  // use the same EMR account, so close the previous browser before handoff.
  const task = globalChromeLane.then(async () => {
    for (const [otherRuntime, otherWorker] of [...workers]) {
      if (otherRuntime !== runtimeDir) {
        await otherWorker.shutdown();
        if (workers.get(otherRuntime) === otherWorker) workers.delete(otherRuntime);
      }
    }
    const worker = workers.get(runtimeDir) || new ResidentWorker(runtimeDir);
    workers.set(runtimeDir, worker);
    return worker.run(command, opts);
  });
  globalChromeLane = task.catch(() => {});
  return task;
}

module.exports = { runRecordsCheckBatch, readOnlyJob, ResidentWorker, residentStatus };
