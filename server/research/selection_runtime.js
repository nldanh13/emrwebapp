'use strict';

// Dựng analysis_selected.csv của một run theo biến/điều kiện đã chọn của nghiên cứu.

const variableSelection = require('./variable_selection');
const { TABLES } = require('./store_paths');
const { readCsvTable, writeCsv } = require('./table_io');
const path = require('path');
const { writeJsonAtomic } = require('../utils/file');

function sanitizeVariableSelection(input) {
  return variableSelection.sanitizeVariableSelection(input);
}

function activeVariableSelectionFromStudy(study) {
  return study?.variable_selection || study?.analysis_config?.variable_selection || null;
}

function readRunRowsForSelection(runDir, tableKey, fallbackRows = [], maxRows = Number.MAX_SAFE_INTEGER) {
  if (!tableKey) return [];
  if (Array.isArray(fallbackRows) && ['cohort', 'initial_list', 'research_source'].includes(tableKey) && fallbackRows.length) return fallbackRows;
  const table = TABLES[tableKey];
  if (!table || table.root !== 'run') return [];
  return readCsvTable(path.join(runDir, table.file), maxRows).rows || [];
}

function loadRunTablesForSelection(runDir, selection, fallbackRows = [], maxRows = Number.MAX_SAFE_INTEGER) {
  const out = {};
  const keys = new Set();
  for (const item of [...(selection?.selected_variables || []), ...(selection?.conditions || [])]) {
    if (item?.table) keys.add(item.table);
  }
  // Mốc "lần đầu dùng thuốc" cần y lệnh thuốc của từng lượt.
  if (selection?.anchor?.kind === 'drug') keys.add('medication_orders');
  for (const key of keys) out[key] = readRunRowsForSelection(runDir, key, fallbackRows, maxRows);
  if (fallbackRows?.length) {
    out.initial_list = out.initial_list || fallbackRows;
    out.cohort = out.cohort || fallbackRows;
    out.research_source = out.research_source || fallbackRows;
  }
  return out;
}

function buildSelectedAnalysisForRun(runDir, analysisReadyRows, normalizedRowsByKey, selection) {
  if (!variableSelection.hasActiveSelection(selection)) return null;
  const selected = variableSelection.buildSelectedAnalysisDataset(analysisReadyRows || [], selection, normalizedRowsByKey || {});
  writeCsv(path.join(runDir, 'analysis_selected.csv'), selected.columns, selected.rows);
  writeJsonAtomic(path.join(runDir, 'analysis_selection_manifest.json'), {
    ...selected.manifest,
    run_id: path.basename(runDir),
    source: 'variable_selection',
  });
  return { rows: selected.rows.length, columns: selected.columns.length, manifest: selected.manifest };
}

const OPERATOR_TEXT = {
  '=': '=', '!=': '≠', '>': '>', '>=': '≥', '<': '<', '<=': '≤', contains: 'chứa', starts_with: 'bắt đầu bằng',
  ends_with: 'kết thúc bằng', in: 'thuộc', between: 'trong khoảng', not_empty: 'có dữ liệu', empty: 'không có dữ liệu',
};
function conditionLabel(c) {
  const op = OPERATOR_TEXT[c.operator] || c.operator || 'có dữ liệu';
  const value = ['not_empty', 'empty'].includes(c.operator) ? '' : c.operator === 'between' ? ` ${c.value} – ${c.value2}` : ` ${c.value}`;
  return `${c.label || c.name} ${op}${value}`.trim();
}

function stepLabel(step, selection) {
  if (step.kind === 'period') {
    const { from, to } = selection.period || {};
    const fmt = d => (d ? d.split('-').reverse().join('/') : '');
    return from && to ? `Nhập viện từ ${fmt(from)} đến ${fmt(to)}` : from ? `Nhập viện từ ${fmt(from)}` : `Nhập viện đến ${fmt(to)}`;
  }
  if (step.kind === 'one_per_patient') return 'Mỗi người bệnh lấy lượt nhập viện đầu tiên';
  return `${step.condition.exclude ? 'Loại trừ: ' : ''}${conditionLabel(step.condition)}`;
}

// Thống kê mô tả các biến đã chọn trên một run (dùng cho bước Kiểm tra của Tạo nghiên cứu và
// phần Thống kê của nghiên cứu). Chỉ trả số liệu tổng hợp, không trả dữ liệu từng lượt.
function summarizeSelectionForRun(runDir, selectionInput, { maxEncounters = Number.MAX_SAFE_INTEGER, maxSourceRows = Number.MAX_SAFE_INTEGER } = {}) {
  const selection = sanitizeVariableSelection(selectionInput);
  const analysisTable = readCsvTable(path.join(runDir, TABLES.analysis_ready.file), maxEncounters);
  const tableRows = loadRunTablesForSelection(runDir, selection, [], maxSourceRows);
  // Sàng lọc từng bước: thời gian nghiên cứu → từng tiêu chuẩn chọn/loại trừ → mỗi người một lượt,
  // để biết mỗi bước loại bao nhiêu lượt. Kết quả cuối giống áp tất cả cùng lúc (nối bằng VÀ).
  const countPatients = list => new Set(list.map(r => String(r?.patient_key || r?.patient_code || '').trim()).filter(Boolean)).size;
  const sourceRows = analysisTable.rows || [];
  const funnel = [{ label: 'Toàn bộ kho', encounters: sourceRows.length, patients: countPatients(sourceRows) }];
  const rows = variableSelection.selectCohortRows(sourceRows, selection, tableRows, (step, list) => {
    funnel.push({ label: stepLabel(step, selection), kind: step.kind, exclude: Boolean(step.condition?.exclude), encounters: list.length, patients: countPatients(list) });
  });
  const dataset = variableSelection.buildSelectedAnalysisDataset(rows, selection, tableRows);
  return {
    dataset,
    summary: { ...variableSelection.summarizeSelectedDataset(dataset), funnel },
    source_total: (analysisTable.rows || []).length,
    source_limited: Boolean(analysisTable.limited) || Object.values(tableRows).some(rows => rows.length >= maxSourceRows),
  };
}

module.exports = {
  summarizeSelectionForRun,
  sanitizeVariableSelection,
  activeVariableSelectionFromStudy,
  readRunRowsForSelection,
  loadRunTablesForSelection,
  buildSelectedAnalysisForRun,
};
