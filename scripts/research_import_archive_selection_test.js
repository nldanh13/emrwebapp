#!/usr/bin/env node
'use strict';

// "Lưu thành nghiên cứu" từ kho: danh sách ban đầu chỉ có Mã BN + giờ vào viện (không mã lượt), nhưng
// điều kiện trên y lệnh thuốc/XN ghép theo mã lượt. Kết quả lưu phải giống bước Kiểm tra & xuất dữ liệu.
// Chạy: node scripts/research_import_archive_selection_test.js

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
process.env.EMR_RUNTIME_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'import_sel_'));
const { writeCsv, readCsvTable } = require('../server/research/table_io');
const { archiveRunsDir, ensureArchiveStore, cohortPath } = require('../server/research/store_paths');
const { importArchiveToStudy } = require('../server/research/normalize');
const { summarizeSelectionForRun } = require('../server/research/selection_runtime');

let passed = 0;
function test(name, fn) {
  try { fn(); passed += 1; console.log(`  ok - ${name}`); } catch (err) { console.error(`  FAIL - ${name}`); console.error(err); process.exitCode = 1; }
}

ensureArchiveStore();
const runDir = path.join(archiveRunsDir(), '20260101_000000');
fs.mkdirSync(runDir, { recursive: true });
fs.writeFileSync(path.join(runDir, 'manifest.json'), JSON.stringify({ run_id: '20260101_000000', created_at: '2026-01-01T00:00:00Z' }));
const initial = [
  { 'T/G vào': '08:00 01/01/2026', 'Mã BN': '1001', 'Mã nội trú': 'NT1', 'Họ tên': 'A', 'Ngày ra viện': '05/01/2026' },
  { 'T/G vào': '09:00 03/02/2026', 'Mã BN': '1001', 'Mã nội trú': 'NT2', 'Họ tên': 'A', 'Ngày ra viện': '07/02/2026' },
  { 'T/G vào': '10:00 10/01/2026', 'Mã BN': '1002', 'Mã nội trú': 'NT3', 'Họ tên': 'B', 'Ngày ra viện': '12/01/2026' },
  { 'T/G vào': '11:00 15/01/2026', 'Mã BN': '1003', 'Mã nội trú': 'NT4', 'Họ tên': 'C', 'Ngày ra viện': '20/01/2026' },
  // Dòng lặp của cùng lượt NT4 (vd. chuyển khoa): không được thành mẫu thứ hai.
  { 'T/G vào': '11:00 15/01/2026', 'Mã BN': '1003', 'Mã nội trú': '', 'Họ tên': 'C', 'Ngày ra viện': '20/01/2026' },
];
writeCsv(path.join(runDir, 'du_lieu_ban_dau.csv'), Object.keys(initial[0]), initial);
const analysis = [
  { research_code: 'NC1', encounter_id: 'enc_a1', patient_code: '1001', patient_key: 'P1', admission_date: '2026-01-01 08:00', discharge_date: '2026-01-05' },
  { research_code: 'NC2', encounter_id: 'enc_a2', patient_code: '1001', patient_key: 'P1', admission_date: '2026-02-03 09:00', discharge_date: '2026-02-07' },
  { research_code: 'NC3', encounter_id: 'enc_b1', patient_code: '1002', patient_key: 'P2', admission_date: '2026-01-10 10:00', discharge_date: '2026-01-12' },
  { research_code: 'NC4', encounter_id: 'enc_c1', patient_code: '1003', patient_key: 'P3', admission_date: '2026-01-15 11:00', discharge_date: '2026-01-20' },
];
writeCsv(path.join(runDir, 'analysis_ready.csv'), Object.keys(analysis[0]), analysis);
const meds = [
  { research_code: 'NC2', encounter_id: 'enc_a2', patient_code: '1001', drug_name_raw: 'Aclasta 5mg/100ml', drug_name_norm: 'aclasta', active_ingredient: 'Acid Zoledronic', order_datetime: '2026-02-04 08:00' },
  { research_code: 'NC4', encounter_id: 'enc_c1', patient_code: '1003', drug_name_raw: 'Zometa 4mg', drug_name_norm: 'zometa', active_ingredient: 'Acid Zoledronic', order_datetime: '2026-01-16 08:00' },
  { research_code: 'NC3', encounter_id: 'enc_b1', patient_code: '1002', drug_name_raw: 'Thermodol 1g', drug_name_norm: 'thermodol', active_ingredient: '', order_datetime: '2026-01-11 08:00' },
];
writeCsv(path.join(runDir, 'medication_orders.csv'), Object.keys(meds[0]), meds);

const selection = {
  selected_variables: [{ id: 'analysis_ready.patient_key', table: 'analysis_ready', name: 'patient_key', type: 'text' }],
  conditions: [{ id: 'c1', variable_id: 'v', table: 'medication_orders', name: 'ingredient:Acid Zoledronic', virtual_kind: 'active_ingredient', operator: 'not_empty' }],
};

test('lưu thành nghiên cứu lấy đúng các lượt dùng hoạt chất như bước xem trước', () => {
  const preview = summarizeSelectionForRun(runDir, selection);
  assert.strictEqual(preview.summary.total, 2);
  const studyId = 'zol';
  fs.mkdirSync(path.dirname(cohortPath(studyId)), { recursive: true });
  const r = importArchiveToStudy({ id: studyId }, { variable_selection: selection });
  assert.strictEqual(r.count, 2);
  const cohort = readCsvTable(cohortPath(studyId), 100).rows;
  assert.deepStrictEqual(cohort.map(x => x['Mã nội trú']), ['NT2', 'NT4']);
  assert.strictEqual(cohort[0].encounter_id, 'enc_a2', 'lưu khóa lượt để các bước sau không ghép nhầm');
});

test('mỗi người bệnh một lượt và thời gian nghiên cứu cũng áp đúng khi lưu', () => {
  const r = importArchiveToStudy({ id: 'all' }, { variable_selection: { ...selection, conditions: [], one_per_patient: true, period: { from: '2026-01-05' } } });
  const cohort = readCsvTable(cohortPath('all'), 100).rows;
  assert.deepStrictEqual(cohort.map(x => x['Mã nội trú']), ['NT2', 'NT3', 'NT4']);
  assert.strictEqual(r.count, 3);
});


test('lưu dùng đúng lượt xem trước khi danh sách ban đầu thiếu mốc giờ và BN có nhiều lượt', () => {
  initial.push({ 'Mã BN': '1004', 'Mã nội trú': '', 'Họ tên': 'D' });
  analysis.push(
    { research_code: 'NC5', encounter_id: 'enc_d1', patient_code: '1004', patient_key: 'P4', admission_date: '2025-12-01 08:00', discharge_date: '2025-12-03' },
    { research_code: 'NC6', encounter_id: 'enc_d2', patient_code: '1004', patient_key: 'P4', admission_date: '2025-12-10 08:00', discharge_date: '2025-12-12' },
  );
  writeCsv(path.join(runDir, 'du_lieu_ban_dau.csv'), Object.keys(initial[0]), initial);
  writeCsv(path.join(runDir, 'analysis_ready.csv'), Object.keys(analysis[0]), analysis);
  const labs = [{ encounter_id: 'enc_d2', patient_code: '1004', result_num: '1.2', test_name_norm: 'Ca++ máu ion hóa' }];
  writeCsv(path.join(runDir, 'lab_results.csv'), Object.keys(labs[0]), labs);
  const labSelection = {
    run_id: '20260101_000000',
    selected_variables: [{ id: 'analysis_ready.patient_key', table: 'analysis_ready', name: 'patient_key', type: 'text' }],
    conditions: [{ id: 'ca', variable_id: 'ca', table: 'lab_results', name: 'result_num', operator: 'not_empty' }],
  };
  const preview = summarizeSelectionForRun(runDir, labSelection);
  assert.strictEqual(preview.summary.total, 1);
  const imported = importArchiveToStudy({ id: 'lab-match' }, { variable_selection: labSelection });
  assert.strictEqual(imported.count, preview.summary.total);
  const cohort = readCsvTable(cohortPath('lab-match'), 100).rows;
  assert.strictEqual(cohort.length, preview.summary.total);
  assert.strictEqual(cohort[0].encounter_id, 'enc_d2', 'giữ đúng lượt mà bước xem trước đã ghép XN');
});

test('không ghi cohort nếu số lượt khác kết quả xem trước', () => {
  assert.throws(
    () => importArchiveToStudy({ id: 'wrong-count' }, { variable_selection: labSelection, expected_count: 2 }),
    err => err?.code === 'COHORT_PREVIEW_MISMATCH' && /xem trước có 2 lượt/.test(err.message),
  );
  assert.strictEqual(fs.existsSync(cohortPath('wrong-count')), false, 'không để lại cohort sai số mẫu');
});

console.log(`research_import_archive_selection_test: ${passed} passed`);
