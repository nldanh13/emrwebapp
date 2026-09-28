// server/services/input_precheck_tokens.js — One-time safety tokens for EMR input actions

'use strict';

const crypto = require('crypto');
const path = require('path');
const { readJsonCritical, writeJsonAtomic, safeUnlink } = require('../utils/file');

const TOKEN_TTL_MS = Math.max(60_000, Math.min(60 * 60 * 1000, Number(process.env.EMR_PRECHECK_TOKEN_TTL_MS || 15 * 60 * 1000))); // mặc định 15 phút
const MAX_TOKENS_PER_SESSION = 60;

function tokenFile(ctx) {
  return path.join(ctx.STATE_DIR || path.join(ctx.dir, 'state'), 'input_precheck_tokens.json');
}

function normalizeTaskName(taskName = '') {
  const t = String(taskName || '').toLowerCase().trim();
  if (['input_infusions', 'infusions', 'infusion', 'dt', 'dich_truyen'].includes(t)) return 'input_infusions';
  if (['input_procedures', 'procedures', 'procedure', 'tt', 'thu_thuat'].includes(t)) return 'input_procedures';
  if (['input_vtyt', 'vtyt', 'supplies', 'supply'].includes(t)) return 'input_vtyt';
  if (['clinic_input_care', 'clinic-care', 'clinic_care', 'cliniccare'].includes(t)) return 'clinic_input_care';
  return 'input_care';
}

function taskNameFromTargets(targets = {}) {
  return normalizeTaskName(targets.taskName || targets.task || targets.taskType || targets.type || 'input_care');
}

function cleanDateList(values) {
  return [...new Set((Array.isArray(values) ? values : [])
    .map(x => String(x || '').trim())
    .filter(Boolean))].sort();
}

function canonicalTargetShape(taskName, targets = {}) {
  const patientIds = cleanDateList(targets.patientIds);
  const patientDates = targets.patientDates && typeof targets.patientDates === 'object' ? targets.patientDates : {};
  const selectedDates = cleanDateList(targets.selectedDates);
  const byPatient = {};
  for (const id of patientIds) {
    const dates = cleanDateList(patientDates[id] || selectedDates);
    byPatient[id] = dates;
  }
  return {
    task: normalizeTaskName(taskName),
    patientIds,
    patientDates: byPatient,
  };
}

function hashTargets(taskName, targets = {}) {
  const canonical = canonicalTargetShape(taskName, targets);
  return crypto.createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

function tokenHash(token) {
  return crypto.createHash('sha256').update(String(token || '')).digest('hex');
}

function readStore(ctx) {
  const now = Date.now();
  const raw = readJsonCritical(tokenFile(ctx), { tokens: [] });
  const tokens = Array.isArray(raw?.tokens) ? raw.tokens : [];
  return {
    tokens: tokens
      .filter(t => t && typeof t === 'object' && Number(t.expires_at_ms || 0) > now)
      .slice(-MAX_TOKENS_PER_SESSION),
  };
}

function writeStore(ctx, store) {
  const tokens = Array.isArray(store?.tokens) ? store.tokens.slice(-MAX_TOKENS_PER_SESSION) : [];
  if (!tokens.length) {
    safeUnlink(tokenFile(ctx));
    return;
  }
  writeJsonAtomic(tokenFile(ctx), { tokens });
}

function issueInputPrecheckToken(ctx, taskName, targets = {}, meta = {}) {
  const normalizedTask = normalizeTaskName(taskName);
  const now = Date.now();
  const token = crypto.randomBytes(24).toString('base64url');
  const store = readStore(ctx);
  store.tokens.push({
    token_hash: tokenHash(token),
    target_hash: hashTargets(normalizedTask, targets),
    task: normalizedTask,
    issued_at: new Date(now).toISOString(),
    issued_at_ms: now,
    expires_at_ms: now + TOKEN_TTL_MS,
    checked_count: Number(meta.checked_count || 0),
  });
  writeStore(ctx, store);
  return {
    precheck_token: token,
    precheck_expires_at: new Date(now + TOKEN_TTL_MS).toISOString(),
    precheck_ttl_seconds: Math.round(TOKEN_TTL_MS / 1000),
  };
}

function validateAndConsumeInputPrecheckToken(ctx, taskName, targets = {}) {
  const token = String(targets.precheck_token || targets.precheckToken || '').trim();
  if (!token) {
    return { ok: false, status: 428, message: 'Chưa có xác nhận kiểm tra y lệnh mới. Hãy bấm nhập lại để hệ thống kiểm tra trước khi nhập EMR.' };
  }
  const normalizedTask = normalizeTaskName(taskName);
  const wantedTokenHash = tokenHash(token);
  const wantedTargetHash = hashTargets(normalizedTask, targets);
  const store = readStore(ctx);
  const idx = store.tokens.findIndex(t => t.token_hash === wantedTokenHash);
  if (idx < 0) {
    writeStore(ctx, store);
    return { ok: false, status: 428, message: 'Xác nhận kiểm tra y lệnh đã hết hạn hoặc đã được dùng. Hãy kiểm tra lại trước khi nhập EMR.' };
  }
  const found = store.tokens[idx];
  store.tokens.splice(idx, 1);
  writeStore(ctx, store);
  if (found.task !== normalizedTask || found.target_hash !== wantedTargetHash) {
    return { ok: false, status: 428, message: 'Xác nhận kiểm tra y lệnh không khớp danh sách BN/ngày cần nhập. Hãy kiểm tra lại trước khi nhập EMR.' };
  }
  return { ok: true, checked_count: found.checked_count || 0 };
}

module.exports = {
  TOKEN_TTL_MS,
  normalizeTaskName,
  taskNameFromTargets,
  canonicalTargetShape,
  hashTargets,
  issueInputPrecheckToken,
  validateAndConsumeInputPrecheckToken,
};
