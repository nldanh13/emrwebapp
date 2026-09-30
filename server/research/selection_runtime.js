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

module.exports = {
  sanitizeVariableSelection,
  activeVariableSelectionFromStudy,
  readRunRowsForSelection,
  loadRunTablesForSelection,
  buildSelectedAnalysisForRun,
};
