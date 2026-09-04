// server/services/artifact_store.js — Theo dõi đầu vào/đầu ra từng module, không lưu payload nhạy cảm.

'use strict';

const fs = require('fs');
const path = require('path');
const { CONFIG_DIR, CONFIG_PATH } = require('../constants');
const { ensureDir, readJsonSafe, writeJsonAtomic } = require('../utils/file');

const MAX_ARTIFACT_HISTORY = Math.max(50, Math.min(5000, Number.parseInt(process.env.EMR_ARTIFACT_HISTORY_MAX || '1000', 10) || 1000));

function nowIso() { return new Date().toISOString(); }
function artifactStatePath(ctx) { return path.join(ctx.STATE_DIR || path.join(ctx.dir, 'state'), 'artifacts.json'); }

function emptyState(ctx) {
  return { schema_version: 1, sid: ctx.sid, updated_at: nowIso(), current: {}, history: [] };
}

function loadState(ctx) {
  const state = readJsonSafe(artifactStatePath(ctx), emptyState(ctx));
  if (!state || typeof state !== 'object' || Array.isArray(state)) return emptyState(ctx);
  if (!state.current || typeof state.current !== 'object') state.current = {};
  if (!Array.isArray(state.history)) state.history = [];
  return state;
}

function persistState(ctx, state) {
  state.updated_at = nowIso();
  state.history = state.history.slice(-MAX_ARTIFACT_HISTORY);
  ensureDir(path.dirname(artifactStatePath(ctx)));
  writeJsonAtomic(artifactStatePath(ctx), state);
  try { fs.chmodSync(artifactStatePath(ctx), 0o600); } catch (_) {}
}

function fileInfo(filePath, ctx) {
  try {
    if (!filePath || !fs.existsSync(filePath)) return null;
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) return null;
    return {
      path: path.relative(ctx.dir, filePath).replace(/\\/g, '/'),
      size_bytes: stat.size,
      modified_at: stat.mtime.toISOString(),
    };
  } catch {
    return null;
  }
}

function firstFileInfo(paths, ctx) {
  for (const filePath of paths.filter(Boolean)) {
    const info = fileInfo(filePath, ctx);
    if (info) return info;
  }
  return null;
}

function hasConfiguredConnection() {
  const payload = readJsonSafe(CONFIG_PATH, {});
  let hasUser = false;
  let hasPassword = false;
  const visit = (value, key = '') => {
    if (value == null) return;
    if (typeof value === 'object') {
      for (const [childKey, child] of Object.entries(value)) visit(child, childKey);
      return;
    }
    const text = String(value || '').trim();
    if (!text) return;
    if (/username|user_name|ten_dang_nhap|tai_khoan/i.test(key)) hasUser = true;
    if (/password|pass|mat_khau/i.test(key)) hasPassword = true;
  };
  visit(payload);
  return hasUser && hasPassword;
}

function configuredListExists(filePath) {
  const payload = readJsonSafe(filePath, null);
  if (Array.isArray(payload)) return payload.length > 0;
  return Boolean(payload && typeof payload === 'object' && Object.keys(payload).length > 0);
}

function builtinArtifact(ctx, artifactId) {
  const id = String(artifactId || '').trim();
  if (id === 'session.current') return { ready: true, source: 'runtime', virtual: true };
  if (id === 'emr.connection') return { ready: hasConfiguredConnection(), source: 'config', virtual: true };
  if (id === 'nurse.schedule') {
    const configured = configuredListExists(CONFIG_PATH) || configuredListExists(path.join(ctx.dir, 'd_v2.json'));
    return { ready: configured, source: 'config', virtual: true };
  }
  if (id === 'material.catalog') {
    return { ready: configuredListExists(path.join(CONFIG_DIR, 'vtyt_dictionary.json')), source: 'config', virtual: true };
  }
  if (id === 'records.reference') {
    return { ready: configuredListExists(path.join(CONFIG_DIR, 'hchanh', 'records_check_google_sheet.json')), source: 'config', virtual: true };
  }

  const resultDir = ctx.PROCESSED_PATH ? path.dirname(ctx.PROCESSED_PATH) : ctx.dir;
  const candidates = {
    'patients.raw': [ctx.RAW_PATH],
    'patients.detail': [ctx.PATIENTS_PATH, ctx.SORTED_PATH],
    'orders.raw': [ctx.ORDER_DAYS_PATH, ctx.FINAL_PATH],
    'orders.classified': [ctx.CLASSIFIED_DAYS_PATH, ctx.PROCESSED_PATH],
    'patients.room-scope': [ctx.BOARD_STATE_PATH, ctx.SORTED_PATH],
    'care.result': [path.join(resultDir, 'input_care_result.json'), ctx.CARE_DONE_PATH],
    'infusion.result': [path.join(resultDir, 'input_infusions_result.json'), ctx.INFUSIONS_DONE_PATH],
    'procedure.result': [path.join(resultDir, 'input_procedures_result.json'), ctx.PROCEDURES_DONE_PATH],
    'material.result': [path.join(resultDir, 'input_vtyt_result.json'), ctx.VTYT_DONE_PATH],
  };
  const info = firstFileInfo(candidates[id] || [], ctx);
  return info ? { ready: true, source: 'file', ...info } : { ready: false, source: 'unknown' };
}

function currentArtifact(ctx, artifactId) {
  const id = String(artifactId || '').trim();
  const state = loadState(ctx);
  const recorded = state.current[id];
  if (recorded?.status === 'ready') return { ready: true, source: 'manifest', ...recorded };
  const builtin = builtinArtifact(ctx, id);
  return { artifact_id: id, ...builtin };
}

function alternatives(requirement) {
  if (requirement && typeof requirement === 'object' && !Array.isArray(requirement)) {
    const id = String(requirement.artifact || requirement.id || '').trim();
    return { ids: id.split('|').map(x => x.trim()).filter(Boolean), optional: requirement.optional === true || requirement.mode === 'optional' };
  }
  return { ids: String(requirement || '').split('|').map(x => x.trim()).filter(Boolean), optional: false };
}

function checkRequirement(ctx, requirement, ephemeral = new Map(), plannedProvides = new Set()) {
  const { ids, optional } = alternatives(requirement);
  if (!ids.length) return { ok: true, optional, alternatives: [] };
  const details = ids.map(id => {
    if (ephemeral instanceof Map && ephemeral.has(id)) return { artifact_id: id, ready: true, source: 'workflow-memory' };
    if (plannedProvides instanceof Set && plannedProvides.has(id)) return { artifact_id: id, ready: true, source: 'planned-upstream' };
    return currentArtifact(ctx, id);
  });
  const ok = details.some(item => item.ready) || optional;
  return { ok, optional, alternatives: details, selected: details.find(item => item.ready)?.artifact_id || '' };
}

function checkRequirements(ctx, requirements = [], ephemeral = new Map(), plannedProvides = new Set()) {
  const checks = requirements.map(req => checkRequirement(ctx, req, ephemeral, plannedProvides));
  return {
    ok: checks.every(item => item.ok),
    checks,
    missing: checks.filter(item => !item.ok).flatMap(item => item.alternatives.map(x => x.artifact_id)),
  };
}

function isSensitiveArtifact(id) {
  return /token|credential|cookie|authorization|password|secret/i.test(String(id || ''));
}

function recordOutputs(ctx, { featureId, stepId = '', runId = '', provides = [], status = 'ready', summary = {} } = {}) {
  const state = loadState(ctx);
  const at = nowIso();
  const cleanSummary = {
    status: String(summary?.status || ''),
    count: Number.isFinite(Number(summary?.count)) ? Number(summary.count) : undefined,
    message: String(summary?.message || '').slice(0, 300),
  };
  for (const artifactId of provides.map(String).filter(Boolean)) {
    if (isSensitiveArtifact(artifactId)) continue;
    const entry = {
      artifact_id: artifactId,
      status,
      feature_id: featureId,
      step_id: stepId,
      run_id: runId,
      updated_at: at,
      summary: cleanSummary,
    };
    state.current[artifactId] = entry;
    state.history.push(entry);
  }
  persistState(ctx, state);
  return state;
}

function listArtifacts(ctx) {
  const state = loadState(ctx);
  return {
    status: 'ok',
    sid: ctx.sid,
    updated_at: state.updated_at,
    artifacts: Object.values(state.current).sort((a, b) => String(a.artifact_id).localeCompare(String(b.artifact_id))),
  };
}

module.exports = {
  artifactStatePath,
  currentArtifact,
  checkRequirement,
  checkRequirements,
  recordOutputs,
  listArtifacts,
};
