// server/routes/admin_nurse.js — /api/admin-nurse-state

'use strict';

const path = require('path');
const router = require('express').Router();

const { getRuntimePaths, ensureSessionAssets } = require('../services/session');
const { runScript, fmtPyError } = require('../services/python_runner');
const { enqueueHeavy, registerCancel, unregisterCancel } = require('../services/task_queue');
const { ROOT_DIR } = require('../constants');
const { readJsonSafe, safeFilePart, writeJsonAtomic } = require('../utils/file');

function getStatePath(req) {
  const ctx = getRuntimePaths(req);
  return path.join(ctx.dir, 'admin_nurse_state.json');
}

function cleanKey(key) {
  return String(key || '').trim().slice(0, 260);
}

function normalizeTaskState(value) {
  const v = value && typeof value === 'object' ? value : {};
  return {
    done: Boolean(v.done),
    note: String(v.note || '').slice(0, 600),
    updated_at: String(v.updated_at || '').slice(0, 40),
  };
}

function normalizeState(body) {
  const input = body && typeof body === 'object' ? body : {};
  const sourceTasks = input.tasks && typeof input.tasks === 'object' ? input.tasks : {};
  const tasks = {};
  for (const [rawKey, rawValue] of Object.entries(sourceTasks)) {
    const key = cleanKey(rawKey);
    if (!key) continue;
    tasks[key] = normalizeTaskState(rawValue);
  }
  return {
    version: 1,
    updated_at: new Date().toISOString(),
    tasks,
  };
}

// GET /api/admin-nurse-state
router.get('/admin-nurse-state', (req, res) => {
  const saved = readJsonSafe(getStatePath(req), { version: 1, tasks: {} });
  const normalized = normalizeState(saved);
  normalized.updated_at = saved?.updated_at || '';
  return res.json({ status: 'ok', ...normalized });
});

// POST /api/admin-nurse-state
router.post('/admin-nurse-state', (req, res) => {
  const next = normalizeState(req.body || {});
  try {
    writeJsonAtomic(getStatePath(req), next);
    return res.json({ status: 'ok', ...next });
  } catch (err) {
    return res.status(500).json({ status: 'error', message: `Không ghi được admin_nurse_state.json: ${err.message || err}` });
  }
});


function normalizePatientId(value) {
  return String(value || '').trim();
}

function getRowPatientId(row) {
  return normalizePatientId(row?.ma_bn || row?.['Mã BN'] || row?.['Mã YT'] || row?.ma_yt || row?.MaBN || row?.Ma_BN || row?.mabn || row?.id);
}

function normalizePatientPayload(input) {
  const p = input && typeof input === 'object' ? input : {};
  const id = getRowPatientId(p);
  return {
    ma_bn: id,
    'Mã BN': id,
    ho_ten: String(p.ho_ten || p.name || p['Họ tên'] || '').trim(),
    'Họ tên': String(p.ho_ten || p.name || p['Họ tên'] || '').trim(),
    Vi_Tri: String(p.so_phong || p.room || p.Vi_Tri || p.phong_giuong || '').trim(),
    phong_giuong: String(p.so_phong || p.room || p.Vi_Tri || p.phong_giuong || '').trim(),
    bac_si: String(p.bac_si || p['Bác sĩ'] || '').trim(),
    'Bác sĩ': String(p.bac_si || p['Bác sĩ'] || '').trim(),
    chan_doan: String(p.chan_doan || p['Chẩn đoán'] || '').trim(),
    'Chẩn đoán': String(p.chan_doan || p['Chẩn đoán'] || '').trim(),
  };
}

function findPatientRow(ctx, patientId, fallback) {
  const sources = [
    readJsonSafe(ctx.SORTED_PATH, []),
    readJsonSafe(ctx.RAW_PATH, []),
    readJsonSafe(ctx.PROCESSED_PATH, []),
  ];
  for (const src of sources) {
    if (!Array.isArray(src)) continue;
    const row = src.find(r => getRowPatientId(r) === patientId);
    if (row) return { ...row, ...fallback };
  }
  return fallback;
}

// POST /api/check-current-bed
// Mở hồ sơ người bệnh bằng Selenium, bấm #btnBG/onShowBuongGiuong, chỉ đọc timeline buồng giường hiện tại.
router.post('/check-current-bed', async (req, res) => {
  const ctx = getRuntimePaths(req);
  const patient = normalizePatientPayload(req.body?.patient || req.body || {});
  const patientId = patient.ma_bn;
  if (!patientId) return res.status(400).json({ status: 'error', message: 'Thiếu mã bệnh nhân để kiểm buồng giường.' });

  try {
    ensureSessionAssets(ctx.dir, ROOT_DIR);
    await enqueueHeavy(ctx.sid, async () => {
      const row = findPatientRow(ctx, patientId, patient);
      const filePart = safeFilePart(patientId) || 'unknown';
      const inputPath = path.join(ctx.dir, `bed_current_${filePart}.input.json`);
      const outPath = path.join(ctx.dir, `bed_current_${filePart}.json`);
      writeJsonAtomic(inputPath, [row]);

      let result;
      try {
        result = await runScript('bed_current_check.py', ['--input', inputPath, '--out', outPath], {
          cwd: ctx.dir,
          runtimeDir: ctx.dir,
          onSpawn: killFn => registerCancel(ctx.sid, killFn),
        });
      } finally {
        unregisterCancel(ctx.sid);
      }

      if (result.spawnError)      return res.status(500).json({ status: 'error', message: `Không khởi động được Python: ${result.spawnError}` });
      if (result.killedByTimeout) return res.status(504).json({ status: 'error', message: 'Timeout khi kiểm buồng giường hiện tại' });
      if (result.code !== 0)      return res.status(500).json({ status: 'error', message: fmtPyError('Python lỗi khi kiểm buồng giường hiện tại.', result) });

      const output = readJsonSafe(outPath, null);
      if (!output || typeof output !== 'object') {
        return res.status(500).json({ status: 'error', message: 'Không đọc được kết quả kiểm buồng giường.' });
      }
      return res.json(output);
    });
  } catch (err) {
    console.error(err);
    if (!res.headersSent) res.status(500).json({ status: 'error', message: String(err.message || err) });
  }
});

module.exports = router;
