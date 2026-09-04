// server/routes/care_baseline.js — lấy thông tin chăm sóc/lường cơ bản nhiều khoa

'use strict';

const router = require('express').Router();
const fs = require('fs');
const path = require('path');

const { ROOT_DIR, CARE_STORE_DIR } = require('../constants');
const { getRuntimePaths } = require('../services/session');
const { enqueueHeavy, registerCancel, unregisterCancel } = require('../services/task_queue');
const { runPython, fmtPyError } = require('../services/python_runner');

const SCRIPT_PATH = path.join(ROOT_DIR, 'worker', 'care_baseline_fetch.py');
const CARE_CONFIG_PATH = path.join(ROOT_DIR, 'config', 'care_baseline.json');
const CARE_EXAMPLE_CONFIG_PATH = path.join(ROOT_DIR, 'config', 'care_baseline.example.json');
const CARE_ROOT = CARE_STORE_DIR;
const LATEST_PATH = path.join(CARE_ROOT, 'latest.json');

function nowRunId() {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function safeFilePart(value, fallback = 'run') {
  return String(value || fallback).replace(/[^a-zA-Z0-9_.-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 80) || fallback;
}

function readJsonSafe(file, fallback = null) {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_) {
    return fallback;
  }
}

function configStatus() {
  const exists = fs.existsSync(CARE_CONFIG_PATH);
  const sample = fs.existsSync(CARE_EXAMPLE_CONFIG_PATH);
  let accountCount = 0;
  let enabledCount = 0;
  if (exists) {
    const cfg = readJsonSafe(CARE_CONFIG_PATH, {});
    const accounts = Array.isArray(cfg?.accounts) ? cfg.accounts : [];
    accountCount = accounts.length;
    enabledCount = accounts.filter(a => a && a.enabled !== false).length;
  }
  return {
    exists,
    sample_exists: sample,
    account_count: accountCount,
    enabled_count: enabledCount,
    config_file: 'config/care_baseline.json',
    sample_file: 'config/care_baseline.example.json',
    store_dir: '.runtime/care_baseline',
  };
}

function sanitizeRunBody(body = {}) {
  const out = {};
  if (body.headless !== undefined) out.headless = body.headless !== false;
  if (body.namesOnly !== undefined || body.names_only !== undefined) {
    out.names_only = body.namesOnly === true || body.names_only === true;
  }
  if (body.skipDone !== undefined || body.skip_done !== undefined) {
    out.skip_done = body.skipDone !== false && body.skip_done !== false;
  }
  const minRows = Number.parseInt(String(body.minRowsToSkip || body.min_rows_to_skip || ''), 10);
  if (Number.isFinite(minRows) && minRows > 0) out.min_rows_to_skip = Math.max(1, Math.min(50, minRows));
  for (const [src, dst] of [
    ['runId', 'run_id'], ['admissionFrom', 'admission_from'], ['admissionTo', 'admission_to'],
    ['careFrom', 'care_from'], ['careTo', 'care_to'], ['status', 'status'],
  ]) {
    const value = String(body[src] ?? body[dst] ?? '').trim();
    if (value) out[dst] = value.slice(0, 80);
  }
  const limit = Number.parseInt(String(body.limit || body.patientLimit || ''), 10);
  if (Number.isFinite(limit) && limit > 0) out.limit = Math.max(1, Math.min(20, limit));
  return out;
}

router.get('/care-baseline/status', (_req, res) => {
  res.json({ status: 'ok', config: configStatus(), latest: readJsonSafe(LATEST_PATH, null) });
});

router.get('/care-baseline/latest', (_req, res) => {
  const latest = readJsonSafe(LATEST_PATH, null);
  res.json({ status: 'ok', latest, config: configStatus() });
});

router.get('/care-baseline/export', (req, res) => {
  const runId = safeFilePart(req.query.runId || req.query.run_id || readJsonSafe(LATEST_PATH, {})?.run_id || '');
  if (!runId) return res.status(404).json({ status: 'error', message: 'Chưa có run lường cơ bản.' });
  const csvPath = path.join(CARE_ROOT, 'runs', runId, 'care_baseline.csv');
  if (!fs.existsSync(csvPath)) return res.status(404).json({ status: 'error', message: 'Không tìm thấy file care_baseline.csv.' });
  res.download(csvPath, `care_baseline_${runId}.csv`);
});

router.post('/care-baseline/run', async (req, res) => {
  const ctx = getRuntimePaths(req);
  try {
    if (!fs.existsSync(SCRIPT_PATH)) return res.status(500).json({ status: 'error', message: 'Thiếu worker/care_baseline_fetch.py.' });
    if (!fs.existsSync(CARE_CONFIG_PATH)) {
      return res.status(400).json({
        status: 'error',
        message: 'Chưa có config/care_baseline.json. Hãy copy config/care_baseline.example.json rồi điền password cho các tài khoản. Tên khoa sẽ được đọc tự động sau đăng nhập.',
        config: configStatus(),
      });
    }
    const options = sanitizeRunBody(req.body || {});
    const runId = safeFilePart(options.run_id || nowRunId());
    const args = [SCRIPT_PATH, '--config', CARE_CONFIG_PATH, '--out-root', CARE_ROOT, '--run-id', runId];
    if (options.headless === false) args.push('--no-headless');
    else args.push('--headless');
    if (options.limit) args.push('--limit', String(options.limit));
    if (options.names_only) args.push('--names-only');
    if (options.skip_done) args.push('--skip-done');
    if (options.min_rows_to_skip) args.push('--min-rows-to-skip', String(options.min_rows_to_skip));
    if (options.status) args.push('--status', options.status);
    if (options.admission_from) args.push('--admission-from', options.admission_from);
    if (options.admission_to) args.push('--admission-to', options.admission_to);
    if (options.care_from) args.push('--care-from', options.care_from);
    if (options.care_to) args.push('--care-to', options.care_to);

    await enqueueHeavy(ctx.sid, async () => {
      let result;
      try {
        result = await runPython(args, {
          cwd: ROOT_DIR,
          timeoutMs: Number(process.env.CARE_BASELINE_TIMEOUT_MS || 45 * 60 * 1000),
          onSpawn: killFn => registerCancel(ctx.sid, killFn),
        });
      } finally {
        unregisterCancel(ctx.sid);
      }
      if (result.spawnError) return res.status(500).json({ status: 'error', message: `Không khởi động được Python: ${result.spawnError}` });
      if (result.killedByTimeout) return res.status(504).json({ status: 'error', message: 'Timeout khi lấy lường cơ bản. Dữ liệu đã ghi từng phần nếu worker chạy được một phần.' });
      const summaryPath = path.join(CARE_ROOT, 'runs', runId, 'summary.json');
      const summary = readJsonSafe(summaryPath, null);
      if (result.code !== 0 && !summary) {
        return res.status(500).json({ status: 'error', message: fmtPyError('Python lỗi khi lấy lường cơ bản.', result) });
      }
      const ok = summary?.status === 'ok' || result.code === 0;
      return res.status(ok ? 200 : 500).json({
        status: ok ? 'ok' : 'error',
        message: ok
          ? `Đã lấy lường cơ bản: ${summary?.patients || 0} người bệnh, ${summary?.rows || 0} dòng chăm sóc.`
          : 'Worker lường cơ bản kết thúc nhưng chưa có dữ liệu hợp lệ.',
        run_id: runId,
        summary,
      });
    });
  } catch (err) {
    console.error(err);
    if (!res.headersSent) res.status(500).json({ status: 'error', message: String(err.message || err) });
  }
});

module.exports = router;
