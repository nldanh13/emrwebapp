#!/usr/bin/env node
'use strict';
// Rà giá trị lạ trước khi xuất: báo tuổi/năm sinh/ngày vô lý, ô không phải số, giá trị khác xa
// phần còn lại; không tự sửa; chỉ Mã NC (giả danh), không có Mã BN/họ tên; khớp dataset thống kê.
const assert = require('assert');
const { checkSelectedValues } = require('../server/research/value_checks');
const { summarizeSelectedDataset } = require('../server/research/variable_selection');

let failed = 0;
let passed = 0;
const test = (name, fn) => { try { fn(); passed += 1; console.log(`  ok - ${name}`); } catch (e) { failed += 1; console.error(`  FAIL - ${name}\n`, e); } };
console.log('research_value_checks_test');

const NOW = new Date(2026, 10, 13);
const glucose = { id: 'lab.glu', output_column: 'glucose', survey_label: 'Glucose', type: 'number', aggregation: 'first' };
const surgeryDate = { id: 'sx.date', output_column: 'ngay_mo', survey_label: 'Ngày mổ', type: 'date', aggregation: 'first' };
const listVar = { id: 'lab.hb', output_column: 'hb', survey_label: 'Hb', type: 'number', aggregation: 'list' };

// 25 lượt glucose 5–7 mmol/L, một lượt 108 (nhập mg/dL), một ô "cao".
const base = Array.from({ length: 25 }, (_, i) => ({
  research_code: `NC${String(i + 1).padStart(3, '0')}`, patient_code: `10${i}`, age: '60', birth_year: '1966',
  admission_date: '2026-01-02', discharge_date: '2026-01-05', hospital_stay_days: '3',
  glucose: String(5 + (i % 5) * 0.5), ngay_mo: '2026-01-03', hb: '120',
}));
const rows = [
  ...base,
  { research_code: 'NC900', patient_code: '9001', age: '206', birth_year: '1820', admission_date: '2026-03-10', discharge_date: '2026-03-01', hospital_stay_days: '-9', glucose: '108', ngay_mo: '2027-05-01', hb: '120; 98' },
  { research_code: 'NC901', patient_code: '9002', age: '45', admission_date: '2026-12-01', glucose: 'cao', hb: '130' },
];
const variables = [glucose, surgeryDate, listVar];
const r = checkSelectedValues(rows, variables, { now: NOW });
const reasonsFor = (code, column) => r.issues.filter(i => i.research_code === code && i.column === column).map(i => i.reason);

test('lượt bình thường không bị báo', () => {
  assert.ok(!r.issues.some(i => i.research_code.startsWith('NC0')), JSON.stringify(r.issues.filter(i => i.research_code.startsWith('NC0'))));
});

test('cột nền: tuổi, năm sinh, ngày nằm viện âm, ngày ra trước ngày vào, ngày tương lai', () => {
  assert.deepStrictEqual(reasonsFor('NC900', 'age'), ['Tuổi ngoài khoảng 0–120']);
  assert.match(reasonsFor('NC900', 'birth_year')[0], /Năm sinh ngoài khoảng 1900–2026/);
  assert.deepStrictEqual(reasonsFor('NC900', 'hospital_stay_days'), ['Số ngày nằm viện âm']);
  assert.match(reasonsFor('NC900', 'discharge_date')[0], /Ngày ra trước ngày vào/);
  assert.deepStrictEqual(reasonsFor('NC901', 'admission_date'), ['Ngày ở tương lai']);
});

test('số liệu khác xa phần còn lại (nhầm đơn vị) và ô không phải số', () => {
  assert.match(reasonsFor('NC900', 'glucose')[0], /Khác xa phần còn lại \(phần lớn từ 5\.5–6\.5\)/);
  assert.deepStrictEqual(reasonsFor('NC901', 'glucose'), ['Không đọc được thành số']);
  assert.deepStrictEqual(reasonsFor('NC900', 'hb'), ['Nhiều giá trị trong một ô']);
});

test('biến ngày: ngày ở tương lai', () => {
  assert.deepStrictEqual(reasonsFor('NC900', 'ngay_mo'), ['Ngày ở tương lai']);
});

test('ít hơn 20 giá trị: không đánh dấu "khác xa" (chưa đủ căn cứ)', () => {
  const few = [{ research_code: 'A', glucose: '5' }, { research_code: 'B', glucose: '500' }];
  assert.strictEqual(checkSelectedValues(few, [glucose], { now: NOW }).total, 0);
});

test('không có Mã BN; không sửa dữ liệu; đếm theo biến và số lượt', () => {
  const snapshot = JSON.stringify(rows);
  const again = checkSelectedValues(rows, variables, { now: NOW });
  assert.strictEqual(JSON.stringify(rows), snapshot);
  assert.ok(!JSON.stringify(again).includes('9001'));
  const keys = new Set(again.issues.flatMap(i => Object.keys(i)));
  assert.deepStrictEqual([...keys].sort(), ['column', 'label', 'reason', 'research_code', 'value']);
  assert.strictEqual(again.cases, 2);
  assert.strictEqual(again.by_variable.reduce((s, v) => s + v.count, 0), again.total);
});

test('biến định danh (ngày sinh) không bao giờ đưa giá trị ra danh sách', () => {
  const dob = { id: 'patients.birth_date', name: 'birth_date', output_column: 'ngay_sinh', label: 'Ngày sinh', type: 'date', aggregation: 'first' };
  const x = checkSelectedValues([{ research_code: 'A', ngay_sinh: '2030-01-01' }], [dob], { now: NOW });
  assert.strictEqual(x.total, 0);
});

test('giới hạn số dòng nhưng báo đủ tổng số', () => {
  const x = checkSelectedValues(rows, variables, { now: NOW, limit: 2 });
  assert.strictEqual(x.issues.length, 2);
  assert.strictEqual(x.total, r.total);
});

test('thống kê nghiên cứu có kèm danh sách giá trị cần kiểm (cùng dataset)', () => {
  const s = summarizeSelectedDataset({ rows, manifest: { variables } });
  assert.ok(s.value_issues_total >= r.total - 1, `${s.value_issues_total} vs ${r.total}`);
  assert.ok(s.value_issues.some(i => i.research_code === 'NC900' && i.column === 'glucose'));
});

if (failed) process.exit(1);
console.log(`${passed} test(s) passed.`);
