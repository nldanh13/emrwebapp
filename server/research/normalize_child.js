'use strict';

// Tiến trình con chạy một lần Chuẩn hóa rồi thoát (xem normalize_runner.js).
process.on('message', (job) => {
  const finish = (payload) => process.send(payload, () => process.exit(0));
  try {
    const normalize = require('./normalize');
    let result;
    if (job?.kind === 'archive') result = normalize.normalizeArchiveLatest();
    else if (job?.kind === 'study') result = normalize.normalizeStudyLatest(job.studyId);
    else result = normalize.normalizeRunOutputs(job.runDir, job.options || {});
    finish({ ok: true, result });
  } catch (err) {
    finish({ ok: false, error: String(err?.message || err), status: err?.status || 0 });
  }
});
