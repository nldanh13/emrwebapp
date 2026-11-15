#!/usr/bin/env node
'use strict';

// Sổ biên bản hội chẩn (SBBHC) trong Kho nghiên cứu (dữ liệu giả lập, không có BN thật):
//  1. Dòng thô hchanh_consult.csv từ output worker; bước ghi và bước chuẩn hóa dùng chung một hàm.
//  2. Phần Hội chẩn là TÙY CHỌN: không nằm trong mặc định, không làm kho cũ thành "thiếu";
//     chỉ lấy khi người dùng bật hoặc đề cương chọn biến consult_*.
//  3. Chuẩn hóa: cột consult_* gắn đúng đợt; 2 đợt của cùng BN không lẫn; nhiều phiếu nối theo thời gian.
// Chạy: node scripts/research_consult_sbbhc_test.js

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const RUNTIME_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'research_consult_test_'));
process.env.EMR_RUNTIME_ROOT = RUNTIME_ROOT;

const research = require('../server/routes/research');
const R = research._test;
const consult = require('../server/research/consult_summary');
const { hchanhFetchOutputToRows } = require('../server/research/research_source');
const collection = require('../server/research/collection');
const { readCsvTable } = require('../server/research/table_io');
const { NORMALIZED_COLUMNS } = require('../server/research/normalized_schema');
const { TABLES } = require('../server/research/data_dictionary');

let passed = 0;
function test(name, fn) {
  try { fn(); passed += 1; console.log(`  ok - ${name}`); } catch (err) { console.error(`  FAIL - ${name}`); console.error(err); process.exitCode = 1; }
}
function writeCsv(file, cols, rows) {
  const esc = v => (/[",\n]/.test(String(v ?? '')) ? `"${String(v).replace(/"/g, '""')}"` : String(v ?? ''));
  fs.writeFileSync(file, `﻿${[cols.join(','), ...rows.map(r => cols.map(c => esc(r[c])).join(','))].join('\n')}\n`, 'utf-8');
}

const FORM = (id, time, ketLuan, extra = {}) => ({
  hosoid: id, khoa: 'CTCH', ngay_tao: time.split(' ').pop(), ThoiGianHoiChan: time,
  YeuCau: 'Hội chẩn chỉ định', ChanDoanTuyenDuoi: 'Gãy cổ xương đùi', HuongDieuTri: 'Phẫu thuật', KetLuan: ketLuan, ...extra,
});

test('Dòng thô hchanh_consult.csv: mỗi SBBHC đã đọc một dòng, giữ meta đợt; lỗi → không có dòng', () => {
  const src = { 'Mã BN': '501', 'Họ tên': 'BN GIA LAP C', 'T/G vào': '08:00 01/03/2026', 'Ngày ra viện': '05/03/2026' };
  const flat = hchanhFetchOutputToRows({ consult: { _fetch_status: 'ok', rows: [FORM('h1', '09:30 02/03/2026', 'Mổ'), FORM('h2', '10:00 03/03/2026', 'Theo dõi')] } }, src, 'r');
  assert.strictEqual(flat.consultRows.length, 2);
  assert.strictEqual(flat.consultRows[0]['Mã hồ sơ SBBHC'], 'h1');
  assert.strictEqual(flat.consultRows[0]['Kết luận'], 'Mổ');
  assert.ok(flat.consultRows[0]['Research key']);
  assert.strictEqual(hchanhFetchOutputToRows({ consult: { _fetch_status: 'error', rows: [] } }, src, 'r').consultRows.length, 0);
  assert.strictEqual(hchanhFetchOutputToRows({}, src, 'r').consultRows.length, 0);
});

test('Gộp theo đợt: sắp theo thời gian hội chẩn, bỏ trùng mã hồ sơ, nối " | "', () => {
  const rows = consult.consultRawRows({ rows: [FORM('h2', '10:00 03/03/2026', 'Theo dõi'), FORM('h1', '09:30 02/03/2026', 'Mổ | gấp'), FORM('h1', '09:30 02/03/2026', 'Mổ | gấp')] });
  const f = consult.consultFieldsForEncounter(rows);
  assert.strictEqual(f.consult_count, '2');
  assert.strictEqual(f.consult_first_time, '2026-03-02 09:30');
  assert.strictEqual(f.consult_last_time, '2026-03-03 10:00');
  assert.strictEqual(f.consult_conclusions, 'Mổ / gấp | Theo dõi', 'dấu | trong nội dung không làm lệch phiếu');
  assert.strictEqual(f.consult_summaries, '', 'ô không phiếu nào ghi thì để trống');
  const none = consult.consultFieldsForEncounter([]);
  assert.strictEqual(none.consult_count, '');
});

test('Phần Hội chẩn là tùy chọn: mặc định không lấy, không làm kho cũ thành thiếu', () => {
  assert.ok(!collection.PART_KEYS.includes('consult'));
  assert.ok(collection.ALL_PART_KEYS.includes('consult'));
  assert.ok(!collection.resolveCollectionParts({}).includes('consult'));
  assert.ok(collection.resolveCollectionParts({ optional: ['consult'] }).includes('consult'));
  assert.ok(collection.resolveCollectionParts({ optional: ['consult'] }).includes('billing'));
  assert.ok(!collection.requirementsFromStudy({}).parts.includes('consult'));
  const withVar = { variable_selection: { selected_variables: [{ id: 'analysis_ready.consult_count', table: 'analysis_ready', name: 'consult_count' }] } };
  assert.ok(collection.requirementsFromStudy(withVar).parts.includes('consult'));

  const src = { 'Research key': 'k1', 'Mã BN': '601', 'Mã NC': 'NC1', 'T/G vào': '08:00 01/03/2026' };
  const at = '2026-03-06T00:00:00Z';
  const ok = (rows, extra = {}) => ({ fetch_status: 'ok', rows, at, ...extra });
  const { HCHANH_CONTENT_VERSIONS } = require('../server/research/fetch_versions');
  const ledger = collection.buildLedger({
    sourceRows: [src], xnProgress: { k1: {} },
    hchanhProgress: { k1: { ma_bn: '601', file_status: { profile: ok(1, { payload_version: HCHANH_CONTENT_VERSIONS.profile }), discharge: ok(1), surgery: ok(0), billing: ok(1, { payload_version: HCHANH_CONTENT_VERSIONS.billing }) } } },
  });
  const hcParts = ['profile', 'discharge', 'surgery', 'billing'];
  assert.strictEqual(collection.planCollection(ledger, { parts: hcParts }).tasks.length, 0, 'không tự lấy Hội chẩn');
  const withConsult = collection.planCollection(ledger, { parts: [...hcParts, 'consult'] });
  assert.deepStrictEqual(withConsult.tasks.map(t => t.parts), [['consult']], 'bật Hội chẩn: chỉ lấy bổ sung phần này');
  // Đi chung lô hành chánh (một Chrome) với các phần khác.
  const groups = collection.groupTasksByFetcher([{ key: 'k', parts: ['profile', 'consult'] }]);
  assert.deepStrictEqual([...groups.hchanh.keys()], ['consult,profile']);
  // Đã lấy Hội chẩn rồi thì không lấy lại.
  const done = collection.buildLedger({
    sourceRows: [src], previous: ledger, xnProgress: { k1: {} },
    hchanhProgress: { k1: { ma_bn: '601', file_status: { profile: ok(1, { payload_version: HCHANH_CONTENT_VERSIONS.profile }), discharge: ok(1), surgery: ok(0), billing: ok(1, { payload_version: HCHANH_CONTENT_VERSIONS.billing }), consult: ok(0) } } },
  });
  assert.strictEqual(done.encounters.k1.parts.consult.status, 'empty');
  assert.strictEqual(collection.planCollection(done, { parts: [...hcParts, 'consult'] }).tasks.length, 0);
});

test('Từ điển dữ liệu và danh sách biến có cột consult_*', () => {
  for (const col of consult.CONSULT_COLUMNS) {
    assert.ok(NORMALIZED_COLUMNS.analysis_ready.includes(col), col);
    assert.ok(TABLES.analysis_ready.columns[col], `từ điển có ${col}`);
  }
  assert.strictEqual(TABLES.analysis_ready.columns.consult_conclusions.identifier, 'free_text');
});

test('Chuẩn hóa: consult_* gắn đúng đợt, 2 đợt cùng BN không lẫn', () => {
  const runDir = path.join(RUNTIME_ROOT, 'fixture', 'r1');
  fs.mkdirSync(runDir, { recursive: true });
  writeCsv(path.join(runDir, 'du_lieu_ban_dau.csv'), ['T/G vào', 'Mã BN', 'Họ tên', 'Ngày ra viện'], [
    { 'T/G vào': '08:00 01/03/2026', 'Mã BN': '701', 'Họ tên': 'BN GIA LAP D', 'Ngày ra viện': '05/03/2026' },
    { 'T/G vào': '08:00 01/05/2026', 'Mã BN': '701', 'Họ tên': 'BN GIA LAP D', 'Ngày ra viện': '04/05/2026' },
    { 'T/G vào': '08:00 01/06/2026', 'Mã BN': '702', 'Họ tên': 'BN GIA LAP E', 'Ngày ra viện': '03/06/2026' },
  ]);
  const raw = (code, from, to, key, form) => ({
    'Mã BN': code, 'Ngày vào viện': from, 'Ngày ra viện': to, 'Research key': key, 'Nguồn': 'hchanh_auto_consult',
    ...consult.consultRawRows({ rows: [form] })[0],
  });
  const rows = [
    raw('701', '08:00 01/03/2026', '05/03/2026', 'kA', FORM('h1', '09:30 02/03/2026', 'Mổ')),
    raw('701', '08:00 01/03/2026', '05/03/2026', 'kA', FORM('h2', '10:00 04/03/2026', 'Ra viện')),
    raw('701', '08:00 01/05/2026', '04/05/2026', 'kB', FORM('h3', '14:00 02/05/2026', 'Điều trị nội')),
  ];
  writeCsv(path.join(runDir, 'hchanh_consult.csv'), Object.keys(rows[0]), rows);
  R.normalizeRunOutputs(runDir, { sourceRunId: 'r', force: true });
  const table = readCsvTable(path.join(runDir, 'analysis_ready.csv'), 100);
  for (const col of consult.CONSULT_COLUMNS) assert.ok(table.columns.includes(col), col);
  const byAdm = Object.fromEntries(table.rows.map(r => [`${r.patient_code}|${String(r.admission_date).slice(0, 10)}`, r]));
  const first = byAdm['701|2026-03-01'];
  const second = byAdm['701|2026-05-01'];
  const other = byAdm['702|2026-06-01'];
  assert.ok(first && second && other, JSON.stringify(Object.keys(byAdm)));
  assert.strictEqual(first.consult_count, '2');
  assert.strictEqual(first.consult_conclusions, 'Mổ | Ra viện');
  assert.strictEqual(second.consult_count, '1');
  assert.strictEqual(second.consult_conclusions, 'Điều trị nội', 'đợt 2 không lấy SBBHC của đợt 1');
  assert.strictEqual(other.consult_count, '');
});

if (!process.exitCode) console.log(`research_consult_sbbhc_test: ${passed} test(s) passed.`);
