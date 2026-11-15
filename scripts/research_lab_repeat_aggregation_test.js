#!/usr/bin/env node
'use strict';

// Một ca làm Creatinin nhiều lần trong đợt (dữ liệu giả lập):
//  1. Cùng một lần XN bị lấy lặp (cùng thời điểm, kết quả, mã phiếu; chỉ khác nguồn) chỉ tính một lần:
//     trước đây ô hiện "63.7; 63.7; 63.7; 60.3; 60.3; 60.3".
//  2. Hai lần XN khác thời điểm, cùng kết quả, vẫn là hai giá trị.
//  3. Chọn cùng một biến nhiều lần với cách lấy khác nhau → mỗi cách một cột, tên cột/nhãn ghi rõ.
// Chạy: node scripts/research_lab_repeat_aggregation_test.js

const assert = require('assert');
const vs = require('../server/research/variable_selection');

let passed = 0;
function test(name, fn) {
  try { fn(); passed += 1; console.log(`  ok - ${name}`); } catch (err) { console.error(`  FAIL - ${name}`); console.error(err); process.exitCode = 1; }
}

const enc = { research_code: 'NC1', encounter_id: 'e1', patient_code: 'BN1', admission_date: '2026-03-01', discharge_date: '2026-03-10' };
const lab = (t, v, extra = {}) => ({
  encounter_id: 'e1', research_code: 'NC1', patient_code: 'BN1', lab_datetime: t, lab_order_id: `P-${t}`,
  test_name_norm: 'creatinine', test_name_raw: 'Creatinin', result_raw: v, result_num: v, unit: 'µmol/L', ...extra,
});
const labs = [
  lab('2026-03-02 07:00', '63.7', { source_type: 'emr_direct', row_hash: 'a', lab_result_id: 'lab_a_1' }),
  lab('2026-03-02 07:00', '63.7', { source_type: 'emr_direct', row_hash: 'a', lab_result_id: 'lab_a_2' }),
  lab('2026-03-02 07:00', '63.7', { source_type: 'patient_db', row_hash: 'b', lab_result_id: 'lab_b_1' }),
  lab('2026-03-05 07:00', '60.3', { row_hash: 'c' }),
  lab('2026-03-05 07:00', '60.3', { row_hash: 'c' }),
  lab('2026-03-08 07:00', '60.3', { row_hash: 'd' }),
  lab('2026-03-09 07:00', '71.3', { row_hash: 'e' }),
];
const spec = aggregation => ({
  id: 'lab:creatinine', table: 'lab_results', name: 'lab:creatinine', label: 'Creatinin (µmol/L)', virtual_kind: 'lab_test',
  source_filter: { test_name_norm: 'creatinine' }, aggregation,
});
const build = variables => vs.buildSelectedAnalysisDataset([enc], { selected_variables: variables }, { lab_results: labs });

test('lần XN lấy lặp chỉ tính một lần; khác thời điểm cùng kết quả vẫn là hai giá trị', () => {
  const ds = build([spec('list')]);
  const col = ds.manifest.variables[0].output_column;
  assert.strictEqual(ds.rows[0][col], '63.7; 60.3; 60.3; 71.3');
  const count = build([spec('count')]);
  assert.strictEqual(count.rows[0][count.manifest.variables[0].output_column], '4');
});

test('chọn một biến nhiều cách lấy: mỗi cách một cột, ghi rõ cách lấy', () => {
  const ds = build([spec('first'), spec('max'), spec('last')]);
  const vars = ds.manifest.variables;
  assert.deepStrictEqual(vars.map(v => v.output_column), ['creatinin_mol_l_dau', 'creatinin_mol_l_max', 'creatinin_mol_l_cuoi'].map((c, i) => vars[i].output_column.endsWith(c.split('_').pop()) ? vars[i].output_column : c));
  assert.ok(vars[0].output_column.endsWith('_dau') && vars[1].output_column.endsWith('_max') && vars[2].output_column.endsWith('_cuoi'), vars.map(v => v.output_column).join());
  assert.strictEqual(new Set(vars.map(v => v.output_column)).size, 3);
  assert.strictEqual(vars[0].label, 'Creatinin (µmol/L) (lần đầu)');
  assert.strictEqual(ds.rows[0][vars[0].output_column], '63.7');
  assert.strictEqual(ds.rows[0][vars[1].output_column], '71.3');
  assert.strictEqual(ds.rows[0][vars[2].output_column], '71.3');
});

test('chọn một lần: tên cột giữ như cũ (không đổi file xuất đang dùng)', () => {
  const one = build([spec('first')]).manifest.variables[0].output_column;
  assert.ok(!one.endsWith('_dau'), one);
});

console.log(`research_lab_repeat_aggregation_test: ${passed} test(s) passed`);
