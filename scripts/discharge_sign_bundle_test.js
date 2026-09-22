#!/usr/bin/env node
'use strict';

// Kiểm thử: GET /hchanh/discharge-bundles (liệt kê bộ phiếu "IN RA VIỆN" đã in
// sẵn để tab Chữ ký ra viện chọn) và các bước xác thực đầu vào của POST
// /hchanh/sign-discharge-bundle (không đụng tới việc gọi Python thật — xem
// tests/test_sign_discharge_bundle.py để kiểm thử phần chèn chữ ký thật).
// Chạy: node scripts/discharge_sign_bundle_test.js

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const RUNTIME_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'discharge_sign_bundle_test_'));
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
  console.log('discharge_sign_bundle_test');

  const server = await startApp();
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}/api`;
  const printDir = path.join(RUNTIME_ROOT, 'print_bundles');
  fs.mkdirSync(printDir, { recursive: true });

  await test('chưa in gì -> danh sách rỗng', async () => {
    const res = await fetch(`${base}/hchanh/discharge-bundles`);
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.deepStrictEqual(body.bundles, []);
  });

  fs.writeFileSync(path.join(printDir, 'IN_RA_VIEN_26089161_Lê_Quân_Em.pdf'), '%PDF-1.4 fake');
  fs.writeFileSync(path.join(printDir, 'IN_RA_VIEN_99000001_Nguyễn_Văn_A.pdf'), '%PDF-1.4 fake2');
  fs.writeFileSync(path.join(printDir, 'IN_RA_VIEN_99000001_Nguyễn_Văn_A_DA_KY.pdf'), '%PDF-1.4 fake2-signed');

  await test('liệt kê đúng file gốc, tách mã BN/họ tên từ tên file, không liệt kê file _DA_KY riêng', async () => {
    const res = await fetch(`${base}/hchanh/discharge-bundles`);
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.bundles.length, 2);
    const byMaBn = Object.fromEntries(body.bundles.map(b => [b.ma_bn, b]));

    assert.strictEqual(byMaBn['26089161'].ho_ten, 'Lê Quân Em');
    assert.strictEqual(byMaBn['26089161'].signed, false);
    assert.strictEqual(byMaBn['26089161'].signed_file_name, null);
    assert.ok(byMaBn['26089161'].size_bytes > 0);

    assert.strictEqual(byMaBn['99000001'].ho_ten, 'Nguyễn Văn A');
    assert.strictEqual(byMaBn['99000001'].signed, true);
    assert.strictEqual(byMaBn['99000001'].signed_file_name, 'IN_RA_VIEN_99000001_Nguyễn_Văn_A_DA_KY.pdf');
  });

  await test('sign: tên file rỗng -> 400', async () => {
    const res = await fetch(`${base}/hchanh/sign-discharge-bundle`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}),
    });
    assert.strictEqual(res.status, 400);
  });

  await test('sign: tên file không đúng dạng IN_RA_VIEN_*.pdf -> 400', async () => {
    const res = await fetch(`${base}/hchanh/sign-discharge-bundle`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ file_name: 'khong_hop_le.pdf' }),
    });
    assert.strictEqual(res.status, 400);
  });

  await test('sign: đã là file _DA_KY -> 400 (không ký chồng file đã ký)', async () => {
    const res = await fetch(`${base}/hchanh/sign-discharge-bundle`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ file_name: 'IN_RA_VIEN_99000001_Nguyễn_Văn_A_DA_KY.pdf' }),
    });
    assert.strictEqual(res.status, 400);
  });

  await test('sign: file gốc không tồn tại -> 404', async () => {
    const res = await fetch(`${base}/hchanh/sign-discharge-bundle`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ file_name: 'IN_RA_VIEN_00000000_Khong_Ton_Tai.pdf' }),
    });
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
