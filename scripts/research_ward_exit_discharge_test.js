#!/usr/bin/env node
'use strict';

// Giờ ra một khoa không được lấy làm giờ ra viện của đợt (ca thật: đợt 19/08 10:11 → 22/08 13:00 hiện
// thành 19/08 → 20/08 12:11 = lúc chuyển khỏi khoa Gây mê, y lệnh 21–22/08 rơi ra ngoài đợt).
// Chạy: node scripts/research_ward_exit_discharge_test.js

const assert = require('assert');
const { combineEncounterSources, dischargeBeforeAdmission } = require('../server/research/source_merge');

let passed = 0;
function test(name, fn) {
  try { fn(); passed += 1; console.log(`  ok - ${name}`); } catch (err) {
    console.error(`  FAIL - ${name}`); console.error(err); process.exitCode = 1;
  }
}

test('trang ra viện ghi ra trước vào (theo khoa) không dùng làm giờ ra', () => {
  assert.strictEqual(dischargeBeforeAdmission({ 'Ngày vào viện': '15:10 20/08/2026', 'Ngày ra viện': '12:11 20/08/2026' }), true);
  assert.strictEqual(dischargeBeforeAdmission({ 'Ngày vào viện': '10:11 19/08/2026', 'Ngày ra viện': '13:00 22/08/2026' }), false);
  assert.strictEqual(dischargeBeforeAdmission({ 'Ngày vào viện': '20/08/2026', 'Ngày ra viện': '20/08/2026' }), false);
});

test('y lệnh của chính lần nằm viện sau giờ ra một khoa → đợt kéo tới ngày y lệnh cuối', () => {
  const rows = combineEncounterSources({
    initialRows: [
      { 'Mã BN': 'BN990002', 'T/G vào': '10:11 19/08/2026', 'Ngày ra viện': '12:11 20/08/2026', 'Research key': 'RK2' },
      { 'Mã BN': 'BN990002', 'T/G vào': '15:10 20/08/2026', 'Research key': 'RK3' },
    ],
    hchanhProfileRows: [{ 'Mã BN': 'BN990002', 'Research key': 'RK2', 'Ngày vào viện': '10:11 19/08/2026', 'Ngày ra viện': '12:11 20/08/2026' }],
    hchanhDischargeRows: [{ 'Mã BN': 'BN990002', 'Research key': 'RK2', 'Ngày vào viện': '15:10 20/08/2026', 'Ngày ra viện': '12:11 20/08/2026' }],
    stayEvidenceRows: [
      { 'Mã BN': 'BN990002', 'Research key': 'RK2', 'Ngày vào viện': '10:11 19/08/2026', 'Ngày ra viện': '12:11 20/08/2026', 'TG y lệnh': '10:17 19/08/2026' },
      { 'Mã BN': 'BN990002', 'Research key': 'RK2', 'Ngày vào viện': '10:11 19/08/2026', 'Ngày ra viện': '12:11 20/08/2026', 'TG y lệnh': '07:57 22/08/2026' },
    ],
  });
  const stays = rows.filter(r => r['Mã BN'] === 'BN990002');
  assert.strictEqual(stays.length, 1);
  assert.match(String(stays[0]['Ngày ra viện']), /2026-08-22|22\/08\/2026/);
});

test('y lệnh ghi ngày ra viện thật (sau y lệnh) → dùng ngày đó', () => {
  const rows = combineEncounterSources({
    initialRows: [{ 'Mã BN': 'BN990004', 'T/G vào': '10:11 19/08/2026', 'Ngày ra viện': '12:11 20/08/2026', 'Research key': 'RK5' }],
    hchanhProfileRows: [{ 'Mã BN': 'BN990004', 'Research key': 'RK5', 'Ngày vào viện': '10:11 19/08/2026', 'Ngày ra viện': '12:11 20/08/2026' }],
    stayEvidenceRows: [
      { 'Mã BN': 'BN990004', 'Research key': 'RK9', 'Ngày vào viện': '10:11 19/08/2026', 'Ngày ra viện': '13:00 22/08/2026', 'TG y lệnh': '07:57 22/08/2026' },
    ],
  });
  const stays = rows.filter(r => r['Mã BN'] === 'BN990004');
  assert.strictEqual(stays.length, 1);
  assert.strictEqual(stays[0]['Ngày ra viện'], '13:00 22/08/2026');
});

test('y lệnh nằm trong đợt không đổi giờ ra viện đã xác minh', () => {
  const rows = combineEncounterSources({
    initialRows: [{ 'Mã BN': 'BN990003', 'T/G vào': '08:00 01/03/2026', 'Ngày ra viện': '10:00 05/03/2026', 'Research key': 'RK4' }],
    hchanhProfileRows: [{ 'Mã BN': 'BN990003', 'Research key': 'RK4', 'Ngày vào viện': '08:00 01/03/2026', 'Ngày ra viện': '10:00 05/03/2026' }],
    stayEvidenceRows: [{ 'Mã BN': 'BN990003', 'Research key': 'RK4', 'Ngày vào viện': '08:00 01/03/2026', 'Ngày ra viện': '23/03/2026', 'TG y lệnh': '07:00 05/03/2026' }],
  });
  const stays = rows.filter(r => r['Mã BN'] === 'BN990003');
  assert.strictEqual(stays.length, 1);
  assert.match(String(stays[0]['Ngày ra viện']), /^(?:10:00 05\/03\/2026|2026-03-05 10:00)$/);
});

test('y lệnh rơi vào đợt sau (cách xa) không nối hai đợt', () => {
  const rows = combineEncounterSources({
    initialRows: [
      { 'Mã BN': 'BN990005', 'T/G vào': '12:12 07/08/2026', 'Ngày ra viện': '13:00 12/08/2026', 'Research key': 'RK6' },
      { 'Mã BN': 'BN990005', 'T/G vào': '10:11 19/08/2026', 'Ngày ra viện': '13:00 22/08/2026', 'Research key': 'RK7' },
    ],
    stayEvidenceRows: [{ 'Mã BN': 'BN990005', 'Research key': 'RK6', 'Ngày vào viện': '12:12 07/08/2026', 'Ngày ra viện': '13:00 12/08/2026', 'TG y lệnh': '07:57 21/08/2026' }],
  });
  assert.strictEqual(rows.filter(r => r['Mã BN'] === 'BN990005').length, 2);
});

console.log(`research_ward_exit_discharge_test: ${passed} test(s) passed`);
if (process.exitCode) process.exit(1);
