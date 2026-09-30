#!/usr/bin/env node
'use strict';

// Kiểm tra bộ đọc CSV theo khối (server/research/csv_reader.js):
//  1. Kết quả giống parseCsv cũ: BOM, CRLF, ô trích dẫn có dấu phẩy/xuống dòng/"" ,
//     dòng trống bị bỏ, dòng thiếu/thừa ô, tiêu đề trống, tiếng Việt, dòng cuối không có \n.
//  2. Dòng vắt qua ranh giới khối 4 MB vẫn đọc đúng.
//  3. maxRows: chỉ tạo đủ số object cần, nhưng count vẫn là tổng số dòng thật.
//  4. Đếm dòng file lớn (countCsvRows) không nạp cả file vào heap: đây là nguyên nhân
//     server hết RAM (heap 2 GB) khi dashboard đếm lại các file XN/CĐHA vài trăm MB.
// Chạy: node --expose-gc scripts/research_csv_reader_test.js

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { readCsvFileRows } = require('../server/research/csv_reader');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'research_csv_reader_test_'));
let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ok - ${name}`);
  } catch (err) {
    console.error(`  FAIL - ${name}`);
    console.error(err.stack || err.message || err);
    process.exitCode = 1;
  }
}
function write(name, text) {
  const file = path.join(dir, name);
  fs.writeFileSync(file, text);
  return file;
}

test('BOM, CRLF và cột tiếng Việt', () => {
  const r = readCsvFileRows(write('a.csv', '﻿Tên XN,Kết quả\r\nHuyết sắc tố (Hb),135\r\nCreatinin máu, 88 \r\n'), 100);
  assert.deepStrictEqual(r.columns, ['Tên XN', 'Kết quả']);
  assert.deepStrictEqual(r.rows, [
    { 'Tên XN': 'Huyết sắc tố (Hb)', 'Kết quả': '135' },
    { 'Tên XN': 'Creatinin máu', 'Kết quả': '88' },
  ]);
  assert.strictEqual(r.count, 2);
  assert.strictEqual(r.limited, false);
});

test('Ô trích dẫn có dấu phẩy, xuống dòng và ""', () => {
  const r = readCsvFileRows(write('q.csv', 'a,b\n"x, y","say ""hi"""\n"multi\nline",z\n'), 100);
  assert.deepStrictEqual(r.rows, [{ a: 'x, y', b: 'say "hi"' }, { a: 'multi\nline', b: 'z' }]);
});

test('Bỏ dòng trống, dòng thiếu/thừa ô, tiêu đề trống, dòng cuối không có \\n', () => {
  const r = readCsvFileRows(write('b.csv', ',b,\n\n1\n , \n"",""\n1,2,3,4\n5,6,7'), 100);
  assert.deepStrictEqual(r.columns, ['Cột 1', 'b', 'Cột 3']);
  assert.deepStrictEqual(r.rows, [
    { 'Cột 1': '1', b: '', 'Cột 3': '' },
    { 'Cột 1': '1', b: '2', 'Cột 3': '3' },
    { 'Cột 1': '5', b: '6', 'Cột 3': '7' },
  ]);
  assert.strictEqual(r.count, 3);
});

test('Số âm và kết quả "+"/"-" ghi ra rồi đọc lại giữ nguyên; file cũ có dấu \' được sửa khi đọc', () => {
  const { rowsToCsvRaw, rowsToCsv } = require('../server/utils/csv');
  const cols = ['result_num', 'days_from_discharge', 'result_raw', 'note'];
  const rows = [{ result_num: '-3.5', days_from_discharge: '-6', result_raw: '+', note: '=SUM(A1)' }];
  const file = write('neg.csv', `\ufeff${rowsToCsvRaw(cols, rows)}`);
  assert.deepStrictEqual(readCsvFileRows(file, 10).rows, rows);
  // File ghi bằng bản cũ (qua bộ chặn công thức) vẫn đọc ra đúng giá trị gốc.
  const legacy = write('legacy.csv', `\ufeff${rowsToCsv(cols, rows)}`);
  assert.ok(fs.readFileSync(legacy, 'utf8').includes("'-3.5"), 'bộ chặn công thức vẫn dùng cho file tải về');
  assert.deepStrictEqual(readCsvFileRows(legacy, 10).rows, rows);
  // Giá trị có dấu ' nhưng không theo sau bởi = + - @ thì giữ nguyên.
  assert.deepStrictEqual(readCsvFileRows(write('q2.csv', "a\n'abc\n"), 10).rows, [{ a: "'abc" }]);
});

test('File rỗng hoặc chỉ có tiêu đề', () => {
  assert.deepStrictEqual(readCsvFileRows(write('e.csv', ''), 10), { columns: [], rows: [], count: 0, limited: false });
  const h = readCsvFileRows(write('h.csv', 'a,b\n'), 10);
  assert.deepStrictEqual(h.columns, ['a', 'b']);
  assert.strictEqual(h.rows.length, 0);
});

// File ~12 MB: nhiều dòng vắt qua ranh giới khối 4 MB, có ô trích dẫn chứa \n.
const bigRows = 120000;
const bigFile = path.join(dir, 'big.csv');
{
  const parts = ['﻿id,ten,ket_qua,ghi_chu\n'];
  for (let i = 0; i < bigRows; i += 1) {
    parts.push(`${i},Xét nghiệm ${i % 7},"${(i * 0.37).toFixed(2)}","dòng ${i}${i % 1000 === 0 ? '\nnối' : ''}, có phẩy"\n`);
  }
  fs.writeFileSync(bigFile, parts.join(''));
}

test('Dòng vắt qua ranh giới khối vẫn đọc đúng từng ô', () => {
  const r = readCsvFileRows(bigFile, Number.MAX_SAFE_INTEGER);
  assert.strictEqual(r.rows.length, bigRows);
  assert.strictEqual(r.count, bigRows);
  for (const i of [0, 1, 999, 1000, 40000, 77777, bigRows - 1]) {
    assert.deepStrictEqual(r.rows[i], {
      id: String(i),
      ten: `Xét nghiệm ${i % 7}`,
      ket_qua: (i * 0.37).toFixed(2),
      ghi_chu: `dòng ${i}${i % 1000 === 0 ? '\nnối' : ''}, có phẩy`,
    });
  }
});

test('maxRows chỉ tạo đủ object cần, count vẫn là tổng số dòng', () => {
  const r = readCsvFileRows(bigFile, 50);
  assert.strictEqual(r.rows.length, 50);
  assert.strictEqual(r.count, bigRows);
  assert.strictEqual(r.limited, true);
  const onlyCount = readCsvFileRows(bigFile, 0);
  assert.strictEqual(onlyCount.rows.length, 0);
  assert.strictEqual(onlyCount.count, bigRows);
});

test('Đếm dòng file lớn không làm heap tăng theo kích thước file', () => {
  // Đo heap chỉ tin cậy khi ép GC được (node --expose-gc, như trong test:ci).
  if (typeof global.gc !== 'function') { console.log('    (bỏ qua đo heap: chạy với node --expose-gc)'); return; }
  global.gc();
  const before = process.memoryUsage().heapUsed;
  for (let i = 0; i < 3; i += 1) assert.strictEqual(readCsvFileRows(bigFile, 0).count, bigRows);
  global.gc();
  const grown = process.memoryUsage().heapUsed - before;
  const fileBytes = fs.statSync(bigFile).size;
  assert.ok(grown < fileBytes / 2, `heap tăng ${grown} byte khi đếm file ${fileBytes} byte`);
});

fs.rmSync(dir, { recursive: true, force: true });
console.log(`\n${passed} kịch bản pass.`);
