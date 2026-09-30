'use strict';

// Đồng bộ research.sqlite3 của một run từ các bảng CSV.

const path = require('path');
const { ARCHIVE_ID, TABLES } = require('./store_paths');
const { syncResearchDatabase } = require('./sqlite_store');
const { NORMALIZED_SCHEMA_VERSION } = require('./normalized_schema');
const { readJsonSafe } = require('../utils/file');

const DATABASE_TABLE_NAME_OVERRIDES = {
  cohort: 'cohort',
  initial_list: 'raw_initial_list',
  research_source: 'raw_research_source',
  deep_source: 'raw_deep_source',
  patient_extra: 'raw_patient_extra',
  patients: 'raw_patients',
  patient_master: 'patients',
  hchanh_profile: 'raw_hchanh_profile',
  hchanh_discharge: 'raw_hchanh_discharge',
  hchanh_surgery: 'raw_hchanh_surgery',
  hchanh_order_history: 'raw_hchanh_order_history',
  xn: 'raw_lab_results',
  cdha: 'raw_imaging_results',
  errors: 'extraction_errors',
  analysis_ready_encoded: 'encoded_analysis_ready',
  analysis_selected_encoded: 'encoded_analysis_selected',
  lab_results_encoded: 'encoded_lab_results',
  imaging_results_encoded: 'encoded_imaging_results',
  medication_orders_encoded: 'encoded_medication_orders',
  diagnoses_encoded: 'encoded_diagnoses',
  surgery_results_encoded: 'encoded_surgery_results',
};

function datasetDirFromRunDir(runDir) {
  return path.dirname(path.dirname(path.resolve(runDir)));
}

function datasetIdentityFromRunDir(runDir) {
  const datasetDir = datasetDirFromRunDir(runDir);
  const datasetId = path.basename(datasetDir);
  return {
    datasetDir,
    datasetId,
    datasetType: datasetId === ARCHIVE_ID ? 'archive' : 'study',
  };
}

function databaseTableSpecsForRun(runDir) {
  const dir = path.resolve(runDir);
  const { datasetDir } = datasetIdentityFromRunDir(dir);
  return Object.entries(TABLES).map(([key, spec]) => {
    const filePath = spec.root === 'study'
      ? path.join(datasetDir, spec.file)
      : path.join(dir, spec.file);
    return {
      table_name: DATABASE_TABLE_NAME_OVERRIDES[key] || key,
      source_file: spec.file,
      file_path: filePath,
    };
  });
}

function syncDatabaseForRun(runDir, {
  runId = '',
  inputSignature = '',
  force = false,
} = {}) {
  const dir = path.resolve(runDir);
  const identity = datasetIdentityFromRunDir(dir);
  return syncResearchDatabase({
    ...identity,
    runId: runId || path.basename(dir),
    inputSignature,
    normalizedSchemaVersion: NORMALIZED_SCHEMA_VERSION,
    tables: databaseTableSpecsForRun(dir),
    force,
  });
}

function publicDatabaseInfo(info = {}) {
  const tables = Array.isArray(info.tables) ? info.tables : [];
  return {
    exists: Boolean(info.exists),
    database_file: info.database_file || 'research.sqlite3',
    dataset_id: info.dataset_id || '',
    dataset_type: info.dataset_type || '',
    run_id: info.run_id || '',
    size_bytes: Number(info.size_bytes || 0),
    updated_at: info.updated_at || info.loaded_at || '',
    cached: Boolean(info.cached),
    tables: tables.map(item => ({
      table_name: item.table_name,
      row_count: Number(item.row_count || 0),
      column_count: Number(item.column_count || 0),
    })),
  };
}

function forceSyncDatabaseAfterDerivedOutput(runDir) {
  const dir = path.resolve(runDir);
  const manifest = readJsonSafe(path.join(dir, 'manifest.json'), {}) || {};
  const info = syncDatabaseForRun(dir, {
    runId: path.basename(dir),
    inputSignature: String(manifest.normalized_input_signature || ''),
    force: true,
  });
  return publicDatabaseInfo(info);
}

module.exports = {
  DATABASE_TABLE_NAME_OVERRIDES,
  datasetDirFromRunDir,
  datasetIdentityFromRunDir,
  databaseTableSpecsForRun,
  syncDatabaseForRun,
  publicDatabaseInfo,
  forceSyncDatabaseAfterDerivedOutput,
};
