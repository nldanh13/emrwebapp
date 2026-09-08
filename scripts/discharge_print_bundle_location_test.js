#!/usr/bin/env node
'use strict';

// Kiểm thử: file PDF tổng hợp in ra viện (GET /hchanh/discharge-bundle/:fileName)
// giờ được ghi/đọc trong .runtime/print_bundles thay vì <ROOT_DIR>/in (thư mục
// nằm ngoài kho dữ liệu runtime, không được kiểm kê/dọn dẹp/backup cùng chỗ với
// phần còn lại — xem discharge_print_bundle_dir() trong server/routes/hchanh.js).
// Chạy: node scripts/discharge_print_bundle_location_test.js

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const RUNTIME_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'discharge_print_bundle_test_'));
process.env.EMR_RUNTIME_ROOT = RUNTIME_ROOT;

const express = require('express');

let passed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ok - ${name}`);
  } catch (err) {
    console.error(`  FAIL - ${name}`);
    console.error(err);
    process.exitCode = 1;
  }
}

function startApp() {
  const app = express();
  app.use(express.json());
  app.use('/api', require('../server/routes/hchanh'));
  return new Promise(resolve => {
    const server = app.listen(0, () => resolve(server));
  });
}

async function main() {
  console.log('discharge_print_bundle_location_test');

  const server = await startApp();
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}/api`;

  await test('chưa có file -> 404', async () => {
    const res = await fetch(`${base}/hchanh/discharge-bundle/khong_ton_tai.pdf`);
    assert.strictEqual(res.status, 404);
  });

  await test('file đã ghi ở .runtime/print_bundles -> tải được, đúng content-type', async () => {
    const printDir = path.join(RUNTIME_ROOT, 'print_bundles');
    fs.mkdirSync(printDir, { recursive: true });
    fs.writeFileSync(path.join(printDir, 'test_bundle.pdf'), '%PDF-1.4 fake content');

    const res = await fetch(`${base}/hchanh/discharge-bundle/test_bundle.pdf`);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.headers.get('content-type'), 'application/pdf');
    const body = await res.text();
    assert.ok(body.includes('fake content'));
  });

  await test('tên file có ".." bị basename bỏ phần thư mục -> 404, không dò ra ngoài thư mục cho phép', async () => {
    const res = await fetch(`${base}/hchanh/discharge-bundle/${encodeURIComponent('../../etc/passwd.pdf')}`);
    assert.strictEqual(res.status, 404);
  });

  server.close();
  fs.rmSync(RUNTIME_ROOT, { recursive: true, force: true });

  console.log(`\n${passed} kịch bản pass.`);
  if (process.exitCode) {
    console.error('CÓ KỊCH BẢN FAIL.');
    process.exit(1);
  }
}

main();
