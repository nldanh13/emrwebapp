// server/routes/sick_leave.js — /api/sick-leave-state
//
// Chỉ lưu trạng thái "đã nộp / chưa nộp" hồ sơ nghỉ ốm (nội trú xuất viện +
// ngoại trú) mà tab "Nghỉ ốm" tự lọc từ dữ liệu đã có sẵn trong app. Không
// tự động nộp lên Cổng Dịch vụ công BHXH — đó là hệ thống ngoài, khác tài
// khoản đăng nhập, cần làm ở bước sau khi có ảnh chụp/mô tả giao diện cổng.

'use strict';

const path = require('path');
const router = require('express').Router();

const { getRuntimePaths } = require('../services/session');
const { readJsonSafe, writeJsonAtomic } = require('../utils/file');

function getStatePath(req) {
  const ctx = getRuntimePaths(req);
  return path.join(ctx.dir, 'sick_leave_state.json');
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

module.exports = router;
