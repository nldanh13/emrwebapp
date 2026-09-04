#!/usr/bin/env node
'use strict';

// Kiểm thử: Kiểm hồ sơ tái sử dụng discharge/cls đã có sẵn trong kho Hành
// chánh (cùng mã BN, cùng worker hchanh_fetch.py) thay vì tự quét lại EMR lần
// nữa — và không nhận nhầm dữ liệu Hành chánh thuộc một đợt nằm viện khác
// (kho Hành chánh chỉ giữ 1 bản mới nhất theo mã BN, không phân biệt đợt).
// Xem hchanh_data_contract.js + reuseSharedHchanhDataForRecordsCheck trong
// server/routes/hchanh.js.
// Chạy: node scripts/records_check_shared_data_reuse_test.js

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const RUNTIME_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'records_check_reuse_test_'));
process.env.EMR_RUNTIME_ROOT = RUNTIME_ROOT;

const express = require('express');
const { write_patient_file } = require('../server/hchanh_data_contract');

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

async function getJson(base, url) {
  const res = await fetch(base + url);
  return { status: res.status, json: await res.json().catch(() => ({})) };
}

function seedRecordsCheckIndex(caseKey, meta) {
  const dir = path.join(RUNTIME_ROOT, 'records_check');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'records_check_index.json'), JSON.stringify({
    patients: { [caseKey]: meta },
    checked: {}, checked_aliases: {}, checklist: {}, checklist_aliases: {},
  }, null, 2));
}

function backdateHchanhFetchedAt(maBn, fileStem, isoTime) {
  const p = path.join(RUNTIME_ROOT, 'hchanh', 'patients', maBn, `${fileStem}.json`);
  const data = JSON.parse(fs.readFileSync(p, 'utf8'));
  data._meta.fetched_at = isoTime;
  fs.writeFileSync(p, JSON.stringify(data, null, 2));
}

async function main() {
  console.log('records_check_shared_data_reuse_test');
  const server = await startApp();
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}/api`;

  await test('Hành chánh đã có discharge/cls cho đúng mã BN -> Kiểm hồ sơ tái sử dụng, không cần quét lại', async () => {
    const MA_BN = 'REUSE001';
    const ctxLike = { dir: RUNTIME_ROOT, sid: 'default' };
    write_patient_file(ctxLike, MA_BN, 'discharge', { so_luu_tru: '12345', raw_time: '01/09/2026 07:30' });
    write_patient_file(ctxLike, MA_BN, 'cls', { rows: [], _fetch_status: 'empty' });
    backdateHchanhFetchedAt(MA_BN, 'ra_vien', '2026-09-01T08:00:00.000Z');
    backdateHchanhFetchedAt(MA_BN, 'xem_ket_qua_cdha', '2026-09-01T08:00:00.000Z');

    const CASE_KEY = `${MA_BN}::abc123`;
    seedRecordsCheckIndex(CASE_KEY, {
      ma_bn: MA_BN, case_key: CASE_KEY, ho_ten: 'Nguyen Van Reuse', active: true,
      discharge_time: '2026-09-01T07:30:00.000Z', // trước thời điểm Hành chánh fetch -> hợp lệ để dùng lại
      fetched: {}, checked: false,
    });

    const start = await postJson(base, '/hchanh/records-check/fetch-batch', { case_keys: [CASE_KEY] });
    assert.strictEqual(start.status, 200);

    let card = null;
    for (let i = 0; i < 20; i++) {
      await new Promise(r => setTimeout(r, 100));
      const dash = await getJson(base, '/hchanh/records-check/dashboard');
      card = (dash.json.patients || []).find(p => p.case_key === CASE_KEY || p.storage_key === CASE_KEY);
      if (card?.discharge && card?.cls) break;
    }

    assert.strictEqual(card?.discharge?.so_luu_tru, '12345', 'card phải hiển thị discharge đã tái sử dụng từ Hành chánh');
    assert.ok(card?.cls, 'card phải hiển thị cls đã tái sử dụng từ Hành chánh');
    const ownDischargePath = path.join(RUNTIME_ROOT, 'records_check', 'patients', CASE_KEY.replace(/[^a-zA-Z0-9._-]/g, '_'), 'ra_vien.json');
    assert.ok(fs.existsSync(ownDischargePath), 'phải đông cứng thành bản riêng của Kiểm hồ sơ (không phụ thuộc kho Hành chánh bị ghi đè sau này)');
  });

  await test('Hành chánh có dữ liệu CŨ HƠN thời điểm ra viện của đợt đang kiểm -> không dùng, tránh lẫn đợt khác', async () => {
    const MA_BN = 'STALE001';
    const ctxLike = { dir: RUNTIME_ROOT, sid: 'default' };
    write_patient_file(ctxLike, MA_BN, 'discharge', { so_luu_tru: '99999', raw_time: '01/01/2026 07:30' });
    backdateHchanhFetchedAt(MA_BN, 'ra_vien', '2026-01-01T07:30:00.000Z');

    const CASE_KEY = `${MA_BN}::xyz789`;
    seedRecordsCheckIndex(CASE_KEY, {
      ma_bn: MA_BN, case_key: CASE_KEY, ho_ten: 'Nguyen Van Stale', active: true,
      discharge_time: '2026-09-01T07:30:00.000Z', // đợt hiện tại ra viện SAU lần Hành chánh fetch cũ -> không đáng tin
      fetched: {}, checked: false,
    });

    const dashBefore = await getJson(base, '/hchanh/records-check/dashboard');
    const cardBefore = (dashBefore.json.patients || []).find(p => p.case_key === CASE_KEY || p.storage_key === CASE_KEY);
    assert.notStrictEqual(cardBefore?.discharge?.so_luu_tru, '99999', 'không được hiển thị nhầm dữ liệu đợt cũ khi vừa render dashboard');

    await postJson(base, '/hchanh/records-check/fetch-batch', { case_keys: [CASE_KEY] });
    await new Promise(r => setTimeout(r, 800));

    const ownDischargePath = path.join(RUNTIME_ROOT, 'records_check', 'patients', CASE_KEY.replace(/[^a-zA-Z0-9._-]/g, '_'), 'ra_vien.json');
    const persisted = fs.existsSync(ownDischargePath) ? JSON.parse(fs.readFileSync(ownDischargePath, 'utf8')) : null;
    assert.notStrictEqual(persisted?.so_luu_tru, '99999', 'không được đông cứng nhầm dữ liệu đợt cũ vào kho riêng của Kiểm hồ sơ');
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
