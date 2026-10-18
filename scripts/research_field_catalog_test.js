#!/usr/bin/env node
'use strict';

// Danh sách trường dữ liệu ở tab Dữ liệu tổng quát (server/research/field_catalog.js), dữ liệu giả:
//  1. Mọi cột của từ điển dữ liệu đều có mặt đúng một lần (trường mới thêm vào từ điển tự hiện).
//  2. Chi phí điều trị là nhóm riêng, không lặp lại trong Bảng phân tích theo lượt.
//  3. Đếm số dòng có giá trị đúng theo file CSV; file đổi thì đếm lại, không dùng số cũ.
//  4. Chưa có kho vẫn trả đủ danh sách trường, không có số đếm.
// Chạy: node scripts/research_field_catalog_test.js

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dict = require('../server/research/data_dictionary');
const { TREATMENT_COST_COLUMNS } = require('../server/research/billing_summary');
const { buildFieldCatalog } = require('../server/research/field_catalog');

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

const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'research_field_catalog_test_'));
const writeCsv = (file, header, rows) => fs.writeFileSync(path.join(runDir, file), '﻿' + [header.join(','), ...rows.map(r => r.join(','))].join('\n') + '\n');

test('mọi cột trong từ điển có mặt đúng một lần', () => {
  const catalog = buildFieldCatalog('');
  const seen = new Map();
  for (const g of catalog.groups) for (const f of g.fields) {
    const key = `${g.table}.${f.name}`;
    seen.set(key, (seen.get(key) || 0) + 1);
  }
  for (const [table, def] of Object.entries(dict.TABLES)) {
    for (const name of Object.keys(def.columns)) assert.strictEqual(seen.get(`${table}.${name}`), 1, `${table}.${name}`);
  }
  const total = Object.values(dict.TABLES).reduce((sum, def) => sum + Object.keys(def.columns).length, 0);
  assert.strictEqual(catalog.total_fields, total);
  assert.ok(catalog.groups.every(g => g.label && !/^[a-z_]+$/.test(g.label)), 'mọi nhóm có tên tiếng Việt');
});

test('chi phí là nhóm riêng, không lặp trong bảng phân tích', () => {
  const catalog = buildFieldCatalog('');
  const cost = catalog.groups.find(g => g.key === 'cost');
  assert.deepStrictEqual(cost.fields.map(f => f.name), [...TREATMENT_COST_COLUMNS]);
  const analysis = catalog.groups.find(g => g.key === 'analysis_ready');
  assert.ok(analysis.fields.every(f => !TREATMENT_COST_COLUMNS.includes(f.name)));
  assert.ok(analysis.fields.some(f => f.name === 'hospital_stay_days'));
});

test('chưa có kho: đủ trường, không có số đếm', () => {
  const catalog = buildFieldCatalog(path.join(runDir, 'khong_co'));
  assert.ok(catalog.total_fields > 0);
  assert.strictEqual(catalog.filled_fields, 0);
  for (const g of catalog.groups) {
    assert.strictEqual(g.has_file, false);
    assert.ok(g.fields.every(f => f.filled === undefined));
  }
});

test('đếm số dòng có giá trị theo file, đếm lại khi file đổi', () => {
  writeCsv('patients.csv', ['patient_code', 'sex', 'address'], [['BN1', 'Nam', ''], ['BN2', '', ''], ['BN3', 'Nữ', '']]);
  let g = buildFieldCatalog(runDir).groups.find(x => x.key === 'patients');
  assert.strictEqual(g.has_file, true);
  assert.strictEqual(g.rows, 3);
  const byName = name => g.fields.find(f => f.name === name);
  assert.strictEqual(byName('patient_code').filled, 3);
  assert.strictEqual(byName('sex').filled, 2);
  assert.strictEqual(byName('address').filled, 0);
  assert.strictEqual(byName('birth_date').filled, 0, 'cột chưa có trong file tính là 0');
  assert.strictEqual(byName('address').use, 'excluded');

  writeCsv('patients.csv', ['patient_code', 'sex', 'address'], [['BN1', 'Nam', 'x'], ['BN2', 'Nữ', ''], ['BN3', 'Nữ', ''], ['BN4', 'Nam', '']]);
  const future = new Date(Date.now() + 5000);
  fs.utimesSync(path.join(runDir, 'patients.csv'), future, future);
  g = buildFieldCatalog(runDir).groups.find(x => x.key === 'patients');
  assert.strictEqual(g.rows, 4);
  assert.strictEqual(g.fields.find(f => f.name === 'sex').filled, 4);
  assert.strictEqual(g.fields.find(f => f.name === 'address').filled, 1);
});

test('chi phí đếm từ analysis_ready', () => {
  const col = TREATMENT_COST_COLUMNS[0];
  writeCsv('analysis_ready.csv', ['research_code', 'encounter_id', col], [['NC0001', 'enc_a', '1000'], ['NC0002', 'enc_b', '']]);
  const catalog = buildFieldCatalog(runDir);
  const cost = catalog.groups.find(x => x.key === 'cost');
  assert.strictEqual(cost.rows, 2);
  assert.strictEqual(cost.fields.find(f => f.name === col).filled, 1);
  assert.ok(catalog.filled_fields >= 3);
});

fs.rmSync(runDir, { recursive: true, force: true });
console.log(`research_field_catalog_test: ${passed} ok`);
