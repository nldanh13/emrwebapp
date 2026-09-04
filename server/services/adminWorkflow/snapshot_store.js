'use strict';

const fs = require('fs');
const path = require('path');
const { ensureDir, readJsonSafe, writeJsonAtomic } = require('../../utils/file');
const { safeArray, stableHash, normText, toNumber } = require('./common');
const { buildDashboard } = require('./dashboard');
const { SNAPSHOT_TTL_MS } = require('./constants');

function workflowDir(ctx) {
  const dir = path.join(ctx.dir, 'admin_workflow');
  ensureDir(dir);
  return dir;
}

function snapshotPath(ctx, kind) {
  return path.join(workflowDir(ctx), `snapshot_${kind}.json`);
}

function deltaPath(ctx) {
  return path.join(workflowDir(ctx), 'delta_result.json');
}

function normalizeItem({ patient, item, itemType }) {
  const name = String(item?.label || item?.name || item?.ten_thuoc || item?.ten_hien_thi || item?.ten || '').trim();
  if (!name) return null;
  const qty = toNumber(item?.qty ?? item?.quantity ?? item?.so_luong ?? item?.required_quantity ?? 1, 1);
  const route = String(item?.routeLabel || item?.category || item?.source || '').trim();
  const date = String(item?.date || item?.ngay || item?.ngay_lam || '').trim();
  const key = stableHash([patient.patientId, itemType, normText(name), normText(route), normText(date)], 16);
  return {
    key,
    patientId: patient.patientId,
    patientName: patient.profile?.name || patient.patientName || '',
    room: patient.profile?.room || '',
    doctor: patient.profile?.doctor || '',
    itemType,
    name,
    qty,
    route,
    date,
    category: item?.category || '',
    source: item?.source || item?.sourceOrder || '',
  };
}

function patientSnapshot(patient) {
  const items = [];
  for (const drug of safeArray(patient.drugs)) {
    const row = normalizeItem({ patient, item: drug, itemType: 'drug' });
    if (row) items.push(row);
  }
  for (const sup of safeArray(patient.supplyPlan).filter(x => x.category !== 'routine' && x.alert !== false)) {
    const row = normalizeItem({ patient, item: sup, itemType: 'supply' });
    if (row) items.push(row);
  }
  for (const svc of safeArray(patient.services).filter(x => /DVKT|CLS|Thủ thuật|PTTT/i.test(String(x.source || '')) || /phẫu thuật|phau thuat|pttt/i.test(String(x.name || '')))) {
    const row = normalizeItem({ patient, item: svc, itemType: 'service' });
    if (row) items.push(row);
  }
  return {
    patientId: patient.patientId,
    patientName: patient.profile?.name || '',
    room: patient.profile?.room || '',
    doctor: patient.profile?.doctor || '',
    tags: patient.workflowTags || [],
    workflows: patient.workflow?.workflows || [],
    workflowStatus: patient.workflowStatus,
    issueCounts: patient.issueCounts,
    printReady: patient.printReady,
    items,
  };
}

function buildSnapshot(ctx, kind, options = {}) {
  const dashboard = options.dashboard || buildDashboard(ctx);
  const now = new Date();
  return {
    version: 2,
    kind,
    sid: ctx.sid,
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + SNAPSHOT_TTL_MS).toISOString(),
    dashboardCounts: dashboard.counts || {},
    printGuard: dashboard.printGuard || {},
    patients: safeArray(dashboard.patients).map(patientSnapshot),
  };
}

function createSnapshot(ctx, kind) {
  const safeKind = kind === 'afternoon' ? 'afternoon' : 'morning';
  const snapshot = buildSnapshot(ctx, safeKind);
  writeJsonAtomic(snapshotPath(ctx, safeKind), snapshot);
  return snapshot;
}

function readSnapshot(ctx, kind) {
  const snapshot = readJsonSafe(snapshotPath(ctx, kind), null);
  if (!snapshot) return null;
  const exp = Date.parse(snapshot.expiresAt || '');
  if (exp && Date.now() > exp) return { ...snapshot, expired: true };
  return snapshot;
}

function writeDelta(ctx, delta) {
  const out = { version: 2, ...delta, createdAt: delta?.createdAt || new Date().toISOString() };
  writeJsonAtomic(deltaPath(ctx), out);
  return out;
}

function readDelta(ctx) {
  return readJsonSafe(deltaPath(ctx), null);
}

function clearWorkflowFiles(ctx) {
  const dir = workflowDir(ctx);
  const removed = [];
  for (const name of ['snapshot_morning.json', 'snapshot_afternoon.json', 'delta_result.json', 'ticket_store.json', 'handoff_state.json', 'print_queue.json']) {
    const file = path.join(dir, name);
    try {
      if (fs.existsSync(file)) {
        fs.rmSync(file, { force: true });
        removed.push(name);
      }
    } catch (_) {}
  }
  return { status: 'ok', removed, message: 'Đã xóa dữ liệu workflow hành chánh trong session.' };
}

module.exports = {
  workflowDir,
  snapshotPath,
  deltaPath,
  buildSnapshot,
  createSnapshot,
  readSnapshot,
  writeDelta,
  readDelta,
  clearWorkflowFiles,
  normalizeItem,
};
