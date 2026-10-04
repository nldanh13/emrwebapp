'use strict';

// Chạy Chuẩn hóa trong một tiến trình Node riêng. Chuẩn hóa đọc/ghi nhiều file đồng bộ và có
// thể mất vài phút với kho lớn; chạy thẳng trong máy chủ sẽ chặn mọi yêu cầu khác (giao diện
// không cập nhật tiến độ, trông như treo). Tiến trình con dùng cùng code và biến môi trường.
//
// EMR_NORMALIZE_INLINE=1: chạy ngay trong tiến trình hiện tại (dùng cho test / gỡ lỗi).

const path = require('path');
const { fork } = require('child_process');

const CHILD = path.join(__dirname, 'normalize_child.js');

function runInline(job) {
  const normalize = require('./normalize');
  if (job.kind === 'archive') return normalize.normalizeArchiveLatest();
  if (job.kind === 'study') return normalize.normalizeStudyLatest(job.studyId);
  return normalize.normalizeRunOutputs(job.runDir, job.options || {});
}

// job: { kind: 'archive' } | { kind: 'study', studyId } | { kind: 'run', runDir, options }
function runNormalizeJob(job) {
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

module.exports = { runNormalizeJob };
