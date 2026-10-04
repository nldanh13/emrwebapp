#!/usr/bin/env node
'use strict';

// Thống kê mô tả biến cho màn hình Tạo nghiên cứu / Thống kê nghiên cứu: đúng số liệu, đúng
// loại đo lường, và văn bản tự do không bị đưa giá trị ra màn hình.
// Chạy: node scripts/research_variable_stats_test.js

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { describeValues, summarizeSelectedDataset } = require('../server/research/variable_selection');
const { summarizeSelectionForRun } = require('../server/research/selection_runtime');

let passed = 0;
function test(name, fn) {
  try { fn(); passed += 1; console.log(`  ok - ${name}`); } catch (err) { console.error(`  FAIL - ${name}`); console.error(err); process.exitCode = 1; }
}

test('biến số: n, trung bình, SD, trung vị, tứ phân vị, khoảng; đếm giá trị không phải số', () => {
  const s = describeValues({ type: 'number' }, ['10', '20', '30', '40', 'âm tính', '']);
  assert.strictEqual(s.kind, 'number');
  assert.strictEqual(s.n, 5);
  assert.strictEqual(s.n_numeric, 4);
  assert.strictEqual(s.non_numeric, 1);
  assert.strictEqual(s.mean, 25);
  assert.strictEqual(s.median, 25);
  assert.strictEqual(s.min, 10);
  assert.strictEqual(s.max, 40);
  assert.strictEqual(s.sd, 12.91);
});

test('biến phân loại: top giá trị kèm %, gom phần còn lại thành "nhóm khác"', () => {
  const values = ['A', 'A', 'A', 'B', 'B', 'C', 'D', 'E', 'F', 'G', 'H'];
  const s = describeValues({ type: 'category' }, values);
  assert.strictEqual(s.kind, 'category');
  assert.deepStrictEqual(s.top[0], { value: 'A', count: 3, pct: 27.3 });
  assert.strictEqual(s.top.length, 6);
  assert.deepStrictEqual(s.other, { groups: 2, count: 2, pct: 18.2 });
});

test('cách lấy "Có / không" và "Số lần" đổi loại đo lường tương ứng', () => {
  assert.strictEqual(describeValues({ type: 'text', aggregation: 'any' }, ['1', '0']).kind, 'category');
  assert.strictEqual(describeValues({ type: 'text', aggregation: 'count' }, ['3', '0']).kind, 'number');
});

test('ngày: khoảng từ–đến; văn bản tự do: không trả giá trị', () => {
  const d = describeValues({ type: 'date' }, ['05/03/2026', '2026-01-02', '']);
  assert.deepStrictEqual([d.kind, d.min, d.max], ['date', '02/01/2026', '05/03/2026']);
  const t = describeValues({ type: 'text' }, Array.from({ length: 25 }, (_, i) => `BN GIA LAP ${i}`));
  assert.strictEqual(t.kind, 'text');
  assert.strictEqual(t.distinct, 25);
  assert.ok(!('top' in t), 'không có danh sách giá trị');
  assert.ok(!JSON.stringify(t).includes('GIA LAP'), 'không lộ nội dung văn bản');
});

test('summary có thống kê từng biến và tóm tắt mẫu (tuổi, giới, số người bệnh)', () => {
  const dataset = {
    rows: [
      { patient_key: 'P1', age: '60', sex: 'Nam', hospital_stay_days: '5', var_hb: '120', encounter_id: 'e1' },
      { patient_key: 'P1', age: '61', sex: 'Nam', hospital_stay_days: '7', var_hb: '', encounter_id: 'e2' },
      { patient_key: 'P2', age: '70', sex: 'Nữ', hospital_stay_days: '9', var_hb: '100', encounter_id: 'e3' },
    ],
    manifest: { variables: [{ id: 'lab.hb', label: 'Hb', survey_label: 'Hb trước mổ', type: 'number', output_column: 'var_hb' }] },
  };
  const s = summarizeSelectedDataset(dataset);
  assert.strictEqual(s.cohort.encounters, 3);
  assert.strictEqual(s.cohort.patients, 2);
  assert.strictEqual(s.cohort.age.median, 61);
  assert.strictEqual(s.cohort.sex.top[0].value, 'Nam');
  assert.strictEqual(s.variables[0].fill_rate, 66.7);
  assert.strictEqual(s.variables[0].stats.mean, 110);
});

test('summarizeSelectionForRun đọc run thật: có và không có điều kiện chọn mẫu', () => {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'research_variable_stats_'));
  fs.writeFileSync(path.join(runDir, 'analysis_ready.csv'), [
    'research_code,encounter_id,patient_key,sex,age',
    'NC1,e1,P1,Nam,60',
    'NC2,e2,P2,Nữ,72',
    'NC3,e3,P3,Nam,45',
  ].join('\n'));
  const variable = { id: 'analysis_ready.age', table: 'analysis_ready', name: 'age', label: 'Tuổi', type: 'number' };
  const all = summarizeSelectionForRun(runDir, { selected_variables: [variable] });
  assert.strictEqual(all.summary.total, 3);
  assert.strictEqual(all.summary.variables[0].stats.median, 60);
  const filtered = summarizeSelectionForRun(runDir, {
    selected_variables: [variable],
    conditions: [{ variable_id: variable.id, table: 'analysis_ready', name: 'age', type: 'number', operator: '>=', value: '50' }],
  });
  assert.strictEqual(filtered.summary.total, 2, 'điều kiện tuổi ≥ 50 giữ 2 lượt');
  assert.strictEqual(filtered.source_total, 3);
});

console.log(`${passed} test(s) passed`);
