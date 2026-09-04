// server/services/task_journal.js — Nhật ký tác vụ bền vững qua lần khởi động lại

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { RUNTIME_ROOT } = require('../constants');
const { ensureDir, readJsonCritical, writeJsonAtomic } = require('../utils/file');

const JOURNAL_DIR = path.join(RUNTIME_ROOT, 'task_journal');
const STATE_PATH = path.join(JOURNAL_DIR, 'task_state.json');
const EVENTS_PATH = path.join(JOURNAL_DIR, 'task_events.jsonl');
const MAX_RETAINED_TASKS = Math.max(100, Number.parseInt(process.env.EMR_TASK_JOURNAL_MAX || '5000', 10) || 5000);

function nowIso() { return new Date().toISOString(); }

function ensureJournalDir() {
  ensureDir(JOURNAL_DIR);
  try { fs.chmodSync(JOURNAL_DIR, 0o700); } catch (_) {}
}

function emptyState() {
  return { schema_version: 1, updated_at: nowIso(), tasks: {} };
}

function loadState() {
  ensureJournalDir();
  const state = readJsonCritical(STATE_PATH, emptyState());
  if (!state || typeof state !== 'object' || Array.isArray(state)) return emptyState();
  if (!state.tasks || typeof state.tasks !== 'object' || Array.isArray(state.tasks)) state.tasks = {};
  return state;
}

let state = loadState();

function appendEvent(event) {
  ensureJournalDir();
  fs.appendFileSync(EVENTS_PATH, `${JSON.stringify(event)}\n`, { encoding: 'utf8', mode: 0o600 });
  try { fs.chmodSync(EVENTS_PATH, 0o600); } catch (_) {}
}

function pruneState() {
  const entries = Object.values(state.tasks || {});
  if (entries.length <= MAX_RETAINED_TASKS) return;
  entries.sort((a, b) => String(b.updated_at || b.created_at || '').localeCompare(String(a.updated_at || a.created_at || '')));
  state.tasks = Object.fromEntries(entries.slice(0, MAX_RETAINED_TASKS).map((item) => [item.task_id, item]));
}

function persistState() {
  pruneState();
  state.updated_at = nowIso();
  writeJsonAtomic(STATE_PATH, state);
  try { fs.chmodSync(STATE_PATH, 0o600); } catch (_) {}
}

function createTask({ sid = 'default', queue_type = 'standard', task_type = 'unspecified', metadata = {} } = {}) {
  const taskId = crypto.randomUUID();
  const at = nowIso();
  const task = {
    task_id: taskId,
    sid: String(sid || 'default'),
    queue_type,
    task_type: String(task_type || 'unspecified'),
    status: 'queued',
    created_at: at,
    updated_at: at,
    attempts: 0,
    metadata: metadata && typeof metadata === 'object' ? metadata : {},
  };
  state.tasks[taskId] = task;
  appendEvent({ event: 'task_queued', at, ...task });
  persistState();
  return taskId;
}

function updateTask(taskId, status, fields = {}) {
  const task = state.tasks[taskId];
  if (!task) return null;
  const at = nowIso();
  Object.assign(task, fields, { status, updated_at: at });
  if (status === 'running') {
    task.started_at = task.started_at || at;
    task.attempts = Number(task.attempts || 0) + 1;
  }
  if (['succeeded', 'failed', 'cancelled', 'unknown_after_restart'].includes(status)) task.finished_at = at;
  appendEvent({ event: `task_${status}`, at, task_id: taskId, sid: task.sid, task_type: task.task_type, ...fields });
  persistState();
  return { ...task };
}

function requestCancel(taskId) {
  return updateTask(taskId, 'cancel_requested');
}

function recoverInterruptedTasks() {
  let changed = 0;
  for (const task of Object.values(state.tasks || {})) {
    if (['queued', 'running', 'cancel_requested'].includes(task.status)) {
      updateTask(task.task_id, 'unknown_after_restart', {
        error_code: 'PROCESS_RESTARTED',
        error_message: 'Server khởi động lại trước khi xác nhận kết quả tác vụ.',
      });
      changed += 1;
    }
  }
  return changed;
}

function getTask(taskId) {
  const task = state.tasks[taskId];
  return task ? { ...task } : null;
}

function listTasks({ sid = '', limit = 100 } = {}) {
  return Object.values(state.tasks || {})
    .filter((task) => !sid || task.sid === sid)
    .sort((a, b) => String(b.updated_at || '').localeCompare(String(a.updated_at || '')))
    .slice(0, Math.max(1, Math.min(1000, Number(limit) || 100)))
    .map((task) => ({ ...task }));
}

recoverInterruptedTasks();

module.exports = {
  createTask,
  updateTask,
  requestCancel,
  getTask,
  listTasks,
  recoverInterruptedTasks,
  STATE_PATH,
  EVENTS_PATH,
};
