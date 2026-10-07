#!/usr/bin/env node
'use strict';

// Kiểm thử an toàn dữ liệu Kho nghiên cứu (chỉ dùng dữ liệu giả lập, không có BN thật):
//  1. Mã NC duy nhất và ổn định qua các lần quét lại; file cũ bị trùng mã được sửa.
//  2. Dữ liệu hành chánh gắn đúng đợt khi 1 BN có nhiều đợt (lỗi NC0001 cũ).
//  3. Dòng chuyển khoa chỉ được gộp khi Mã BN + khoảng thời gian chứng minh cùng lần nằm;
//     nếu chỉ nghi cùng đợt thì đưa vào danh sách duyệt, không tự gộp.
//  4. Ghép bảng con vào đúng lượt bằng Mã BN + thời gian/ngày duy nhất, không đoán ca mơ hồ.
//  5. Thống kê danh mục biến có giới hạn bộ nhớ với cột nhiều giá trị khác nhau.
//  6. Báo cáo chất lượng: lỗi chặn (trùng khóa, mồ côi khóa ngoại) và cảnh báo.
//  7. Chuẩn hóa dở dang/lỗi bị phát hiện, chặn tạo dataset cuối, chạy lại không dùng cache.
//  8. Dataset cuối không bị mất khi Chuẩn hóa lại (được lưu phiên bản).
//  9. Xuất ẩn danh vẫn che các trường legacy nhạy cảm nếu gặp và URL EMR (chứa Mã BN).
// 10. Xóa nghiên cứu chỉ dành cho admin.
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
const { buildEncounterId } = require('../server/research/encounter_context');
const { redactCsvTable } = require('../server/research/export_utils');
const { requiredRoleForRequest } = require('../server/services/authz');
const variableSelection = require('../server/research/variable_selection');
const { readCsvTable } = require('../server/research/table_io');

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

const INITIAL_COLS = ['T/G vào', 'Mã BN', 'Họ tên', 'GT', 'Trạng thái'];
const INITIAL_ROWS = [
  { 'T/G vào': '08:00 20/02/2026', 'Mã BN': '111', 'Họ tên': 'BN GIA LAP A' },
  { 'T/G vào': '09:00 25/02/2026', 'Mã BN': '111', 'Họ tên': 'BN GIA LAP A' },
  { 'T/G vào': '10:00 01/03/2026', 'Mã BN': '222', 'Họ tên': 'BN GIA LAP B' },
];

test('Ghép lượt không dùng Mã NC; chỉ Mã BN chưa đủ khi người bệnh có nhiều đợt', () => {
  const rows = [
    { 'Mã BN': '111', 'Mã NC': 'NC0001', 'T/G vào': '08:00 20/02/2026', 'Ngày ra viện': '22/02/2026' },
    { 'Mã BN': '111', 'Mã NC': 'NC0002', 'T/G vào': '09:00 25/02/2026', 'Ngày ra viện': '28/02/2026' },
  ];
  const map = R.buildContextMap(rows, 'r');

  const byResearchCodeOnly = R.contextForRow(map, { 'Mã BN': '111', 'Mã NC': 'NC0002' }, '111');
  assert.strictEqual(byResearchCodeOnly.encounter_id, '', 'Mã NC không được dùng để quyết định đợt');
  assert.strictEqual(R.encounterMatchStatus(byResearchCodeOnly), 'ambiguous');

  const byPatientAndEventTime = R.contextForRow(map, { 'Mã BN': '111', 'Mã NC': 'NC0001', 'TG chỉ định': '26/02/2026' }, '111');
  assert.strictEqual(byPatientAndEventTime.encounter_id, buildEncounterId(rows[1]));
  assert.strictEqual(R.encounterMatchMethod(byPatientAndEventTime), 'event_date_range');
});

test('Chỉ có Mã BN và thiếu thời gian thì không được tự gán vào đợt duy nhất', () => {
  const rows = [
    { 'Mã BN': '777', 'T/G vào': '08:00 10/04/2026', 'Ngày ra viện': '12/04/2026' },
  ];
  const map = R.buildContextMap(rows, 'r');
  const unresolved = R.contextForRow(map, { 'Mã BN': '777' }, '777');
  assert.strictEqual(unresolved.encounter_id, '');
  assert.strictEqual(unresolved.needs_manual_review, 'encounter_match_missing_event_time');
  assert.strictEqual(R.encounterMatchStatus(unresolved), 'missing');
});

test('Các trường mã điều trị/nội trú legacy không tham gia ghép; Mã BN + thời gian mới quyết định', () => {
  const rows = [
    { 'Mã BN': '111', 'T/G vào': '08:00 20/02/2026', 'Ngày ra viện': '22/02/2026' },
    { 'Mã BN': '222', 'T/G vào': '08:00 20/02/2026', 'Ngày ra viện': '22/02/2026' },
  ];
  const map = R.buildContextMap(rows, 'r');

  const matched = R.contextForRow(map, {
    'Mã BN': '111', 'Mã điều trị': 'gia-tri-khong-dung', 'Mã nội trú': 'gia-tri-khong-dung', 'TG chỉ định': '21/02/2026',
  }, '111');
  assert.strictEqual(matched.encounter_id, buildEncounterId(rows[0]));
  assert.strictEqual(R.encounterMatchStatus(matched), 'matched');
  assert.strictEqual(R.encounterMatchMethod(matched), 'event_date_range');
});

test('QA matching quality phân biệt khóa mạnh, thời gian, mơ hồ và ngoài đợt; Mã NC trùng không BLOCK', () => {
  const patients = [{ patient_code: 'p1' }, { patient_code: 'p2' }];
  const encounters = [
    { encounter_id: 'e1', research_code: 'NCX', patient_code: 'p1', admission_date: '2026-01-01', discharge_date: '2026-01-05' },
    { encounter_id: 'e2', research_code: 'NCX', patient_code: 'p2', admission_date: '2026-02-01', discharge_date: '2026-02-05' },
  ];
  const labs = [
    { lab_result_id: 'l1', patient_code: 'p1', encounter_id: 'e1', encounter_match_status: 'matched', encounter_match_method: 'encounter_id', encounter_match_reason: '', is_within_encounter: '1' },
    { lab_result_id: 'l2', patient_code: 'p1', encounter_id: 'e1', encounter_match_status: 'matched', encounter_match_method: 'event_date_range', encounter_match_reason: '', is_within_encounter: '1' },
    { lab_result_id: 'l3', patient_code: 'p1', encounter_id: '', encounter_match_status: 'missing', encounter_match_method: '', encounter_match_reason: 'encounter_match_outside_time', is_within_encounter: '' },
    { lab_result_id: 'l4', patient_code: 'p1', encounter_id: '', encounter_match_status: 'missing', encounter_match_method: '', encounter_match_reason: 'encounter_match_identity_conflict', is_within_encounter: '' },
  ];
  const report = buildQualityReport({ tables: { patients, encounters, lab_results: labs } });
  assert.ok(!report.blocking.some(x => x.code === 'duplicate_research_code'));
  assert.ok(report.warnings.some(x => x.code === 'research_code_reused'));
  assert.strictEqual(report.matching_quality.total_rows, 4);
  assert.strictEqual(report.matching_quality.matched_rows, 2);
  assert.strictEqual(report.matching_quality.strong_key, 1);
  assert.strictEqual(report.matching_quality.event_time_range, 1);
  assert.strictEqual(report.matching_quality.outside_treatment_time, 1);
  assert.strictEqual(report.matching_quality.identity_conflict, 1);
  assert.ok(report.blocking.some(x => x.code === 'encounter_match_identity_conflict'));
});

test('Ghép theo ngày vào duy nhất khi nguồn thiếu giờ/ngày ra; không ghép nếu ngày đó có nhiều lượt', () => {
  const rows = [
    { 'Mã BN': '111', 'T/G vào': '08:00 20/02/2026' },
    { 'Mã BN': '111', 'T/G vào': '09:00 25/02/2026' },
  ];
  const map = R.buildContextMap(rows, 'r');
  const matched = R.contextForRow(map, { 'Mã BN': '111', 'Ngày vào viện': '20/02/2026' }, '111');
  assert.ok(matched.encounter_id);
  assert.strictEqual(matched.encounter_id, buildEncounterId(rows[0]));
  assert.strictEqual(R.encounterMatchMethod(matched), 'admission_date');

  const ambiguousMap = R.buildContextMap([
    ...rows,
    { 'Mã BN': '111', 'T/G vào': '18:00 20/02/2026' },
  ], 'r');
  const ambiguous = R.contextForRow(ambiguousMap, { 'Mã BN': '111', 'Ngày vào viện': '20/02/2026' }, '111');
  assert.strictEqual(ambiguous.encounter_id, '');
  assert.strictEqual(R.encounterMatchStatus(ambiguous), 'ambiguous');
});

test('Ghép theo ngày sự kiện chỉ khi nằm trong đúng một lượt, không nới sang ngày ngoài viện', () => {
  const rows = [
    { 'Mã BN': '111', 'T/G vào': '08:00 20/02/2026', 'Ngày ra viện': '22/02/2026' },
    { 'Mã BN': '111', 'T/G vào': '09:00 25/02/2026', 'Ngày ra viện': '28/02/2026' },
  ];
  const map = R.buildContextMap(rows, 'r');
  const matched = R.contextForRow(map, { 'Mã BN': '111', 'TG chỉ định': '21/02/2026' }, '111');
  assert.strictEqual(matched.encounter_id, buildEncounterId(rows[0]));
  assert.strictEqual(R.encounterMatchMethod(matched), 'event_date_range');

  const outside = R.contextForRow(map, { 'Mã BN': '111', 'TG chỉ định': '23/02/2026' }, '111');
  assert.strictEqual(outside.encounter_id, '');
  assert.strictEqual(R.encounterMatchStatus(outside), 'missing');
  assert.strictEqual(outside.needs_manual_review, 'encounter_match_outside_time');
});

test('Kết quả chỉ thuộc đợt khi thời gian nằm trong khoảng vào-ra viện; có giờ thì so chính xác theo giờ', () => {
  // Có "Ngày vào viện" (hồ sơ hành chánh: lúc nhận vào viện, kể cả Cấp cứu) → so đúng giờ đó.
  const rows = [
    { 'Mã BN': '555', 'T/G vào': '09:30 10/04/2026', 'Ngày vào viện': '08:00 10/04/2026', 'Ngày ra viện': '17:00 12/04/2026' },
  ];
  const map = R.buildContextMap(rows, 'r');

  // Trong 24 giờ trước giờ vào: Cấp cứu/khám trước nhập khoa → thuộc đợt, ghi cách ghép riêng.
  const emergency = R.contextForRow(map, { 'Mã BN': '555', 'TG chỉ định': '07:30 10/04/2026' }, '555');
  assert.strictEqual(emergency.encounter_id, buildEncounterId(rows[0]));
  assert.strictEqual(R.encounterMatchMethod(emergency), 'emergency_before_ward');
  const beforeAdmission = R.contextForRow(map, {
    'Mã BN': '555', 'TG chỉ định': '07:30 09/04/2026',
  }, '555');
  assert.strictEqual(beforeAdmission.encounter_id, '', 'quá 24 giờ trước giờ vào không được thuộc khoảng nằm viện');
  assert.strictEqual(beforeAdmission.needs_manual_review, 'encounter_match_outside_time');

  const duringStay = R.contextForRow(map, {
    'Mã BN': '555', 'TG chỉ định': '09:00 10/04/2026',
  }, '555');
  assert.strictEqual(duringStay.encounter_id, buildEncounterId(rows[0]));
  assert.strictEqual(R.encounterMatchStatus(duringStay), 'matched');

  const afterDischarge = R.contextForRow(map, {
    'Mã BN': '555', 'TG chỉ định': '17:30 12/04/2026',
  }, '555');
  assert.strictEqual(afterDischarge.encounter_id, '', 'sau giờ ra viện không được thuộc khoảng nằm viện');
  assert.strictEqual(afterDischarge.needs_manual_review, 'encounter_match_outside_time');

  const dateOnlySameDay = R.contextForRow(map, {
    'Mã BN': '555', 'TG chỉ định': '10/04/2026',
  }, '555');
  assert.strictEqual(dateOnlySameDay.encounter_id, buildEncounterId(rows[0]), 'khi nguồn chỉ có ngày thì chỉ có thể xác nhận theo ngày lịch');
});

test('Một đợt tính từ lúc nhận Cấp cứu đến hết ngày ra viện, không chỉ từ lúc vào khoa', () => {
  // Chỉ có giờ vào khoa (danh sách nội trú), chưa có giờ nhận vào viện: kết quả làm ở Cấp cứu
  // trong 24 giờ trước khi vào khoa vẫn thuộc đợt, ghi cách ghép riêng để lọc được.
  const rows = [
    { 'Mã BN': '556', 'T/G vào': '08:00 10/04/2026', 'Ngày ra viện': '12/04/2026' },
    { 'Mã BN': '557', 'T/G vào': '08:00 01/03/2026', 'Ngày ra viện': '05/03/2026' },
    { 'Mã BN': '557', 'T/G vào': '09:00 05/03/2026', 'Ngày ra viện': '20/03/2026' },
  ];
  const map = R.buildContextMap(rows, 'r');
  const at = (code, t) => R.contextForRow(map, { 'Mã BN': code, 'TG chỉ định': t }, code);

  for (const t of ['06:30 10/04/2026', '22:00 09/04/2026']) {
    const ed = at('556', t);
    assert.strictEqual(ed.encounter_id, buildEncounterId(rows[0]), `${t}: XN cấp cứu trước giờ vào khoa thuộc đợt`);
    assert.strictEqual(R.encounterMatchMethod(ed), 'emergency_before_ward');
  }
  assert.strictEqual(at('556', '07:00 09/04/2026').encounter_id, '', 'quá 24 giờ trước khi vào khoa thì không tự gắn');

  // Ngày ra viện chỉ có ngày: cả ngày ra viện thuộc đợt (trước đây bị hiểu là 00:00 nên XN sáng ngày ra bị loại).
  const dischargeDay = at('556', '07:00 12/04/2026');
  assert.strictEqual(dischargeDay.encounter_id, buildEncounterId(rows[0]), 'XN sáng ngày ra viện thuộc đợt');
  assert.strictEqual(at('556', '07:00 13/04/2026').encounter_id, '', 'sau ngày ra viện thì không');

  // Không lấn sang đợt trước: 06:00 05/03 vẫn trong đợt 01/03–05/03, chỉ thuộc đợt đó.
  const prev = at('557', '06:00 05/03/2026');
  assert.strictEqual(prev.encounter_id, buildEncounterId(rows[1]), 'trong đợt trước thì thuộc đợt trước');
});

test('Đợt chưa có ngày ra viện nhận kết quả quá 60 ngày sau ngày vào (tính tới hôm nay)', () => {
  const rows = [
    { 'Mã BN': '444', 'T/G vào': '08:00 01/01/2025', 'Ngày ra viện': '10/01/2025' },
    { 'Mã BN': '444', 'T/G vào': '08:00 01/01/2026' },
  ];
  const map = R.buildContextMap(rows, 'r');
  const late = R.contextForRow(map, { 'Mã BN': '444', 'TG chỉ định': '15/03/2026' }, '444');
  assert.strictEqual(late.encounter_id, buildEncounterId(rows[1]), 'kết quả 73 ngày sau ngày vào vẫn thuộc đợt đang nằm');
  assert.strictEqual(R.encounterMatchMethod(late), 'event_date_range');
});

test('QA cảnh báo dòng đã gắn đợt nhưng ngoài thời gian nằm viện, và đợt chưa có ngày ra viện', () => {
  const encounters = [
    { encounter_id: 'e1', research_code: 'NC1', patient_code: 'p1', admission_date: '2026-01-01', discharge_date: '2026-01-05' },
    { encounter_id: 'e2', research_code: 'NC2', patient_code: 'p2', admission_date: '2026-02-01', discharge_date: '' },
  ];
  const labs = [
    { lab_result_id: 'l1', encounter_id: 'e1', encounter_match_status: 'matched', is_within_encounter: '0' },
    { lab_result_id: 'l2', encounter_id: 'e1', encounter_match_status: 'matched', is_within_encounter: '1' },
  ];
  const report = buildQualityReport({ tables: { patients: [{ patient_code: 'p1' }, { patient_code: 'p2' }], encounters, lab_results: labs } });
  const outside = report.warnings.find(w => w.code === 'child_outside_encounter');
  assert.ok(outside && outside.count === 1 && outside.table === 'lab_results');
  assert.ok(report.warnings.some(w => w.code === 'missing_discharge_date' && w.count === 1));
});

test('Ca mổ đầu tiên của đợt: dòng có ngày thắng dòng không ngày, chọn ngày sớm nhất', () => {
  const { firstSurgeryByEncounter } = require('../server/research/encounter_linkage');
  const map = firstSurgeryByEncounter([
    { encounter_id: 'e1', surgery_name: 'không ngày', surgery_date: '' },
    { encounter_id: 'e1', surgery_name: 'mổ lần 2', surgery_date: '2026-03-02' },
    { encounter_id: 'e1', surgery_name: 'mổ lần 1', surgery_datetime: '2026-03-01T08:00:00' },
    { encounter_id: '', surgery_name: 'thiếu đợt', surgery_date: '2026-01-01' },
  ]);
  assert.strictEqual(map.get('e1').surgery_name, 'mổ lần 1');
  assert.strictEqual(map.size, 1, 'dòng thiếu encounter_id không được gắn vào đợt nào');
});

test('Danh mục biến giới hạn mẫu và số giá trị khác nhau để không tăng RAM vô hạn', () => {
  const rows = Array.from({ length: 7000 }, (_, index) => ({
    bien_nhieu_gia_tri: `gia_tri_${index}`,
    bien_phan_loai: index % 2 ? 'Có' : 'Không',
  }));
  const stats = R.summarizeVariableColumns(['bien_nhieu_gia_tri', 'bien_phan_loai'], rows);
  const many = stats.get('bien_nhieu_gia_tri');
  const category = stats.get('bien_phan_loai');
  assert.strictEqual(many.nonempty, 7000);
  assert.strictEqual(many.distinct.size, 5000);
  assert.strictEqual(many.distinct_truncated, true);
  assert.ok(many.samples.size <= 30);
  assert.strictEqual(category.distinct.size, 2);
  assert.strictEqual(R.VARIABLE_CATALOG_MAX_ROWS, 50000);
});

test('Xem trước biến báo đúng lượt đủ, thiếu, trống và cần rà soát', () => {
  const selection = variableSelection.sanitizeVariableSelection({ selected_variables: [
    { id: 'age', table: 'analysis_ready', name: 'age', label: 'Tuổi', survey_label: 'Tuổi lúc nhập viện' },
    { id: 'hb', table: 'analysis_ready', name: 'hb', label: 'Hb', survey_label: 'Hb trước mổ' },
  ] });
  assert.strictEqual(selection.selected_variables[0].survey_label, 'Tuổi lúc nhập viện');
  const dataset = variableSelection.buildSelectedAnalysisDataset([
    { encounter_id: 'e1', age: '70', hb: '120' },
    { encounter_id: 'e2', age: '65', hb: '' },
    { encounter_id: '', age: '', hb: '', needs_manual_review: 'ambiguous' },
  ], selection, {});
  const summary = variableSelection.summarizeSelectedDataset(dataset);
  assert.deepStrictEqual({ total: summary.total, complete: summary.complete, partial: summary.partial, empty: summary.empty, review: summary.review }, {
    total: 3, complete: 1, partial: 1, empty: 1, review: 1,
  });
  assert.strictEqual(summary.variables.find(v => v.id === 'hb').missing, 2);
});

test('Mã NC duy nhất, giữ nguyên khi quét lại đổi thứ tự, dòng mới nhận số kế tiếp', () => {
  const first = R.normalizeResearchSourceRows(INITIAL_ROWS, { sourceRunId: 'r' });
  const codes = first.map(r => r['Mã NC']);
  assert.strictEqual(new Set(codes).size, 3, `Mã NC phải khác nhau: ${codes}`);

  const prev = new Map(first.map(r => [r['Research key'], r['Mã NC']]));
  const extra = { 'T/G vào': '07:00 05/03/2026', 'Mã BN': '333', 'Họ tên': 'BN GIA LAP C' };
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

test('Mã NC dùng lại mã script XN/CĐHA khi cùng Mã BN + thời điểm vào, không cần mã điều trị', () => {
  const runDir = newRunDir();
  writeCsv(path.join(runDir, 'du_lieu_ban_dau.csv'), INITIAL_COLS, INITIAL_ROWS);
  writeCsv(path.join(runDir, 'du_lieu_goc.csv'), ['Mã NC', 'Mã BN', 'T/G vào'], [
    { 'Mã NC': 'NC0002', 'Mã BN': '111', 'T/G vào': '09:00 25/02/2026' },
    { 'Mã NC': 'NC0001', 'Mã BN': '999', 'T/G vào': '08:00 01/01/2026' },
  ]);
  const info = R.ensureResearchSourceRows(runDir, { sourceRunId: 'r', force: true });
  const byVisit = Object.fromEntries(info.rows.map(r => [`${r['Mã BN']}|${r['T/G vào']}`, r['Mã NC']]));
  assert.strictEqual(byVisit['111|09:00 25/02/2026'], 'NC0002');
  assert.notStrictEqual(byVisit['111|08:00 20/02/2026'], 'NC0001', 'NC0001 đã thuộc BN/khung thời gian khác trong du_lieu_goc.csv');
  assert.strictEqual(new Set(Object.values(byVisit)).size, 3);
});

test('Dữ liệu hành chánh của đợt 2 gắn đúng đợt 2 (không ghép theo Mã NC trùng)', () => {
  const src = R.normalizeResearchSourceRows(INITIAL_ROWS, { sourceRunId: 'r' });
  const stay2 = src[1];
  const hchanh = [{ 'Mã BN': '111', 'Mã NC': 'NC0001', 'Research key': stay2['Research key'], 'Ngày vào viện': '25/02/2026', 'Số thẻ': 'THE-GIA-LAP' }];
  const merged = R.combineEncounterSources({ initialRows: src, hchanhProfileRows: hchanh, sourceRunId: 'r' });
  const withCard = merged.filter(r => r['Số thẻ'] === 'THE-GIA-LAP');
  assert.strictEqual(withCard.length, 1);
  assert.strictEqual(withCard[0]['Research key'], stay2['Research key']);
  assert.strictEqual(withCard[0]['Mã NC'], stay2['Mã NC'], 'Mã NC của dòng nguồn không bị mã cũ trong file hchanh đè');
});

test('Chuyển khoa cùng đợt (khoảng vào–ra chồng nhau): gộp thành một đợt, không còn phải duyệt tay', () => {
  // Quy tắc: một lần nằm viện là một đợt, từ lúc vào viện đến lúc ra viện; hai đợt của cùng Mã BN
  // không thể chồng thời gian. Trước đây trường hợp này bị tách 2 đợt và đưa vào danh sách duyệt tay.
  const runDir = newRunDir();
  writeCsv(path.join(runDir, 'du_lieu_ban_dau.csv'), INITIAL_COLS, INITIAL_ROWS);
  R.normalizeRunOutputs(runDir, { sourceRunId: 'r' });
  const source = readCsv(path.join(runDir, 'research_source.csv'));
  const discharge = source.filter(r => r['Mã BN'] === '111').map(r => ({
    'Mã NC': r['Mã NC'], 'Mã BN': '111', 'Research key': r['Research key'],
    'Ngày vào viện': r['T/G vào'], 'Ngày ra viện': '10/03/2026',
  }));
  writeCsv(path.join(runDir, 'hchanh_discharge.csv'), Object.keys(discharge[0]), discharge);
  const out = R.normalizeRunOutputs(runDir, { sourceRunId: 'r', force: true });
  assert.strictEqual(out.encounters, 2, '2 dòng khoa của BN 111 (20/02 và 25/02, cùng ra viện 10/03) là một đợt');
  const enc111 = readCsvTable(path.join(runDir, 'encounters.csv'), 100).rows.filter(r => r.patient_code === '111');
  assert.strictEqual(enc111.length, 1);
  assert.ok(String(enc111[0].admission_date).startsWith('2026-02-20'), 'vào viện = mốc vào sớm nhất');
  assert.ok(String(enc111[0].discharge_date).startsWith('2026-03-10'));
  const qa = JSON.parse(fs.readFileSync(path.join(runDir, 'qa_report.json'), 'utf-8'));
  assert.strictEqual(qa.blocking_count, 0, JSON.stringify(qa.blocking));
  const review = fs.existsSync(path.join(runDir, 'encounter_review.csv'))
    ? readCsv(path.join(runDir, 'encounter_review.csv')).filter(r => r.issue === 'possible_same_stay') : [];
  assert.strictEqual(review.length, 0);
  const history = fs.readFileSync(path.join(runDir, 'normalize_history.jsonl'), 'utf-8').trim().split('\n');
  assert.strictEqual(history.length, 2, 'mỗi lần chuẩn hóa thêm đúng 1 dòng lịch sử');
  assert.ok(JSON.parse(history[1]).input_signature);
  // Báo cáo QA không chứa họ tên.
  assert.ok(!fs.readFileSync(path.join(runDir, 'qa_report.json'), 'utf-8').includes('GIA LAP'));
});

test('Mã NC cũ bị cấp trùng còn trong file hồ sơ/ra viện (một mã cho nhiều Mã BN) không được gắn vào đợt', () => {
  // Dữ liệu thật: một Mã NC cũ có ở hchanh_profile/discharge của 513 Mã BN → 66 đợt khác người bệnh
  // cùng một Mã NC, chặn tạo dataset (research_code_cross_patient).
  const runDir = newRunDir();
  writeCsv(path.join(runDir, 'du_lieu_ban_dau.csv'), INITIAL_COLS, INITIAL_ROWS);
  R.normalizeRunOutputs(runDir, { sourceRunId: 'r' });
  const source = readCsv(path.join(runDir, 'research_source.csv'));
  // Hồ sơ của các đợt cũ (không có trong danh sách hiện tại) vẫn mang mã cũ dùng chung.
  const stale = source.map((r, i) => ({
    'Mã NC': 'NC9999', 'Mã BN': r['Mã BN'], 'Research key': `cu_${r['Research key']}`,
    'Ngày vào viện': `08:00 0${i + 1}/01/2026`, 'Ngày ra viện': `1${i}/01/2026`, 'Số thẻ': 'THE-GIA-LAP',
  }));
  writeCsv(path.join(runDir, 'hchanh_profile.csv'), Object.keys(stale[0]), stale);
  R.normalizeRunOutputs(runDir, { sourceRunId: 'r', force: true });
  const encounters = readCsvTable(path.join(runDir, 'encounters.csv'), 100).rows;
  const byCode = new Map();
  for (const e of encounters) {
    if (!e.research_code) continue;
    if (!byCode.has(e.research_code)) byCode.set(e.research_code, new Set());
    byCode.get(e.research_code).add(e.patient_code);
  }
  assert.ok([...byCode.values()].every(set => set.size === 1), 'mỗi Mã NC chỉ thuộc một Mã BN');
  assert.ok(!byCode.has('NC9999'), 'mã cũ dùng chung cho nhiều Mã BN không được dùng');
});

test('Ngày phẫu thuật EMR ghi kiểu tháng/ngày vẫn ghép đúng đợt; kiểu ngày/tháng không bị đảo nhầm', () => {
  // Dữ liệu thật: đọc ngày/tháng chỉ 154 ca rơi vào đợt, đảo tháng/ngày thì 608 ca.
  const runDir = newRunDir();
  writeCsv(path.join(runDir, 'du_lieu_ban_dau.csv'), ['T/G vào', 'Mã BN', 'Họ tên', 'Ngày ra viện'], [
    { 'T/G vào': '08:00 01/03/2026', 'Mã BN': '901', 'Họ tên': 'BN GIA LAP S', 'Ngày ra viện': '30/03/2026' },
    { 'T/G vào': '08:00 01/05/2026', 'Mã BN': '902', 'Họ tên': 'BN GIA LAP T', 'Ngày ra viện': '10/05/2026' },
  ]);
  writeCsv(path.join(runDir, 'hchanh_surgery.csv'), ['Mã BN', 'Ngày phẫu thuật', 'Tên phẫu thuật', 'Nguồn'], [
    { 'Mã BN': '901', 'Ngày phẫu thuật': '03/05/2026 09:00', 'Tên phẫu thuật': 'PT A', 'Nguồn': 'hchanh_surgery' },
    { 'Mã BN': '901', 'Ngày phẫu thuật': '03/25/2026 09:00', 'Tên phẫu thuật': 'PT B', 'Nguồn': 'hchanh_surgery' },
    { 'Mã BN': '902', 'Ngày phẫu thuật': '03/05/2026 09:00', 'Tên phẫu thuật': 'PT C', 'Nguồn': 'hchanh_surgery' },
  ]);
  R.normalizeRunOutputs(runDir, { sourceRunId: 'r', force: true });
  const surg = readCsvTable(path.join(runDir, 'surgery_results.csv'), 100).rows;
  const by = Object.fromEntries(surg.map(r => [r.surgery_name, r]));
  assert.strictEqual(by['PT A'].surgery_date, '2026-03-05', '03/05 trong đợt 01/03–30/03 → 5/3 (tháng/ngày)');
  assert.strictEqual(by['PT B'].surgery_date, '2026-03-25', '03/25 chỉ có thể là tháng/ngày');
  assert.strictEqual(by['PT C'].surgery_date, '2026-05-03', '03/05 trong đợt 01/05–10/05 → 3/5 (ngày/tháng)');
  assert.ok(surg.every(r => r.encounter_match_status === 'matched'), JSON.stringify(surg.map(r => r.encounter_match_reason)));
});

test('Y lệnh sau ngày ra khoa nhưng trong khoảng vào–ra cả lần nằm viện ghi trên dòng y lệnh: thuộc đợt', () => {
  // Dữ liệu thật: 6.500 dòng y lệnh ngoài đợt kho nhưng trong khoảng ghi trên chính dòng (đợt kho bị ngắn).
  const runDir = newRunDir();
  writeCsv(path.join(runDir, 'du_lieu_ban_dau.csv'), ['T/G vào', 'Mã BN', 'Họ tên', 'Ngày ra viện'], [
    { 'T/G vào': '08:00 01/03/2026', 'Mã BN': '903', 'Họ tên': 'BN GIA LAP Y', 'Ngày ra viện': '05/03/2026' },
  ]);
  writeCsv(path.join(runDir, 'hchanh_order_history.csv'), ['Mã BN', 'Ngày vào viện', 'Ngày ra viện', 'TG y lệnh', 'Diễn biến', 'Tên y lệnh', 'Nguồn'], [
    { 'Mã BN': '903', 'Ngày vào viện': '08:00 01/03/2026', 'Ngày ra viện': '12/03/2026', 'TG y lệnh': '08:00 03/03/2026', 'Diễn biến': 'Ổn', 'Tên y lệnh': '(TT) Paracetamol 500mg 01v x2 (u)', 'Nguồn': 'hchanh_auto_order_history' },
    { 'Mã BN': '903', 'Ngày vào viện': '08:00 01/03/2026', 'Ngày ra viện': '12/03/2026', 'TG y lệnh': '08:00 10/03/2026', 'Diễn biến': 'Tập PHCN', 'Tên y lệnh': '(TT) Eperison 50mg 01v x3 (u)', 'Nguồn': 'hchanh_auto_order_history' },
  ]);
  R.normalizeRunOutputs(runDir, { sourceRunId: 'r', force: true });
  const enc = readCsvTable(path.join(runDir, 'encounters.csv'), 100).rows.filter(r => r.patient_code === '903');
  assert.strictEqual(enc.length, 1);
  assert.ok(String(enc[0].discharge_date).startsWith('2026-03-12'), `ra viện theo khoảng trên y lệnh: ${enc[0].discharge_date}`);
  const meds = readCsvTable(path.join(runDir, 'medication_orders.csv'), 100).rows.filter(r => r.patient_code === '903');
  assert.ok(meds.length >= 2);
  assert.ok(meds.every(m => m.encounter_match_status === 'matched'), JSON.stringify(meds.map(m => m.encounter_match_reason)));
});

test('Chỉ Mã BN: nhiều dòng nguồn trong cùng khoảng EMR gộp 1 đợt và không nhân bản y lệnh reuse', () => {
  const runDir = newRunDir();
  const cols = ['T/G vào', 'Mã BN', 'Họ tên'];
  const initial = [
    { 'T/G vào': '08:00 08/09/2026', 'Mã BN': '777', 'Họ tên': 'BN GIA LAP C' },
    { 'T/G vào': '09:00 10/09/2026', 'Mã BN': '777', 'Họ tên': 'BN GIA LAP C' },
    { 'T/G vào': '10:00 15/09/2026', 'Mã BN': '777', 'Họ tên': 'BN GIA LAP C' },
  ];
  writeCsv(path.join(runDir, 'du_lieu_ban_dau.csv'), cols, initial);
  const sourceInfo = R.ensureResearchSourceRows(runDir, { sourceRunId: 'r', force: true });
  const source = sourceInfo.rows.filter(r => r['Mã BN'] === '777');
  assert.strictEqual(source.length, 3, 'raw/source vẫn giữ 3 dòng nguồn');

  const actualAdmission = '08:00 08/09/2026';
  const actualDischarge = '21/09/2026';
  const profile = source.map(r => ({
    'Mã NC': r['Mã NC'], 'Mã BN': '777', 'Research key': r['Research key'],
    'Ngày vào viện': actualAdmission, 'Ngày ra viện': actualDischarge,
    'Họ tên': 'BN GIA LAP C', 'Nguồn input': 'hchanh_auto_profile',
  }));
  const discharge = source.map(r => ({
    'Mã NC': r['Mã NC'], 'Mã BN': '777', 'Research key': r['Research key'],
    'Ngày vào viện': actualAdmission, 'Ngày ra viện': actualDischarge,
    'Họ tên': 'BN GIA LAP C', 'Chẩn đoán ra viện': 'TB45 - giả lập',
    'Nguồn input': 'hchanh_auto_discharge',
  }));
  const orders = source.map((r, idx) => ({
    'Mã NC': r['Mã NC'], 'Mã BN': '777', 'Research key': r['Research key'],
    // Mô phỏng file cũ: mỗi bản reuse vẫn mang ngày của dòng nguồn khác nhau.
    'Ngày vào viện': initial[idx]['T/G vào'], 'Ngày ra viện': actualDischarge,
    'TG y lệnh': '08:00 15/09/2026',
    'Diễn biến': 'Bệnh nhân tỉnh',
    'Tên y lệnh': '(TT) Eperison 50mg 01v x3 (u) 8h-14h-20h',
    'Y lệnh khác': '',
    'Nguồn': 'hchanh_auto_order_history',
  }));
  writeCsv(path.join(runDir, 'hchanh_profile.csv'), Object.keys(profile[0]), profile);
  writeCsv(path.join(runDir, 'hchanh_discharge.csv'), Object.keys(discharge[0]), discharge);
  writeCsv(path.join(runDir, 'hchanh_order_history.csv'), Object.keys(orders[0]), orders);

  const out = R.normalizeRunOutputs(runDir, { sourceRunId: 'r', force: true });
  assert.strictEqual(out.encounters, 1, 'các dòng nguồn cùng khoảng EMR phải thành một encounter');
  assert.strictEqual(readCsv(path.join(runDir, 'hchanh_order_history.csv')).length, 3, 'raw vẫn giữ đủ 3 bản reuse để audit');

  const encounters = readCsvTable(path.join(runDir, 'encounters.csv'), Number.MAX_SAFE_INTEGER).rows.filter(r => r.patient_code === '777');
  assert.strictEqual(encounters.length, 1);
  assert.ok(String(encounters[0].admission_date).startsWith('2026-09-08'));
  assert.ok(String(encounters[0].discharge_date).startsWith('2026-09-21'));

  const meds = readCsvTable(path.join(runDir, 'medication_orders.csv'), Number.MAX_SAFE_INTEGER).rows.filter(r => r.patient_code === '777');
  assert.strictEqual(meds.length, 1, 'cùng một y lệnh reuse không được nhân theo số dòng nguồn');
  assert.strictEqual(meds[0].encounter_match_status, 'matched');

  const notes = readCsvTable(path.join(runDir, 'clinical_notes.csv'), Number.MAX_SAFE_INTEGER).rows.filter(r => r.patient_code === '777');
  assert.strictEqual(notes.length, 1, 'clinical note reuse giống hệt cũng chỉ giữ một bản chuẩn hóa');
});

test('Dòng nguồn vẫn tách; encounters chỉ gộp khi Mã BN + khoảng vào-ra chứng minh cùng lần nằm viện', () => {
  const runDir = newRunDir();
  // Dòng vào khoa sau đứng trước; dòng vào viện sớm hơn có ngày ra bao trùm mốc chuyển khoa.
  writeCsv(path.join(runDir, 'du_lieu_ban_dau.csv'), [...INITIAL_COLS, 'Ngày ra viện'], [
    { 'T/G vào': '09:00 04/03/2026', 'Mã BN': '111', 'Họ tên': 'BN GIA LAP A', 'Ngày ra viện': '' },
    { 'T/G vào': '08:00 20/02/2026', 'Mã BN': '111', 'Họ tên': 'BN GIA LAP A', 'Ngày ra viện': '10/03/2026' },
    { 'T/G vào': '10:00 01/03/2026', 'Mã BN': '222', 'Họ tên': 'BN GIA LAP B', 'Ngày ra viện': '05/03/2026' },
  ]);
  const out = R.normalizeRunOutputs(runDir, { sourceRunId: 'r' });
  assert.strictEqual(out.encounters, 2);
  const source = readCsv(path.join(runDir, 'research_source.csv')).filter(r => r['Mã BN'] === '111');
  assert.strictEqual(source.length, 2, 'research_source giữ từng dòng nguồn, không ép gộp thành một ô/dòng lớn');
  assert.deepStrictEqual(source.map(r => r.fetch_from_date).sort(), ['2026-02-20', '2026-03-04']);
  const enc = readCsv(path.join(runDir, 'encounters.csv')).find(r => r.patient_code === '111');
  assert.strictEqual(enc.admission_date, '2026-02-20 08:00');
});

test('XN: giữ đủ mọi lần xét nghiệm; dòng giống hệt chỉ cảnh báo nghi trùng, kết quả mâu thuẫn vẫn giữ cả hai', () => {
  const runDir = newRunDir();
  writeCsv(path.join(runDir, 'du_lieu_ban_dau.csv'), INITIAL_COLS, INITIAL_ROWS);
  const xnCols = ['Mã BN', 'TG chỉ định', 'Chỉ số', 'Kết quả', 'Đơn vị'];
  const hb = { 'Mã BN': '111', 'TG chỉ định': '07:30 21/02/2026', 'Chỉ số': 'Hb', 'Kết quả': '125', 'Đơn vị': 'g/L' };
  const crp = { 'Mã BN': '111', 'TG chỉ định': '07:30 21/02/2026', 'Chỉ số': 'CRP', 'Kết quả': '5', 'Đơn vị': 'mg/L' };
  writeCsv(path.join(runDir, 'lich_su_xn.csv'), xnCols, [hb, { ...hb }, crp, { ...crp, 'Kết quả': '50' }]);
  const out = R.normalizeRunOutputs(runDir, { sourceRunId: 'r' });
  assert.strictEqual(out.lab_results, 4, 'không xóa Hb giống hệt vì có thể là hai lần xét nghiệm thật');
  const labs = readCsv(path.join(runDir, 'lab_results.csv'));
  assert.strictEqual(new Set(labs.map(r => r.lab_result_id)).size, 4, 'mỗi dòng XN có ID riêng');
  const qa = JSON.parse(fs.readFileSync(path.join(runDir, 'qa_report.json'), 'utf-8'));
  assert.ok(!qa.blocking.some(b => b.code === 'duplicate_row_id'), JSON.stringify(qa.blocking));
  assert.ok(qa.warnings.some(w => w.code === 'possible_duplicate_lab_rows'));
  assert.ok(qa.warnings.some(w => w.code === 'conflicting_results' && w.table === 'lab_results'));
  const review = readCsv(path.join(runDir, 'encounter_review.csv'));
  assert.strictEqual(review.filter(r => r.issue === 'possible_duplicate_lab_rows').length, 1);
  assert.strictEqual(review.filter(r => r.issue === 'conflicting_lab_result').length, 1);
});

test('CĐHA/XN giữ đầy đủ ở bảng dài; analysis_ready chỉ giữ count, không nhét cả đợt vào một ô', () => {
  const runDir = newRunDir();
  writeCsv(path.join(runDir, 'du_lieu_ban_dau.csv'), INITIAL_COLS, INITIAL_ROWS);
  const xnCols = ['Mã BN', 'TG chỉ định', 'Mã phiếu', 'Chỉ số', 'Kết quả', 'Đơn vị', 'Khoảng tham chiếu'];
  writeCsv(path.join(runDir, 'lich_su_xn.csv'), xnCols, [
    { 'Mã BN': '111', 'TG chỉ định': '07:30 21/02/2026', 'Mã phiếu': 'P1', 'Chỉ số': 'Hb', 'Kết quả': '125', 'Đơn vị': 'g/L', 'Khoảng tham chiếu': '120-160' },
    { 'Mã BN': '111', 'TG chỉ định': '12:30 21/02/2026', 'Mã phiếu': 'P2', 'Chỉ số': 'Hb', 'Kết quả': '120', 'Đơn vị': 'g/L', 'Khoảng tham chiếu': '120-160' },
  ]);
  const longResult = 'Mô tả '.repeat(250) + 'ĐOẠN_CUỐI_KẾT_QUẢ';
  const imagingCols = ['Mã BN', 'TG chỉ định', 'Tên dịch vụ', 'Mô tả/Kết quả', 'Kết luận', 'Trạng thái'];
  const img = { 'Mã BN': '111', 'TG chỉ định': '09:00 21/02/2026', 'Tên dịch vụ': 'CT ngực', 'Mô tả/Kết quả': longResult, 'Kết luận': 'KẾT_LUẬN_ĐẦY_ĐỦ', 'Trạng thái': 'Hoàn tất' };
  writeCsv(path.join(runDir, 'lich_su_cdha.csv'), imagingCols, [img, { ...img }]);

  const out = R.normalizeRunOutputs(runDir, { sourceRunId: 'r' });
  assert.strictEqual(out.lab_results, 2);
  assert.strictEqual(out.imaging_results, 2, 'hai lần CĐHA giống nội dung vẫn phải được giữ');

  const labs = readCsv(path.join(runDir, 'lab_results.csv'));
  const images = readCsv(path.join(runDir, 'imaging_results.csv'));
  assert.strictEqual(labs.length, 2, 'bảng dài XN phải giữ đủ hai lần Hb');
  assert.deepStrictEqual(labs.map(x => x.lab_order_id), ['P1', 'P2']);
  assert.strictEqual(images.length, 2, 'bảng dài CĐHA phải giữ đủ hai lần');
  assert.ok(images.every(x => x.result_text.endsWith('ĐOẠN_CUỐI_KẾT_QUẢ')));
  assert.ok(images.every(x => x.conclusion_text === 'KẾT_LUẬN_ĐẦY_ĐỦ'));

  const ready = (readCsvTable(path.join(runDir, 'analysis_ready.csv'), Number.MAX_SAFE_INTEGER).rows || []).find(r => r.patient_code === '111');
  assert.ok(ready);
  assert.strictEqual(Number(ready.lab_result_count), 2);
  assert.strictEqual(Number(ready.imaging_result_count), 2);
  assert.ok(!Object.prototype.hasOwnProperty.call(ready, 'lab_results_json'));
  assert.ok(!Object.prototype.hasOwnProperty.call(ready, 'imaging_results_json'));
  assert.ok(!Object.prototype.hasOwnProperty.call(ready, 'imaging_summary'));

  const qa = JSON.parse(fs.readFileSync(path.join(runDir, 'qa_report.json'), 'utf-8'));
  assert.ok(qa.warnings.some(w => w.code === 'possible_duplicate_imaging_rows'));
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

test('Số lượt theo dõi = số lượt trong danh sách; mục tiến độ không có Mã NC không tạo lượt mới', () => {
  const runDir = fs.mkdtempSync(path.join(RUNTIME_ROOT, 'progress_snapshot_'));
  const cols = ['research_code', 'encounter_id', 'patient_code', 'patient_name', 'xn_status', 'cdha_status', 'overall_status', 'last_error'];
  const csv = [cols.join(','),
    'NC0001,enc_a1,1000001,A,,,,',
    'NC0002,enc_b1,1000002,B,,,,',
    'NC0003,enc_b2,1000002,B,,,,',
  ].join('\n') + '\n';
  fs.writeFileSync(path.join(runDir, 'extract_status.csv'), csv);
  fs.writeFileSync(path.join(runDir, 'progress.json'), JSON.stringify({
    // Có Mã NC: ghép đúng lượt.
    '1000001|row:1': { 'Mã BN': '1000001', 'Mã NC': 'NC0001', popup: 'done', xn: 'done', cdha: 'done', status: 'done' },
    // Không Mã NC, BN chỉ có 1 lượt: ghép vào lượt đó.
    '1000001|row:2': { 'Mã BN': '1000001', popup: 'error', last_error: 'Không mở được popup' },
    // Không Mã NC, BN có 2 lượt: không đoán, không tạo lượt mới.
    '1000002|row:3': { 'Mã BN': '1000002', popup: 'error', last_error: 'Không mở được popup' },
    // BN không có trong danh sách.
    '9999999|row:1': { 'Mã BN': '9999999', popup: 'error', last_error: 'x' },
    // Mã NC cũ (trước khi đánh lại) của BN 2 lượt: không ghép.
    'NC0999': { 'Mã BN': '1000002', 'Mã NC': 'NC0999', popup: 'error' },
  }));
  const snap = R.buildResearchProgressSnapshot(runDir, {}, { isArchive: true });
  assert.strictEqual(snap.total, 3);
  assert.strictEqual(snap.unmatched_progress, 3);
  const a = snap.rows.find(r => (r.research_code || r.sample) === 'NC0001' || r.key === 'NC0001');
  assert.ok(a, 'có dòng NC0001');
  assert.ok(snap.counts.error <= 1, `lỗi chỉ tính trên lượt có thật, nhận ${snap.counts.error}`);
});

test('Chuẩn hóa giữ nguyên số âm và kết quả "+" trong lab_results.csv (không chèn dấu \')', () => {
  const runDir = newRunDir();
  writeCsv(path.join(runDir, 'du_lieu_ban_dau.csv'), ['T/G vào', 'Mã BN', 'Họ tên', 'Ngày ra viện'], [
    { 'T/G vào': '08:00 20/02/2026', 'Mã BN': '333', 'Họ tên': 'BN GIA LAP C', 'Ngày ra viện': '28/02/2026' },
  ]);
  R.normalizeRunOutputs(runDir, { sourceRunId: 'r' });
  const nc = readCsv(path.join(runDir, 'research_source.csv'))[0]['Mã NC'];
  writeCsv(path.join(runDir, 'lich_su_xn.csv'), ['Mã NC', 'Mã BN', 'Thời gian', 'Chỉ số', 'Kết quả', 'Đơn vị'], [
    { 'Mã NC': nc, 'Mã BN': '333', 'Thời gian': '08:00 22/02/2026', 'Chỉ số': 'Kiềm dư (BE)', 'Kết quả': '-3.5', 'Đơn vị': 'mmol/L' },
    { 'Mã NC': nc, 'Mã BN': '333', 'Thời gian': '08:00 23/02/2026', 'Chỉ số': 'Protein niệu', 'Kết quả': '+', 'Đơn vị': '' },
  ]);
  R.normalizeRunOutputs(runDir, { sourceRunId: 'r', force: true });
  const text = fs.readFileSync(path.join(runDir, 'lab_results.csv'), 'utf-8');
  assert.ok(!/(^|,)'[-+]/m.test(text), 'không có dấu \' trước số âm/"+"');
  const labs = readCsv(path.join(runDir, 'lab_results.csv'));
  const be = labs.find(r => r.test_name_raw === 'Kiềm dư (BE)');
  assert.strictEqual(be.result_num, '-3.5');
  assert.strictEqual(be.days_from_discharge, '-6');
  assert.strictEqual(labs.find(r => r.test_name_raw === 'Protein niệu').result_raw, '+');
});

test('Mã run từ URL/body không được là "." hoặc ".." (không trỏ lên thư mục cha)', () => {
  assert.strictEqual(R.safeRunId('..'), '');
  assert.strictEqual(R.safeRunId('.'), '');
  assert.strictEqual(R.safeRunId('../../etc'), '.._.._etc');
  assert.strictEqual(R.safeRunId('20260529_162615'), '20260529_162615');
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
