#!/usr/bin/env node
'use strict';

// Chọn mẫu theo đề cương: thời gian nghiên cứu → tiêu chuẩn chọn vào → tiêu chuẩn loại trừ →
// mỗi người bệnh một lượt; vai trò biến (kết cục chính...) đi theo thống kê.
// Chạy: node scripts/research_cohort_selection_test.js

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
process.env.EMR_RUNTIME_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'cohort_sel_'));
const vs = require('../server/research/variable_selection');
const { writeCsv } = require('../server/research/table_io');
const { summarizeSelectionForRun } = require('../server/research/selection_runtime');

let passed = 0;
function test(name, fn) {
  try { fn(); passed += 1; console.log(`  ok - ${name}`); } catch (err) { console.error(`  FAIL - ${name}`); console.error(err); process.exitCode = 1; }
}

const encounters = [
  { research_code: 'NC1', encounter_id: 'e1', patient_code: 'BN1', patient_key: 'P1', admission_date: '2026-01-10', age: '70', sex: 'Nữ' },
  { research_code: 'NC2', encounter_id: 'e2', patient_code: 'BN1', patient_key: 'P1', admission_date: '2026-03-05', age: '70', sex: 'Nữ' },
  { research_code: 'NC3', encounter_id: 'e3', patient_code: 'BN2', patient_key: 'P2', admission_date: '05/02/2026 08:30', age: '65', sex: 'Nam' },
  { research_code: 'NC4', encounter_id: 'e4', patient_code: 'BN3', patient_key: 'P3', admission_date: '2025-12-20', age: '80', sex: 'Nữ' },
  { research_code: 'NC5', encounter_id: 'e5', patient_code: 'BN4', patient_key: 'P4', admission_date: '2026-02-15', age: '55', sex: 'Nam' },
];
const diagnoses = [
  { encounter_id: 'e1', icd_code: 'M81.0' }, { encounter_id: 'e2', icd_code: 'M81.0' }, { encounter_id: 'e3', icd_code: 'M80.0' },
  { encounter_id: 'e4', icd_code: 'M81.0' }, { encounter_id: 'e5', icd_code: 'M81.0' }, { encounter_id: 'e5', icd_code: 'N18.5' },
];
const ageVar = { id: 'analysis_ready.age', table: 'analysis_ready', name: 'age', type: 'number', role: 'primary_outcome' };
const osteo = { id: 'c1', variable_id: 'dx', table: 'diagnoses', name: 'icd_code', operator: 'starts_with', value: 'M8' };
const ckd = { id: 'c2', variable_id: 'dx', table: 'diagnoses', name: 'icd_code', operator: 'starts_with', value: 'N18', exclude: true };

test('sanitize giữ vai trò hợp lệ, bỏ vai trò lạ; giữ exclude, period, one_per_patient, sample_size', () => {
  const s = vs.sanitizeVariableSelection({
    selected_variables: [ageVar, { ...ageVar, id: 'x', role: 'hack' }],
    conditions: [ckd], period: { from: '2026-01-01', to: '31/03/2026' }, one_per_patient: true,
    sample_size: { design: 'prop_one', p: '0.3', d: 0.05, __proto__: 1, junk: 'abc' },
  });
  assert.strictEqual(s.selected_variables[0].role, 'primary_outcome');
  assert.strictEqual(s.selected_variables[1].role, '');
  assert.strictEqual(s.conditions[0].exclude, true);
  assert.deepStrictEqual(s.period, { from: '2026-01-01', to: '2026-03-31' });
  assert.strictEqual(s.one_per_patient, true);
  assert.deepStrictEqual(s.sample_size, { design: 'prop_one', p: 0.3, d: 0.05 });
});

test('thời gian nghiên cứu theo ngày nhập viện (ISO và dd/mm/yyyy có giờ)', () => {
  const out = vs.filterCohortRowsByVariableSelection(encounters, { period: { from: '2026-01-01', to: '2026-02-28' } }, {}).rows;
  assert.deepStrictEqual(out.map(r => r.encounter_id), ['e1', 'e3', 'e5']);
});

test('tiêu chuẩn loại trừ loại lượt khớp', () => {
  const out = vs.filterCohortRowsByVariableSelection(encounters, { conditions: [osteo, ckd] }, { diagnoses }).rows;
  assert.deepStrictEqual(out.map(r => r.encounter_id), ['e1', 'e2', 'e3', 'e4']);
});

test('mỗi người bệnh lấy lượt nhập viện sớm nhất', () => {
  const out = vs.filterCohortRowsByVariableSelection(encounters, { one_per_patient: true }, {}).rows;
  assert.deepStrictEqual(out.map(r => r.encounter_id), ['e1', 'e3', 'e4', 'e5']);
});

test('sơ đồ sàng lọc theo thứ tự đề cương và vai trò biến trong thống kê', () => {
  const runDir = path.join(process.env.EMR_RUNTIME_ROOT, 'run');
  fs.mkdirSync(runDir, { recursive: true });
  writeCsv(path.join(runDir, 'analysis_ready.csv'), Object.keys(encounters[0]), encounters);
  writeCsv(path.join(runDir, 'diagnoses.csv'), ['encounter_id', 'icd_code'], diagnoses);
  const r = summarizeSelectionForRun(runDir, {
    selected_variables: [ageVar],
    conditions: [osteo, ckd],
    period: { from: '2026-01-01' },
    one_per_patient: true,
  });
  assert.deepStrictEqual(r.summary.funnel.map(f => f.encounters), [5, 4, 4, 3, 2]);
  assert.match(r.summary.funnel[1].label, /Nhập viện từ 01\/01\/2026/);
  assert.match(r.summary.funnel[3].label, /^Loại trừ: /);
  assert.strictEqual(r.summary.funnel[3].exclude, true);
  assert.match(r.summary.funnel[4].label, /Mỗi người bệnh/);
  assert.strictEqual(r.summary.total, 2);
  assert.strictEqual(r.summary.variables[0].role, 'primary_outcome');
});

fs.rmSync(process.env.EMR_RUNTIME_ROOT, { recursive: true, force: true });
console.log(`\n${passed} test(s) passed.`);
