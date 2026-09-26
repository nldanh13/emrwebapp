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

const TEST_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'discharge_sign_bundle_test_'));
// Như bản cài thật (.runtime/): thư mục chấm không được làm hỏng việc tải file.
const RUNTIME_ROOT = path.join(TEST_ROOT, '.runtime');
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

  const upload = (body) => fetch(`${base}/hchanh/upload-discharge-pdf`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const pdfDataUrl = (text) => `data:application/pdf;base64,${Buffer.from(text).toString('base64')}`;

  await test('upload: không phải .pdf -> 400', async () => {
    const res = await upload({ file_name: 'phieu.docx', pdf_data_url: pdfDataUrl('%PDF-1.4 x') });
    assert.strictEqual(res.status, 400);
  });

  await test('upload: nội dung không phải PDF (thiếu %PDF-) -> 400', async () => {
    const res = await upload({ file_name: 'phieu.pdf', pdf_data_url: pdfDataUrl('hello') });
    assert.strictEqual(res.status, 400);
  });

  await test('upload: lưu vào thư mục in với tiền tố TAILEN, giữ dấu tiếng Việt, liệt kê là file tải lên', async () => {
    const res = await upload({ file_name: 'Phiếu ra viện (Trần Thị B).pdf', pdf_data_url: pdfDataUrl('%PDF-1.4 uploaded') });
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.file_name, 'IN_RA_VIEN_TAILEN_Phiếu_ra_viện_Trần_Thị_B.pdf');
    assert.strictEqual(fs.readFileSync(path.join(printDir, body.file_name), 'utf8'), '%PDF-1.4 uploaded');

    const list = await (await fetch(`${base}/hchanh/discharge-bundles`)).json();
    const item = list.bundles.find(b => b.file_name === body.file_name);
    assert.ok(item);
    assert.strictEqual(item.uploaded, true);
    assert.strictEqual(item.ma_bn, '');
    assert.strictEqual(item.ho_ten, 'Phiếu ra viện Trần Thị B');
    assert.strictEqual(list.bundles.find(b => b.ma_bn === '26089161').uploaded, false);
  });

  await test('upload: tải lại cùng tên -> ghi đè và bỏ bản đã ký cũ; tên file có đường dẫn bị cắt', async () => {
    const signedOld = path.join(printDir, 'IN_RA_VIEN_TAILEN_mau_DA_KY.pdf');
    fs.writeFileSync(path.join(printDir, 'IN_RA_VIEN_TAILEN_mau.pdf'), '%PDF-1.4 old');
    fs.writeFileSync(signedOld, '%PDF-1.4 old-signed');
    const res = await upload({ file_name: '../../x/mau_DA_KY.pdf', pdf_data_url: pdfDataUrl('%PDF-1.4 new') });
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.file_name, 'IN_RA_VIEN_TAILEN_mau.pdf');
    assert.strictEqual(fs.readFileSync(path.join(printDir, body.file_name), 'utf8'), '%PDF-1.4 new');
    assert.strictEqual(fs.existsSync(signedOld), false);
  });

  await test('download: tải được file trong thư mục in dù nằm dưới .runtime/', async () => {
    const res = await fetch(`${base}/hchanh/discharge-bundle/${encodeURIComponent('IN_RA_VIEN_TAILEN_mau.pdf')}`);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(await res.text(), '%PDF-1.4 new');
  });

  await test('list: trả tổng dung lượng thư mục in (kể cả bản đã ký)', async () => {
    const body = await (await fetch(`${base}/hchanh/discharge-bundles`)).json();
    const expected = fs.readdirSync(printDir).filter(n => /^IN_RA_VIEN_.+\.pdf$/i.test(n))
      .reduce((sum, n) => sum + fs.statSync(path.join(printDir, n)).size, 0);
    assert.strictEqual(body.total_bytes, expected);
  });

  await test('delete: xoá file gốc kèm bản đã ký; tên _DA_KY hoặc sai dạng -> 400; không có -> 404', async () => {
    const del = name => fetch(`${base}/hchanh/discharge-bundle/${encodeURIComponent(name)}`, { method: 'DELETE' });
    assert.strictEqual((await del('IN_RA_VIEN_99000001_Nguyễn_Văn_A_DA_KY.pdf')).status, 400);
    assert.strictEqual((await del('khac.pdf')).status, 400);
    assert.strictEqual((await del('IN_RA_VIEN_00000000_Khong_Co.pdf')).status, 404);
    const res = await del('IN_RA_VIEN_99000001_Nguyễn_Văn_A.pdf');
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.removed, 2);
    assert.ok(body.freed_bytes > 0);
    assert.ok(!fs.existsSync(path.join(printDir, 'IN_RA_VIEN_99000001_Nguyễn_Văn_A.pdf')));
    assert.ok(!fs.existsSync(path.join(printDir, 'IN_RA_VIEN_99000001_Nguyễn_Văn_A_DA_KY.pdf')));
  });

  await test('cleanup: chỉ xoá bộ phiếu cũ hơn N ngày (kèm bản đã ký), giữ file mới và file lạ', async () => {
    const old = new Date(Date.now() - 40 * 24 * 3600 * 1000);
    for (const n of ['IN_RA_VIEN_1_Cu.pdf', 'IN_RA_VIEN_1_Cu_DA_KY.pdf', 'ghi_chu.pdf']) {
      fs.writeFileSync(path.join(printDir, n), '%PDF-1.4 old');
      fs.utimesSync(path.join(printDir, n), old, old);
    }
    const post = body => fetch(`${base}/hchanh/discharge-bundles/cleanup`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    assert.strictEqual((await post({ older_than_days: 0 })).status, 400);
    const res = await post({ older_than_days: 30 });
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.bundles, 1);
    assert.strictEqual(body.removed, 2);
    assert.ok(!fs.existsSync(path.join(printDir, 'IN_RA_VIEN_1_Cu.pdf')));
    assert.ok(!fs.existsSync(path.join(printDir, 'IN_RA_VIEN_1_Cu_DA_KY.pdf')));
    assert.ok(fs.existsSync(path.join(printDir, 'ghi_chu.pdf')));
    assert.ok(fs.existsSync(path.join(printDir, 'IN_RA_VIEN_26089161_Lê_Quân_Em.pdf')));
  });

  await test('authz: xoá/dọn bộ phiếu cần quyền giám sát', async () => {
    const { requiredRoleForRequest } = require('../server/services/authz');
    assert.strictEqual(requiredRoleForRequest({ method: 'DELETE', path: '/hchanh/discharge-bundle/IN_RA_VIEN_1_A.pdf' }), 'supervisor');
    assert.strictEqual(requiredRoleForRequest({ method: 'POST', path: '/hchanh/discharge-bundles/cleanup' }), 'supervisor');
    assert.strictEqual(requiredRoleForRequest({ method: 'GET', path: '/hchanh/discharge-bundle/IN_RA_VIEN_1_A.pdf' }), 'viewer');
  });

  server.close();
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });

  console.log(`\n${passed} kịch bản pass.`);
  if (process.exitCode) {
    console.error('CÓ KỊCH BẢN FAIL.');
    process.exit(1);
  }
}

main();
