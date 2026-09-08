#!/usr/bin/env node
'use strict';

// Kiểm thử: records_check_index.json cũ trong sessions/<sid>/hchanh/ (từ trước
// khi có kho cố định records_check/) được tự động migrate sang kho cố định
// đúng 1 lần, và file cũ phải bị xoá sau khi migrate xong (tránh tồn đọng file
// không đồng bộ, chỉ tốn dung lượng — xem read_records_check_index trong
// server/routes/hchanh.js).
// Chạy: node scripts/records_check_legacy_migration_test.js

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const RUNTIME_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'records_check_legacy_migration_test_'));
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

async function getJson(base, url) {
  const res = await fetch(base + url);
  return { status: res.status, json: await res.json().catch(() => ({})) };
}

async function main() {
  console.log('records_check_legacy_migration_test');

  const legacyPath = path.join(RUNTIME_ROOT, 'hchanh', 'records_check_index.json');
  const persistentPath = path.join(RUNTIME_ROOT, 'records_check', 'records_check_index.json');
  fs.mkdirSync(path.dirname(legacyPath), { recursive: true });
  fs.writeFileSync(legacyPath, JSON.stringify({
    version: 1,
    patients: {
      LEGACY001: { ma_bn: 'LEGACY001', case_key: 'LEGACY001::abc', ho_ten: 'Nguyen Van Legacy', active: true },
    },
    checked: {}, checked_aliases: {}, checklist: {}, checklist_aliases: {},
  }, null, 2));

  const server = await startApp();
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}/api`;

  await test('lần đọc đầu tiên: migrate dữ liệu legacy sang kho cố định', async () => {
    const dash = await getJson(base, '/hchanh/records-check/dashboard');
    assert.strictEqual(dash.status, 200);
    assert.ok(fs.existsSync(persistentPath), 'kho cố định phải được tạo từ dữ liệu legacy');
    const persisted = JSON.parse(fs.readFileSync(persistentPath, 'utf8'));
    assert.ok(persisted.patients?.LEGACY001, 'dữ liệu BN từ file legacy phải có mặt trong kho cố định');
  });

  await test('sau khi migrate xong, file legacy phải bị xoá', async () => {
    assert.strictEqual(fs.existsSync(legacyPath), false, 'file legacy còn sót lại sau khi đã migrate là rác tồn đọng vĩnh viễn');
  });

  await test('lần đọc sau vẫn đọc đúng kho cố định dù không còn file legacy', async () => {
    const dash = await getJson(base, '/hchanh/records-check/dashboard');
    assert.strictEqual(dash.status, 200);
    const card = (dash.json.patients || []).find(p => p.ma_bn === 'LEGACY001' || p.case_key === 'LEGACY001::abc');
    assert.ok(card, 'phải vẫn thấy BN đã migrate ở lần đọc sau');
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
