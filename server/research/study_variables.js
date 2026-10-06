'use strict';

// Thêm / bớt biến của một nghiên cứu riêng. Chỉ đổi danh sách biến (không đổi tiêu chuẩn chọn mẫu),
// chỉ ghi vào thư mục của nghiên cứu: dựng lại analysis_selected.csv của run mới nhất từ dữ liệu đã
// có trong run đó. Không mở EMR, không đụng kho dữ liệu gốc.

const fs = require('fs');
const path = require('path');
const { readStudy, resolveRunId, updateStudy } = require('./run_registry');
const { runsDir, TABLES } = require('./store_paths');
const { readCsvTable } = require('./table_io');
const { activeVariableSelectionFromStudy, sanitizeVariableSelection, loadRunTablesForSelection, buildSelectedAnalysisForRun } = require('./selection_runtime');
const { snapshotFinalDatasetIfUnsaved } = require('./dataset_store');

function fail(message, status = 400) {
  const err = new Error(message);
  err.status = status;
  throw err;
}

function updateStudyVariables(studyId, selectedVariables) {
  const study = readStudy(studyId);
  if (!study) fail('Không tìm thấy nghiên cứu.', 404);
  if (!Array.isArray(selectedVariables) || !selectedVariables.length) fail('Chọn ít nhất 1 biến.');
  const current = activeVariableSelectionFromStudy(study) || {};
  // Giữ nguyên tiêu chuẩn chọn mẫu, mốc, thời gian nghiên cứu — chỉ thay danh sách biến.
  const next = sanitizeVariableSelection({ ...current, selected_variables: selectedVariables });
  if (!next.selected_variables.length) fail('Biến không hợp lệ. Tải lại trang rồi chọn lại.');

  const updated = updateStudy(study.id, {
    variable_selection: next,
    analysis_config: { ...(study.analysis_config || {}), variable_selection: next },
  });

  let rebuilt = null;
  const runId = resolveRunId(study.id, 'latest');
  const runDir = runId ? path.join(runsDir(study.id), runId) : '';
  const readyFile = runDir ? path.join(runDir, TABLES.analysis_ready.file) : '';
  if (readyFile && fs.existsSync(readyFile)) {
    // Dataset cuối dựng theo danh sách biến cũ: lưu bản sao (nếu chưa lưu) rồi gỡ, như khi chuẩn hóa lại.
    snapshotFinalDatasetIfUnsaved(runDir, 'superseded_by_variable_change');
    try { fs.unlinkSync(path.join(runDir, 'analysis_final.csv')); } catch (_) {}
    const ready = readCsvTable(readyFile, Number.MAX_SAFE_INTEGER).rows || [];
    const tables = loadRunTablesForSelection(runDir, next);
    rebuilt = buildSelectedAnalysisForRun(runDir, ready, { ...tables, analysis_ready: ready }, next);
  }
  return {
    study: updated,
    run_id: runId,
    rows: rebuilt?.rows || 0,
    variables: next.selected_variables.length,
  };
}

module.exports = { updateStudyVariables };
