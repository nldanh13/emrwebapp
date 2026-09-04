// server/services/unified_ticket_store.js — Kho phiếu sửa tập trung cho Hành chánh + Admin Workflow.
//
// Mục tiêu: chỉ còn một file canonical hchanh/tickets/ticket_store.json,
// nhưng vẫn giữ API cũ bằng cách lọc source_scope theo từng module.

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { ensureDir, readJsonSafe, writeJsonAtomic } = require('../utils/file');
const { hchanh_tickets_path } = require('../hchanh_data_contract');

const UNIFIED_TICKET_VERSION = 3;
const SOURCE_HCHANH = 'hchanh';
const SOURCE_ADMIN_WORKFLOW = 'admin_workflow';

const CLOSED_STATUSES = new Set(['VERIFIED', 'CLOSED', 'NO_ISSUE']);

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function nowIso() {
  return new Date().toISOString();
}

function stableHash(value, length = 10) {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify(value || '', Object.keys(value || {}).sort()))
    .digest('hex')
    .slice(0, length);
}

function canonicalTicketPath(ctx) {
  return hchanh_tickets_path(ctx);
}

function legacyAdminTicketPath(ctx) {
  const dir = path.join(ctx.dir, 'admin_workflow');
  return path.join(dir, 'ticket_store.json');
}

function readRawStore(filePath) {
  const data = readJsonSafe(filePath, null);
  if (data && typeof data === 'object' && Array.isArray(data.tickets)) return data;
  return { version: UNIFIED_TICKET_VERSION, updatedAt: null, tickets: [] };
}

function normalizeSourceScope(raw, fallbackSource = SOURCE_HCHANH) {
  const explicit = String(raw?.source_scope || raw?.sourceScope || raw?.module || raw?.ticket_scope || '').trim();
  if (explicit === SOURCE_ADMIN_WORKFLOW || explicit === 'adminWorkflow' || explicit === 'admin') return SOURCE_ADMIN_WORKFLOW;
  if (explicit === SOURCE_HCHANH || explicit === 'hc') return SOURCE_HCHANH;
  return fallbackSource || SOURCE_HCHANH;
}

function normalizeStatus(status) {
  const s = String(status || 'OPEN').trim().toUpperCase();
  return s || 'OPEN';
}

function normalizeIssue(issue, idx = 0) {
  if (!issue || typeof issue !== 'object') {
    return { id: `issue-${idx + 1}`, title: String(issue || 'Cần kiểm tra'), severity: 'warn', order: idx + 1 };
  }
  const id = String(issue.id || issue.signature || '').trim() || stableHash({
    group: issue.group,
    category: issue.category,
    severity: issue.severity,
    title: issue.title,
    detail: issue.detail || issue.evidence,
    action: issue.action,
  }, 14);
  return {
    ...issue,
    id,
    group: issue.group || issue.category || issue.owner || 'Hành chánh',
    category: issue.category || issue.group || 'Hành chánh',
    severity: issue.severity === 'error' ? 'error' : issue.severity === 'info' ? 'info' : 'warn',
    title: issue.title || issue.label || 'Cần kiểm tra',
    detail: issue.detail || issue.evidence || issue.note || '',
    action: issue.action || '',
    evidence: issue.evidence || '',
    order: Number(issue.order || idx + 1) || idx + 1,
  };
}

function normalizeTicket(raw, fallbackSource = SOURCE_HCHANH, idx = 0) {
  const sourceScope = normalizeSourceScope(raw, fallbackSource);
  const patientId = String(raw?.patientId || raw?.ma_bn || raw?.patient_id || raw?.maBn || '').trim();
  const maBn = String(raw?.ma_bn || raw?.patientId || raw?.patient_id || '').trim();
  const createdAt = String(raw?.createdAt || raw?.created_at || raw?.created || '').trim() || nowIso();
  const ticketId = String(raw?.ticketId || raw?.ticket_id || raw?.id || '').trim()
    || `${sourceScope === SOURCE_ADMIN_WORKFLOW ? 'AW' : 'HC'}-${createdAt.slice(0, 10).replace(/-/g, '')}-${stableHash([sourceScope, patientId, raw?.patientName || raw?.ho_ten || '', idx], 8).toUpperCase()}`;
  const issues = safeArray(raw?.issues).map(normalizeIssue);
  const patientName = String(raw?.patientName || raw?.ho_ten || raw?.name || '').trim();
  const room = String(raw?.room || raw?.phong || '').trim();
  const status = normalizeStatus(raw?.status || (issues.length ? 'OPEN' : 'NO_ISSUE'));
  const logs = safeArray(raw?.logs).map(x => (x && typeof x === 'object' ? x : { at: createdAt, action: 'note', note: String(x || '') }));
  return {
    ...raw,
    ticketId,
    ticket_id: ticketId,
    source_scope: sourceScope,
    sourceScope,
    patientId,
    ma_bn: maBn || patientId,
    patientName,
    ho_ten: String(raw?.ho_ten || patientName || '').trim(),
    room,
    phong: String(raw?.phong || room || '').trim(),
    scope: raw?.scope || (sourceScope === SOURCE_ADMIN_WORKFLOW ? 'admin_workflow' : 'daily'),
    status,
    issues,
    issueSignatures: safeArray(raw?.issueSignatures).length ? raw.issueSignatures : issues.map(i => i.id),
    createdAt,
    updatedAt: String(raw?.updatedAt || raw?.updated_at || createdAt).trim() || createdAt,
    logs,
  };
}

function ticketMergeKey(ticket) {
  if (ticket.ticketId) return `id:${ticket.ticketId}`;
  return `fallback:${ticket.source_scope}:${ticket.patientId || ticket.ma_bn}:${ticket.createdAt}`;
}

function newerTicket(a, b) {
  const at = Date.parse(a?.updatedAt || a?.createdAt || '') || 0;
  const bt = Date.parse(b?.updatedAt || b?.createdAt || '') || 0;
  return bt >= at ? b : a;
}

function mergeTickets(...ticketLists) {
  const byKey = new Map();
  for (const list of ticketLists) {
    for (const ticket of safeArray(list)) {
      if (!ticket || typeof ticket !== 'object') continue;
      const key = ticketMergeKey(ticket);
      const old = byKey.get(key);
      byKey.set(key, old ? newerTicket(old, ticket) : ticket);
    }
  }
  return [...byKey.values()].sort((a, b) => {
    const au = Date.parse(a.updatedAt || a.createdAt || '') || 0;
    const bu = Date.parse(b.updatedAt || b.createdAt || '') || 0;
    if (bu !== au) return bu - au;
    return String(a.ticketId).localeCompare(String(b.ticketId));
  });
}

function readUnifiedTicketStore(ctx, options = {}) {
  const autoMigrate = options.autoMigrate !== false;
  const canonicalPath = canonicalTicketPath(ctx);
  const legacyAdminPath = legacyAdminTicketPath(ctx);
  const canonical = readRawStore(canonicalPath);
  const canonicalTickets = safeArray(canonical.tickets).map((t, idx) => normalizeTicket(t, t?.source_scope || SOURCE_HCHANH, idx));

  let legacyAdminTickets = [];
  if (fs.existsSync(legacyAdminPath)) {
    const legacyAdmin = readRawStore(legacyAdminPath);
    legacyAdminTickets = safeArray(legacyAdmin.tickets).map((t, idx) => normalizeTicket(t, SOURCE_ADMIN_WORKFLOW, idx));
  }

  let tickets = mergeTickets(canonicalTickets, legacyAdminTickets);
  if (Array.isArray(options.sources) && options.sources.length) {
    const allowed = new Set(options.sources);
    tickets = tickets.filter(t => allowed.has(t.source_scope));
  }

  const store = {
    version: UNIFIED_TICKET_VERSION,
    updatedAt: canonical.updatedAt || null,
    canonicalPath: path.relative(ctx.dir, canonicalPath).replace(/\\/g, '/'),
    legacyAdminPath: fs.existsSync(legacyAdminPath) ? path.relative(ctx.dir, legacyAdminPath).replace(/\\/g, '/') : null,
    tickets,
  };

  if (autoMigrate && legacyAdminTickets.length) {
    writeUnifiedTicketStore(ctx, { ...store, tickets: mergeTickets(canonicalTickets, legacyAdminTickets) });
  }
  return store;
}

function writeUnifiedTicketStore(ctx, store) {
  const canonicalPath = canonicalTicketPath(ctx);
  const tickets = mergeTickets(safeArray(store?.tickets).map((t, idx) => normalizeTicket(t, t?.source_scope || SOURCE_HCHANH, idx)));
  const out = {
    version: UNIFIED_TICKET_VERSION,
    updatedAt: nowIso(),
    tickets,
  };
  ensureDir(path.dirname(canonicalPath));
  writeJsonAtomic(canonicalPath, out);
  return out;
}

function readScopedTicketStore(ctx, sourceScope) {
  return readUnifiedTicketStore(ctx, { sources: [sourceScope] });
}

function writeScopedTicketStore(ctx, sourceScope, scopedStore) {
  const current = readUnifiedTicketStore(ctx, { autoMigrate: true });
  const incoming = safeArray(scopedStore?.tickets).map((t, idx) => normalizeTicket(t, sourceScope, idx));
  const kept = safeArray(current.tickets).filter(t => t.source_scope !== sourceScope);
  return writeUnifiedTicketStore(ctx, { tickets: mergeTickets(kept, incoming) });
}

function openTicketStatuses() {
  return CLOSED_STATUSES;
}

module.exports = {
  UNIFIED_TICKET_VERSION,
  SOURCE_HCHANH,
  SOURCE_ADMIN_WORKFLOW,
  CLOSED_STATUSES,
  canonicalTicketPath,
  legacyAdminTicketPath,
  normalizeTicket,
  readUnifiedTicketStore,
  writeUnifiedTicketStore,
  readScopedTicketStore,
  writeScopedTicketStore,
  openTicketStatuses,
};
