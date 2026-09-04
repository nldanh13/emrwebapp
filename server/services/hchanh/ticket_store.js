// server/services/hchanh/ticket_store.js
// Adapter phiếu sửa hồ sơ cho module Hành chánh.
// Dữ liệu được lưu chung trong hchanh/tickets/ticket_store.json cùng adminWorkflow,
// nhưng API cũ vẫn chỉ đọc/ghi các ticket source_scope='hchanh'.

'use strict';

const {
  SOURCE_HCHANH,
  readScopedTicketStore,
  writeScopedTicketStore,
  CLOSED_STATUSES,
} = require('../unified_ticket_store');

const TICKET_STATUS = Object.freeze({
  OPEN:       'OPEN',
  SENT:       'SENT',
  VERIFYING:  'VERIFYING',
  VERIFIED:   'VERIFIED',
  PARTIAL:    'PARTIAL',
  STALE:      'STALE',
  CLOSED:     'CLOSED',
  NO_ISSUE:   'NO_ISSUE',
});

function readTicketStore(ctx) {
  return readScopedTicketStore(ctx, SOURCE_HCHANH);
}

function writeTicketStore(ctx, store) {
  return writeScopedTicketStore(ctx, SOURCE_HCHANH, { ...store, version: 3 });
}

function makeTicketId(ma_bn) {
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const rand = Math.random().toString(36).slice(2, 6).toUpperCase();
  return `HC-${date}-${String(ma_bn || '').slice(0, 8)}-${rand}`;
}

function openTicketForPatient(store, ma_bn) {
  return (store.tickets || []).find(t =>
    String(t.ma_bn || t.patientId || '') === String(ma_bn || '') &&
    !CLOSED_STATUSES.has(String(t.status || '').toUpperCase())
  );
}

// Tạo hoặc cập nhật phiếu sửa cho 1 BN.
// issues: mảng issue từ discharge QA hoặc do người dùng tạo thủ công.
function upsertTicket(ctx, ma_bn, meta, patient_data, patch = {}) {
  const store = readTicketStore(ctx);
  const existing = openTicketForPatient(store, ma_bn);
  const issues = Array.isArray(patch.issues) ? patch.issues : [];

  if (!issues.length && !existing) {
    return {
      status: 'ok',
      ticket: {
        ticketId: makeTicketId(ma_bn),
        source_scope: SOURCE_HCHANH,
        sourceScope: SOURCE_HCHANH,
        patientId: ma_bn,
        ma_bn,
        patientName: meta?.ho_ten || '',
        ho_ten: meta?.ho_ten || '',
        room: meta?.phong || '',
        phong: meta?.phong || '',
        scope: meta?.scope_default || 'daily',
        status: TICKET_STATUS.NO_ISSUE,
        issues: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
      created: false,
      message: 'Không có vấn đề cần tạo phiếu sửa.',
    };
  }

  if (existing) {
    existing.issues = issues.length ? issues : existing.issues;
    existing.issueSignatures = (existing.issues || []).map((x, idx) => x?.id || x?.signature || `issue-${idx + 1}`);
    existing.doctor = patch.doctor || existing.doctor;
    existing.note = patch.note || existing.note;
    existing.updatedAt = new Date().toISOString();
    const tickets = (store.tickets || []).map(t => t.ticketId === existing.ticketId ? existing : t);
    writeTicketStore(ctx, { ...store, tickets });
    return { status: 'ok', ticket: existing, created: false };
  }

  const ticket = {
    ticketId: makeTicketId(ma_bn),
    source_scope: SOURCE_HCHANH,
    sourceScope: SOURCE_HCHANH,
    patientId: ma_bn,
    ma_bn,
    patientName: meta?.ho_ten || '',
    ho_ten: meta?.ho_ten || '',
    room: meta?.phong || '',
    phong: meta?.phong || '',
    encounter_key: meta?.encounter_key || '',
    scope: meta?.scope_default || 'daily',
    status: TICKET_STATUS.OPEN,
    issues,
    issueSignatures: issues.map((x, idx) => x?.id || x?.signature || `issue-${idx + 1}`),
    doctor: patch.doctor || '',
    note: patch.note || '',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    logs: [{ at: new Date().toISOString(), action: 'created', note: 'Tạo phiếu sửa hồ sơ hành chánh.' }],
  };

  store.tickets.push(ticket);
  writeTicketStore(ctx, store);
  return { status: 'ok', ticket, created: true };
}

function updateTicket(ctx, ticketId, patch = {}) {
  const store = readTicketStore(ctx);
  const ticket = (store.tickets || []).find(t => t.ticketId === ticketId || t.patientId === ticketId || t.ma_bn === ticketId);
  if (!ticket) return { status: 'error', message: `Không tìm thấy phiếu ${ticketId}.` };

  const allowedStatuses = Object.values(TICKET_STATUS);
  if (patch.status && allowedStatuses.includes(String(patch.status).toUpperCase())) ticket.status = String(patch.status).toUpperCase();
  if (patch.note !== undefined) ticket.note = patch.note;
  if (patch.doctor !== undefined) ticket.doctor = patch.doctor;
  ticket.updatedAt = new Date().toISOString();
  ticket.logs = [
    ...(Array.isArray(ticket.logs) ? ticket.logs : []),
    { at: ticket.updatedAt, action: patch.status ? `status:${ticket.status}` : 'update', note: patch.note || '' },
  ];

  writeTicketStore(ctx, { ...store, tickets: store.tickets.map(t => t.ticketId === ticket.ticketId ? ticket : t) });
  return { status: 'ok', ticket };
}

module.exports = { readTicketStore, writeTicketStore, upsertTicket, updateTicket, TICKET_STATUS };
