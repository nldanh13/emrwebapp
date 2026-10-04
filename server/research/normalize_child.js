'use strict';

// Tiến trình con chạy một lần Chuẩn hóa rồi thoát (xem normalize_runner.js).
process.on('message', (job) => {
  const finish = (payload) => process.send(payload, () => process.exit(0));
  try {
    const normalize = require('./normalize');
    const { repairRawSurgeryCsv } = require('./surgery_raw_repair');
    let result;
    if (job?.kind === 'archive') result = normalize.normalizeArchiveLatest();
    else if (job?.kind === 'study') result = normalize.normalizeStudyLatest(job.studyId);
    else {
      // Hành chánh đã lưu Raw JSON của màn hình phẫu thuật. Sửa các dòng legacy
      // (đặc biệt trường hợp `bat_dau` chỉ có giờ, còn ngày nằm ở `thoi_gian`)
      // trước khi normalize để không làm rơi ca phẫu thuật khỏi surgery_results.csv.
      const surgeryRepair = repairRawSurgeryCsv(job.runDir);
      result = normalize.normalizeRunOutputs(job.runDir, job.options || {});
      if (result && typeof result === 'object') result.surgery_raw_repair = surgeryRepair;
    }
    finish({ ok: true, result });
  } catch (err) {
    finish({ ok: false, error: String(err?.message || err), status: err?.status || 0 });
  }
});
