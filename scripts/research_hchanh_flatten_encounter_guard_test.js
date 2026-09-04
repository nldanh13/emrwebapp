#!/usr/bin/env node
'use strict';

// Kiểm thử flattenHchanhIntoResearchRun (POST /research/archive/import-hchanh):
// dữ liệu discharge/surgery/order_history lấy từ kho Hành chánh (chỉ giữ 1 bản
// mới nhất theo mã BN, không phân biệt đợt nằm viện) chỉ được gộp vào kho
// nghiên cứu nếu được fetch SAU thời điểm nhập khoa hiện tại của đúng mã BN đó
// — tránh gán nhầm dữ liệu một đợt nằm viện cũ vào dữ liệu nghiên cứu, vì dữ
// liệu Nghiên cứu bắt buộc phải đúng (khác với dữ liệu Hành chánh, có thể xóa
// làm lại mỗi ngày). Xem hchanhSharedDataMatchesEncounter trong routes/research.js.
// Chạy: node scripts/research_hchanh_flatten_encounter_guard_test.js

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const RUNTIME_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'research_flatten_guard_test_'));
process.env.EMR_RUNTIME_ROOT = RUNTIME_ROOT;

const express = require('express');
const { write_patient_file, write_index, read_index } = require('../server/hchanh_data_contract');

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
  app.use('/api', require('../server/routes/research'));
  return new Promise(resolve => {
    const server = app.listen(0, () => resolve(server));
  });
}

async function postJson(base, url, body) {
  const res = await fetch(base + url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
  return { status: res.status, json: await res.json().catch(() => ({})) };
}

function backdateFetchedAt(maBn, fileStem, isoTime) {
  const p = path.join(RUNTIME_ROOT, 'hchanh', 'patients', maBn, `${fileStem}.json`);
  const data = JSON.parse(fs.readFileSync(p, 'utf8'));
  data._meta.fetched_at = isoTime;
  fs.writeFileSync(p, JSON.stringify(data, null, 2));
}

function readCsvRows(csvPath) {
  if (!fs.existsSync(csvPath)) return [];
  const text = fs.readFileSync(csvPath, 'utf8').replace(/^﻿/, '');
  const lines = text.split('\n').filter(l => l.trim().length);
  if (lines.length < 2) return [];
  const headers = lines[0].split(',').map(h => h.replace(/^"|"$/g, ''));
  return lines.slice(1).map(line => {
    const cells = line.split(',').map(c => c.replace(/^"|"$/g, ''));
    const row = {};
    headers.forEach((h, i) => { row[h] = cells[i]; });
    return row;
  });
}

async function main() {
  console.log('research_hchanh_flatten_encounter_guard_test');
  const ctxLike = { dir: RUNTIME_ROOT, sid: 'default' };

  // Ca 1: dữ liệu Hành chánh FRESH (fetch sau khi nhập khoa hiện tại) -> phải được gộp.
  const MA_BN_FRESH = 'FLATFRESH01';
  write_patient_file(ctxLike, MA_BN_FRESH, 'discharge', { chan_doan_ra: 'Viêm phổi', so_luu_tru: '111' });
  backdateFetchedAt(MA_BN_FRESH, 'ra_vien', '2026-09-05T08:00:00.000Z');

  // Ca 2: dữ liệu Hành chánh CŨ HƠN thời điểm nhập khoa hiện tại (thuộc đợt trước)
  // -> phải bị loại, không gộp nhầm vào kho nghiên cứu.
  const MA_BN_STALE = 'FLATSTALE01';
  write_patient_file(ctxLike, MA_BN_STALE, 'discharge', { chan_doan_ra: 'DU LIEU DOT CU', so_luu_tru: '999' });
  backdateFetchedAt(MA_BN_STALE, 'ra_vien', '2026-01-01T07:00:00.000Z');

  let index = read_index(ctxLike);
  index.patients[MA_BN_FRESH] = { ma_bn: MA_BN_FRESH, ho_ten: 'Nguyen Van Fresh', admission_time: '2026-09-01T00:00:00.000Z', active: true };
  index.patients[MA_BN_STALE] = { ma_bn: MA_BN_STALE, ho_ten: 'Nguyen Van Stale', admission_time: '2026-09-01T00:00:00.000Z', active: true };
  write_index(ctxLike, index);

  const server = await startApp();
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}/api`;
  const runId = 'test_run_001';

  await test('Gộp Hành chánh vào Nghiên cứu: chỉ nhận dữ liệu đúng đợt, loại dữ liệu đợt cũ', async () => {
    const res = await postJson(base, '/research/archive/import-hchanh', { runId });
    assert.strictEqual(res.status, 200, JSON.stringify(res.json));
    assert.strictEqual(res.json.imported.discharge, 1, 'chỉ 1/2 ca (FRESH) được gộp vào hchanh_discharge.csv');

    const csvPath = path.join(RUNTIME_ROOT, 'research', 'research_store', 'du_lieu_goc', 'runs', runId, 'hchanh_discharge.csv');
    const rows = readCsvRows(csvPath);
    assert.strictEqual(rows.length, 1, 'CSV chỉ có đúng 1 dòng discharge');
    assert.strictEqual(rows[0]['Mã BN'], MA_BN_FRESH, 'dòng còn lại phải là ca FRESH');
    assert.ok(!rows.some(r => r['Mã BN'] === MA_BN_STALE), 'không được có dữ liệu đợt cũ của ca STALE trong kho nghiên cứu');
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
