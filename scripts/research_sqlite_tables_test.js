#!/usr/bin/env node
'use strict';

// research.sqlite3 trên máy vận hành đã 567 MB vì chép lại mọi CSV của run, kể cả bảng thô
// hành chánh (y lệnh thô 226 MB) và các bảng encoded — không màn hình nào truy vấn chúng
// trong SQLite. Bảng app thực sự truy vấn (patient_history.js) và bảng chuẩn hóa phải còn.

const assert = require('assert');
const path = require('path');
const { databaseTableSpecsForRun, SQLITE_SKIPPED_TABLE_KEYS } = require('../server/research/research_db');

const runDir = path.join('/tmp', 'du_lieu_goc', 'runs', 'run_1');
const names = new Set(databaseTableSpecsForRun(runDir).map(t => t.table_name));

for (const kept of ['patients', 'encounters', 'lab_results', 'imaging_results', 'medication_orders', 'surgery_results',
  'raw_lab_results', 'raw_imaging_results', 'clinical_notes', 'patient_day', 'analysis_ready', 'analysis_final',
  'cohort', 'crf', 'extraction_errors', 'lab_dictionary', 'drug_dictionary']) {
  assert.ok(names.has(kept), `phải giữ bảng ${kept} trong SQLite`);
}
for (const skipped of ['raw_hchanh_order_history', 'raw_hchanh_profile', 'raw_hchanh_discharge', 'raw_hchanh_surgery',
  'raw_initial_list', 'raw_research_source', 'raw_deep_source', 'raw_patient_extra', 'raw_patients',
  'encoded_analysis_ready', 'encoded_analysis_selected', 'encoded_lab_results', 'encoded_imaging_results',
  'encoded_medication_orders', 'encoded_diagnoses', 'encoded_surgery_results']) {
  assert.ok(!names.has(skipped), `không chép ${skipped} vào SQLite (đã có trong CSV của run)`);
}
assert.ok(Array.isArray(SQLITE_SKIPPED_TABLE_KEYS) && SQLITE_SKIPPED_TABLE_KEYS.length > 0);

// DB cũ (cùng run, cùng chữ ký đầu vào) còn bảng thô đã bỏ: không được dùng lại bản cũ, phải dựng lại.
const fs = require('fs');
const os = require('os');
const { syncResearchDatabase } = require('../server/research/sqlite_store');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'research-sqlite-'));
try {
  const csv = path.join(tmp, 'patients.csv');
  fs.writeFileSync(csv, 'patient_code,age\nBN1,70\n', 'utf-8');
  const base = { datasetDir: tmp, datasetId: 'du_lieu_goc', datasetType: 'archive', runId: 'run_1', inputSignature: 'sig', normalizedSchemaVersion: 1 };
  const tables = [{ table_name: 'patients', source_file: 'patients.csv', file_path: csv }];
  fs.writeFileSync(path.join(tmp, 'research.sqlite3'), 'cu');
  fs.writeFileSync(path.join(tmp, 'research.sqlite3.manifest.json'), JSON.stringify({
    run_id: 'run_1', input_signature: 'sig', normalized_schema_version: 1,
    tables: [{ table_name: 'patients' }, { table_name: 'raw_hchanh_order_history' }],
  }));
  const rebuilt = syncResearchDatabase({ ...base, tables });
  assert.ok(!rebuilt.cached, 'DB cũ còn bảng thô phải được dựng lại');
  assert.deepStrictEqual(rebuilt.tables.map(t => t.table_name), ['patients']);
  const again = syncResearchDatabase({ ...base, tables });
  assert.ok(again.cached, 'đã gọn rồi thì dùng lại, không dựng lại mỗi lần');
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
console.log('research_sqlite_tables_test: OK');
