'use strict';

// Bảng mã hóa (encoded/): thay văn bản bằng mã từ điển, người bệnh nhận diện bằng patient_key.

const { normalizeSimple } = require('./encounter_context');
const path = require('path');
const { readCsvTable, writeCsv, writeCsvUnion } = require('./table_io');
const { nowIso } = require('./store_paths');
const fs = require('fs');
const { ENCODED_DIRNAME } = require('./dataset_store');
const { ensureDir, readJsonSafe, writeJsonAtomic } = require('../utils/file');
const { forceSyncDatabaseAfterDerivedOutput } = require('./research_db');

function dictCell(row, name) {
  return String(row?.[name] ?? '').trim();
}

function dictKeyFromValues(values) {
  return values.map(v => normalizeSimple(v)).join('|');
}

function loadDictionary(encodedDir, filename, codeColumn, columns, keyColumns) {
  const filePath = path.join(encodedDir, filename);
  const table = readCsvTable(filePath, Number.MAX_SAFE_INTEGER);
  const rows = Array.isArray(table.rows) ? table.rows : [];
  const keyToCode = new Map();
  let maxCode = 0;
  for (const row of rows) {
    const code = Number(dictCell(row, codeColumn));
    if (Number.isFinite(code) && code > maxCode) maxCode = code;
    const explicitKey = dictCell(row, 'dict_key');
    const key = explicitKey || dictKeyFromValues(keyColumns.map(col => dictCell(row, col)));
    if (key && dictCell(row, codeColumn)) keyToCode.set(key, dictCell(row, codeColumn));
  }
  return { filePath, codeColumn, columns, keyColumns, rows, keyToCode, nextCode: maxCode + 1, newRows: 0 };
}

function allocateDictionaryCode(dict, values) {
  const clean = {};
  for (const [k, v] of Object.entries(values || {})) clean[k] = String(v ?? '').trim();
  const key = clean.dict_key || dictKeyFromValues(dict.keyColumns.map(col => clean[col]));
  if (!key || key.split('|').every(part => !part)) return '';
  const existing = dict.keyToCode.get(key);
  if (existing) return existing;
  const code = String(dict.nextCode++);
  const now = nowIso();
  const row = { ...clean, [dict.codeColumn]: code, dict_key: key, created_at: now, updated_at: now };
  for (const col of dict.columns) if (row[col] == null) row[col] = '';
  dict.rows.push(row);
  dict.keyToCode.set(key, code);
  dict.newRows += 1;
  return code;
}

function saveDictionary(dict) {
  writeCsv(dict.filePath, dict.columns, dict.rows);
}

function buildEncodedDataset(runDir) {
  if (!runDir || !fs.existsSync(runDir)) {
    const err = new Error('Chưa có run để tạo dữ liệu encoded.');
    err.status = 400;
    throw err;
  }
  const encodedDir = path.join(runDir, ENCODED_DIRNAME);
  ensureDir(encodedDir);

  const labDict = loadDictionary(encodedDir, 'lab_dictionary.csv', 'lab_code', [
    'lab_code', 'lab_group', 'test_name_raw', 'test_name_norm', 'unit', 'ref_range_raw', 'dict_key', 'created_at', 'updated_at',
  ], ['test_name_norm', 'unit', 'ref_range_raw', 'lab_group']);
  const imagingDict = loadDictionary(encodedDir, 'imaging_dictionary.csv', 'imaging_code', [
    'imaging_code', 'service_name_raw', 'service_name_norm', 'modality', 'body_region', 'dict_key', 'created_at', 'updated_at',
  ], ['service_name_norm', 'modality', 'body_region']);
  const drugDict = loadDictionary(encodedDir, 'drug_dictionary.csv', 'drug_code', [
    'drug_code', 'drug_name_raw', 'drug_name_norm', 'drug_group_guess', 'active_ingredient', 'dict_key', 'created_at', 'updated_at',
  ], ['drug_name_norm', 'active_ingredient', 'drug_group_guess']);
  const routeDict = loadDictionary(encodedDir, 'route_dictionary.csv', 'route_code', [
    'route_code', 'route_raw', 'route_norm', 'dict_key', 'created_at', 'updated_at',
  ], ['route_norm', 'route_raw']);
  const diagnosisDict = loadDictionary(encodedDir, 'diagnosis_dictionary.csv', 'diagnosis_code', [
    'diagnosis_code', 'icd_code', 'diagnosis_text', 'diagnosis_text_norm', 'dict_key', 'created_at', 'updated_at',
  ], ['icd_code', 'diagnosis_text_norm']);
  const procedureDict = loadDictionary(encodedDir, 'procedure_dictionary.csv', 'procedure_code', [
    'procedure_code', 'surgery_name', 'surgery_name_norm', 'surgery_method', 'surgery_class', 'dict_key', 'created_at', 'updated_at',
  ], ['surgery_name_norm', 'surgery_method', 'surgery_class']);
  const anesthesiaDict = loadDictionary(encodedDir, 'anesthesia_dictionary.csv', 'anesthesia_code', [
    'anesthesia_code', 'anesthesia_method', 'anesthesia_method_norm', 'dict_key', 'created_at', 'updated_at',
  ], ['anesthesia_method_norm']);

  const labRows = readCsvTable(path.join(runDir, 'lab_results.csv'), Number.MAX_SAFE_INTEGER).rows || [];
  const labEncoded = labRows.map(row => {
    const labCode = allocateDictionaryCode(labDict, {
      lab_group: dictCell(row, 'lab_group'),
      test_name_raw: dictCell(row, 'test_name_raw'),
      test_name_norm: dictCell(row, 'test_name_norm') || normalizeSimple(dictCell(row, 'test_name_raw')),
      unit: dictCell(row, 'unit'),
      ref_range_raw: dictCell(row, 'ref_range_raw'),
    });
    return {
      lab_result_id: dictCell(row, 'lab_result_id'), research_code: dictCell(row, 'research_code'), patient_key: dictCell(row, 'patient_key'), encounter_id: dictCell(row, 'encounter_id'), encounter_match_status: dictCell(row, 'encounter_match_status'),
      lab_datetime: dictCell(row, 'lab_datetime'), lab_date: dictCell(row, 'lab_date'), lab_code: labCode,
      result_raw: dictCell(row, 'result_raw'), result_operator: dictCell(row, 'result_operator'), result_num: dictCell(row, 'result_num'), result_text: dictCell(row, 'result_text'),
      flag_raw: dictCell(row, 'flag_raw'), flag_norm: dictCell(row, 'flag_norm'),
      days_from_admission: dictCell(row, 'days_from_admission'), days_from_surgery: dictCell(row, 'days_from_surgery'), days_from_discharge: dictCell(row, 'days_from_discharge'), is_within_encounter: dictCell(row, 'is_within_encounter'),
      source_run_id: dictCell(row, 'source_run_id'), row_hash: dictCell(row, 'row_hash'),
    };
  });
  const labEncodedCols = ['lab_result_id', 'research_code', 'patient_key', 'encounter_id', 'encounter_match_status', 'lab_datetime', 'lab_date', 'lab_code', 'result_raw', 'result_operator', 'result_num', 'result_text', 'flag_raw', 'flag_norm', 'days_from_admission', 'days_from_surgery', 'days_from_discharge', 'is_within_encounter', 'source_run_id', 'row_hash'];

  const imagingRows = readCsvTable(path.join(runDir, 'imaging_results.csv'), Number.MAX_SAFE_INTEGER).rows || [];
  const imagingEncoded = imagingRows.map(row => {
    const serviceNameNorm = normalizeSimple(dictCell(row, 'service_name_raw'));
    const imagingCode = allocateDictionaryCode(imagingDict, {
      service_name_raw: dictCell(row, 'service_name_raw'),
      service_name_norm: serviceNameNorm,
      modality: dictCell(row, 'modality'),
      body_region: dictCell(row, 'body_region'),
    });
    return {
      imaging_id: dictCell(row, 'imaging_id'), research_code: dictCell(row, 'research_code'), patient_key: dictCell(row, 'patient_key'), encounter_id: dictCell(row, 'encounter_id'), encounter_match_status: dictCell(row, 'encounter_match_status'),
      ordered_at: dictCell(row, 'ordered_at'), order_date: dictCell(row, 'order_date'), imaging_code: imagingCode,
      has_result_text: dictCell(row, 'result_text') ? '1' : '0', has_conclusion_text: dictCell(row, 'conclusion_text') ? '1' : '0',
      status: dictCell(row, 'status'), days_from_admission: dictCell(row, 'days_from_admission'), days_from_surgery: dictCell(row, 'days_from_surgery'), days_from_discharge: dictCell(row, 'days_from_discharge'), is_within_encounter: dictCell(row, 'is_within_encounter'), source_run_id: dictCell(row, 'source_run_id'), row_hash: dictCell(row, 'row_hash'),
    };
  });
  const imagingEncodedCols = ['imaging_id', 'research_code', 'patient_key', 'encounter_id', 'encounter_match_status', 'ordered_at', 'order_date', 'imaging_code', 'has_result_text', 'has_conclusion_text', 'status', 'days_from_admission', 'days_from_surgery', 'days_from_discharge', 'is_within_encounter', 'source_run_id', 'row_hash'];

  const medRows = readCsvTable(path.join(runDir, 'medication_orders.csv'), Number.MAX_SAFE_INTEGER).rows || [];
  const medEncoded = medRows.map(row => {
    const drugCode = allocateDictionaryCode(drugDict, {
      drug_name_raw: dictCell(row, 'drug_name_raw'),
      drug_name_norm: dictCell(row, 'drug_name_norm') || normalizeSimple(dictCell(row, 'drug_name_raw')),
      drug_group_guess: dictCell(row, 'drug_group_guess'),
      active_ingredient: dictCell(row, 'active_ingredient'),
    });
    const routeCode = allocateDictionaryCode(routeDict, {
      route_raw: dictCell(row, 'route_raw'),
      route_norm: dictCell(row, 'route_norm') || normalizeSimple(dictCell(row, 'route_raw')),
    });
    return {
      med_order_id: dictCell(row, 'med_order_id'), research_code: dictCell(row, 'research_code'), patient_key: dictCell(row, 'patient_key'), encounter_id: dictCell(row, 'encounter_id'),
      order_datetime: dictCell(row, 'order_datetime'), order_date: dictCell(row, 'order_date'), drug_code: drugCode, route_code: routeCode,
      dose_raw: dictCell(row, 'dose_raw'), times_per_day: dictCell(row, 'times_per_day'),
      surgery_datetime_ref: dictCell(row, 'surgery_datetime_ref'), surgery_date_ref: dictCell(row, 'surgery_date_ref'), postop_day_index: dictCell(row, 'postop_day_index'), postop_day_label: dictCell(row, 'postop_day_label'), is_postop_day_1_3: dictCell(row, 'is_postop_day_1_3'),
      source: dictCell(row, 'source'), source_run_id: dictCell(row, 'source_run_id'), row_hash: dictCell(row, 'row_hash'),
    };
  });
  const medEncodedCols = ['med_order_id', 'research_code', 'patient_key', 'encounter_id', 'order_datetime', 'order_date', 'drug_code', 'route_code', 'dose_raw', 'times_per_day', 'surgery_datetime_ref', 'surgery_date_ref', 'postop_day_index', 'postop_day_label', 'is_postop_day_1_3', 'source', 'source_run_id', 'row_hash'];

  const diagnosisRows = readCsvTable(path.join(runDir, 'diagnoses.csv'), Number.MAX_SAFE_INTEGER).rows || [];
  const diagnosisEncoded = diagnosisRows.map(row => {
    const diagnosisCode = allocateDictionaryCode(diagnosisDict, {
      icd_code: dictCell(row, 'icd_code'),
      diagnosis_text: dictCell(row, 'diagnosis_text'),
      diagnosis_text_norm: normalizeSimple(dictCell(row, 'diagnosis_text')),
    });
    return {
      diagnosis_id: dictCell(row, 'diagnosis_id'), research_code: dictCell(row, 'research_code'), patient_key: dictCell(row, 'patient_key'), encounter_id: dictCell(row, 'encounter_id'),
      diagnosis_date: dictCell(row, 'diagnosis_date'), diagnosis_type: dictCell(row, 'diagnosis_type'), diagnosis_code: diagnosisCode,
      source: dictCell(row, 'source'), source_run_id: dictCell(row, 'source_run_id'), row_hash: dictCell(row, 'row_hash'),
    };
  });
  const diagnosisEncodedCols = ['diagnosis_id', 'research_code', 'patient_key', 'encounter_id', 'diagnosis_date', 'diagnosis_type', 'diagnosis_code', 'source', 'source_run_id', 'row_hash'];

  const surgeryRows = readCsvTable(path.join(runDir, 'surgery_results.csv'), Number.MAX_SAFE_INTEGER).rows || [];
  const surgeryEncoded = surgeryRows.map(row => {
    const procedureCode = allocateDictionaryCode(procedureDict, {
      surgery_name: dictCell(row, 'surgery_name'),
      surgery_name_norm: normalizeSimple(dictCell(row, 'surgery_name')),
      surgery_method: dictCell(row, 'surgery_method'),
      surgery_class: dictCell(row, 'surgery_class'),
    });
    const anesthesiaCode = allocateDictionaryCode(anesthesiaDict, {
      anesthesia_method: dictCell(row, 'anesthesia_method'),
      anesthesia_method_norm: normalizeSimple(dictCell(row, 'anesthesia_method')),
    });
    return {
      surgery_id: dictCell(row, 'surgery_id'), research_code: dictCell(row, 'research_code'), patient_key: dictCell(row, 'patient_key'), encounter_id: dictCell(row, 'encounter_id'),
      surgery_datetime: dictCell(row, 'surgery_datetime'), surgery_date: dictCell(row, 'surgery_date'), procedure_code: procedureCode, anesthesia_code: anesthesiaCode,
      status: dictCell(row, 'status'), source: dictCell(row, 'source'), source_run_id: dictCell(row, 'source_run_id'), row_hash: dictCell(row, 'row_hash'),
    };
  });
  const surgeryEncodedCols = ['surgery_id', 'research_code', 'patient_key', 'encounter_id', 'surgery_datetime', 'surgery_date', 'procedure_code', 'anesthesia_code', 'status', 'source', 'source_run_id', 'row_hash'];

  const selectedAnalysisPath = path.join(runDir, 'analysis_selected.csv');
  const analysisSourceFile = fs.existsSync(selectedAnalysisPath) ? 'analysis_selected.csv' : 'analysis_ready.csv';
  const arTable = readCsvTable(path.join(runDir, analysisSourceFile), Number.MAX_SAFE_INTEGER);
  const analysisEncoded = (arTable.rows || []).map(row => {
    const diagnosisCode = allocateDictionaryCode(diagnosisDict, {
      icd_code: '', diagnosis_text: dictCell(row, 'diagnosis_raw'), diagnosis_text_norm: normalizeSimple(dictCell(row, 'diagnosis_raw')),
    });
    const procedureCode = allocateDictionaryCode(procedureDict, {
      surgery_name: dictCell(row, 'surgery_name'), surgery_name_norm: normalizeSimple(dictCell(row, 'surgery_name')), surgery_method: dictCell(row, 'surgery_method'), surgery_class: '',
    });
    const anesthesiaCode = allocateDictionaryCode(anesthesiaDict, {
      anesthesia_method: dictCell(row, 'anesthesia_method'), anesthesia_method_norm: normalizeSimple(dictCell(row, 'anesthesia_method')),
    });
    const out = { ...row };
    delete out.patient_code;
    delete out.patient_name;
    delete out.diagnosis_raw;
    delete out.surgery_name;
    delete out.surgery_method;
    delete out.anesthesia_method;
    out.sex_code = normalizeSimple(row.sex).startsWith('nam') ? '1' : normalizeSimple(row.sex).startsWith('nu') ? '2' : '';
    out.diagnosis_code = diagnosisCode;
    out.procedure_code = procedureCode;
    out.anesthesia_code = anesthesiaCode;
    return out;
  });
  const analysisEncodedPreferred = [
    'research_code', 'patient_key', 'sex_code', 'birth_year', 'age', 'admission_date', 'surgery_date', 'discharge_date', 'hospital_stay_days', 'time_to_surgery_hours',
    'diagnosis_code', 'procedure_code', 'anesthesia_code',
  ];

  writeCsv(path.join(encodedDir, 'lab_results_encoded.csv'), labEncodedCols, labEncoded);
  writeCsv(path.join(encodedDir, 'imaging_results_encoded.csv'), imagingEncodedCols, imagingEncoded);
  writeCsv(path.join(encodedDir, 'medication_orders_encoded.csv'), medEncodedCols, medEncoded);
  writeCsv(path.join(encodedDir, 'diagnoses_encoded.csv'), diagnosisEncodedCols, diagnosisEncoded);
  writeCsv(path.join(encodedDir, 'surgery_results_encoded.csv'), surgeryEncodedCols, surgeryEncoded);
  writeCsvUnion(path.join(encodedDir, 'analysis_ready_encoded.csv'), analysisEncoded, analysisEncodedPreferred);
  if (analysisSourceFile === 'analysis_selected.csv') {
    writeCsvUnion(path.join(encodedDir, 'analysis_selected_encoded.csv'), analysisEncoded, analysisEncodedPreferred);
  } else {
    try { fs.unlinkSync(path.join(encodedDir, 'analysis_selected_encoded.csv')); } catch (_) {}
  }

  for (const dict of [labDict, imagingDict, drugDict, routeDict, diagnosisDict, procedureDict, anesthesiaDict]) saveDictionary(dict);

  const outputs = {
    lab_results_encoded: labEncoded.length,
    lab_dictionary: labDict.rows.length,
    imaging_results_encoded: imagingEncoded.length,
    imaging_dictionary: imagingDict.rows.length,
    medication_orders_encoded: medEncoded.length,
    drug_dictionary: drugDict.rows.length,
    route_dictionary: routeDict.rows.length,
    diagnoses_encoded: diagnosisEncoded.length,
    diagnosis_dictionary: diagnosisDict.rows.length,
    surgery_results_encoded: surgeryEncoded.length,
    procedure_dictionary: procedureDict.rows.length,
    anesthesia_dictionary: anesthesiaDict.rows.length,
    analysis_ready_encoded: analysisEncoded.length,
    analysis_selected_encoded: analysisSourceFile === 'analysis_selected.csv' ? analysisEncoded.length : 0,
  };
  const new_entries = {
    lab_dictionary: labDict.newRows,
    imaging_dictionary: imagingDict.newRows,
    drug_dictionary: drugDict.newRows,
    route_dictionary: routeDict.newRows,
    diagnosis_dictionary: diagnosisDict.newRows,
    procedure_dictionary: procedureDict.newRows,
    anesthesia_dictionary: anesthesiaDict.newRows,
  };
  const manifestPath = path.join(runDir, 'manifest.json');
  const manifest = readJsonSafe(manifestPath, {});
  writeJsonAtomic(manifestPath, {
    ...manifest,
    encoded_at: nowIso(),
    encoded_schema_version: 2,
    encoded_analysis_source: analysisSourceFile,
    encoded_outputs: outputs,
    encoded_new_entries: new_entries,
  });
  writeJsonAtomic(path.join(encodedDir, 'encoding_manifest.json'), {
    dataset_type: 'research_dictionary_encoded',
    run_id: path.basename(runDir),
    created_at: nowIso(),
    schema_version: 2,
    analysis_source: analysisSourceFile,
    rule: 'Nếu chuỗi mới chưa có trong dictionary thì tự cấp mã số tiếp theo và lưu lại dictionary; mã cũ được giữ nguyên.',
    outputs,
    new_entries,
  });
  let database = null;
  let database_warning = '';
  try {
    database = forceSyncDatabaseAfterDerivedOutput(runDir);
  } catch (err) {
    database_warning = String(err?.message || err);
    console.warn('[RESEARCH][SQLITE] Encoded dataset đã tạo nhưng chưa sync SQLite:', database_warning);
  }
  return { run_id: path.basename(runDir), outputs, new_entries, database, database_warning };
}

module.exports = {
  dictCell,
  dictKeyFromValues,
  loadDictionary,
  allocateDictionaryCode,
  saveDictionary,
  buildEncodedDataset,
};
