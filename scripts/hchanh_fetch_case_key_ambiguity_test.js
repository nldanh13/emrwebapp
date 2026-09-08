#!/usr/bin/env node
'use strict';

// Kiểm thử: POST /api/hchanh/fetch với records_check=true nhưng KHÔNG có
// case_key phải từ chối (400) khi mã BN có nhiều hơn 1 dòng kiểm hồ sơ đang
// hoạt động (tái nhập viện), thay vì tự chọn đại một dòng — trước đây
// Object.values(rcIndex.patients).find(meta => meta.ma_bn === ma_bn) lấy
// dòng đầu tiên gặp được, có thể lấy nhầm dữ liệu của đợt nhập viện khác.
// Xem router.post('/hchanh/fetch', ...) trong server/routes/hchanh.js.
// Chạy: node scripts/hchanh_fetch_case_key_ambiguity_test.js

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const RUNTIME_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'hchanh_fetch_ambiguity_test_'));
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

function writeRecordsCheckIndex(patients) {
  const dir = path.join(RUNTIME_ROOT, 'records_check');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'records_check_index.json'), JSON.stringify({
    version: '2.0', updatedAt: new Date().toISOString(), lastScan: null,
    patients, checked: {}, checked_aliases: {}, checklist: {}, checklist_aliases: {},
  }, null, 2));
}

async function main() {
  console.log('hchanh_fetch_case_key_ambiguity_test');

  writeRecordsCheckIndex({
    'READMIT01::admission-a': { ma_bn: 'READMIT01', case_key: 'READMIT01::admission-a', active: true, ho_ten: 'Đợt A', scope_default: 'discharge' },
    'READMIT01::admission-b': { ma_bn: 'READMIT01', case_key: 'READMIT01::admission-b', active: true, ho_ten: 'Đợt B', scope_default: 'discharge' },
    'SINGLE01::admission-x': { ma_bn: 'SINGLE01', case_key: 'SINGLE01::admission-x', active: true, ho_ten: 'Ca đơn', scope_default: 'discharge' },
  });

  const server = await startApp();
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}/api`;

  await test('records_check=true không case_key, 2 đợt đang hoạt động cùng mã BN -> từ chối 400, không tự chọn đại', async () => {
    const res = await postJson(base, '/hchanh/fetch', { ma_bn: 'READMIT01', records_check: true });
    assert.strictEqual(res.status, 400, JSON.stringify(res.json));
    assert.ok(/2 dòng kiểm hồ sơ|nhiều lần nhập viện/.test(res.json.message || ''), `message phải giải thích lý do từ chối: ${res.json.message}`);
  });

  await test('records_check=true không case_key, chỉ 1 đợt đang hoạt động -> không bị từ chối vì lý do "nhiều lần nhập viện"', async () => {
    const res = await postJson(base, '/hchanh/fetch', { ma_bn: 'SINGLE01', records_check: true, date_from: '2026-07-20' });
    assert.notStrictEqual(res.status, 400);
    assert.ok(!/nhiều lần nhập viện/.test(res.json.message || ''), `không được bị chặn vì lý do nhập nhằng khi chỉ có 1 đợt: ${res.json.message}`);
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
