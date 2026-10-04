#!/usr/bin/env node
'use strict';

// Mốc thời gian (lần đầu dùng thuốc / nhập viện / phẫu thuật) và cửa sổ ngày quanh mốc cho
// biến của nghiên cứu, vd. đề tài phản ứng pha cấp sau truyền Zoledronic Acid:
//  - Vitamin D "gần trước mốc nhất" trong 14 ngày trước truyền
//  - số lần dùng Paracetamol trong ngày 1–3 sau truyền
// Chạy: node scripts/research_anchor_window_test.js

const assert = require('assert');
const vs = require('../server/research/variable_selection');

let passed = 0;
function test(name, fn) {
  try { fn(); passed += 1; console.log(`  ok - ${name}`); } catch (err) { console.error(`  FAIL - ${name}`); console.error(err); process.exitCode = 1; }
}

const enc = { research_code: 'NC1', encounter_id: 'e1', patient_code: 'BN1', patient_key: 'P1', admission_date: '01/03/2026', discharge_date: '20/03/2026', surgery_date: '' };
const enc2 = { research_code: 'NC2', encounter_id: 'e2', patient_code: 'BN2', patient_key: 'P2', admission_date: '01/03/2026', discharge_date: '05/03/2026', surgery_date: '' };
const tables = {
  medication_orders: [
    { encounter_id: 'e1', order_datetime: '2026-03-10 14:00', drug_name_raw: 'Zoledronic acid 5mg/100ml (Aclasta)' },
    { encounter_id: 'e1', order_datetime: '2026-03-12 09:00', drug_name_raw: 'Zoledronic acid 5mg/100ml (Aclasta)' },
    { encounter_id: 'e1', order_datetime: '2026-03-09 08:00', drug_name_raw: 'Paracetamol 500mg' },
    { encounter_id: 'e1', order_datetime: '2026-03-11 08:00', drug_name_raw: 'Paracetamol 500mg' },
    { encounter_id: 'e1', order_datetime: '2026-03-13 20:00', drug_name_raw: 'Paracetamol 500mg' },
    { encounter_id: 'e1', order_datetime: '2026-03-15 08:00', drug_name_raw: 'Paracetamol 500mg' },
  ],
  lab_results: [
    { encounter_id: 'e1', lab_datetime: '2026-02-20 07:00', test_name_raw: 'Vitamin D', result_num: '18' },
    { encounter_id: 'e1', lab_datetime: '2026-03-05 07:00', test_name_raw: 'Vitamin D', result_num: '22' },
    { encounter_id: 'e1', lab_datetime: '2026-03-10 16:00', test_name_raw: 'Vitamin D', result_num: '30' },
  ],
};
const selection = {
  anchor: { kind: 'drug', drug: 'Zoledronic', label: 'Truyền Zoledronic Acid' },
  selected_variables: [
    { id: 'lab:vitd', table: 'lab_results', name: 'lab:Vitamin D', label: 'Vitamin D', type: 'number', virtual_kind: 'lab_item', aggregation: 'closest_before_anchor', window_from_days: -14, window_to_days: 0 },
    { id: 'drug:para', table: 'medication_orders', name: 'drug:Paracetamol', label: 'Paracetamol', virtual_kind: 'drug_item', aggregation: 'count', window_from_days: 1, window_to_days: 3 },
    { id: 'lab:vitd_all', table: 'lab_results', name: 'lab:Vitamin D', label: 'Vitamin D (mọi lúc)', type: 'number', virtual_kind: 'lab_item', aggregation: 'count' },
  ],
};

test('làm sạch cấu hình: giữ mốc thuốc và cửa sổ, bỏ mốc không hợp lệ', () => {
  const clean = vs.sanitizeVariableSelection(selection);
  assert.deepStrictEqual(clean.anchor, { kind: 'drug', drug: 'Zoledronic', label: 'Truyền Zoledronic Acid' });
  assert.strictEqual(clean.selected_variables[0].window_from_days, -14);
  assert.strictEqual(clean.selected_variables[0].window_to_days, 0);
  assert.ok(!('window_from_days' in clean.selected_variables[2]));
  assert.strictEqual(vs.sanitizeVariableSelection({ ...selection, anchor: { kind: 'drug', drug: 'a' } }).anchor, undefined, 'tên thuốc quá ngắn');
  assert.strictEqual(vs.sanitizeVariableSelection({ ...selection, anchor: { kind: 'xyz' } }).anchor, undefined);
});

test('mốc = y lệnh Zoledronic sớm nhất trong đợt; lượt không dùng thuốc thì không có mốc', () => {
  const ds = vs.buildSelectedAnalysisDataset([enc, enc2], selection, tables);
  assert.ok(ds.columns.includes('anchor_datetime'));
  assert.strictEqual(ds.rows[0].anchor_datetime, '2026-03-10 14:00');
  assert.strictEqual(ds.rows[1].anchor_datetime, '');
});

test('Vitamin D gần trước mốc nhất trong 14 ngày: bỏ kết quả 20/02 (quá 14 ngày) và kết quả sau mốc', () => {
  const ds = vs.buildSelectedAnalysisDataset([enc], selection, tables);
  const col = ds.manifest.variables[0].output_column;
  assert.strictEqual(ds.rows[0][col], '22');
});

test('Paracetamol trong ngày 1–3 sau truyền: đếm 11/03 và 13/03, không đếm 09/03 và 15/03', () => {
  const ds = vs.buildSelectedAnalysisDataset([enc], selection, tables);
  assert.strictEqual(ds.rows[0][ds.manifest.variables[1].output_column], '2');
  assert.strictEqual(ds.rows[0][ds.manifest.variables[2].output_column], '3', 'không đặt cửa sổ thì đếm mọi lúc');
});

test('không có mốc thì biến có cửa sổ để trống; summary báo số lượt có/không có mốc', () => {
  const ds = vs.buildSelectedAnalysisDataset([enc, enc2], selection, tables);
  assert.strictEqual(ds.rows[1][ds.manifest.variables[0].output_column], '');
  const summary = vs.summarizeSelectedDataset(ds);
  assert.strictEqual(summary.anchor.found, 1);
  assert.strictEqual(summary.anchor.missing, 1);
});

test('mốc ngày nhập viện vẫn dùng được với cửa sổ (biến bảng nhiều dòng)', () => {
  const ds = vs.buildSelectedAnalysisDataset([enc], {
    anchor: { kind: 'admission' },
    selected_variables: [{ id: 'lab:vitd', table: 'lab_results', name: 'lab:Vitamin D', virtual_kind: 'lab_item', aggregation: 'count', window_from_days: 0, window_to_days: 7 }],
  }, tables);
  assert.strictEqual(ds.rows[0][ds.manifest.variables[0].output_column], '1', 'chỉ kết quả 05/03 nằm trong 7 ngày đầu');
});

console.log(`${passed} test(s) passed`);
