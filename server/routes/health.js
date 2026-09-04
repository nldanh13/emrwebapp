// server/routes/health.js — /api/health, /api/diagnostics

'use strict';

const router = require('express').Router();
const { buildDiagnostics } = require('../services/diagnostics');
const { getRuntimePaths } = require('../services/session');
const { buildRuntimeHealth } = require('../services/runtime_health');
const { migrateRuntimeKeys, refreshRuntimeV2 } = require('../services/runtime_v2');
const { authStatus } = require('../services/authz');
const { auditPath, verifyAuditFile } = require('../services/security_audit');
const { listDurableTasks, getDurableTask } = require('../services/task_queue');

router.get('/auth/me', (req, res) => {
  const status = authStatus();
  return res.json({
    status: 'ok',
    user: req.auth ? { id: req.auth.id, name: req.auth.name, role: req.auth.role, auth_type: req.auth.auth_type } : null,
    auth_mode: status.mode,
    identified_research_export_enabled: status.identified_research_export_enabled,
  });
});

router.get('/audit/verify', (_req, res) => {
  try {
    const file = auditPath();
    if (!require('fs').existsSync(file)) return res.json({ status: 'ok', exists: false, rows: 0, errors: [] });
    const result = verifyAuditFile(file);
    return res.status(result.ok ? 200 : 500).json({ status: result.ok ? 'ok' : 'error', exists: true, ...result });
  } catch (err) {
    return res.status(500).json({ status: 'error', message: String(err.message || err) });
  }
});

router.get('/tasks', (req, res) => {
  const sid = String(req.query.sid || '').trim();
  const limit = Number.parseInt(req.query.limit || '100', 10);
  return res.json({ status: 'ok', tasks: listDurableTasks({ sid, limit }) });
});

router.get('/tasks/:taskId', (req, res) => {
  const task = getDurableTask(String(req.params.taskId || ''));
  if (!task) return res.status(404).json({ status: 'error', code: 'TASK_NOT_FOUND', message: 'Không tìm thấy tác vụ.' });
  return res.json({ status: 'ok', task });
});

router.get('/health', (req, res) => {
  const info = buildDiagnostics(req, { detailed: false });
  return res.status(info.status === 'ok' ? 200 : 503).json(info);
});

router.get('/diagnostics', (req, res) => {
  const info = buildDiagnostics(req, { detailed: true });
  return res.status(info.status === 'ok' ? 200 : 503).json(info);
});


router.get('/runtime-health', (req, res) => {
  const ctx = getRuntimePaths(req);
  const info = buildRuntimeHealth(ctx);
  return res.status(info.errors && info.errors.length ? 500 : 200).json(info);
});

router.post('/runtime-migrate', async (req, res) => {
  const ctx = getRuntimePaths(req);
  const migrated = await migrateRuntimeKeys(ctx);
  const v2 = await refreshRuntimeV2(ctx, 'runtime_migrate');
  const health = buildRuntimeHealth(ctx);
  return res.status(migrated.code === 0 ? 200 : 500).json({
    status: migrated.code === 0 ? 'ok' : 'error',
    message: migrated.code === 0 ? 'Đã migrate key runtime sang ISO và cập nhật data v2.' : 'Migrate runtime bị lỗi, kiểm tra log server.',
    v2: v2?.indexes || null,
    health,
  });
});

module.exports = router;
