'use strict';

// Tiến trình con chạy một lần Chuẩn hóa rồi thoát (xem normalize_runner.js).
// Mọi đường archive/study/run đều đi qua normalize_safe để không có nhánh nào
// quên repair raw PT hoặc bỏ qua kiểm tra integrity.
process.on('message', (job) => {
  const finish = (payload) => process.send(payload, () => process.exit(0));
  try {
    const safe = require('./normalize_safe');
    let result;
    if (job?.kind === 'archive') result = safe.normalizeArchiveLatestSafe();
    else if (job?.kind === 'study') result = safe.normalizeStudyLatestSafe(job.studyId);
    else result = safe.normalizeRunOutputsSafe(job.runDir, job.options || {});
    finish({ ok: true, result });
  } catch (err) {
    finish({ ok: false, error: String(err?.message || err), status: err?.status || 0 });
  }
});
