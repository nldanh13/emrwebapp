#!/usr/bin/env node
'use strict';

// Lấy dữ liệu nghiên cứu thẳng từ kho (mẫu chọn từ kho): không mở EMR, chỉ dữ liệu của đúng lượt đã
// chọn, Mã NC theo nghiên cứu, phần kho đã lấy xong không bị đòi lấy lại, có analysis_selected.
// Chạy: node scripts/research_study_from_archive_test.js

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
process.env.EMR_RUNTIME_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'study_from_archive_'));
const { writeCsv, readCsvTable } = require('../server/research/table_io');
const { archiveRunsDir, ensureArchiveStore, cohortPath, studyMetaPath, runsDir } = require('../server/research/store_paths');
const { importArchiveToStudy, normalizeRunOutputs } = require('../server/research/normalize');
const { seedStudyRunFromArchive } = require('../server/research/study_from_archive');
const { normalizeResearchSourceRows } = require('../server/research/research_source');
const { readStudy } = require('../server/research/run_registry');

let passed = 0;
async function test(name, fn) {
  try { await fn(); passed += 1; console.log(`  ok - ${name}`); } catch (err) { console.error(`  FAIL - ${name}`); console.error(err); process.exitCode = 1; }
}

ensureArchiveStore();
const ARCHIVE_RUN = '20260101_000000';
const runDir = path.join(archiveRunsDir(), ARCHIVE_RUN);
fs.mkdirSync(runDir, { recursive: true });
fs.writeFileSync(path.join(runDir, 'manifest.json'), JSON.stringify({ run_id: ARCHIVE_RUN }));
const initial = [
  { 'T/G vào': '08:00 01/01/2026', 'Mã BN': '1001', 'Mã nội trú': 'NT1', 'Họ tên': 'A', 'Ngày ra viện': '05/01/2026' },
  { 'T/G vào': '09:00 03/02/2026', 'Mã BN': '1001', 'Mã nội trú': 'NT2', 'Họ tên': 'A', 'Ngày ra viện': '07/02/2026' },
  { 'T/G vào': '10:00 10/01/2026', 'Mã BN': '1002', 'Mã nội trú': 'NT3', 'Họ tên': 'B', 'Ngày ra viện': '12/01/2026' },
];
writeCsv(path.join(runDir, 'du_lieu_ban_dau.csv'), Object.keys(initial[0]), initial);
const encounters = [
  { encounter_id: 'enc_a1', research_code: 'NC1', patient_code: '1001', admission_date: '2026-01-01 08:00', discharge_date: '2026-01-05', emr_noitru_id: 'NT1' },
  { encounter_id: 'enc_a2', research_code: 'NC2', patient_code: '1001', admission_date: '2026-02-03 09:00', discharge_date: '2026-02-07', emr_noitru_id: 'NT2' },
  { encounter_id: 'enc_b1', research_code: 'NC3', patient_code: '1002', admission_date: '2026-01-10 10:00', discharge_date: '2026-01-12', emr_noitru_id: 'NT3' },
];
writeCsv(path.join(runDir, 'encounters.csv'), Object.keys(encounters[0]), encounters);
writeCsv(path.join(runDir, 'analysis_ready.csv'), ['research_code', 'encounter_id', 'patient_code', 'admission_date', 'discharge_date'], encounters);
writeCsv(path.join(runDir, 'medication_orders.csv'), ['research_code', 'encounter_id', 'patient_code', 'drug_name_raw', 'drug_name_norm', 'active_ingredient', 'order_datetime'], [
  { research_code: 'NC2', encounter_id: 'enc_a2', patient_code: '1001', drug_name_raw: 'Aclasta 5mg', drug_name_norm: 'aclasta', active_ingredient: 'Acid Zoledronic', order_datetime: '2026-02-04 08:00' },
]);
// Dữ liệu thô của kho: XN của cả hai lượt người bệnh 1001 và người bệnh 1002.
writeCsv(path.join(runDir, 'lich_su_xn.csv'), ['Mã BN', 'Mã điều trị', 'TG chỉ định', 'Chỉ số', 'Kết quả', 'Đơn vị'], [
  { 'Mã BN': '1001', 'Mã điều trị': 'NT1', 'TG chỉ định': '07:30 01/01/2026', 'Chỉ số': 'WBC', 'Kết quả': '9', 'Đơn vị': 'G/L' },
  { 'Mã BN': '1001', 'Mã điều trị': 'NT2', 'TG chỉ định': '07:30 04/02/2026', 'Chỉ số': 'WBC', 'Kết quả': '11', 'Đơn vị': 'G/L' },
  { 'Mã BN': '1002', 'Mã điều trị': 'NT3', 'TG chỉ định': '07:30 11/01/2026', 'Chỉ số': 'WBC', 'Kết quả': '7', 'Đơn vị': 'G/L' },
]);
writeCsv(path.join(runDir, 'hchanh_profile.csv'), ['Mã NC', 'Mã BN', 'Mã nội trú', 'Giới tính', 'Năm sinh'], [
  { 'Mã NC': 'NC2', 'Mã BN': '1001', 'Mã nội trú': 'NT2', 'Giới tính': 'Nữ', 'Năm sinh': '1950' },
  { 'Mã NC': 'NC3', 'Mã BN': '1002', 'Mã nội trú': 'NT3', 'Giới tính': 'Nam', 'Năm sinh': '1960' },
]);
// Trạng thái kho: XN/CĐHA chưa ghi "đã lấy" nhưng có dòng XN (lấy bổ sung từ Kho người bệnh);
// y lệnh chưa ghi trạng thái nhưng có y lệnh thuốc → vẫn coi là đã có.
writeCsv(path.join(runDir, 'extract_status.csv'), ['research_code', 'encounter_id', 'patient_code', 'popup_status', 'xn_status', 'cdha_status', 'profile_status', 'discharge_status', 'surgery_status', 'order_history_status', 'lab_count', 'imaging_count', 'medication_count'], [
  { research_code: 'NC2', encounter_id: 'enc_a2', patient_code: '1001', popup_status: '', xn_status: '', cdha_status: '', profile_status: 'done', discharge_status: 'error', surgery_status: '', order_history_status: '', lab_count: '1', imaging_count: '0', medication_count: '1' },
]);

const STUDY = 'zol';
fs.mkdirSync(path.dirname(studyMetaPath(STUDY)), { recursive: true });
const selection = {
  selected_variables: [{ id: 'medication_orders.v', table: 'medication_orders', name: 'ingredient:Acid Zoledronic', virtual_kind: 'active_ingredient', aggregation: 'any', type: 'category' }],
  conditions: [{ id: 'c1', variable_id: 'v', table: 'medication_orders', name: 'ingredient:Acid Zoledronic', virtual_kind: 'active_ingredient', operator: 'not_empty' }],
};
fs.writeFileSync(studyMetaPath(STUDY), JSON.stringify({ id: STUDY, name: 'Zol', variable_selection: selection, analysis_config: { variable_selection: selection } }));

(async () => {
  await test('kho thu thập không tự cấp Mã NC; cohort nghiên cứu mới giữ mã được cấp riêng', async () => {
    const sourceRows = normalizeResearchSourceRows([
      { 'Mã BN': '1001', 'Ngày vào viện': '2026-01-01', 'Ngày ra viện': '2026-01-05' },
    ], { sourceRunId: 'archive_run' });
    assert.strictEqual(sourceRows.length, 1);
    assert.strictEqual(sourceRows[0]['Mã NC'], '', 'dữ liệu nguồn chỉ có Mã BN/Research key');
    const studyRows = normalizeResearchSourceRows([
      { 'Mã BN': '1001', 'Mã NC': 'NC0001', 'Ngày vào viện': '2026-01-01' },
    ], { sourceRunId: 'study_run' });
    assert.strictEqual(studyRows[0]['Mã NC'], 'NC0001', 'giữ mã đã được cấp cho cohort nghiên cứu');
  });

  await test('lưu nghiên cứu rồi lấy dữ liệu từ kho: chỉ lượt đã chọn, Mã NC theo nghiên cứu', async () => {
    const imp = importArchiveToStudy(readStudy(STUDY), { variable_selection: selection });
    assert.strictEqual(imp.count, 1);
    const study = readStudy(STUDY);
    assert.strictEqual(study.cohort_source, 'archive');
    const seeded = seedStudyRunFromArchive(study, { runId: '20260301_000000' });
    assert.strictEqual(seeded.samples, 1);
    assert.strictEqual(seeded.linked, 1);
    const sRun = path.join(runsDir(STUDY), '20260301_000000');
    const xn = readCsvTable(path.join(sRun, 'lich_su_xn.csv'), 100).rows;
    assert.deepStrictEqual(xn.map(r => r['Kết quả']), ['11'], 'chỉ XN của lượt NT2, bỏ lượt NT1 và người bệnh khác');
    const profile = readCsvTable(path.join(sRun, 'hchanh_profile.csv'), 100).rows;
    const code = readCsvTable(cohortPath(STUDY), 10).rows[0]['Mã NC'];
    assert.deepStrictEqual(profile.map(r => r['Mã NC']), [code], 'Mã NC đổi sang mã của nghiên cứu');
    const progress = JSON.parse(fs.readFileSync(path.join(sRun, 'progress.json'), 'utf8'));
    assert.strictEqual(progress.enc_a2.xn, 'done', 'có dòng XN trong kho → đã có');
    assert.strictEqual(progress.enc_a2.cdha, 'empty');
    const orders = JSON.parse(fs.readFileSync(path.join(sRun, 'order_history_auto_progress.json'), 'utf8'));
    assert.strictEqual(orders['enc_a2#order_history'].status, 'done', 'có y lệnh thuốc trong kho → đã có');
    const hchanh = JSON.parse(fs.readFileSync(path.join(sRun, 'hchanh_auto_progress.json'), 'utf8'));
    assert.ok(hchanh['enc_a2#profile'], 'hồ sơ kho đã lấy → mang sang');
    assert.ok(!hchanh['enc_a2#discharge'], 'ra viện kho bị lỗi → để Thu thập tự động lấy');
  });

  await test('chuẩn hóa đợt chạy từ kho: có XN của lượt, trạng thái đã lấy theo kho, có analysis_selected', async () => {
    const sRun = path.join(runsDir(STUDY), '20260301_000000');
    normalizeRunOutputs(sRun, { sourceRunId: '20260301_000000' });
    const labs = readCsvTable(path.join(sRun, 'lab_results.csv'), 100).rows;
    assert.strictEqual(labs.length, 1);
    const status = readCsvTable(path.join(sRun, 'extract_status.csv'), 100).rows;
    assert.strictEqual(status.length, 1);
    assert.strictEqual(status[0].xn_status, 'done');
    assert.strictEqual(status[0].profile_status, 'done');
    assert.ok(/discharge/.test(status[0].missing_required), 'ra viện còn thiếu');
    assert.ok(!/xn_cdha|profile/.test(status[0].missing_required), 'XN/CĐHA và hồ sơ không bị đòi lấy lại');
    assert.ok(fs.existsSync(path.join(sRun, 'analysis_selected.csv')), 'có bảng phân tích theo biến đã chọn');
  });

  await test('"Thu thập tự động" chỉ lấy phần thiếu hoặc phần Y lệnh cần migration parser', async () => {
    const sRun = path.join(runsDir(STUDY), '20260301_000000');
    const { syncCollectionLedger } = require('../server/research/collection_runtime');
    const { readResearchHchanhSourceRows } = require('../server/research/research_source');
    const collection = require('../server/research/collection');
    const ledger = syncCollectionLedger(sRun, readResearchHchanhSourceRows(sRun).rows);
    const plan = collection.planCollection(ledger, {});
    assert.strictEqual(plan.tasks.length, 1);
    // Kho: XN có, CĐHA không có dòng, hồ sơ xong, ra viện lỗi. Fixture archive legacy
    // chưa có fetch_window_version cho Y lệnh nên phải lấy lại order_history một lần;
    // không được coi "có thuốc" đồng nghĩa parser/cửa sổ đã hiện hành.
    assert.deepStrictEqual(plan.tasks[0].parts.filter(p => p !== 'surgery').sort(), ['discharge', 'order_history']);
    assert.strictEqual(plan.tasks[0].reasons.order_history, 'parser_migration');
  });

  await test('nghiên cứu không chọn mẫu từ kho: báo rõ, không tạo đợt chạy', async () => {
    fs.mkdirSync(path.dirname(studyMetaPath('khac')), { recursive: true });
    fs.writeFileSync(studyMetaPath('khac'), JSON.stringify({ id: 'khac', name: 'Khác' }));
    fs.writeFileSync(cohortPath('khac'), 'Mã NC,Mã BN\nNC0001,1001\n');
    assert.throws(() => seedStudyRunFromArchive(readStudy('khac')), /không lấy dữ liệu từ kho/);
  });

  console.log(`research_study_from_archive_test: ${passed} passed`);
})();
