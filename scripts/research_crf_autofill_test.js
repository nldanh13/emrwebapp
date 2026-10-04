#!/usr/bin/env node
'use strict';

// Phiếu nhập tay tự điền từ dữ liệu EMR/kho: XN 14 ngày trước truyền (gần mốc nhất), thuốc 3 ngày
// trước truyền, statin, bệnh kèm theo ICD, năm sinh/giới/khoa, buổi truyền; giá trị nhập tay được ưu tiên.
// Chạy: node scripts/research_crf_autofill_test.js

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
process.env.EMR_RUNTIME_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'crf_autofill_'));
const { writeCsv } = require('../server/research/table_io');
const { computeAutoValues } = require('../server/research/crf_autofill');
const crfStore = require('../server/research/crf_store');
const { studyDir, cohortPath } = require('../server/research/store_paths');

let passed = 0;
function test(name, fn) {
  try { fn(); passed += 1; console.log(`  ok - ${name}`); } catch (err) { console.error(`  FAIL - ${name}`); console.error(err); process.exitCode = 1; }
}

const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crf_autofill_run_'));
const w = (name, rows) => writeCsv(path.join(runDir, `${name}.csv`), Object.keys(rows[0]), rows);
w('analysis_ready', [
  { research_code: 'NC1', encounter_id: 'e1', birth_year: '1950', sex: 'Nữ' },
  { research_code: 'NC2', encounter_id: 'e2', birth_year: '1960', sex: 'Nam' },
]);
w('encounters', [{ research_code: 'NC1', encounter_id: 'e1', department: 'Nội tổng hợp' }, { research_code: 'NC2', encounter_id: 'e2', department: 'Cấp cứu' }]);
w('analysis_selected', [{ research_code: 'NC1', anchor_datetime: '2026-03-10 14:00' }, { research_code: 'NC2', anchor_datetime: '' }]);
w('diagnoses', [
  { research_code: 'NC1', encounter_id: 'e1', icd_code: 'M81.0' },
  { research_code: 'NC1', encounter_id: 'e1', icd_code: 'E11.9' },
  { research_code: 'NC2', encounter_id: 'e2', icd_code: 'M80.0' },
  { research_code: 'NC2', encounter_id: 'e2', icd_code: 'M06.9' },
]);
w('lab_results', [
  { research_code: 'NC1', lab_datetime: '2026-02-20 07:00', test_name_raw: '25(OH) Vitamin D', result_num: '18', unit: 'ng/mL' }, // > 14 ngày: bỏ
  { research_code: 'NC1', lab_datetime: '2026-03-01 07:00', test_name_raw: '25(OH) Vitamin D', result_num: '22.5', unit: 'ng/mL' },
  { research_code: 'NC1', lab_datetime: '2026-03-09 07:00', test_name_raw: 'Canxi ion hóa', result_num: '1.12', unit: 'mmol/L' },
  { research_code: 'NC1', lab_datetime: '2026-03-08 07:00', test_name_raw: 'WBC', result_num: '6.1', unit: 'G/L' },
  { research_code: 'NC1', lab_datetime: '2026-03-09 07:00', test_name_raw: 'WBC', result_num: '7.4', unit: 'G/L' },
  { research_code: 'NC1', lab_datetime: '2026-03-09 07:00', test_name_raw: 'LYM%', result_num: '31', unit: '%' },
  { research_code: 'NC1', lab_datetime: '2026-03-09 07:00', test_name_raw: 'LYM#', result_num: '2.1', unit: 'G/L' },
  { research_code: 'NC1', lab_datetime: '2026-03-09 07:00', test_name_raw: 'MONO%', result_num: '6', unit: '%' },
  { research_code: 'NC1', lab_datetime: '2026-03-09 07:00', test_name_raw: 'eGFR (CKD-EPI)', result_num: '68', unit: 'mL/ph/1.73m2' },
  { research_code: 'NC1', lab_datetime: '2026-03-11 07:00', test_name_raw: 'WBC', result_num: '12', unit: 'G/L' }, // sau truyền: bỏ
]);
w('medication_orders', [
  { research_code: 'NC1', order_datetime: '2026-03-08 08:00', drug_name_raw: 'Celecoxib 200mg', active_ingredient: '' },
  { research_code: 'NC1', order_datetime: '2026-03-10 13:00', drug_name_raw: 'Paracetamol 1g/100ml', active_ingredient: '' }, // cùng ngày truyền: dự phòng
  { research_code: 'NC1', order_datetime: '2026-03-10 14:00', drug_name_raw: 'Aclasta 5mg/100ml', active_ingredient: 'Acid Zoledronic' },
  { research_code: 'NC1', order_datetime: '2026-03-05 08:00', drug_name_raw: 'Atorvastatin 20mg', active_ingredient: '' },
  { research_code: 'NC2', order_datetime: '2026-04-02 09:30', drug_name_raw: 'Aclasta 5mg/100ml', active_ingredient: 'Acid Zoledronic' },
]);

const field = (id, type, auto, extra = {}) => ({ id, label: id, type, auto, ...extra });
const form = crfStore.sanitizeForm({ fields: [
  field('nam_sinh', 'number', 'birth_year'), field('gioi', 'choice', 'sex', { options: ['Nam', 'Nữ'] }), field('khoa', 'text', 'department'),
  field('chan_doan', 'choice', 'osteo_dx', { options: ['Loãng xương sau mãn kinh/nguyên phát', 'Loãng xương nặng (có gãy xương)'] }),
  field('gay_xuong', 'yesno', 'fracture'), field('ksv', 'yesno', 'analgesic_3d'), field('ten_ksv', 'text', 'analgesic_3d_names'),
  field('statin', 'yesno', 'statin'), field('dtd', 'yesno', 'dm'), field('tu_mien', 'yesno', 'autoimmune'),
  field('vitd', 'number', 'lab_vitd'), field('ngay_vitd', 'date', 'lab_vitd_date'), field('ca', 'number', 'lab_ca_ion'), field('egfr', 'number', 'lab_egfr'),
  field('wbc', 'number', 'lab_wbc'), field('lym', 'number', 'lab_lym'), field('mono', 'number', 'lab_mono'),
  field('buoi', 'choice', 'infusion_session', { options: ['Sáng (trước 12h)', 'Chiều (sau 12h)'] }), field('la', 'text', 'khong_co_khoa_nay'),
] });
const selection = { conditions: [{ table: 'medication_orders', name: 'ingredient:Acid Zoledronic', virtual_kind: 'active_ingredient', operator: 'not_empty' }] };
const values = (code, entries = {}) => Object.fromEntries(Object.entries(computeAutoValues({ runDir, form, entries, codes: [code], selection })[code].values).map(([k, v]) => [k, v.value]));

test('sanitize giữ khóa tự điền hợp lệ, bỏ khóa lạ', () => {
  assert.strictEqual(form.fields.find(f => f.id === 'vitd').auto, 'lab_vitd');
  assert.strictEqual(form.fields.find(f => f.id === 'la').auto, undefined);
});

test('NC1: nền, bệnh kèm, XN gần mốc trong 14 ngày, thuốc 3 ngày trước truyền, statin, buổi truyền', () => {
  assert.deepStrictEqual(values('NC1'), {
    nam_sinh: '1950', gioi: 'Nữ', khoa: 'Nội tổng hợp',
    chan_doan: 'Loãng xương sau mãn kinh/nguyên phát', gay_xuong: '0',
    ksv: '1', ten_ksv: 'Celecoxib 200mg', statin: '1', dtd: '1', tu_mien: '0',
    vitd: '22.5', ngay_vitd: '2026-03-01', ca: '1.12', egfr: '68', wbc: '7.4', lym: '31', mono: '6',
    buoi: 'Chiều (sau 12h)',
  });
});

test('NC2 không có mốc tự động: suy mốc từ y lệnh Acid Zoledronic sớm nhất; M80 → loãng xương nặng', () => {
  const v = values('NC2');
  assert.strictEqual(v.buoi, 'Sáng (trước 12h)');
  assert.strictEqual(v.chan_doan, 'Loãng xương nặng (có gãy xương)');
  assert.strictEqual(v.gay_xuong, '1');
  assert.strictEqual(v.tu_mien, '1');
  assert.strictEqual(v.ksv, '0');
  assert.strictEqual(v.vitd, undefined, 'không có XN thì để trống, không đoán');
});

test('mốc nhập tay được ưu tiên khi tính cửa sổ XN', () => {
  const v = values('NC1', { NC1: { anchor_at: '2026-03-08T10:00' } });
  assert.strictEqual(v.wbc, '6.1');
  assert.strictEqual(v.buoi, 'Sáng (trước 12h)');
});

test('màn nhập phiếu và xuất: giá trị tự điền đi kèm nguồn; nhập tay ghi đè khi xuất', () => {
  const STUDY = 's1';
  fs.mkdirSync(studyDir(STUDY), { recursive: true });
  fs.writeFileSync(cohortPath(STUDY), 'Mã NC,Mã BN\nNC1,1001\nNC2,1002\n');
  crfStore.saveForm(STUDY, form);
  crfStore.saveEntry(STUDY, 'NC1', { values: { vitd: '30' } });
  const view = crfStore.readCrfView(STUDY, { runDir, selection });
  const nc1 = view.samples.find(s => s.research_code === 'NC1');
  assert.match(nc1.auto_values.vitd.source, /Vitamin D ngày 01\/03\/2026/);
  assert.strictEqual(view.samples.find(s => s.research_code === 'NC2').anchor_auto_source, 'y lệnh thuốc sớm nhất');
  const exp = crfStore.autoFillForExport(STUDY, { runDir, selection });
  assert.strictEqual(exp.values.NC1.wbc, '7.4');
});

console.log(`research_crf_autofill_test: ${passed} passed`);
