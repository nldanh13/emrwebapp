#!/usr/bin/env node
'use strict';

// Biến tự định nghĩa của nghiên cứu (dữ liệu giả lập): hiệu ngày, công thức (BMI), chia nhóm theo
// ngưỡng, gom nhóm theo từ khóa/ICD, số sau từ khóa trong tờ điều trị theo ngày sau mổ.
// Kiểm cả việc cột mới vào file "Biến đã chọn", thống kê và các ca thiếu dữ liệu.
// Chạy: node scripts/research_derived_variables_test.js

const assert = require('assert');
const vs = require('../server/research/variable_selection');
const dv = require('../server/research/derived_variables');

let passed = 0;
function test(name, fn) {
  try { fn(); passed += 1; console.log(`  ok - ${name}`); } catch (err) { console.error(`  FAIL - ${name}`); console.error(err); process.exitCode = 1; }
}

const encs = [
  { research_code: 'NC1', encounter_id: 'e1', patient_code: 'BN1', age: '72', admission_date: '2026-03-01', discharge_date: '2026-03-10', surgery_date: '2026-03-03', diagnosis_raw: 'Gãy liên mấu chuyển xương đùi phải S72.1' },
  { research_code: 'NC2', encounter_id: 'e2', patient_code: 'BN2', age: '45', admission_date: '2026-04-01', discharge_date: '2026-04-05', surgery_date: '', diagnosis_raw: 'Thoát vị đĩa đệm L4-L5 M51.2' },
];
const tables = {
  clinical_events: [
    { research_code: 'NC1', encounter_id: 'e1', patient_code: 'BN1', event_name: 'weight', value: '60' },
    { research_code: 'NC1', encounter_id: 'e1', patient_code: 'BN1', event_name: 'height', value: '155' },
  ],
  clinical_notes: [
    { research_code: 'NC1', encounter_id: 'e1', patient_code: 'BN1', note_datetime: '2026-03-04 08:00', clinical_text: 'Tỉnh, đau vết mổ VAS: 6/10', order_text: '' },
    { research_code: 'NC1', encounter_id: 'e1', patient_code: 'BN1', note_datetime: '2026-03-04 16:00', clinical_text: 'Đỡ đau, VAS 4 điểm', order_text: '' },
    { research_code: 'NC1', encounter_id: 'e1', patient_code: 'BN1', note_datetime: '2026-03-05 08:00', clinical_text: 'vas 2', order_text: '' },
  ],
};

const selection = {
  selected_variables: [
    { id: 'analysis_ready:surgery_date', table: 'analysis_ready', name: 'surgery_date', label: 'Ngày mổ', type: 'date', aggregation: 'first' },
    { id: 'w', table: 'clinical_events', name: 'value', label: 'Cân nặng', type: 'number', aggregation: 'first', source_filter: { event_name: 'weight' } },
    { id: 'h', table: 'clinical_events', name: 'value', label: 'Chiều cao', type: 'number', aggregation: 'first', source_filter: { event_name: 'height' } },
  ],
  conditions: [],
  derived_variables: [
    { name: 'so_ngay_truoc_mo', label: 'Số ngày từ vào viện tới mổ', kind: 'date_diff', params: { from: 'admission_date', to: 'ngay_mo', unit: 'days' } },
    { name: 'bmi', label: 'BMI', kind: 'formula', params: { expression: 'can_nang / (chieu_cao/100)^2', digits: 1 } },
    { name: 'nhom_bmi', label: 'Phân loại BMI', kind: 'cut', params: { source: 'bmi', breaks: '18.5; 23; 25', labels: 'Gầy; Bình thường; Thừa cân; Béo phì' } },
    { name: 'nhom_tuoi', label: 'Nhóm tuổi', kind: 'cut', params: { source: 'age', breaks: [60], labels: ['<60', '≥60'] } },
    { name: 'vung_pt', label: 'Vùng phẫu thuật', kind: 'keyword_group', params: { sources: ['diagnosis_raw'], rules: [
      { code: '1', label: 'Khớp háng', keywords: 'xương đùi; S72; khớp háng' },
      { code: '2', label: 'Cột sống', keywords: 'đĩa đệm; cột sống; M51' },
    ], fallback: '9' } },
    { name: 'vas_n1', label: 'VAS ngày 1 sau mổ', kind: 'note_number', params: { keyword: 'VAS', day_ref: 'surgery', day: 1, pick: 'max' } },
    { name: 'vas_n1_cuoi', label: 'VAS ngày 1 (lần cuối)', kind: 'note_number', params: { keyword: 'vas', day: 1, pick: 'last' } },
  ],
};

test('định nghĩa được làm sạch, kiểu lạ bị bỏ, tên trùng thêm hậu tố', () => {
  const out = dv.sanitizeDerivedVariables([
    { name: 'Số ngày', kind: 'date_diff', params: { from: 'a', to: 'b' } },
    { name: 'Số ngày', kind: 'formula', params: { expression: '1+1' } },
    { name: 'x', kind: 'eval', params: { code: 'process.exit()' } },
  ]);
  assert.deepStrictEqual(out.map(d => d.name), ['So_ngay', 'So_ngay_2']);
  assert.strictEqual(out[0].params.unit, 'days');
});

test('công thức không dùng eval: ký tự lạ báo lỗi tiếng Việt', () => {
  assert.throws(() => dv.parseFormula('can_nang; process.exit()'), /ký tự không đọc được/);
  assert.throws(() => dv.parseFormula('(a + b'), /đóng ngoặc/);
  assert.throws(() => dv.parseFormula(''), /Chưa nhập/);
});

const ds = vs.buildSelectedAnalysisDataset(encs, selection, tables);
const [r1, r2] = ds.rows;

test('cột biến tự định nghĩa đứng sau biến đã chọn', () => {
  const tail = ds.columns.slice(-7);
  assert.deepStrictEqual(tail, ['so_ngay_truoc_mo', 'bmi', 'nhom_bmi', 'nhom_tuoi', 'vung_pt', 'vas_n1', 'vas_n1_cuoi']);
});

test('hiệu ngày: ngày lịch, thiếu mốc thì để trống', () => {
  assert.strictEqual(r1.so_ngay_truoc_mo, '2');
  assert.strictEqual(r2.so_ngay_truoc_mo, '');
});

test('công thức BMI và chia nhóm từ kết quả biến trước', () => {
  assert.strictEqual(r1.bmi, '25');
  assert.strictEqual(r1.nhom_bmi, 'Béo phì', 'ngưỡng 25 thuộc nhóm trên');
  assert.strictEqual(r2.bmi, '', 'thiếu cân nặng/chiều cao thì không đoán');
  assert.strictEqual(r2.nhom_bmi, '');
  assert.strictEqual(r1.nhom_tuoi, '≥60');
  assert.strictEqual(r2.nhom_tuoi, '<60');
});

test('gom nhóm theo từ khóa/mã ICD, không dấu không phân biệt hoa thường', () => {
  assert.strictEqual(r1.vung_pt, '1');
  assert.strictEqual(r2.vung_pt, '2');
  const row = dv.applyDerivedVariables(dv.sanitizeDerivedVariables([selection.derived_variables[4]]), { diagnosis_raw: 'Gãy xương quay' });
  assert.strictEqual(row.vung_pt, '9');
});

test('số sau từ khóa trong tờ điều trị theo ngày sau mổ', () => {
  assert.strictEqual(r1.vas_n1, '6');
  assert.strictEqual(r1.vas_n1_cuoi, '4');
  assert.strictEqual(r2.vas_n1, '', 'không có ngày mổ thì để trống');
  assert.deepStrictEqual(dv.numbersAfterKeyword('Mất máu khoảng 200 ml, truyền 1 đơn vị', 'mất máu'), [200]);
});

test('thống kê và ca thiếu dữ liệu tính cả biến tự định nghĩa; từ điển có mô tả cách tính', () => {
  const s = vs.summarizeSelectedDataset(ds);
  const bmi = s.variables.find(v => v.output_column === 'bmi');
  assert.ok(bmi, 'BMI có trong thống kê');
  assert.strictEqual(bmi.filled, 1);
  const vung = ds.manifest.variables.find(v => v.output_column === 'vung_pt');
  assert.strictEqual(vung.derived, true);
  assert.strictEqual(vung.type, 'category');
  assert.match(vung.source_note, /Gom nhóm theo từ khóa/);
  const nc2 = s.missing_by_case.find(c => c.research_code === 'NC2');
  assert.ok(nc2.missing.includes('BMI'));
});

test('kiểm định nghĩa: cột không có, chưa nhập ngưỡng', () => {
  const defs = dv.sanitizeDerivedVariables([
    { name: 'a', kind: 'formula', params: { expression: 'khong_co / 2' } },
    { name: 'b', kind: 'cut', params: { source: 'age', breaks: '' } },
    { name: 'c', kind: 'cut', params: { source: 'a', breaks: '1' } },
  ]);
  const errs = dv.validateDerivedVariables(defs, ['age']);
  assert.strictEqual(errs.length, 2, errs.join('\n'));
  assert.match(errs[0], /không có cột "khong_co"/);
  assert.match(errs[1], /chưa nhập ngưỡng/);
});

test('tên trùng cột có sẵn: đổi tên, biến sau vẫn trỏ đúng', () => {
  const d = vs.buildSelectedAnalysisDataset(encs, {
    selected_variables: selection.selected_variables.slice(0, 1), conditions: [],
    derived_variables: [
      { name: 'age', label: 'Tuổi x2', kind: 'formula', params: { expression: 'age * 2' } },
      { name: 'nhom', label: 'Nhóm', kind: 'cut', params: { source: 'age', breaks: '100', labels: 'thấp; cao' } },
    ],
  }, {});
  assert.strictEqual(d.rows[0].age, '72');
  assert.strictEqual(d.rows[0].age_2, '144');
  assert.strictEqual(d.rows[0].nhom, 'cao');
});

test('nạp Diễn biến/Y lệnh khi có biến tìm số trong tờ điều trị', () => {
  const sel = vs.sanitizeVariableSelection(selection);
  assert.ok(vs.hasActiveSelection({ derived_variables: sel.derived_variables }));
  assert.strictEqual(sel.derived_variables.length, 7);
});

console.log(`${passed} test(s) passed`);
