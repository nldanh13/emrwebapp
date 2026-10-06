#!/usr/bin/env node
'use strict';
// Nghiên cứu riêng chỉ thêm/bớt biến trên dữ liệu đã có: đổi danh sách biến thì "Biến đã chọn"
// dựng lại ngay, mẫu nghiên cứu (tiêu chuẩn chọn) giữ nguyên, kho dữ liệu gốc không bị đụng tới.
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
process.env.EMR_RUNTIME_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'study_vars_'));
const { writeCsv, readCsvTable } = require('../server/research/table_io');
const { archiveRunsDir, ensureArchiveStore, studyMetaPath, runsDir, studyDir } = require('../server/research/store_paths');
const { readStudy } = require('../server/research/run_registry');
const { updateStudyVariables } = require('../server/research/study_variables');

let failed = 0;
const test = (name, fn) => { try { fn(); console.log(`  ok - ${name}`); } catch (e) { failed += 1; console.error(`  FAIL - ${name}\n`, e); } };
console.log('research_study_variables_test');

const hashDir = (dir) => {
  const h = crypto.createHash('sha1');
  const walk = (d) => { for (const n of fs.readdirSync(d).sort()) { const p = path.join(d, n); const st = fs.statSync(p); if (st.isDirectory()) walk(p); else h.update(`${p}:${fs.readFileSync(p)}`); } };
  if (fs.existsSync(dir)) walk(dir);
  return h.digest('hex');
};

ensureArchiveStore();
const archiveRun = path.join(archiveRunsDir(), '20260101_000000');
fs.mkdirSync(archiveRun, { recursive: true });
writeCsv(path.join(archiveRun, 'analysis_ready.csv'), ['research_code', 'sex', 'age'], [{ research_code: 'NC1', sex: 'Nữ', age: '70' }]);

const STUDY = 'nc_test';
fs.mkdirSync(studyDir(STUDY), { recursive: true });
const condition = { id: 'c1', variable_id: 'analysis_ready.age', table: 'analysis_ready', name: 'age', label: 'Tuổi', type: 'number', operator: '>=', value: '50' };
const sexVar = { id: 'analysis_ready.sex', table: 'analysis_ready', name: 'sex', label: 'Giới tính', type: 'category' };
const ageVar = { id: 'analysis_ready.age', table: 'analysis_ready', name: 'age', label: 'Tuổi', type: 'number' };
const selection = { selected_variables: [sexVar], conditions: [condition], one_per_patient: true };
fs.writeFileSync(studyMetaPath(STUDY), JSON.stringify({ id: STUDY, name: 'NC thử', analysis_config: { preset: 'general', custom_fields: [], variable_selection: selection }, variable_selection: selection }));
const runDir = path.join(runsDir(STUDY), '20260102_000000');
fs.mkdirSync(runDir, { recursive: true });
fs.writeFileSync(path.join(runDir, 'manifest.json'), JSON.stringify({ run_id: '20260102_000000' }));
writeCsv(path.join(runDir, 'analysis_ready.csv'), ['research_code', 'encounter_id', 'patient_key', 'sex', 'age'], [
  { research_code: 'NC1', encounter_id: 'e1', patient_key: 'p1', sex: 'Nữ', age: '70' },
  { research_code: 'NC2', encounter_id: 'e2', patient_key: 'p2', sex: 'Nam', age: '65' },
]);
writeCsv(path.join(runDir, 'analysis_final.csv'), ['research_code', 'sex'], [{ research_code: 'NC1', sex: 'Nữ' }]);

const archiveBefore = hashDir(path.dirname(archiveRunsDir()));

test('thêm biến → lưu vào nghiên cứu, "Biến đã chọn" dựng lại có cột mới, đủ lượt', () => {
  const r = updateStudyVariables(STUDY, [sexVar, ageVar]);
  assert.strictEqual(r.variables, 2);
  assert.strictEqual(r.rows, 2);
  const study = readStudy(STUDY);
  assert.deepStrictEqual(study.variable_selection.selected_variables.map(v => v.id), ['analysis_ready.sex', 'analysis_ready.age']);
  assert.deepStrictEqual(study.analysis_config.variable_selection.selected_variables.map(v => v.id), ['analysis_ready.sex', 'analysis_ready.age']);
  const selected = readCsvTable(path.join(runDir, 'analysis_selected.csv'), 100);
  assert.ok(selected.columns.some(c => /age|Tuổi/i.test(c)), `có cột tuổi: ${selected.columns}`);
  assert.strictEqual(selected.rows.length, 2);
});

test('tiêu chuẩn chọn mẫu, mỗi người một lượt giữ nguyên', () => {
  const sel = readStudy(STUDY).variable_selection;
  assert.strictEqual(sel.conditions.length, 1);
  assert.strictEqual(sel.conditions[0].operator, '>=');
  assert.strictEqual(sel.one_per_patient, true);
});

test('dataset cuối dựng theo biến cũ bị gỡ (có bản sao lưu), không để lệch biến', () => {
  assert.ok(!fs.existsSync(path.join(runDir, 'analysis_final.csv')));
});

test('bớt biến → còn đúng biến đã giữ', () => {
  updateStudyVariables(STUDY, [ageVar]);
  assert.deepStrictEqual(readStudy(STUDY).variable_selection.selected_variables.map(v => v.id), ['analysis_ready.age']);
});

test('không còn biến nào → báo lỗi tiếng Việt, không ghi', () => {
  assert.throws(() => updateStudyVariables(STUDY, []), /Chọn ít nhất 1 biến/);
  assert.strictEqual(readStudy(STUDY).variable_selection.selected_variables.length, 1);
});

test('kho dữ liệu gốc không bị đụng tới', () => {
  assert.strictEqual(hashDir(path.dirname(archiveRunsDir())), archiveBefore);
});

if (failed) process.exit(1);
console.log('6 test(s) passed.');
