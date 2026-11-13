#!/usr/bin/env node
'use strict';
// Danh sách ca còn thiếu dữ liệu: chỉ Mã NC và tên biến thiếu (không giá trị, không định danh),
// ca thiếu nhiều lên trước, giới hạn số dòng nhưng báo đủ tổng số; khớp số đếm của thống kê.
const assert = require('assert');
const { missingVariablesByCase, summarizeSelectedDataset } = require('../server/research/variable_selection');

let failed = 0;
const test = (name, fn) => { try { fn(); console.log(`  ok - ${name}`); } catch (e) { failed += 1; console.error(`  FAIL - ${name}\n`, e); } };
console.log('research_missing_by_case_test');

const variables = [
  { id: 'a', output_column: 'gioi', survey_label: 'Giới tính', type: 'category' },
  { id: 'b', output_column: 'tuoi', survey_label: 'Tuổi', type: 'number' },
];
const rows = [
  { research_code: 'NC1', patient_code: '1001', gioi: 'Nữ', tuoi: '70' },
  { research_code: 'NC2', patient_code: '1002', gioi: '', tuoi: '', needs_manual_review: '1' },
  { research_code: 'NC3', patient_code: '1003', gioi: 'Nam', tuoi: '' },
];

test('ca thiếu nhiều lên trước, đúng tên biến thiếu, có cờ cần xem lại', () => {
  const r = missingVariablesByCase(rows, variables);
  assert.strictEqual(r.total, 2);
  assert.deepStrictEqual(r.cases.map(c => c.research_code), ['NC2', 'NC3']);
  assert.deepStrictEqual(r.cases[0].missing, ['Giới tính', 'Tuổi']);
  assert.strictEqual(r.cases[0].needs_review, true);
  assert.strictEqual(r.cases[1].needs_review, false);
});

test('chỉ có Mã NC, số biến thiếu, tên biến, cờ: không có Mã BN hay giá trị', () => {
  const r = missingVariablesByCase(rows, variables);
  const keys = new Set(r.cases.flatMap(c => Object.keys(c)));
  assert.deepStrictEqual([...keys].sort(), ['missing', 'missing_count', 'needs_review', 'research_code']);
  assert.ok(!JSON.stringify(r).includes('1002'));
  assert.ok(!JSON.stringify(r).includes('Nam'));
});

test('giới hạn số dòng nhưng báo đủ tổng số', () => {
  const many = Array.from({ length: 5 }, (_, i) => ({ research_code: `NC${i}`, gioi: '', tuoi: '1' }));
  const r = missingVariablesByCase(many, variables, 2);
  assert.strictEqual(r.total, 5);
  assert.strictEqual(r.cases.length, 2);
});

test('thống kê trả về danh sách, khớp số lượt thiếu một phần + trống', () => {
  const s = summarizeSelectedDataset({ rows, manifest: { variables } });
  assert.strictEqual(s.missing_by_case_total, s.partial + s.empty);
  assert.deepStrictEqual(s.missing_by_case.map(c => c.research_code), ['NC2', 'NC3']);
});

if (failed) process.exit(1);
console.log('4 test(s) passed.');
