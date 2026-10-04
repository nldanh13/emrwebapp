'use strict';

// Chuẩn hóa là quy trình riêng, tách khỏi Thu thập:
//  - Chạy trong một tiến trình Node con: chuẩn hóa đọc/ghi nhiều file đồng bộ, chạy thẳng trong
//    máy chủ sẽ chặn mọi yêu cầu khác (giao diện không cập nhật được, trông như treo).
//  - Có hàng đợi riêng: mỗi lúc chỉ một lần chuẩn hóa (bấm tay hay sau thu thập đều xếp hàng),
//    và khóa riêng "<phạm vi>:normalize" — không dùng khóa của Thu thập, nên đang chuẩn hóa vẫn
//    bấm thu thập được và ngược lại.
//  - Yêu cầu chuẩn hóa trùng phạm vi khi đã có một lần đang chờ thì gộp làm một.
//
// EMR_NORMALIZE_INLINE=1: chạy ngay trong tiến trình hiện tại (dùng cho test / gỡ lỗi).

const path = require('path');
const { fork } = require('child_process');
const { RESEARCH_SCOPE_LOCKS } = require('./research_http');
const { nowIso } = require('./store_paths');

const CHILD = path.join(__dirname, 'normalize_child.js');
const NORMALIZE_LANE = 'normalize';

function normalizeLockKey(scopeKey = 'archive') {
  return `${scopeKey}:${NORMALIZE_LANE}`;
}

function runInline(job) {
  // Inline phải có cùng preflight/repair/integrity với child mode; trước đây đây
  // là một đường vòng có thể gọi normalize trực tiếp và bỏ qua repair raw PT.
  const safe = require('./normalize_safe');
  if (job.kind === 'archive') return safe.normalizeArchiveLatestSafe();
  if (job.kind === 'study') return safe.normalizeStudyLatestSafe(job.studyId);
  return safe.normalizeRunOutputsSafe(job.runDir, job.options || {});
}

function runInChild(job) {
  if (['1', 'true', 'yes'].includes(String(process.env.EMR_NORMALIZE_INLINE || '').toLowerCase())) {
    return Promise.resolve().then(() => runInline(job));
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    const child = fork(CHILD, [], { env: process.env, stdio: ['ignore', 'inherit', 'inherit', 'ipc'], serialization: 'advanced' });
    const done = (fn, value) => { if (!settled) { settled = true; fn(value); } };
    child.on('message', (msg) => {
      if (msg?.ok) done(resolve, msg.result);
      else {
        const err = new Error(String(msg?.error || 'Chuẩn hóa lỗi.'));
        if (msg?.status) err.status = msg.status;
        done(reject, err);
      }
    });
    child.on('error', err => done(reject, err));
    child.on('exit', (code, signal) => {
      if (!settled) done(reject, new Error(`Tiến trình chuẩn hóa dừng bất thường (${signal || `mã ${code}`}).`));
    });
    child.send(job);
  });
}

function scopeKeyForJob(job) {
  if (job.scopeKey) return job.scopeKey;
  if (job.kind === 'study') return `study:${job.studyId}`;
  return 'archive';
}

// Hàng đợi chung: một lần chuẩn hóa tại một thời điểm.
let chain = Promise.resolve();
const pendingByScope = new Map(); // scopeKey -> promise của lần đang chờ (chưa bắt đầu)

// job: { kind: 'archive' } | { kind: 'study', studyId } | { kind: 'run', runDir, options, scopeKey }
// reason: hiện cho người dùng (vd. 'Sau thu thập tự động').
function runNormalizeJob(job, { reason = '' } = {}) {
  const scopeKey = scopeKeyForJob(job);
  const waiting = pendingByScope.get(scopeKey);
  if (waiting) return waiting; // đã có một lần chờ chạy cho phạm vi này: dùng chung kết quả
  const run = async () => {
    pendingByScope.delete(scopeKey);
    const key = normalizeLockKey(scopeKey);
    const token = { label: 'Chuẩn hóa', since: nowIso(), lane: NORMALIZE_LANE, reason };
    RESEARCH_SCOPE_LOCKS.set(key, token);
    try {
      return await runInChild(job);
    } finally {
      if (RESEARCH_SCOPE_LOCKS.get(key) === token) RESEARCH_SCOPE_LOCKS.delete(key);
    }
  };
  const promise = chain.then(run, run);
  pendingByScope.set(scopeKey, promise);
  chain = promise.catch(() => {});
  return promise;
}

function normalizeRunning(scopeKey = 'archive') {
  return RESEARCH_SCOPE_LOCKS.get(normalizeLockKey(scopeKey)) || null;
}

module.exports = { runNormalizeJob, normalizeRunning, normalizeLockKey, NORMALIZE_LANE };
