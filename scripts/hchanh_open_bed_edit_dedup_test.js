#!/usr/bin/env node
'use strict';

// Kiểm thử: POST /hchanh/open-bed-edit không cho mở 2 cửa sổ sửa giường cùng
// lúc cho CÙNG một mã BN (bấm trùng nút, 2 tab) — trả 409 khi tiến trình
// trước còn đang chạy, và cho mở lại bình thường sau khi tiến trình đó đã
// thoát (child.on('exit') dọn guard). Route này cố ý không dùng enqueueHeavy
// (xem comment trong server/routes/hchanh.js) nên cần guard riêng.
// Chạy: node scripts/hchanh_open_bed_edit_dedup_test.js

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const RUNTIME_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'open_bed_edit_dedup_test_'));
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

async function postJson(base, url, body) {
  const res = await fetch(base + url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
  return { status: res.status, json: await res.json().catch(() => ({})) };
}

async function main() {
  console.log('hchanh_open_bed_edit_dedup_test');
  const server = await startApp();
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}/api`;

  const MA_BN = 'BEDEDIT01';

  const first = await postJson(base, '/hchanh/open-bed-edit', { ma_bn: MA_BN });

  await test('lần mở đầu tiên -> ok, spawn tiến trình', () => {
    assert.strictEqual(first.status, 200);
    assert.strictEqual(first.json.status, 'ok');
  });

  const second = await postJson(base, '/hchanh/open-bed-edit', { ma_bn: MA_BN });

  await test('mở trùng khi cửa sổ trước chưa đóng -> 409, không spawn thêm', () => {
    assert.strictEqual(second.status, 409);
    assert.strictEqual(second.json.status, 'error');
  });

  const otherPatient = await postJson(base, '/hchanh/open-bed-edit', { ma_bn: 'BEDEDIT02' });

  await test('mã BN khác vẫn mở được bình thường, không bị chặn chéo', () => {
    assert.strictEqual(otherPatient.status, 200);
  });

  // Tiến trình Python thật trong sandbox này không có Chrome driver nên sẽ
  // thoát khá nhanh (lỗi NoSuchDriverException) -> guard sẽ tự dọn.
  let reopened = null;
  for (let i = 0; i < 30; i++) {
    await new Promise(r => setTimeout(r, 500));
    reopened = await postJson(base, '/hchanh/open-bed-edit', { ma_bn: MA_BN });
    if (reopened.status === 200) break;
  }

  await test('sau khi tiến trình cũ đã thoát -> mở lại được cho cùng mã BN', () => {
    assert.strictEqual(reopened?.status, 200);
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
