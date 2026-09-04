// server/routes/workflows.js — API plan/run/status workflow và artifact.

'use strict';

const router = require('express').Router();
const { getRuntimePaths } = require('../services/session');
const { publicRegistry, getWorkflow, updateWorkflowOverride, clearOverride } = require('../services/feature_registry');
const { planWorkflow } = require('../services/workflow_planner');
const { runWorkflow } = require('../services/workflow_runner');
const workflowStore = require('../services/workflow_store');
const { listArtifacts } = require('../services/artifact_store');
const { cancelSession } = require('../services/task_queue');
const { requireRole } = require('../services/authz');

router.get('/workflows', (_req, res) => {
  const registry = publicRegistry();
  return res.json({ status: 'ok', workflows: registry.workflows });
});

router.get('/workflows/runs', (req, res) => {
  const ctx = getRuntimePaths(req);
  return res.json({ status: 'ok', runs: workflowStore.listRuns(ctx, { workflowId: String(req.query.workflow_id || ''), limit: req.query.limit }) });
});

router.get('/workflows/runs/:runId', (req, res) => {
  const ctx = getRuntimePaths(req);
  const run = workflowStore.getRun(ctx, req.params.runId);
  if (!run) return res.status(404).json({ status: 'error', code: 'WORKFLOW_RUN_NOT_FOUND', message: 'Không tìm thấy lượt chạy.' });
  return res.json({ status: 'ok', run });
});

router.post('/workflows/:workflowId/plan', (req, res) => {
  const ctx = getRuntimePaths(req);
  try {
    return res.json(planWorkflow(ctx, req.params.workflowId, req.body || {}));
  } catch (err) {
    return res.status(Number(err.status) || 500).json({ status: 'error', code: err.code || 'WORKFLOW_PLAN_FAILED', message: String(err.message || err) });
  }
});

router.post('/workflows/:workflowId/run', async (req, res) => {
  const ctx = getRuntimePaths(req);
  try {
    const run = await runWorkflow(req, ctx, req.params.workflowId, req.body || {});
    return res.status(run.status === 'failed' ? 500 : (run.status === 'partial' ? 207 : 200)).json({ status: run.status, run });
  } catch (err) {
    if (!res.headersSent) return res.status(Number(err.status) || 500).json({ status: 'error', code: err.code || 'WORKFLOW_RUN_FAILED', message: String(err.message || err) });
  }
});

router.post('/workflows/runs/:runId/cancel', (req, res) => {
  const ctx = getRuntimePaths(req);
  const run = workflowStore.requestCancel(ctx, req.params.runId);
  if (!run) return res.status(404).json({ status: 'error', code: 'WORKFLOW_RUN_NOT_FOUND', message: 'Không tìm thấy lượt chạy.' });
  const workerCancelled = cancelSession(ctx.sid);
  return res.json({ status: 'ok', message: workerCancelled ? 'Đã yêu cầu huỷ workflow và worker đang chạy.' : 'Đã yêu cầu workflow dừng sau bước hiện tại.', run });
});

router.get('/artifacts', (req, res) => {
  const ctx = getRuntimePaths(req);
  return res.json(listArtifacts(ctx));
});

router.patch('/workflows/:workflowId/state', requireRole('admin'), (req, res) => {
  try {
    const workflow = getWorkflow(req.params.workflowId);
    if (!workflow) return res.status(404).json({ status: 'error', code: 'WORKFLOW_NOT_FOUND', message: 'Không tìm thấy workflow.' });
    updateWorkflowOverride(workflow.id, req.body || {});
    return res.json({ status: 'ok', workflow: publicRegistry().workflows.find(item => item.id === workflow.id) });
  } catch (err) {
    return res.status(Number(err.status) || 500).json({ status: 'error', code: err.code || 'WORKFLOW_UPDATE_FAILED', message: String(err.message || err) });
  }
});

router.delete('/workflows/:workflowId/state', requireRole('admin'), (req, res) => {
  clearOverride('workflow', req.params.workflowId);
  return res.json({ status: 'ok', workflow: publicRegistry().workflows.find(item => item.id === req.params.workflowId) || null });
});

module.exports = router;
