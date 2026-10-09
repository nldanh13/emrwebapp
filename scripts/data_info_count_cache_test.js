#!/usr/bin/env node
'use strict';

// /api/data-info được gọi mỗi lần mở Lấy dữ liệu và Bệnh phòng. Trước đây mỗi lần gọi đều đọc và
// giải mã cả file y lệnh (final/processed — thường lớn nhất) chỉ để đếm số dòng. Kiểm: file không
// đổi thì lần gọi sau không giải mã lại; file đổi thì số đếm cập nhật.
// Chạy: node scripts/data_info_count_cache_test.js

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const RUNTIME_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'data_info_count_cache_test_'));
process.env.EMR_RUNTIME_ROOT = RUNTIME_ROOT;

const express = require('express');
const { buildRuntimePathsForSid } = require('../server/services/session');

const MARKER = 'Y_LENH_DANH_DAU';

async function main() {
  const ctx = buildRuntimePathsForSid('default');
  fs.mkdirSync(path.dirname(ctx.FINAL_PATH), { recursive: true });
  const rows = n => Array.from({ length: n }, (_, i) => ({ ma_bn: String(i), y_lenh: MARKER }));
  fs.writeFileSync(ctx.FINAL_PATH, JSON.stringify(rows(5)));

  const app = express();
  app.use('/api', require('../server/routes/board'));
  const server = await new Promise(resolve => { const s = app.listen(0, () => resolve(s)); });
  const url = `http://127.0.0.1:${server.address().port}/api/data-info`;

  const originalParse = JSON.parse;
  let parses = 0;
  JSON.parse = function countingParse(text, ...rest) {
    if (typeof text === 'string' && text.includes(MARKER) && !text.includes('"final"')) parses += 1;
    return originalParse.call(this, text, ...rest);
  };
  try {
    const first = await (await fetch(url)).json();
    assert.strictEqual(first.final.count, 5);
    const afterFirst = parses;
    const second = await (await fetch(url)).json();
    assert.strictEqual(second.final.count, 5);
    assert.strictEqual(parses, afterFirst, 'file không đổi thì không giải mã lại');
    console.log('  ✓ file không đổi thì không đọc lại để đếm');

    fs.writeFileSync(ctx.FINAL_PATH, JSON.stringify(rows(7)));
    const future = new Date(Date.now() + 5000);
    fs.utimesSync(ctx.FINAL_PATH, future, future);
    const third = await (await fetch(url)).json();
    assert.strictEqual(third.final.count, 7, 'file đổi thì đếm lại');
    console.log('  ✓ file đổi thì đếm lại');
    console.log('data_info_count_cache_test: ok');
  } finally {
    JSON.parse = originalParse;
    server.close();
    fs.rmSync(RUNTIME_ROOT, { recursive: true, force: true });
  }
}

main().catch(err => { console.error(err); process.exit(1); });
