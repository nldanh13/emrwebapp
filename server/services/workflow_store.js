// server/services/workflow_store.js — Nhật ký workflow theo session.

'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { readJsonSafe, writeJsonAtomic, ensureDir } = require('../utils/file');

const MAX_RUNS = Math.max(20, Math.min(1000, Number.parseInt(process.env.EMR_WORKFLOW_RUNS_MAX || '200', 10) || 200));

function nowIso() { return new Date().toISOString(); }
function statePath(ctx) { return path.join(ctx.STATE_DIR || path.join(ctx.dir, 'state'), 'workflow_runs.json'); }
function emptyState(ctx) { return { schema_version: 1, sid: ctx.sid, updated_at: nowIso(), runs: {} }; }

function load(ctx) {
  const state = readJsonSafe(statePath(ctx), emptyState(ctx));
  if (!state || typeof state !== 'object' || Array.isArray(state)) return emptyState(ctx);
  if (!state.runs || typeof state.runs !== 'object') state.runs = {};
  return state;
}

function persist(ctx, state) {
  const rows = Object.values(state.runs || {}).sort((a, b) => String(b.updated_at || '').localeCompare(String(a.updated_at || '')));
  state.runs = Object.fromEntries(rows.slice(0, MAX_RUNS).map(row => [row.run_id, row]));
  state.updated_at = nowIso();
  ensureDir(path.dirname(statePath(ctx)));
  writeJsonAtomic(statePath(ctx), state);
  try { fs.chmodSync(statePath(ctx), 0o600); } catch (_) {}
}

function createRun(ctx, { workflowId, actor = null, plan = null, metadata = {} } = {}) {
  const state = load(ctx);
  const at = nowIso();
  const run = {
    run_id: crypto.randomUUID(),
    workflow_id: workflowId,
    sid: ctx.sid,
    status: 'queued',
    created_at: at,
    updated_at: at,
    actor: actor ? { id: actor.id, name: actor.name, role: actor.role } : null,
    plan,
    steps: [],
    metadata,
    cancel_requested: false,
  };
  state.runs[run.run_id] = run;
  persist(ctx, state);
  return { ...run };
}

function updateRun(ctx, runId, patch = {}) {
  const state = load(ctx);
  const run = state.runs[runId];
  if (!run) return null;
  Object.assign(run, patch, { updated_at: nowIso() });
  if (['succeeded', 'partial', 'failed', 'cancelled'].includes(run.status) && !run.finished_at) run.finished_at = run.updated_at;
  persist(ctx, state);
  return JSON.parse(JSON.stringify(run));
}

function getRun(ctx, runId) {
  const run = load(ctx).runs[runId];
  return run ? JSON.parse(JSON.stringify(run)) : null;
}

function listRuns(ctx, { workflowId = '', limit = 50 } = {}) {
  return Object.values(load(ctx).runs)
    .filter(run => !workflowId || run.workflow_id === workflowId)
    .sort((a, b) => String(b.updated_at || '').localeCompare(String(a.updated_at || '')))
    .slice(0, Math.max(1, Math.min(200, Number(limit) || 50)))
    .map(run => JSON.parse(JSON.stringify(run)));
}

function requestCancel(ctx, runId) {
  return updateRun(ctx, runId, { cancel_requested: true, status: 'cancel_requested' });
}

module.exports = { statePath, createRun, updateRun, getRun, listRuns, requestCancel };
