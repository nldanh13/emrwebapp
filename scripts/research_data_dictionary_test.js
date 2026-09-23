#!/usr/bin/env node
'use strict';

// Kiểm tra từ điển dữ liệu (server/research/data_dictionary.js) không lệch với code:
//  1. Mỗi bảng chuẩn hóa có trong từ điển, cột khớp ĐÚNG thứ tự NORMALIZED_COLUMNS.
//  2. Mỗi cột có đủ thông tin: kiểu, ý nghĩa, phân loại định danh, phạm vi dùng hợp lệ.
//  3. Phân loại "excluded" khớp đúng quy tắc che khi xuất (export_utils.isSensitiveColumn):
//     cột bị che thì phải là excluded và ngược lại.
//  4. Mỗi bảng có mô tả dòng, khóa chính nằm trong danh sách cột, khóa nối trỏ tới bảng có thật.
//  5. docs/DATA_DICTIONARY.md đã được sinh lại từ bản từ điển hiện tại.
// Chạy: node scripts/research_data_dictionary_test.js

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

process.env.EMR_RUNTIME_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'research_dictionary_test_'));

const { NORMALIZED_COLUMNS } = require('../server/routes/research');
const dict = require('../server/research/data_dictionary');
const { isSensitiveColumn } = require('../server/research/export_utils');

const TYPES = new Set(['string', 'text', 'integer', 'decimal', 'date', 'datetime', 'flag01', 'enum', 'json']);
const IDENTIFIERS = new Set(['direct', 'quasi', 'free_text', 'staff', 'pseudonymous', 'none']);
const USES = new Set(['allowed', 'approval_required', 'excluded']);

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ok - ${name}`);
  } catch (err) {
    console.error(`  FAIL - ${name}`);
    console.error(err.message || err);
    process.exitCode = 1;
  }
}

test('Mọi bảng chuẩn hóa có trong từ điển, cột khớp đúng thứ tự file CSV', () => {
  for (const [table, columns] of Object.entries(NORMALIZED_COLUMNS)) {
    const entry = dict.TABLES[table];
    assert.ok(entry, `Thiếu bảng ${table} trong từ điển`);
    assert.deepStrictEqual(Object.keys(entry.columns), columns, `Cột bảng ${table} lệch với NORMALIZED_COLUMNS`);
  }
  for (const table of Object.keys(dict.TABLES)) {
    assert.ok(NORMALIZED_COLUMNS[table], `Từ điển có bảng ${table} không còn trong code`);
  }
});

test('Mỗi cột có kiểu, ý nghĩa, phân loại định danh và phạm vi dùng hợp lệ', () => {
  for (const [table, entry] of Object.entries(dict.TABLES)) {
    for (const [name, c] of Object.entries(entry.columns)) {
      const where = `${table}.${name}`;
      assert.ok(TYPES.has(c.type), `${where}: kiểu không hợp lệ ${c.type}`);
      assert.ok(String(c.meaning || '').trim(), `${where}: thiếu ý nghĩa`);
      assert.ok(IDENTIFIERS.has(c.identifier), `${where}: identifier không hợp lệ ${c.identifier}`);
      assert.ok(USES.has(c.use), `${where}: use không hợp lệ ${c.use}`);
      if (c.type === 'flag01') assert.deepStrictEqual(c.allowed, ['1', '0'], `${where}: cờ phải là 1/0`);
      if (c.type === 'enum') assert.ok(c.allowed, `${where}: danh mục phải liệt kê giá trị cho phép`);
      if (c.identifier === 'direct') assert.strictEqual(c.use, 'excluded', `${where}: định danh trực tiếp phải bị loại`);
    }
  }
});

test('Phân loại "excluded" khớp đúng quy tắc che khi xuất', () => {
  for (const [table, entry] of Object.entries(dict.TABLES)) {
    for (const [name, c] of Object.entries(entry.columns)) {
      const redacted = isSensitiveColumn(name);
      assert.strictEqual(redacted, c.use === 'excluded',
        `${table}.${name}: từ điển ghi use=${c.use} nhưng khi xuất ${redacted ? 'BỊ che' : 'KHÔNG bị che'}`);
    }
  }
});

test('Mỗi bảng có mô tả dòng, khóa chính hợp lệ, khóa nối trỏ tới bảng có thật', () => {
  for (const [table, entry] of Object.entries(dict.TABLES)) {
    assert.ok(String(entry.grain || '').trim(), `${table}: thiếu "mỗi dòng là"`);
    assert.ok(entry.primary_key?.length, `${table}: thiếu khóa chính`);
    for (const key of entry.primary_key) assert.ok(entry.columns[key], `${table}: khóa chính ${key} không có trong cột`);
    for (const fk of entry.foreign_keys || []) {
      for (const colName of fk.columns) assert.ok(entry.columns[colName], `${table}: khóa nối ${colName} không có trong cột`);
      const [refTable, refCol] = fk.references.split('.');
      assert.ok(dict.TABLES[refTable]?.columns?.[refCol], `${table}: khóa nối trỏ tới ${fk.references} không tồn tại`);
    }
    assert.ok(entry.sources?.length && entry.processing, `${table}: thiếu nguồn/cách xử lý`);
    assert.ok(entry.quality?.required?.length, `${table}: thiếu trường bắt buộc`);
  }
});

test('docs/DATA_DICTIONARY.md đã được sinh lại từ từ điển hiện tại', () => {
  execFileSync(process.execPath, [path.join(__dirname, 'build_data_dictionary.js'), '--check'], { stdio: 'pipe' });
});

console.log(`\n${passed} kịch bản pass.`);
