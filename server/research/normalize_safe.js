'use strict';

// Một cửa vào an toàn cho mọi đường Chuẩn hóa chính thức.
// Trước normalize: repair raw PT từ bằng chứng explicit + ghi integrity report.
// Sau normalize: cập nhật integrity report để không bỏ sót lỗi thu thập/linkage.

const fs = require('fs');
const path = require('path');
const normalize = require('./normalize');
const { repairRawSurgeryCsv } = require('./surgery_raw_repair');
const { buildCollectionIntegrityReport } = require('./collection_integrity');
const { archiveRunsDir, runsDir } = require('./store_paths');

function latestRunDir(root) {
  if (!fs.existsSync(root)) return null;
  const names = fs.readdirSync(root, { withFileTypes: true })
    .filter(e => e.isDirectory())
    .map(e => e.name)
    .sort((a, b) => b.localeCompare(a));
  if (!names.length) return null;
  return { runId: names[0], runDir: path.join(root, names[0]) };
}

function prepareRunForNormalize(runDir) {
  const dir = path.resolve(runDir);
  const surgeryRawRepair = repairRawSurgeryCsv(dir);
  const integrityBefore = buildCollectionIntegrityReport(dir, { phase: 'before_normalize' });
  return { run_dir: dir, surgery_raw_repair: surgeryRawRepair, integrity_before: integrityBefore };
}

function normalizeRunOutputsSafe(runDir, options = {}) {
  const prep = prepareRunForNormalize(runDir);
  const counts = normalize.normalizeRunOutputs(prep.run_dir, options);
  const integrityAfter = buildCollectionIntegrityReport(prep.run_dir, { phase: 'after_normalize' });
  return { ...counts, surgery_raw_repair: prep.surgery_raw_repair, collection_integrity: integrityAfter };
}

function normalizeArchiveLatestSafe() {
  const latest = latestRunDir(archiveRunsDir());
  if (!latest) throw new Error('Kho dữ liệu gốc chưa có run để chuẩn hóa.');
  const counts = normalizeRunOutputsSafe(latest.runDir, { sourceRunId: latest.runId });
  return { run_id: latest.runId, counts };
}

function normalizeStudyLatestSafe(studyId) {
  const latest = latestRunDir(runsDir(studyId));
  if (!latest) throw new Error('Nghiên cứu chưa có run để chuẩn hóa.');
  const counts = normalizeRunOutputsSafe(latest.runDir, { sourceRunId: latest.runId });
  return { run_id: latest.runId, counts };
}

module.exports = {
  latestRunDir,
  prepareRunForNormalize,
  normalizeRunOutputsSafe,
  normalizeArchiveLatestSafe,
  normalizeStudyLatestSafe,
};
