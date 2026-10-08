#!/usr/bin/env node
'use strict';

// Kiểm tra tách Mã BN khỏi dữ liệu phân tích (patient_link.csv + patient_key):
//  1. Chuẩn hóa tạo patient_link.csv ở thư mục KHO (không nằm trong run), mọi bảng có
//     patient_code có thêm patient_key; cùng Mã BN → cùng patient_key ở mọi đợt.
//  2. patient_key giữ nguyên khi Chuẩn hóa lại và khi có run mới của cùng kho; người bệnh
//     mới nhận mã tiếp theo.
//  3. Dataset chọn biến, dataset cuối (và bản lưu trong datasets/), bảng mã hóa không có
//     Mã BN/họ tên, chỉ có patient_key.
// Chạy: node scripts/research_patient_link_test.js

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.EMR_RUNTIME_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'research_patient_link_test_'));

const R = require('../server/routes/research')._test;
const { readCsvFileRows } = require('../server/research/csv_reader');

let passed = 0;
function test(name, fn) {
  try { fn(); passed += 1; console.log(`  ok - ${name}`); } catch (err) { console.error(`  FAIL - ${name}`); console.error(err); process.exitCode = 1; }
}
const read = file => readCsvFileRows(file, Number.MAX_SAFE_INTEGER);
function writeCsv(file, cols, rows) {
  const esc = v => (/[",\n]/.test(String(v ?? '')) ? `"${String(v).replace(/"/g, '""')}"` : String(v ?? ''));
  fs.writeFileSync(file, `﻿${[cols.join(','), ...rows.map(r => cols.map(c => esc(r[c])).join(','))].join('\n')}\n`);
}

const storeDir = path.join(process.env.EMR_RUNTIME_ROOT, 'store', 'kho_thu');
const INITIAL_COLS = ['T/G vào', 'Mã BN', 'Mã nội trú', 'Họ tên', 'Ngày ra viện'];
function makeRun(name, rows) {
  const runDir = path.join(storeDir, 'runs', name);
  fs.mkdirSync(runDir, { recursive: true });
  writeCsv(path.join(runDir, 'du_lieu_ban_dau.csv'), INITIAL_COLS, rows);
  return runDir;
}
const ROWS = [
  { 'T/G vào': '08:00 20/02/2026', 'Mã BN': '1000111', 'Mã nội trú': 'nt-a', 'Họ tên': 'BN GIA LAP A', 'Ngày ra viện': '22/02/2026' },
  { 'T/G vào': '09:00 25/03/2026', 'Mã BN': '1000111', 'Mã nội trú': 'nt-b', 'Họ tên': 'BN GIA LAP A', 'Ngày ra viện': '28/03/2026' },
  { 'T/G vào': '10:00 01/03/2026', 'Mã BN': '1000222', 'Mã nội trú': 'nt-c', 'Họ tên': 'BN GIA LAP B', 'Ngày ra viện': '05/03/2026' },
];

const run1 = makeRun('r1', ROWS);
R.normalizeRunOutputs(run1, { sourceRunId: 'r1' });
const linkFile = path.join(storeDir, 'patient_link.csv');

test('patient_link.csv nằm ở thư mục kho; mọi bảng có patient_code có patient_key nhất quán', () => {
  assert.ok(fs.existsSync(linkFile), 'có patient_link.csv ở thư mục kho');
  assert.ok(!fs.existsSync(path.join(run1, 'patient_link.csv')), 'không nằm trong run');
  const link = read(linkFile).rows;
  assert.deepStrictEqual(link.map(r => r.patient_code).sort(), ['1000111', '1000222']);
  const keyOf = Object.fromEntries(link.map(r => [r.patient_code, r.patient_key]));
  assert.match(keyOf['1000111'], /^P\d{6}$/);
  assert.notStrictEqual(keyOf['1000111'], keyOf['1000222']);
  for (const file of ['patients.csv', 'encounters.csv', 'analysis_ready.csv', 'extract_status.csv']) {
    const t = read(path.join(run1, file));
    assert.ok(t.columns.includes('patient_key'), `${file} có patient_key`);
    for (const row of t.rows) assert.strictEqual(row.patient_key, keyOf[row.patient_code], `${file}: patient_key khớp bảng liên kết`);
  }
  const enc = read(path.join(run1, 'encounters.csv')).rows.filter(r => r.patient_code === '1000111');
  assert.strictEqual(enc.length, 2);
  assert.strictEqual(enc[0].patient_key, enc[1].patient_key, 'hai đợt của cùng người bệnh cùng patient_key');
});

test('patient_key giữ nguyên khi chuẩn hóa lại và ở run mới; người bệnh mới nhận mã tiếp theo', () => {
  const before = Object.fromEntries(read(linkFile).rows.map(r => [r.patient_code, r.patient_key]));
  R.normalizeRunOutputs(run1, { sourceRunId: 'r1', force: true });
  const run2 = makeRun('r2', [
    { 'T/G vào': '08:00 01/04/2026', 'Mã BN': '1000333', 'Mã nội trú': 'nt-d', 'Họ tên': 'BN GIA LAP C', 'Ngày ra viện': '03/04/2026' },
    ROWS[2],
  ]);
  R.normalizeRunOutputs(run2, { sourceRunId: 'r2' });
  const after = Object.fromEntries(read(linkFile).rows.map(r => [r.patient_code, r.patient_key]));
  assert.strictEqual(after['1000111'], before['1000111']);
  assert.strictEqual(after['1000222'], before['1000222']);
  assert.ok(after['1000333'] && !Object.values(before).includes(after['1000333']), 'mã mới không trùng mã cũ');
  const b2 = read(path.join(run2, 'patients.csv')).rows.find(r => r.patient_code === '1000222');
  assert.strictEqual(b2.patient_key, before['1000222'], 'run mới dùng lại mã cũ');
});

test('Dataset cuối có Mã BN để đối chiếu; bảng mã hóa vẫn ẩn danh bằng patient_key', () => {
  // Giả lập mọi lượt đã lấy đủ dữ liệu để được phép tạo dataset cuối.
  const status = read(path.join(run1, 'extract_status.csv'));
  writeCsv(path.join(run1, 'extract_status.csv'), status.columns, status.rows.map(r => ({ ...r, ready_for_analysis: '1', overall_status: 'done' })));
  R.finalizeAnalysisDataset(run1);
  const final = read(path.join(run1, 'analysis_final.csv'));
  assert.ok(final.rows.length > 0);
  assert.ok(final.columns.includes('patient_key'));
  assert.ok(final.columns.includes('patient_code'), 'analysis_final có Mã BN gốc');
  assert.ok(!final.columns.includes('patient_name'), 'analysis_final vẫn loại họ tên');
  const text = fs.readFileSync(path.join(run1, 'analysis_final.csv'), 'utf8');
  assert.ok(text.includes('1000111'), 'analysis_final giữ Mã BN để đối chiếu');
  assert.ok(!text.includes('BN GIA LAP'), 'analysis_final không có họ tên');
  const snaps = fs.readdirSync(path.join(run1, 'datasets')).filter(n => !n.startsWith('.'));
  assert.ok(snaps.length >= 1);
  for (const snap of snaps) {
    const snapText = fs.readFileSync(path.join(run1, 'datasets', snap, 'analysis_final.csv'), 'utf8');
    assert.ok(snapText.includes('1000111'), `datasets/${snap} giữ Mã BN để đối chiếu`);
    assert.ok(!snapText.includes('BN GIA LAP'), `datasets/${snap} không có họ tên`);
  }
  R.buildEncodedDataset(run1);
  const encodedDir = path.join(run1, 'encoded');
  for (const file of fs.readdirSync(encodedDir).filter(f => f.endsWith('_encoded.csv'))) {
    const t = read(path.join(encodedDir, file));
    assert.ok(!t.columns.includes('patient_code') && !t.columns.includes('patient_name'), `${file} không có Mã BN/họ tên`);
  }
  assert.ok(read(path.join(encodedDir, 'analysis_ready_encoded.csv')).columns.includes('patient_key'));
});

console.log(`\n${passed} kịch bản pass.`);
