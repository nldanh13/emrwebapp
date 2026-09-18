// server/routes/sick_leave.js — /api/sick-leave-state
//
// Chỉ lưu trạng thái "đã nộp / chưa nộp" hồ sơ nghỉ ốm (nội trú xuất viện +
// ngoại trú) mà tab "Nghỉ ốm" tự lọc từ dữ liệu đã có sẵn trong app. Không
// tự động nộp lên Cổng Dịch vụ công BHXH — đó là hệ thống ngoài, khác tài
// khoản đăng nhập, cần làm ở bước sau khi có ảnh chụp/mô tả giao diện cổng.

'use strict';

const fs = require('fs');
const path = require('path');
const router = require('express').Router();

const { getRuntimePaths } = require('../services/session');
const { runScript, fmtPyError } = require('../services/python_runner');
const { readJsonSafe, writeJsonAtomic, safeUnlink } = require('../utils/file');
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

function normalizeEntryState(value) {
  const v = value && typeof value === 'object' ? value : {};
  return {
    submitted: Boolean(v.submitted),
    note: String(v.note || '').slice(0, 600),
    updated_at: String(v.updated_at || '').slice(0, 40),
  };
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

module.exports = router;
