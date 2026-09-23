#!/usr/bin/env node
'use strict';

// Kiểm thử an toàn dữ liệu Kho nghiên cứu (chỉ dùng dữ liệu giả lập, không có BN thật):
//  1. Mã NC duy nhất và ổn định qua các lần quét lại; file cũ bị trùng mã được sửa.
//  2. Dữ liệu hành chánh gắn đúng đợt khi 1 BN có nhiều đợt (lỗi NC0001 cũ).
//  3. Dòng chuyển khoa chung Mã nội trú gộp thành 1 đợt với ngày vào sớm nhất; ca nghi
//     cùng đợt nhưng KHÔNG chung khóa EMR thì chỉ đưa vào danh sách duyệt, không tự gộp.
//  4. Báo cáo chất lượng: lỗi chặn (trùng khóa, mồ côi khóa ngoại) và cảnh báo.
//  5. Chuẩn hóa dở dang/lỗi bị phát hiện, chặn tạo dataset cuối, chạy lại không dùng cache.
//  6. Dataset cuối không bị mất khi Chuẩn hóa lại (được lưu phiên bản).
//  7. Xuất ẩn danh che cả Mã nội trú và URL EMR (chứa Mã BN).
//  8. Xóa nghiên cứu chỉ dành cho admin.
// Chạy: node scripts/research_data_safety_test.js

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const RUNTIME_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'research_data_safety_test_'));
process.env.EMR_RUNTIME_ROOT = RUNTIME_ROOT;

const research = require('../server/routes/research');
const R = research._test;
const { buildQualityReport } = require('../server/research/quality');
const { redactCsvTable } = require('../server/research/export_utils');
const { requiredRoleForRequest } = require('../server/services/authz');

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ok - ${name}`);
  } catch (err) {
    console.error(`  FAIL - ${name}`);
    console.error(err);
    process.exitCode = 1;
  }
}

function writeCsv(file, cols, rows) {
  const esc = v => (/[",\n]/.test(String(v ?? '')) ? `"${String(v).replace(/"/g, '""')}"` : String(v ?? ''));
  fs.writeFileSync(file, `﻿${[cols.join(','), ...rows.map(r => cols.map(c => esc(r[c])).join(','))].join('\n')}\n`, 'utf-8');
}

function readCsv(file) {
  const [head, ...lines] = fs.readFileSync(file, 'utf-8').replace(/^﻿/, '').trim().split('\n');
  const cols = head.split(',');
  return lines.filter(Boolean).map(line => Object.fromEntries(line.split(',').map((v, i) => [cols[i], v])));
}

let runSeq = 0;
function newRunDir() {
  runSeq += 1;
  const dir = path.join(RUNTIME_ROOT, 'fixture', `r${runSeq}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

const INITIAL_COLS = ['T/G vào', 'Mã BN', 'Mã nội trú', 'Họ tên', 'GT', 'Trạng thái'];
const INITIAL_ROWS = [
  { 'T/G vào': '08:00 20/02/2026', 'Mã BN': '111', 'Mã nội trú': 'nt-a', 'Họ tên': 'BN GIA LAP A' },
  { 'T/G vào': '09:00 25/02/2026', 'Mã BN': '111', 'Mã nội trú': 'nt-b', 'Họ tên': 'BN GIA LAP A' },
  { 'T/G vào': '10:00 01/03/2026', 'Mã BN': '222', 'Mã nội trú': 'nt-c', 'Họ tên': 'BN GIA LAP B' },
];

test('Mã NC duy nhất, giữ nguyên khi quét lại đổi thứ tự, dòng mới nhận số kế tiếp', () => {
  const first = R.normalizeResearchSourceRows(INITIAL_ROWS, { sourceRunId: 'r' });
  const codes = first.map(r => r['Mã NC']);
  assert.strictEqual(new Set(codes).size, 3, `Mã NC phải khác nhau: ${codes}`);

  const prev = new Map(first.map(r => [r['Research key'], r['Mã NC']]));
  const extra = { 'T/G vào': '07:00 05/03/2026', 'Mã BN': '333', 'Mã nội trú': 'nt-d', 'Họ tên': 'BN GIA LAP C' };
  const second = R.normalizeResearchSourceRows([extra, ...INITIAL_ROWS].reverse(), { sourceRunId: 'r', previousCodes: prev });
  for (const row of second) {
    if (prev.has(row['Research key'])) assert.strictEqual(row['Mã NC'], prev.get(row['Research key']));
  }
  assert.strictEqual(second.find(r => r['Mã BN'] === '333')['Mã NC'], 'NC0004');
});

test('research_source.csv cũ bị trùng Mã NC (NC0001 cho mọi dòng) được tạo lại với mã duy nhất', () => {
  const runDir = newRunDir();
  writeCsv(path.join(runDir, 'du_lieu_ban_dau.csv'), INITIAL_COLS, INITIAL_ROWS);
  const broken = R.normalizeResearchSourceRows(INITIAL_ROWS, { sourceRunId: 'r' }).map(r => ({ ...r, 'Mã NC': 'NC0001' }));
  // research_source mới hơn du_lieu_ban_dau: trước đây sẽ được dùng lại nguyên trạng.
  writeCsv(path.join(runDir, 'research_source.csv'), Object.keys(broken[0]), broken);
  const info = R.ensureResearchSourceRows(runDir, { sourceRunId: 'r' });
  assert.strictEqual(new Set(info.rows.map(r => r['Mã NC'])).size, 3);
});

test('Mã NC dùng lại mã script XN/CĐHA đã cấp cho cùng đợt, không cấp trùng mã đó cho đợt khác', () => {
  const runDir = newRunDir();
  writeCsv(path.join(runDir, 'du_lieu_ban_dau.csv'), INITIAL_COLS, INITIAL_ROWS);
  writeCsv(path.join(runDir, 'du_lieu_goc.csv'), ['Mã NC', 'Mã BN', 'Mã điều trị'], [
    { 'Mã NC': 'NC0002', 'Mã BN': '111', 'Mã điều trị': 'nt-b' },
    { 'Mã NC': 'NC0001', 'Mã BN': '999', 'Mã điều trị': 'nt-khac' },
  ]);
  const info = R.ensureResearchSourceRows(runDir, { sourceRunId: 'r', force: true });
  const byNoitru = Object.fromEntries(info.rows.map(r => [r['Mã nội trú'], r['Mã NC']]));
  assert.strictEqual(byNoitru['nt-b'], 'NC0002');
  assert.notStrictEqual(byNoitru['nt-a'], 'NC0001', 'NC0001 đã thuộc đợt khác trong du_lieu_goc.csv');
  assert.strictEqual(new Set(Object.values(byNoitru)).size, 3);
});

test('Dữ liệu hành chánh của đợt 2 gắn đúng đợt 2 (không ghép theo Mã NC trùng)', () => {
  const src = R.normalizeResearchSourceRows(INITIAL_ROWS, { sourceRunId: 'r' });
  const stay2 = src[1];
  const hchanh = [{ 'Mã BN': '111', 'Mã NC': 'NC0001', 'Research key': stay2['Research key'], 'Ngày vào viện': '25/02/2026', 'Số thẻ': 'THE-GIA-LAP' }];
  const merged = R.combineEncounterSources({ initialRows: src, hchanhProfileRows: hchanh, sourceRunId: 'r' });
  const withCard = merged.filter(r => r['Số thẻ'] === 'THE-GIA-LAP');
  assert.strictEqual(withCard.length, 1);
  assert.strictEqual(withCard[0]['Mã nội trú'], 'nt-b');
  assert.strictEqual(withCard[0]['Mã NC'], stay2['Mã NC'], 'Mã NC của dòng nguồn không bị mã cũ trong file hchanh đè');
});

test('Chuyển khoa nghi cùng đợt: không tự gộp, có trong encounter_review.csv, QA cảnh báo', () => {
  const runDir = newRunDir();
  writeCsv(path.join(runDir, 'du_lieu_ban_dau.csv'), INITIAL_COLS, INITIAL_ROWS);
  R.normalizeRunOutputs(runDir, { sourceRunId: 'r' });
  const source = readCsv(path.join(runDir, 'research_source.csv'));
  const discharge = source.filter(r => r['Mã BN'] === '111').map(r => ({
    'Mã NC': r['Mã NC'], 'Mã BN': '111', 'Mã nội trú': r['Mã nội trú'], 'Research key': r['Research key'],
    'Ngày vào viện': r['T/G vào'], 'Ngày ra viện': '10/03/2026',
  }));
  writeCsv(path.join(runDir, 'hchanh_discharge.csv'), Object.keys(discharge[0]), discharge);
  const out = R.normalizeRunOutputs(runDir, { sourceRunId: 'r', force: true });
  assert.strictEqual(out.encounters, 3, 'không được tự gộp 2 dòng của BN 111');
  const qa = JSON.parse(fs.readFileSync(path.join(runDir, 'qa_report.json'), 'utf-8'));
  assert.ok(qa.warnings.some(w => w.code === 'possible_same_stay'), JSON.stringify(qa.warnings));
  assert.strictEqual(qa.blocking_count, 0, JSON.stringify(qa.blocking));
  const review = readCsv(path.join(runDir, 'encounter_review.csv')).filter(r => r.issue === 'possible_same_stay');
  assert.strictEqual(review.length, 2);
  const history = fs.readFileSync(path.join(runDir, 'normalize_history.jsonl'), 'utf-8').trim().split('\n');
  assert.strictEqual(history.length, 2, 'mỗi lần chuẩn hóa thêm đúng 1 dòng lịch sử');
  assert.ok(JSON.parse(history[1]).input_signature);
  // Báo cáo QA không chứa họ tên.
  assert.ok(!fs.readFileSync(path.join(runDir, 'qa_report.json'), 'utf-8').includes('GIA LAP'));
});

test('Dòng chuyển khoa chung Mã nội trú gộp thành 1 đợt, ngày vào = thời điểm vào sớm nhất', () => {
  const runDir = newRunDir();
  // Danh sách xếp khoa sau lên trước: không được lấy ngày vào khoa sau làm ngày vào viện.
  writeCsv(path.join(runDir, 'du_lieu_ban_dau.csv'), INITIAL_COLS, [
    { 'T/G vào': '09:00 04/03/2026', 'Mã BN': '111', 'Mã nội trú': 'nt-chung', 'Họ tên': 'BN GIA LAP A' },
    { 'T/G vào': '08:00 20/02/2026', 'Mã BN': '111', 'Mã nội trú': 'nt-chung', 'Họ tên': 'BN GIA LAP A' },
    { 'T/G vào': '10:00 01/03/2026', 'Mã BN': '222', 'Mã nội trú': 'nt-khac', 'Họ tên': 'BN GIA LAP B' },
  ]);
  const out = R.normalizeRunOutputs(runDir, { sourceRunId: 'r' });
  assert.strictEqual(out.encounters, 2);
  const source = readCsv(path.join(runDir, 'research_source.csv')).filter(r => r['Mã BN'] === '111');
  assert.strictEqual(source.length, 1, 'research_source chỉ còn 1 dòng cho đợt này');
  assert.strictEqual(source[0].fetch_from_date, '2026-02-20', 'khoảng lấy dữ liệu bắt đầu từ ngày vào viện');
  const enc = readCsv(path.join(runDir, 'encounters.csv')).find(r => r.patient_code === '111');
  assert.strictEqual(enc.admission_date, '2026-02-20 08:00');
});

test('XN: dòng giống hệt nhau giữ một (cảnh báo, không chặn); cùng giờ + chỉ số mà khác kết quả thì giữ cả hai và đưa vào duyệt', () => {
  const runDir = newRunDir();
  writeCsv(path.join(runDir, 'du_lieu_ban_dau.csv'), INITIAL_COLS, INITIAL_ROWS);
  const xnCols = ['Mã BN', 'Mã điều trị', 'TG chỉ định', 'Chỉ số', 'Kết quả', 'Đơn vị'];
  const hb = { 'Mã BN': '111', 'Mã điều trị': 'nt-a', 'TG chỉ định': '07:30 21/02/2026', 'Chỉ số': 'Hb', 'Kết quả': '125', 'Đơn vị': 'g/L' };
  const crp = { 'Mã BN': '111', 'Mã điều trị': 'nt-a', 'TG chỉ định': '07:30 21/02/2026', 'Chỉ số': 'CRP', 'Kết quả': '5', 'Đơn vị': 'mg/L' };
  writeCsv(path.join(runDir, 'lich_su_xn.csv'), xnCols, [hb, { ...hb }, crp, { ...crp, 'Kết quả': '50' }]);
  const out = R.normalizeRunOutputs(runDir, { sourceRunId: 'r' });
  assert.strictEqual(out.lab_results, 3, 'Hb trùng giữ 1, CRP mâu thuẫn giữ cả 2');
  const qa = JSON.parse(fs.readFileSync(path.join(runDir, 'qa_report.json'), 'utf-8'));
  assert.ok(!qa.blocking.some(b => b.code === 'duplicate_row_id'), JSON.stringify(qa.blocking));
  assert.ok(qa.warnings.some(w => w.code === 'duplicate_raw_rows_removed' && w.count === 1));
  assert.ok(qa.warnings.some(w => w.code === 'conflicting_results' && w.table === 'lab_results'));
  const review = readCsv(path.join(runDir, 'encounter_review.csv')).filter(r => r.issue === 'conflicting_lab_result');
  assert.strictEqual(review.length, 1);
});

test('Báo cáo chất lượng: trùng khóa và mồ côi khóa ngoại là lỗi chặn; ghép mơ hồ là cảnh báo', () => {
  const encounters = [
    { encounter_id: 'e1', research_code: 'NC1', patient_code: 'p1', admission_date: '2026-01-01', discharge_date: '2026-01-05' },
    { encounter_id: 'e1', research_code: 'NC2', patient_code: 'p1', admission_date: '2026-02-01', discharge_date: '2026-01-20' },
  ];
  const labs = [
    { lab_result_id: 'l1', encounter_id: 'e9', encounter_match_status: 'matched' },
    { lab_result_id: 'l2', encounter_id: '', encounter_match_status: 'ambiguous' },
  ];
  const report = buildQualityReport({ tables: { patients: [{ patient_code: 'p1' }], encounters, lab_results: labs } });
  const codes = report.blocking.map(b => b.code);
  assert.ok(codes.includes('duplicate_encounter_id'));
  assert.ok(codes.includes('orphan_child_row'));
  assert.ok(report.warnings.some(w => w.code === 'child_match_ambiguous'));
  assert.ok(report.review.some(r => r.issue === 'discharge_before_admission'));
  assert.strictEqual(report.status, 'blocked');
});

test('Chuẩn hóa dừng giữa chừng/lỗi: chặn dataset cuối, lần sau không dùng cache', () => {
  const runDir = newRunDir();
  writeCsv(path.join(runDir, 'du_lieu_ban_dau.csv'), INITIAL_COLS, INITIAL_ROWS);
  R.normalizeRunOutputs(runDir, { sourceRunId: 'r' });
  // Giả lập tiến trình chết giữa lúc ghi bảng.
  fs.writeFileSync(path.join(runDir, 'normalize_state.json'), JSON.stringify({ status: 'running', started_at: 'x' }));
  assert.ok(R.buildCoverageSummary(runDir).blockers.some(b => b.includes('dừng giữa chừng')));
  const rerun = R.normalizeRunOutputs(runDir, { sourceRunId: 'r' });
  assert.strictEqual(rerun.cached, false, 'không được dùng cache khi lần trước chưa hoàn tất');
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(runDir, 'normalize_state.json'))).status, 'complete');

  // Giả lập lỗi ghi: patients.csv là thư mục nên ghi file thất bại.
  fs.rmSync(path.join(runDir, 'patients.csv'));
  fs.mkdirSync(path.join(runDir, 'patients.csv'));
  assert.throws(() => R.normalizeRunOutputs(runDir, { sourceRunId: 'r', force: true }));
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(runDir, 'normalize_state.json'))).status, 'failed');
  assert.ok(R.buildCoverageSummary(runDir).blockers.some(b => b.includes('bị lỗi')));
  fs.rmSync(path.join(runDir, 'patients.csv'), { recursive: true });
  R.normalizeRunOutputs(runDir, { sourceRunId: 'r', force: true });
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(runDir, 'normalize_state.json'))).status, 'complete');
});

test('Chuẩn hóa lại không làm mất analysis_final.csv đã chốt (lưu phiên bản trong datasets/)', () => {
  const runDir = newRunDir();
  writeCsv(path.join(runDir, 'du_lieu_ban_dau.csv'), INITIAL_COLS, INITIAL_ROWS);
  R.normalizeRunOutputs(runDir, { sourceRunId: 'r' });
  const finalContent = '﻿research_code,hb\nNC0001,120\n';
  fs.writeFileSync(path.join(runDir, 'analysis_final.csv'), finalContent);
  R.normalizeRunOutputs(runDir, { sourceRunId: 'r', force: true });
  assert.ok(!fs.existsSync(path.join(runDir, 'analysis_final.csv')));
  const snaps = R.listDatasetSnapshots(runDir);
  assert.strictEqual(snaps.length, 1);
  assert.strictEqual(snaps[0].kind, 'superseded_by_normalize');
  assert.strictEqual(fs.readFileSync(path.join(runDir, 'datasets', snaps[0].name, 'analysis_final.csv'), 'utf-8'), finalContent);
  assert.ok(snaps[0].sha256 && snaps[0].normalized_input_signature);
});

test('Xuất ẩn danh che Mã nội trú và URL EMR (URL chứa keyword=Mã BN)', () => {
  const cols = ['Mã NC', 'Mã nội trú', 'URL bác sĩ', 'URL điều dưỡng', 'emr_noitru_id', 'Số lưu trữ', 'hb'];
  const out = redactCsvTable(cols, [{}]);
  assert.deepStrictEqual(out.columns, ['Mã NC', 'hb']);
});

test('Xóa nghiên cứu yêu cầu admin; xem vẫn là researcher, thao tác ghi là supervisor', () => {
  const req = (method, p) => ({ method, path: p });
  assert.strictEqual(requiredRoleForRequest(req('DELETE', '/research/studies/nc1')), 'admin');
  assert.strictEqual(requiredRoleForRequest(req('GET', '/research/studies/nc1')), 'researcher');
  assert.strictEqual(requiredRoleForRequest(req('POST', '/research/studies/nc1/normalize')), 'supervisor');
});

console.log(`\n${passed} kịch bản pass.`);
