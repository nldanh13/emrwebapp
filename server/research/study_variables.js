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

// Dựng lại "Biến đã chọn" (analysis_selected.csv) của run mới nhất theo danh sách biến hiện tại.
// Dùng khi đổi biến và ngay trước khi xuất, để file xuất luôn khớp thống kê (cùng cách chọn mẫu).
function rebuildStudySelected(study, { keepFinal = false } = {}) {
  const selection = activeVariableSelectionFromStudy(study);
  if (!selection?.selected_variables?.length) return null;
  const runId = resolveRunId(study.id, 'latest');
  const runDir = runId ? path.join(runsDir(study.id), runId) : '';
  const readyFile = runDir ? path.join(runDir, TABLES.analysis_ready.file) : '';
  if (!readyFile || !fs.existsSync(readyFile)) return null;
  if (!keepFinal) {
    // Dataset cuối dựng theo danh sách biến cũ: lưu bản sao (nếu chưa lưu) rồi gỡ, như khi chuẩn hóa lại.
    snapshotFinalDatasetIfUnsaved(runDir, 'superseded_by_variable_change');
    try { fs.unlinkSync(path.join(runDir, 'analysis_final.csv')); } catch (_) {}
  }
  const ready = readCsvTable(readyFile, Number.MAX_SAFE_INTEGER).rows || [];
  const tables = loadRunTablesForSelection(runDir, selection);
  const built = buildSelectedAnalysisForRun(runDir, ready, { ...tables, analysis_ready: ready }, selection);
  return built ? { ...built, run_id: runId, run_dir: runDir } : null;
}

const AGGREGATION_TEXT = {
  list: 'Liệt kê mọi giá trị trong đợt (nối bằng dấu ;)', first: 'Giá trị đầu tiên trong đợt', last: 'Giá trị cuối cùng trong đợt',
  min: 'Nhỏ nhất trong đợt', max: 'Lớn nhất trong đợt', mean: 'Trung bình trong đợt', count: 'Số lần xuất hiện trong đợt',
  any: 'Có / không trong đợt', closest_before_surgery: 'Gần trước mổ nhất', closest_after_surgery: 'Gần sau mổ nhất',
  closest_before_anchor: 'Gần trước mốc nhất', closest_after_anchor: 'Gần sau mốc nhất',
};

// Cột nền của file "Biến đã chọn" (không định danh).
const BASE_COLUMN_TEXT = {
  research_code: ['Mã nghiên cứu của lượt', 'Văn bản'],
  encounter_id: ['Mã lượt điều trị trong kho (giả danh)', 'Văn bản'],
  patient_key: ['Mã người bệnh giả danh (cùng người = cùng mã)', 'Văn bản'],
  sex: ['Giới tính', 'Phân loại'],
  birth_year: ['Năm sinh', 'Số'],
  age: ['Tuổi lúc vào viện', 'Số', 'năm'],
  admission_date: ['Ngày vào viện', 'Ngày'],
  surgery_date: ['Ngày phẫu thuật', 'Ngày'],
  discharge_date: ['Ngày ra viện', 'Ngày'],
  anchor_datetime: ['Thời điểm mốc của nghiên cứu (vd. giờ truyền thuốc)', 'Ngày giờ'],
  hospital_stay_days: ['Số ngày nằm viện', 'Số', 'ngày'],
  time_to_surgery_hours: ['Thời gian từ vào viện tới mổ', 'Số', 'giờ'],
  diagnosis_raw: ['Chẩn đoán (nguyên văn EMR)', 'Văn bản'],
  needs_manual_review: ['Lượt cần xem lại tay (1 = có)', 'Phân loại'],
  source_run_id: ['Đợt dữ liệu nguồn', 'Văn bản'],
  row_hash: ['Mã kiểm tra dòng (kỹ thuật)', 'Văn bản'],
};

const TYPE_TEXT = { number: 'Số', category: 'Phân loại', date: 'Ngày', datetime: 'Ngày giờ', text: 'Văn bản' };
const unitFromLabel = (label) => (/\(([^()]{1,30})\)\s*$/.exec(String(label || '')) || [])[1] || '';

// Từ điển biến (codebook) cho file "Biến đã chọn": tên cột, nhãn, kiểu, đơn vị, cách lấy giá trị,
// mã hóa, số lượt có / thiếu dữ liệu. Tính trên đúng file sẽ xuất.
function buildStudyCodebook(study) {
  const built = rebuildStudySelected(study, { keepFinal: true });
  if (!built) fail('Nghiên cứu chưa có dữ liệu hoặc chưa có biến nào để lập từ điển biến.');
  const selected = readCsvTable(path.join(built.run_dir, 'analysis_selected.csv'), Number.MAX_SAFE_INTEGER);
  const rows = selected.rows || [];
  const filled = (col) => rows.filter(r => String(r?.[col] ?? '').trim() !== '').length;
  const byColumn = new Map((built.manifest?.variables || []).map(v => [v.output_column, v]));
  const out = (selected.columns || []).map(col => {
    const v = byColumn.get(col);
    const n = filled(col);
    if (!v) {
      const [label, kind, unit] = BASE_COLUMN_TEXT[col] || [col, ''];
      return { cot: col, ma_bien_nguon: col, nhan: label, kieu: kind, don_vi: unit || '', cach_lay: 'Thông tin chung của lượt', ma_hoa: col === 'needs_manual_review' ? '1 = cần xem lại' : '', co_du_lieu: n, thieu: rows.length - n };
    }
    const presence = String(v.aggregation || '') === 'any';
    const windowText = v.window_from_days != null || v.window_to_days != null
      ? ` (từ ngày ${v.window_from_days ?? '…'} đến ngày ${v.window_to_days ?? '…'} so với mốc)` : '';
    return {
      cot: col,
      ma_bien_nguon: v.id || v.name,
      nhan: v.survey_label || v.label || v.name,
      kieu: presence ? 'Phân loại (0/1)' : (TYPE_TEXT[String(v.type || '')] || ''),
      don_vi: unitFromLabel(v.label),
      cach_lay: `${AGGREGATION_TEXT[String(v.aggregation || 'list')] || v.aggregation}${windowText}${v.source_note ? `; ${v.source_note}` : ''}`,
      ma_hoa: presence ? '1 = Có, 0 = Không' : '',
      co_du_lieu: n,
      thieu: rows.length - n,
    };
  });
  return { rows: out, columns: ['cot', 'ma_bien_nguon', 'nhan', 'kieu', 'don_vi', 'cach_lay', 'ma_hoa', 'co_du_lieu', 'thieu'], encounters: rows.length };
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

  const rebuilt = rebuildStudySelected(updated);
  return {
    study: updated,
    run_id: rebuilt?.run_id || '',
    rows: rebuilt?.rows || 0,
    variables: next.selected_variables.length,
  };
}

module.exports = { updateStudyVariables, rebuildStudySelected, buildStudyCodebook };
