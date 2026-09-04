// server/routes/admin_workflow.js — /api/admin-workflow/*

'use strict';

const router = require('express').Router();
const { getRuntimePaths } = require('../services/session');
const { buildDashboard } = require('../services/adminWorkflow/dashboard');
const { createSnapshot, readSnapshot, writeDelta, readDelta } = require('../services/adminWorkflow/snapshot_store');
const { compareSnapshots } = require('../services/adminWorkflow/delta_diff');
const { upsertTicket, updateTicket, readTicketStore, markTicketsAfterRescan } = require('../services/adminWorkflow/repair_ticket');
const { clearAdminWorkflowState } = require('../services/adminWorkflow/cleanup');
const { buildPrintGuard } = require('../services/adminWorkflow/print_guard');
const { buildPrintQueue, readPrintQueue } = require('../services/adminWorkflow/print_pack');
const { buildGlobalForecast } = require('../services/adminWorkflow/forecast_planner');

function handleRoute(fn) {
  return (req, res) => {
    try {
      const ctx = getRuntimePaths(req);
      return fn(req, res, ctx);
    } catch (err) {
      console.error('[ADMIN-WORKFLOW]', err);
      return res.status(500).json({ status: 'error', message: String(err.message || err) });
    }
  };
}

function getPatientFromDashboard(dashboard, patientId) {
  return (dashboard.patients || []).find(p => String(p.patientId) === String(patientId));
}

router.get('/admin-workflow/dashboard', handleRoute((_req, res, ctx) => {
  return res.json(buildDashboard(ctx));
}));

router.get('/admin-workflow/patient/:patientId', handleRoute((req, res, ctx) => {
  const patientId = String(req.params?.patientId || '').trim();
  const dashboard = buildDashboard(ctx);
  const patient = getPatientFromDashboard(dashboard, patientId);
  if (!patient) return res.status(404).json({ status: 'error', message: 'Không tìm thấy người bệnh trong dashboard workflow.' });
  return res.json({
    status: 'ok',
    patientId,
    patient,
    profile: patient.adminProfile || patient.profile,
    workflowSummary: patient.workflowSummary,
    checklist: patient.checklist,
    actionItems: patient.actionItems || [],
    issues: patient.issues || [],
    qa: patient.qa,
    billingAudit: patient.billingAudit,
    surgeryPackageAudit: patient.surgeryPackageAudit,
    printReady: patient.printReady,
  });
}));


router.post('/admin-workflow/snapshot/morning', handleRoute((_req, res, ctx) => {
  return res.json({ status: 'ok', snapshot: createSnapshot(ctx, 'morning') });
}));

router.post('/admin-workflow/snapshot/afternoon', handleRoute((_req, res, ctx) => {
  return res.json({ status: 'ok', snapshot: createSnapshot(ctx, 'afternoon') });
}));

router.get('/admin-workflow/snapshot', handleRoute((_req, res, ctx) => {
  return res.json({
    status: 'ok',
    morning: readSnapshot(ctx, 'morning'),
    afternoon: readSnapshot(ctx, 'afternoon'),
    delta: readDelta(ctx),
  });
}));

router.post('/admin-workflow/diff', handleRoute((_req, res, ctx) => {
  const morning = readSnapshot(ctx, 'morning');
  const afternoon = readSnapshot(ctx, 'afternoon');
  if (!morning) return res.status(400).json({ status: 'error', message: 'Chưa có Snapshot sáng để so chênh lệch.' });
  if (!afternoon) return res.status(400).json({ status: 'error', message: 'Chưa có Snapshot chiều để so chênh lệch.' });
  if (morning.expired) return res.status(400).json({ status: 'error', message: 'Snapshot sáng đã quá TTL 12 tiếng. Vui lòng chốt lại.' });
  if (afternoon.expired) return res.status(400).json({ status: 'error', message: 'Snapshot chiều đã quá TTL 12 tiếng. Vui lòng quét lại.' });
  return res.json({ status: 'ok', delta: writeDelta(ctx, compareSnapshots(morning, afternoon)) });
}));


router.get('/admin-workflow/forecast', handleRoute((req, res, ctx) => {
  const days = Math.max(1, Math.min(7, Number(req.query?.days || 3) || 3));
  const dashboard = buildDashboard(ctx, { forecastDays: days });
  return res.json({ status: 'ok', forecast: buildGlobalForecast(dashboard.patients, { days }), counts: dashboard.counts });
}));

router.get('/admin-workflow/billing-audit', handleRoute((req, res, ctx) => {
  const patientId = String(req.query?.patientId || '').trim();
  const dashboard = buildDashboard(ctx);
  if (!patientId) {
    return res.json({ status: 'ok', patients: dashboard.patients.map(p => ({ patientId: p.patientId, patientName: p.profile?.name || '', billingAudit: p.billingAudit, qa: p.qa })) });
  }
  const patient = getPatientFromDashboard(dashboard, patientId);
  if (!patient) return res.status(404).json({ status: 'error', message: 'Không tìm thấy người bệnh trong dashboard workflow.' });
  return res.json({ status: 'ok', patientId, billingAudit: patient.billingAudit, qa: patient.qa, patient });
}));

router.get('/admin-workflow/surgery-package', handleRoute((req, res, ctx) => {
  const patientId = String(req.query?.patientId || '').trim();
  const dashboard = buildDashboard(ctx);
  if (!patientId) {
    return res.json({ status: 'ok', patients: dashboard.patients.map(p => ({ patientId: p.patientId, patientName: p.profile?.name || '', surgeryPackageAudit: p.surgeryPackageAudit })) });
  }
  const patient = getPatientFromDashboard(dashboard, patientId);
  if (!patient) return res.status(404).json({ status: 'error', message: 'Không tìm thấy người bệnh trong dashboard workflow.' });
  return res.json({ status: 'ok', patientId, surgeryPackageAudit: patient.surgeryPackageAudit, patient });
}));

router.post('/admin-workflow/discharge-qa', handleRoute((req, res, ctx) => {
  const patientId = String(req.body?.patientId || '').trim();
  const dashboard = buildDashboard(ctx);
  if (!patientId) return res.json({ status: 'ok', patients: dashboard.patients.filter(p => p.qa?.required).map(p => ({ patientId: p.patientId, qa: p.qa, issues: p.issues })) });
  const patient = getPatientFromDashboard(dashboard, patientId);
  if (!patient) return res.status(404).json({ status: 'error', message: 'Không tìm thấy người bệnh trong dashboard workflow.' });
  return res.json({ status: 'ok', patientId, qa: patient.qa, issues: patient.issues, patient });
}));

router.post('/admin-workflow/ticket', handleRoute((req, res, ctx) => {
  const patientId = String(req.body?.patientId || '').trim();
  if (!patientId) return res.status(400).json({ status: 'error', message: 'Thiếu patientId để tạo phiếu sửa.' });
  const dashboard = buildDashboard(ctx);
  const patient = getPatientFromDashboard(dashboard, patientId);
  if (!patient) return res.status(404).json({ status: 'error', message: 'Không tìm thấy người bệnh trong dashboard workflow.' });
  return res.json(upsertTicket(ctx, patient, { doctor: req.body?.doctor, note: req.body?.note }));
}));

router.get('/admin-workflow/tickets', handleRoute((_req, res, ctx) => {
  return res.json({ status: 'ok', ...readTicketStore(ctx) });
}));

router.patch('/admin-workflow/ticket/:ticketId', handleRoute((req, res, ctx) => {
  const result = updateTicket(ctx, req.params.ticketId, req.body || {});
  if (result.status === 'error') return res.status(404).json(result);
  return res.json(result);
}));

router.post('/admin-workflow/rescan', handleRoute((req, res, ctx) => {
  // Xác minh lại trên dữ liệu EMR đã xử lý mới nhất trong session.
  // UI sẽ gọi /api/run-details-one trước khi nghiệm thu từng người bệnh để tránh dùng cache cũ.
  const patientId = String(req.body?.patientId || '').trim();
  const dashboard = buildDashboard(ctx);
  const patient = patientId ? getPatientFromDashboard(dashboard, patientId) : null;
  if (patientId && !patient) return res.status(404).json({ status: 'error', message: 'Không tìm thấy người bệnh để nghiệm thu workflow.' });
  const ticketResult = markTicketsAfterRescan(ctx, dashboard, patientId);
  const refreshed = buildDashboard(ctx);
  return res.json({
    status: 'ok',
    dashboard: refreshed,
    patient: patientId ? getPatientFromDashboard(refreshed, patientId) : null,
    tickets: ticketResult.store,
  });
}));

router.get('/admin-workflow/print-ready', handleRoute((_req, res, ctx) => {
  const dashboard = buildDashboard(ctx);
  return res.json({ status: 'ok', printGuard: buildPrintGuard(dashboard.patients), counts: dashboard.counts, printQueue: readPrintQueue(ctx) });
}));

router.post('/admin-workflow/print-pack', handleRoute((_req, res, ctx) => {
  const result = buildPrintQueue(ctx);
  if (result.status === 'blocked') return res.status(409).json(result);
  return res.json({ status: 'ok', ...result });
}));

router.post('/admin-workflow/clear', handleRoute((_req, res, ctx) => {
  return res.json(clearAdminWorkflowState(ctx));
}));

module.exports = router;
