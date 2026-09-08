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
const { write_patient_file, read_index, write_index } = require('../server/hchanh_data_contract');

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

  await test('Hành chánh đang ở đợt TÁI NHẬP VIỆN mới hơn cho cùng mã BN -> không dùng dữ liệu dùng chung dù fetch sau discharge của đợt đang kiểm', async () => {
    const MA_BN = 'READMIT02';
    const ctxLike = { dir: RUNTIME_ROOT, sid: 'default' };
    // Dữ liệu dùng chung được Hành chánh fetch SAU discharge của đợt đang kiểm
    // (qua được kiểm tra cũ), nhưng thực chất thuộc đợt tái nhập viện mới hơn.
    write_patient_file(ctxLike, MA_BN, 'discharge', { so_luu_tru: '55555', raw_time: '10/09/2026 08:00' });
    backdateHchanhFetchedAt(MA_BN, 'ra_vien', '2026-09-10T08:00:00.000Z');

    // Hành chánh hiện coi đợt ĐANG active của mã BN này có admission_time mới
    // hơn admission_time của đợt Kiểm hồ sơ đang xem bên dưới.
    const index = read_index(ctxLike);
    index.patients[MA_BN] = { ma_bn: MA_BN, admission_time: '2026-09-08T00:00:00.000Z', active: true };
    write_index(ctxLike, index);

    const CASE_KEY = `${MA_BN}::old-admission`;
    seedRecordsCheckIndex(CASE_KEY, {
      ma_bn: MA_BN, case_key: CASE_KEY, ho_ten: 'Nguyen Van Readmit', active: true,
      admission_time: '2026-09-01T00:00:00.000Z', // đợt CŨ hơn đợt Hành chánh đang active
      discharge_time: '2026-09-03T07:30:00.000Z', // sớm hơn cả fetched_at ở trên -> lọt qua guard cũ
      fetched: {}, checked: false,
    });

    await postJson(base, '/hchanh/records-check/fetch-batch', { case_keys: [CASE_KEY] });
    await new Promise(r => setTimeout(r, 800));

    const ownDischargePath = path.join(RUNTIME_ROOT, 'records_check', 'patients', CASE_KEY.replace(/[^a-zA-Z0-9._-]/g, '_'), 'ra_vien.json');
    const persisted = fs.existsSync(ownDischargePath) ? JSON.parse(fs.readFileSync(ownDischargePath, 'utf8')) : null;
    assert.notStrictEqual(persisted?.so_luu_tru, '55555', 'không được đông cứng nhầm dữ liệu của đợt tái nhập viện mới hơn vào đợt cũ đang kiểm');
  });

  await test('Bản dùng chung đóng dấu ĐÚNG đợt vẫn dùng được dù Hành chánh sau đó đã chuyển sang đợt mới hơn', async () => {
    const MA_BN = 'RESTAMP01';
    const ctxLike = { dir: RUNTIME_ROOT, sid: 'default' };
    const ADMISSION_A = '2026-09-01T00:00:00.000Z';
    const ADMISSION_B = '2026-09-10T00:00:00.000Z'; // đợt tái nhập viện sau đó

    // Hành chánh ghi dữ liệu trong lúc đợt A đang active -> đóng dấu đúng admission_time.
    write_patient_file(ctxLike, MA_BN, 'discharge', { so_luu_tru: '77777', raw_time: '02/09/2026 07:30' }, ADMISSION_A);

    // Sau đó Hành chánh chuyển sang coi đợt B là hiện tại cho cùng mã BN (chưa
    // ai ghi đè lại file discharge, nó vẫn là dữ liệu hợp lệ của đợt A).
    const index = read_index(ctxLike);
    index.patients[MA_BN] = { ma_bn: MA_BN, admission_time: ADMISSION_B, active: true };
    write_index(ctxLike, index);

    // Kiểm hồ sơ đang xem đúng đợt A.
    const CASE_KEY = `${MA_BN}::admission-a`;
    seedRecordsCheckIndex(CASE_KEY, {
      ma_bn: MA_BN, case_key: CASE_KEY, ho_ten: 'Nguyen Van Restamp', active: true,
      admission_time: ADMISSION_A,
      discharge_time: '2026-09-03T00:00:00.000Z',
      fetched: {}, checked: false,
    });

    const dash = await getJson(base, '/hchanh/records-check/dashboard');
    const card = (dash.json.patients || []).find(p => p.case_key === CASE_KEY || p.storage_key === CASE_KEY);
    assert.strictEqual(card?.discharge?.so_luu_tru, '77777', 'phải dùng lại được dữ liệu đóng dấu đúng đợt A dù Hành chánh đã chuyển sang đợt B');
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
