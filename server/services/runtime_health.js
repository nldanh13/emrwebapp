// server/services/runtime_health.js — Kiểm tra trùng/lệch dữ liệu runtime bằng JS, không cần spawn Python.
'use strict';

const fs = require('fs');
const path = require('path');
const { readJsonSafe } = require('../utils/file');
const { dmyToIso, normalizeDmy } = require('../utils/validation');
const { readUnifiedTicketStore, legacyAdminTicketPath } = require('./unified_ticket_store');

function patientId(row) {
  return String(row?.ma_bn || row?.['Mã BN'] || row?.['Mã YT'] || row?.ma_yt || row?.MaBN || row?.Ma_BN || row?.mabn || row?.id || '').trim();
}

function patientDayKey(row) {
  const id = patientId(row);
  const raw = row?.ngay_lam || row?.['Ngày làm'] || row?.ngay || row?.date || row?.work_date || '';
  const iso = dmyToIso(raw) || String(raw || '').trim();
  return id && iso ? `${id}::${iso}` : '';
}

function canonicalKey(key) {
  const text = String(key || '').trim();
  const m = text.match(/^([^:]+)::([^:]+)(.*)$/);
  if (!m) return text;
  const iso = dmyToIso(m[2]);
  return iso ? `${m[1]}::${iso}${m[3] || ''}` : text;
}

function rowsFrom(value) {
  if (Array.isArray(value)) return value.filter(x => x && typeof x === 'object' && !Array.isArray(x));
  if (value && typeof value === 'object' && value.patient_days && typeof value.patient_days === 'object') {
    return Object.values(value.patient_days).filter(x => x && typeof x === 'object' && !Array.isArray(x));
  }
  if (value && typeof value === 'object' && value.patients && typeof value.patients === 'object') {
    return Object.values(value.patients).filter(x => x && typeof x === 'object' && !Array.isArray(x));
  }
  return [];
}

function duplicateCounts(rows, keyFn) {
  const counts = new Map();
  for (const row of rows) {
    const key = keyFn(row);
    if (!key) continue;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return [...counts.entries()].filter(([, n]) => n > 1).map(([key, count]) => ({ key, count })).slice(0, 50);
}

function oldKeyHits(value, limit = 100) {
  const hits = [];
  function walk(v, p) {
    if (hits.length >= limit) return;
    if (Array.isArray(v)) {
      v.forEach((x, i) => walk(x, `${p}[${i}]`));
      return;
    }
    if (!v || typeof v !== 'object') return;
    for (const [k, child] of Object.entries(v)) {
      const ck = canonicalKey(k);
      if (ck !== k) hits.push(p ? `${p}/${k}` : k);
      if (typeof child === 'string' && canonicalKey(child) !== child) hits.push(p ? `${p}/${k}` : k);
      walk(child, p ? `${p}/${k}` : k);
      if (hits.length >= limit) return;
    }
  }
  walk(value, '');
  return hits;
}

function readMaybe(file) {
  return file && fs.existsSync(file) ? readJsonSafe(file, null) : null;
}


function ticketHealth(ctx, rawIds) {
  const warnings = [];
  const store = readUnifiedTicketStore(ctx, { autoMigrate: false });
  const tickets = Array.isArray(store.tickets) ? store.tickets : [];
  const ids = new Map();
  const openByPatientScope = new Map();
  const activeStatuses = new Set(['OPEN', 'SENT', 'VERIFYING', 'PARTIAL']);
  for (const t of tickets) {
    const id = String(t.ticketId || '').trim();
    if (id) ids.set(id, (ids.get(id) || 0) + 1);
    const pid = String(t.patientId || t.ma_bn || '').trim();
    const scope = String(t.source_scope || t.sourceScope || t.scope || '').trim();
    const status = String(t.status || '').toUpperCase();
    if (pid && activeStatuses.has(status)) {
      const key = `${scope || 'unknown'}::${pid}`;
      if (!openByPatientScope.has(key)) openByPatientScope.set(key, []);
      openByPatientScope.get(key).push(t.ticketId || '(missing-id)');
    }
  }
  const dupIds = [...ids.entries()].filter(([, n]) => n > 1).map(([key, count]) => ({ key, count }));
  if (dupIds.length) warnings.push({ code: 'duplicate_ticket_ids', count: dupIds.length, samples: dupIds.slice(0, 10) });
  const multipleOpen = [...openByPatientScope.entries()].filter(([, list]) => list.length > 1)
    .map(([key, list]) => ({ key, tickets: list.slice(0, 10) }));
  if (multipleOpen.length) warnings.push({ code: 'multiple_open_tickets_same_patient_scope', count: multipleOpen.length, samples: multipleOpen.slice(0, 10) });
  try {
    const legacyPath = legacyAdminTicketPath(ctx);
    if (legacyPath && fs.existsSync(legacyPath)) {
      warnings.push({ code: 'legacy_admin_ticket_store_present', file: path.relative(ctx.dir, legacyPath).replace(/\\/g, '/'), note: 'Ticket adminWorkflow sẽ được migrate vào hchanh/tickets/ticket_store.json khi API ticket được đọc.' });
    }
  } catch (_) {}
  const activeNotRaw = tickets
    .filter(t => ['OPEN', 'SENT', 'VERIFYING', 'PARTIAL'].includes(String(t.status || '').toUpperCase()))
    .map(t => String(t.patientId || t.ma_bn || '').trim())
    .filter(id => id && rawIds && rawIds.size && !rawIds.has(id));
  if (activeNotRaw.length) warnings.push({ code: 'open_ticket_patient_not_in_raw', count: new Set(activeNotRaw).size, samples: [...new Set(activeNotRaw)].slice(0, 20) });
  return { warnings, count: tickets.length };
}

function buildRuntimeHealth(ctx) {
  const raw = readMaybe(ctx.RAW_PATH) || [];
  const sorted = readMaybe(ctx.SORTED_PATH) || [];
  const orders = readMaybe(ctx.FINAL_PATH) || [];
  const processed = readMaybe(ctx.PROCESSED_PATH) || [];
  const board = readMaybe(ctx.BOARD_STATE_PATH) || {};
  const orderDays = readMaybe(ctx.ORDER_DAYS_PATH) || {};
  const classifiedDays = readMaybe(ctx.CLASSIFIED_DAYS_PATH) || {};
  const hchanh = readMaybe(path.join(ctx.dir, 'hchanh', 'index.json')) || {};

  const rawRows = rowsFrom(raw);
  const sortedRows = rowsFrom(sorted);
  const orderRows = rowsFrom(orders);
  const processedRows = rowsFrom(processed);

  const warnings = [];
  const errors = [];

  for (const [name, rows, keyFn] of [
    ['raw', rawRows, patientId],
    ['selected', sortedRows, patientId],
    ['orders', orderRows, patientDayKey],
    ['classified', processedRows, patientDayKey],
  ]) {
    const dup = duplicateCounts(rows, keyFn);
    if (dup.length) warnings.push({ code: 'duplicate_keys', file: name, count: dup.length, samples: dup.slice(0, 10) });
  }

  const rawIds = new Set(rawRows.map(patientId).filter(Boolean));
  const selectedIds = new Set(sortedRows.map(patientId).filter(Boolean));
  const selectedNotRaw = [...selectedIds].filter(id => rawIds.size && !rawIds.has(id));
  if (selectedNotRaw.length) warnings.push({ code: 'selected_not_in_raw', count: selectedNotRaw.length, samples: selectedNotRaw.slice(0, 20) });

  const boardIds = new Set(Array.isArray(board.selected_patient_ids) ? board.selected_patient_ids.map(String) : []);
  if (selectedIds.size && boardIds.size) {
    const selectedOnly = [...selectedIds].filter(id => !boardIds.has(id));
    const boardOnly = [...boardIds].filter(id => !selectedIds.has(id));
    if (selectedOnly.length || boardOnly.length) warnings.push({ code: 'board_state_mismatch', selected_only: selectedOnly.slice(0, 20), board_only: boardOnly.slice(0, 20) });
  }

  if (hchanh && hchanh.patients && typeof hchanh.patients === 'object') {
    const active = Object.entries(hchanh.patients).filter(([, v]) => v && v.active === true).map(([k]) => k);
    const activeNotRaw = active.filter(id => rawIds.size && !rawIds.has(id));
    if (activeNotRaw.length) warnings.push({ code: 'hchanh_active_not_in_raw', count: activeNotRaw.length, samples: activeNotRaw.slice(0, 20) });
  }

  const ticketCheck = ticketHealth(ctx, rawIds);
  warnings.push(...ticketCheck.warnings);

  const keyFiles = {
    order_days: orderDays,
    classified_days: classifiedDays,
    care_done: readMaybe(ctx.CARE_DONE_PATH),
    infusions_done: readMaybe(ctx.INFUSIONS_DONE_PATH),
    procedures_done: readMaybe(ctx.PROCEDURES_DONE_PATH),
    vtyt_done: readMaybe(ctx.VTYT_DONE_PATH),
  };
  for (const [file, payload] of Object.entries(keyFiles)) {
    const hits = oldKeyHits(payload || {});
    if (hits.length) warnings.push({ code: 'legacy_dmy_keys', file, count: hits.length, samples: hits.slice(0, 10) });
  }

  return {
    ok: errors.length === 0,
    sid: ctx.sid,
    updated_at: new Date().toISOString(),
    counts: {
      raw: rawRows.length,
      selected: sortedRows.length,
      orders: orderRows.length,
      classified: processedRows.length,
      order_days: orderDays?.patient_days ? Object.keys(orderDays.patient_days).length : 0,
      classified_days: classifiedDays?.patient_days ? Object.keys(classifiedDays.patient_days).length : 0,
      hchanh_patients: hchanh?.patients ? Object.keys(hchanh.patients).length : 0,
      tickets: ticketCheck.count,
    },
    errors,
    warnings,
  };
}

module.exports = { buildRuntimeHealth };
