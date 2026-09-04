'use strict';

const fs = require('fs');
const path = require('path');
const { ensureDir } = require('../../utils/file');
const { safeArray, stableHash } = require('./common');
const { TICKET_STATUS } = require('./constants');
const {
  SOURCE_ADMIN_WORKFLOW,
  canonicalTicketPath,
  legacyAdminTicketPath,
  readScopedTicketStore,
  writeScopedTicketStore,
} = require('../unified_ticket_store');

function adminWorkflowDir(ctx) {
  const dir = path.join(ctx.dir, 'admin_workflow');
  ensureDir(dir);
  return dir;
}

// Tương thích export cũ: từ nay ticket canonical nằm chung ở hchanh/tickets/.
function ticketPath(ctx) {
  return canonicalTicketPath(ctx);
}

function readTicketStore(ctx) {
  return readScopedTicketStore(ctx, SOURCE_ADMIN_WORKFLOW);
}

function writeTicketStore(ctx, store) {
  return writeScopedTicketStore(ctx, SOURCE_ADMIN_WORKFLOW, { ...store, version: 3 });
}

function ticketIdFor(patient) {
  return `AW-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${stableHash([patient.patientId, patient.profile?.name], 6).toUpperCase()}`;
}

function issueSignature(issue) {
  return issue?.id || stableHash([issue?.group, issue?.category, issue?.severity, issue?.title, issue?.detail, issue?.action], 14);
}

function isVtytIssue(issue) {
  const hay = [issue?.group, issue?.category, issue?.title, issue?.detail, issue?.evidence, issue?.action]
    .map(x => String(x || '').toLowerCase())
    .join(' ')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd');
  return /vtyt|vat tu|tieu hao|gac|gang|bom tiem|day truyen|kim luon|catheter|sonde|foley|tegaderm/.test(hay);
}

function activeIssues(patient) {
  return safeArray(patient?.issues || patient?.assessment?.issues).filter(x => x.severity !== 'info' && !isVtytIssue(x));
}

function buildTicketFromPatient(patient, previous = null, patch = {}) {
  const issues = activeIssues(patient);
  if (!issues.length && !previous) {
    return {
      ticketId: ticketIdFor(patient),
      source_scope: SOURCE_ADMIN_WORKFLOW,
      sourceScope: SOURCE_ADMIN_WORKFLOW,
      patientId: patient.patientId,
      ma_bn: patient.patientId,
      status: TICKET_STATUS.NO_ISSUE,
      issues: [],
      message: 'Không có lỗi đỏ/vàng để tạo phiếu sửa.',
    };
  }
  const now = new Date().toISOString();
  const previousLog = safeArray(previous?.logs);
  const status = patch.status || previous?.status || TICKET_STATUS.OPEN;
  const ticket = {
    ...previous,
    ticketId: previous?.ticketId || ticketIdFor(patient),
    ticket_id: previous?.ticketId || ticketIdFor(patient),
    source_scope: SOURCE_ADMIN_WORKFLOW,
    sourceScope: SOURCE_ADMIN_WORKFLOW,
    patientId: patient.patientId,
    ma_bn: patient.patientId,
    patientName: patient.profile?.name || patient.patientName || '',
    ho_ten: patient.profile?.name || patient.patientName || '',
    room: patient.profile?.room || '',
    phong: patient.profile?.room || '',
    scope: 'admin_workflow',
    status: issues.length ? status : TICKET_STATUS.VERIFIED,
    createdAt: previous?.createdAt || now,
    updatedAt: now,
    sentAt: patch.sentAt || previous?.sentAt || null,
    verifiedAt: previous?.verifiedAt || null,
    lastRescanAt: previous?.lastRescanAt || null,
    issueSignatures: issues.map(issueSignature),
    issues: issues.map((it, idx) => ({
      id: issueSignature(it),
      group: it.group || it.category || 'Workflow',
      category: it.category || it.group || 'Workflow',
      severity: it.severity === 'error' ? 'error' : 'warn',
      title: it.title || 'Cần kiểm tra',
      detail: it.detail || it.evidence || '',
      action: it.action || '',
      evidence: it.evidence || '',
      order: idx + 1,
    })),
    logs: previousLog.length ? previousLog : [{ at: now, action: 'created', note: 'Tạo phiếu sửa lỗi hành chánh.' }],
  };
  if (patch.note) ticket.logs = [...ticket.logs, { at: now, action: patch.status ? `status:${patch.status}` : 'note', note: patch.note }];
  return ticket;
}

function upsertTicket(ctx, patient, patch = {}) {
  const store = readTicketStore(ctx);
  const existing = store.tickets.find(t => t.patientId === patient.patientId);
  const ticket = buildTicketFromPatient(patient, existing, patch);
  const tickets = store.tickets.filter(t => t.patientId !== patient.patientId);
  tickets.unshift(ticket);
  return { status: 'ok', ticket, store: writeTicketStore(ctx, { ...store, tickets }) };
}

function updateTicket(ctx, ticketId, patch = {}) {
  const store = readTicketStore(ctx);
  const now = new Date().toISOString();
  let found = null;
  const tickets = store.tickets.map(t => {
    if (t.ticketId !== ticketId && t.patientId !== ticketId) return t;
    found = {
      ...t,
      ...patch,
      source_scope: SOURCE_ADMIN_WORKFLOW,
      sourceScope: SOURCE_ADMIN_WORKFLOW,
      updatedAt: now,
      sentAt: patch.status === TICKET_STATUS.SENT ? (t.sentAt || now) : (patch.sentAt ?? t.sentAt),
      logs: [...safeArray(t.logs), { at: now, action: patch.status ? `status:${patch.status}` : 'update', note: patch.note || '' }],
    };
    return found;
  });
  if (!found) return { status: 'error', message: 'Không tìm thấy phiếu sửa lỗi.' };
  return { status: 'ok', ticket: found, store: writeTicketStore(ctx, { ...store, tickets }) };
}

function markTicketsAfterRescan(ctx, dashboard, patientId = '') {
  const store = readTicketStore(ctx);
  const byId = new Map(safeArray(dashboard?.patients).map(p => [p.patientId, p]));
  const now = new Date().toISOString();
  const tickets = store.tickets.map(ticket => {
    if (patientId && ticket.patientId !== patientId) return ticket;
    const patient = byId.get(ticket.patientId);
    if (!patient) {
      return { ...ticket, status: TICKET_STATUS.STALE, updatedAt: now, lastRescanAt: now, logs: [...safeArray(ticket.logs), { at: now, action: 'rescan:stale', note: 'Không còn thấy người bệnh trong dashboard workflow.' }] };
    }
    const current = new Set(activeIssues(patient).map(issueSignature));
    const unresolved = safeArray(ticket.issueSignatures).filter(sig => current.has(sig));
    const nextStatus = unresolved.length === 0 ? TICKET_STATUS.VERIFIED : unresolved.length < safeArray(ticket.issueSignatures).length ? TICKET_STATUS.PARTIAL : TICKET_STATUS.OPEN;
    return {
      ...ticket,
      status: nextStatus,
      updatedAt: now,
      lastRescanAt: now,
      verifiedAt: nextStatus === TICKET_STATUS.VERIFIED ? now : ticket.verifiedAt,
      unresolvedIssueSignatures: unresolved,
      logs: [...safeArray(ticket.logs), { at: now, action: `rescan:${nextStatus}`, note: nextStatus === TICKET_STATUS.VERIFIED ? 'Re-scan xác nhận đã hết lỗi trong phiếu.' : `Còn ${unresolved.length} lỗi/cảnh báo chưa hết.` }],
    };
  });
  return { status: 'ok', store: writeTicketStore(ctx, { ...store, tickets }) };
}

function ticketsByPatient(ctx) {
  const store = readTicketStore(ctx);
  const map = {};
  for (const ticket of safeArray(store.tickets)) {
    if (!ticket.patientId) continue;
    map[ticket.patientId] = ticket;
  }
  return map;
}

function clearTickets(ctx) {
  const store = readTicketStore(ctx);
  writeTicketStore(ctx, { ...store, tickets: [] });
  // Dọn legacy admin_workflow/ticket_store.json nếu còn để tránh migrate lại.
  try {
    const legacy = legacyAdminTicketPath(ctx);
    if (fs.existsSync(legacy)) fs.rmSync(legacy, { force: true });
  } catch (_) {}
}

module.exports = {
  adminWorkflowDir,
  ticketPath,
  readTicketStore,
  writeTicketStore,
  upsertTicket,
  updateTicket,
  markTicketsAfterRescan,
  ticketsByPatient,
  clearTickets,
  issueSignature,
};
