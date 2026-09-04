// server/services/task_progress.js — Lưu tiến trình tác vụ nhập EMR theo session

'use strict';

const { readJsonCritical, ensureDir, writeJsonAtomic } = require('../utils/file');
const { doneKey } = require('../utils/validation');

function nowIso() {
  return new Date().toISOString();
}

function readProgress(progressPath) {
  const data = readJsonCritical(progressPath, {});
  return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
}

function writeProgress(progressPath, progress) {
  ensureDir(require('path').dirname(progressPath));
  writeJsonAtomic(progressPath, progress || {});
}

function targetKeysFromTargets(targets = {}) {
  const ids = Array.isArray(targets.patientIds)
    ? targets.patientIds.map(x => String(x || '').trim()).filter(Boolean)
    : [];
  const patientDates = (targets.patientDates && typeof targets.patientDates === 'object') ? targets.patientDates : {};
  const selectedDates = Array.isArray(targets.selectedDates)
    ? targets.selectedDates.map(x => String(x || '').trim()).filter(Boolean)
    : [];
  const fallbackDate = String(targets.ngay_lam || '').trim();

  const keys = [];
  const seen = new Set();
  const push = (id, date) => {
    const key = doneKey(id, date || '');
    if (!key || seen.has(key)) return;
    seen.add(key);
    keys.push(key);
  };

  for (const id of ids) {
    const dates = Array.isArray(patientDates[id])
      ? patientDates[id].map(x => String(x || '').trim()).filter(Boolean)
      : [];
    if (dates.length) dates.forEach(date => push(id, date));
    else if (selectedDates.length) selectedDates.forEach(date => push(id, date));
    else push(id, fallbackDate);
  }
  return keys;
}

function beginTask(progressPath, taskName, targets = {}) {
  const progress = readProgress(progressPath);
  const task = progress[taskName] && typeof progress[taskName] === 'object' ? progress[taskName] : {};
  const at = nowIso();
  for (const key of targetKeysFromTargets(targets)) {
    task[key] = {
      ...(task[key] || {}),
      status: 'running',
      started_at: at,
      updated_at: at,
      last_error: '',
    };
  }
  progress[taskName] = task;
  writeProgress(progressPath, progress);
}

function finishTask(progressPath, taskName, pyResult = {}, statusHint = '') {
  const progress = readProgress(progressPath);
  const task = progress[taskName] && typeof progress[taskName] === 'object' ? progress[taskName] : {};
  const at = nowIso();

  const succeeded = Array.isArray(pyResult.succeeded) ? pyResult.succeeded.map(String) : [];
  const failed = pyResult.failed && typeof pyResult.failed === 'object' ? pyResult.failed : {};
  const skippedRaw = pyResult.skipped && typeof pyResult.skipped === 'object' && !Array.isArray(pyResult.skipped) ? pyResult.skipped : {};
  const skipped = Object.fromEntries(Object.entries(skippedRaw).filter(([key]) => key !== 'reason' && key !== 'patient_count'));

  for (const key of succeeded) {
    task[key] = {
      ...(task[key] || {}),
      status: 'done',
      updated_at: at,
      finished_at: at,
      last_error: '',
    };
  }

  for (const [key, message] of Object.entries(failed)) {
    task[key] = {
      ...(task[key] || {}),
      status: statusHint || 'failed',
      updated_at: at,
      finished_at: at,
      last_error: String(message || 'Không rõ lỗi'),
    };
  }

  for (const [key, message] of Object.entries(skipped)) {
    task[key] = {
      ...(task[key] || {}),
      status: 'skipped',
      updated_at: at,
      finished_at: at,
      last_error: String(message || ''),
    };
  }

  progress[taskName] = task;
  writeProgress(progressPath, progress);
}

function failRunningTask(progressPath, taskName, message) {
  const progress = readProgress(progressPath);
  const task = progress[taskName] && typeof progress[taskName] === 'object' ? progress[taskName] : {};
  const at = nowIso();
  for (const [key, item] of Object.entries(task)) {
    if (item && item.status === 'running') {
      task[key] = {
        ...item,
        status: 'failed',
        updated_at: at,
        finished_at: at,
        last_error: String(message || 'Tác vụ bị lỗi trước khi trả kết quả'),
      };
    }
  }
  progress[taskName] = task;
  writeProgress(progressPath, progress);
}


function markRunningTaskStatus(progressPath, taskName, status, message) {
  const progress = readProgress(progressPath);
  const task = progress[taskName] && typeof progress[taskName] === 'object' ? progress[taskName] : {};
  const at = nowIso();
  for (const [key, item] of Object.entries(task)) {
    if (item && item.status === 'running') {
      task[key] = {
        ...item,
        status: String(status || 'skipped'),
        updated_at: at,
        finished_at: at,
        last_error: String(message || ''),
      };
    }
  }
  progress[taskName] = task;
  writeProgress(progressPath, progress);
}

function progressForPatient(progress, patientId) {
  const id = String(patientId || '').trim();
  if (!id || !progress || typeof progress !== 'object') return {};
  const prefix = `${id}::`;
  const out = {};
  for (const [taskName, task] of Object.entries(progress)) {
    if (!task || typeof task !== 'object') continue;
    out[taskName] = Object.fromEntries(
      Object.entries(task).filter(([key]) => key === id || key.startsWith(prefix))
    );
  }
  return out;
}

module.exports = {
  readProgress,
  writeProgress,
  beginTask,
  finishTask,
  failRunningTask,
  markRunningTaskStatus,
  progressForPatient,
  targetKeysFromTargets,
};
