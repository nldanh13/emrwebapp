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

  // Ca 3: profile (thông tin nền) CŨ HƠN đợt hiện tại -> cũng phải bị loại,
  // không chỉ discharge/surgery/order_history (lỗ hổng đã sửa: trước đây
  // profile được gộp vô điều kiện, không qua hchanhSharedDataMatchesEncounter).
  const MA_BN_STALE_PROFILE = 'FLATSTALEPF01';
  write_patient_file(ctxLike, MA_BN_STALE_PROFILE, 'profile', { chan_doan_vao: 'CHAN DOAN DOT CU', ho_ten: 'Nguyen Van StaleProfile' });
  backdateFetchedAt(MA_BN_STALE_PROFILE, 'thong_tin_nen', '2026-01-01T07:00:00.000Z');

  // Một profile FRESH để hchanh_profile.csv thực sự được ghi ra (nếu không có
  // dòng nào hợp lệ thì file không tồn tại, khiến bài test ở dưới luôn pass
  // giả vì đọc file không tồn tại trả về mảng rỗng).
  const MA_BN_FRESH_PROFILE = 'FLATFRESHPF01';
  write_patient_file(ctxLike, MA_BN_FRESH_PROFILE, 'profile', { chan_doan_vao: 'CHAN DOAN DOT MOI', ho_ten: 'Nguyen Van FreshProfile' });
  backdateFetchedAt(MA_BN_FRESH_PROFILE, 'thong_tin_nen', '2026-09-05T08:00:00.000Z');

  // Ca 4: dữ liệu thiếu _meta.fetched_at (không có mốc để so sánh) -> phải bị
  // loại thay vì mặc định coi là khớp (lỗ hổng đã sửa: hàm cũ fail-open, trả
  // "khớp" khi thiếu mốc — chính là loại dữ liệu legacy dễ bị cũ nhất).
  const MA_BN_NO_META = 'FLATNOMETA01';
  write_patient_file(ctxLike, MA_BN_NO_META, 'discharge', { chan_doan_ra: 'THIEU MOC THOI GIAN', so_luu_tru: '777' });
  const noMetaPath = path.join(RUNTIME_ROOT, 'hchanh', 'patients', MA_BN_NO_META, 'ra_vien.json');
  const noMetaData = JSON.parse(fs.readFileSync(noMetaPath, 'utf8'));
  delete noMetaData._meta.fetched_at;
  fs.writeFileSync(noMetaPath, JSON.stringify(noMetaData, null, 2));

  // Ca 5: profile đóng dấu ĐÚNG admission_time của đợt (qua tham số mới của
  // write_patient_file) nhưng fetched_at lại SỚM HƠN admission_time (chênh
  // lệch múi giờ/độ trễ giữa các mốc ghi nhận) -> heuristic cũ (fetchedAt >=
  // admissionAt) sẽ loại nhầm dữ liệu ĐÚNG đợt này. So khớp trực tiếp theo
  // admission_time đã đóng dấu phải nhận dữ liệu này thay vì loại oan.
  const MA_BN_STAMPED = 'FLATSTAMPED01';
  const STAMPED_ADMISSION = '2026-09-01T00:00:00.000Z';
  write_patient_file(ctxLike, MA_BN_STAMPED, 'profile', { chan_doan_vao: 'CHAN DOAN DUNG DOT', ho_ten: 'Nguyen Van Stamped' }, STAMPED_ADMISSION);
  backdateFetchedAt(MA_BN_STAMPED, 'thong_tin_nen', '2026-08-31T23:00:00.000Z'); // trước admission_time

  let index = read_index(ctxLike);
  index.patients[MA_BN_FRESH] = { ma_bn: MA_BN_FRESH, ho_ten: 'Nguyen Van Fresh', admission_time: '2026-09-01T00:00:00.000Z', active: true };
  index.patients[MA_BN_STALE] = { ma_bn: MA_BN_STALE, ho_ten: 'Nguyen Van Stale', admission_time: '2026-09-01T00:00:00.000Z', active: true };
  index.patients[MA_BN_STALE_PROFILE] = { ma_bn: MA_BN_STALE_PROFILE, ho_ten: 'Nguyen Van StaleProfile', admission_time: '2026-09-01T00:00:00.000Z', active: true };
  index.patients[MA_BN_FRESH_PROFILE] = { ma_bn: MA_BN_FRESH_PROFILE, ho_ten: 'Nguyen Van FreshProfile', admission_time: '2026-09-01T00:00:00.000Z', active: true };
  index.patients[MA_BN_NO_META] = { ma_bn: MA_BN_NO_META, ho_ten: 'Nguyen Van NoMeta', admission_time: '2026-09-01T00:00:00.000Z', active: true };
  // Cùng đợt (admission_time hiện tại của Hành chánh khớp đúng mốc đã đóng dấu
  // lúc fetch) — chỉ khác là fetched_at kỹ thuật sớm hơn admission_time.
  index.patients[MA_BN_STAMPED] = { ma_bn: MA_BN_STAMPED, ho_ten: 'Nguyen Van Stamped', admission_time: STAMPED_ADMISSION, active: true };
  write_index(ctxLike, index);

  const server = await startApp();
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}/api`;
  const runId = 'test_run_001';

  await test('Gộp Hành chánh vào Nghiên cứu: chỉ nhận dữ liệu đúng đợt, loại dữ liệu đợt cũ', async () => {
    const res = await postJson(base, '/research/archive/import-hchanh', { runId });
    assert.strictEqual(res.status, 200, JSON.stringify(res.json));
    assert.strictEqual(res.json.imported.discharge, 1, 'chỉ 1/2 ca discharge (FRESH) được gộp, STALE và NO_META bị loại');

    const csvPath = path.join(RUNTIME_ROOT, 'research', 'research_store', 'du_lieu_goc', 'runs', runId, 'hchanh_discharge.csv');
    const rows = readCsvRows(csvPath);
    assert.strictEqual(rows.length, 1, 'CSV chỉ có đúng 1 dòng discharge');
    assert.strictEqual(rows[0]['Mã BN'], MA_BN_FRESH, 'dòng còn lại phải là ca FRESH');
    assert.ok(!rows.some(r => r['Mã BN'] === MA_BN_STALE), 'không được có dữ liệu đợt cũ của ca STALE trong kho nghiên cứu');
    assert.ok(!rows.some(r => r['Mã BN'] === MA_BN_NO_META), 'thiếu _meta.fetched_at phải bị loại, không được mặc định coi là khớp đợt');
  });

  await test('Profile (thông tin nền) đợt cũ cũng bị loại như discharge/surgery/order_history', async () => {
    const csvPath = path.join(RUNTIME_ROOT, 'research', 'research_store', 'du_lieu_goc', 'runs', runId, 'hchanh_profile.csv');
    const rows = readCsvRows(csvPath);
    assert.ok(rows.length > 0, 'hchanh_profile.csv phải có ít nhất dòng FRESH, không được rỗng/không tồn tại');
    assert.ok(rows.some(r => r['Mã BN'] === MA_BN_FRESH_PROFILE), 'phải giữ lại profile đúng đợt (FRESH)');
    assert.ok(!rows.some(r => r['Mã BN'] === MA_BN_STALE_PROFILE), 'profile đợt cũ (FLATSTALEPF01) không được lọt vào kho nghiên cứu');
  });

  await test('So khớp theo admission_time đã đóng dấu nhận đúng dữ liệu dù fetched_at kỹ thuật sớm hơn admission_time', async () => {
    const csvPath = path.join(RUNTIME_ROOT, 'research', 'research_store', 'du_lieu_goc', 'runs', runId, 'hchanh_profile.csv');
    const rows = readCsvRows(csvPath);
    assert.ok(rows.some(r => r['Mã BN'] === MA_BN_STAMPED), 'phải nhận dữ liệu đóng dấu đúng admission_time dù fetched_at < admission_time (heuristic cũ sẽ loại oan ca này)');
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
