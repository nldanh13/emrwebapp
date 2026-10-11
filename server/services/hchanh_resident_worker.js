// server/services/hchanh_resident_worker.js
// One long-lived Python/Chrome owner per workspace, for read-only Records Check.
// Opt-in via EMR_PERSISTENT_HCHANH_WORKER=1; other routes keep existing behavior.
'use strict';

const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const { ROOT_DIR, WORKER_DIR, PY_TIMEOUT_MS } = require('../constants');
const { PYTHON_BIN, runScript, terminateProcessTree } = require('./python_runner');
const { redactLogLine, isDriverStackNoise, LOG_REDACT_SALT } = require('../utils/log_redact');
const { resolveDv2Path } = require('../utils/dv2_path');
const emrBridge = require('./emr_bridge');

const workers = new Map();
const IDLE_MS = 2 * 60 * 1000;
const MAX_PENDING = 2;
const MAX_LINE = 256 * 1024;

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
  const low = String(line || '').toLowerCase();
  if (/(password|mat_khau|token|secret|username|authorization|cookie|set-cookie)/.test(low)) {
    return '[redacted sensitive Python log line]';
  }
  return redactLogLine(line);
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
      stdio: ['pipe', 'pipe', 'pipe'],
      env: makeEnv(this.runtimeDir),
    });
    this.child = child;
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
      const safe = safeLine(line);
      this.stderrTail.push(safe);
      if (this.stderrTail.length > 20) this.stderrTail.shift();
      console.log('[HCHANH WORKER] ' + safe);
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
      spawnError: detail || undefined, stderrTail: [...this.stderrTail, safeLine(reason)] });
  }

  _invalidate(reason) {
    const child = this.child;
    this._idleClear();
    if (child && !this.retiring) {
      this.retiring = new Promise(resolve => { this.retiringDone = resolve; });
    }
    if (child) terminateProcessTree(child);
    // Never start another Chrome until this one has actually exited.
    // No automatic replay: the last EMR request may have already completed.
    this._complete({ code: -1, killedByTimeout: Boolean(this.active?.timedOut),
      stderrTail: [...this.stderrTail, safeLine(reason)] });
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
      try { child.stdin.end(); } catch (_) { terminateProcessTree(child); }
      const force = setTimeout(() => {
        if (this.child === child) terminateProcessTree(child);
      }, 5000);
      force.unref?.();
    }, IDLE_MS);
    this.idleTimer.unref?.();
  }

  run(command, { onSpawn, timeoutMs } = {}) {
    if (this.pending >= MAX_PENDING) {
      return Promise.resolve({ code: -1, stderrTail: ['Hàng đợi Chrome Worker đã đầy.'] });
    }
    this.pending += 1;
    this._idleClear();
    const execute = async () => {
      if (this.retiring) await this.retiring;
      const child = this.child || this._spawn();
      const id = crypto.randomUUID();
      return new Promise(resolve => {
        const timer = setTimeout(() => {
          if (this.active?.id === id) {
            this.active.timedOut = true;
            this._invalidate('Chrome Worker quá thời gian xử lý.');
          }
        }, Math.max(5000, timeoutMs || PY_TIMEOUT_MS));
        this.active = { id, resolve, timer, timedOut: false };
        try {
          if (typeof onSpawn === 'function') {
            onSpawn(() => this._invalidate('Đã dừng Chrome Worker theo yêu cầu.'));
          }
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
  if (process.env.EMR_PERSISTENT_HCHANH_WORKER !== '1' || !command ||
      !runtimeDir || bridgeEnv.EMR_BRIDGE_URL || process.env.EMR_BRIDGE_URL) {
    return runScript('hchanh_fetch.py', args, opts);
  }
  const worker = workers.get(runtimeDir) || new ResidentWorker(runtimeDir);
  workers.set(runtimeDir, worker);
  return worker.run(command, opts);
}

module.exports = { runRecordsCheckBatch, readOnlyJob };
