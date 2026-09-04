'use strict';

const path = require('path');
const { writeJsonAtomic, readJsonSafe, ensureDir } = require('../../utils/file');
const { safeArray, stableHash } = require('./common');
const { buildDashboard } = require('./dashboard');
const { buildPrintGuard } = require('./print_guard');

function printQueuePath(ctx) {
  const dir = path.join(ctx.dir, 'admin_workflow');
  ensureDir(dir);
  return path.join(dir, 'print_queue.json');
}

function buildPrintQueue(ctx) {
  const dashboard = buildDashboard(ctx);
  const guard = buildPrintGuard(dashboard.patients);
  if (!guard.canPrintAll) {
    return { status: 'blocked', message: 'Chưa đủ điều kiện in: còn hồ sơ chưa xanh hoặc phiếu sửa chưa nghiệm thu.', printGuard: guard, queue: [] };
  }
  const now = new Date().toISOString();
  const queue = safeArray(dashboard.patients)
    .filter(p => p.workflow?.isLeaving && p.printReady)
    .flatMap(p => ([
      {
        jobId: `PRINT-${stableHash([p.patientId, 'BANG_KE_CHI_PHI', now], 10).toUpperCase()}`,
        patientId: p.patientId,
        patientName: p.profile?.name || '',
        room: p.profile?.room || '',
        doctor: p.profile?.doctor || '',
        documentType: 'BANG_KE_CHI_PHI',
        title: 'Bảng kê chi phí',
        status: 'READY',
      },
      {
        jobId: `PRINT-${stableHash([p.patientId, 'PHIEU_CONG_KHAI', now], 10).toUpperCase()}`,
        patientId: p.patientId,
        patientName: p.profile?.name || '',
        room: p.profile?.room || '',
        doctor: p.profile?.doctor || '',
        documentType: 'PHIEU_CONG_KHAI',
        title: 'Phiếu công khai',
        status: 'READY',
      },
    ]));
  const payload = { version: 1, status: 'ready', createdAt: now, printGuard: guard, queue };
  writeJsonAtomic(printQueuePath(ctx), payload);
  return payload;
}

function readPrintQueue(ctx) {
  return readJsonSafe(printQueuePath(ctx), { version: 1, status: 'empty', queue: [] });
}

module.exports = { printQueuePath, buildPrintQueue, readPrintQueue };
