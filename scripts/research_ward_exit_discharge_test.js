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

test('hồ sơ ghi giờ vào của đợt sau cho đợt trước: đợt trước vẫn tách riêng, không nhuộm đợt sau', () => {
  // Ca thật: 4 dòng hồ sơ (kể cả của đợt 07/08) đều ghi vào 10:11 19/08 (trang hồ sơ mở đợt mới nhất);
  // trang ra viện của đợt 07/08 đúng: 07/08 12:12 → 12/08 13:00. Trước đây khoảng "đã xác minh" thành
  // 19/08 → 12/08, đợt 07/08 biến mất và khoa / chẩn đoán của nó dính sang đợt 19/08.
  const rows = combineEncounterSources({
    initialRows: [
      { 'Mã BN': 'BN990006', 'T/G vào': '12:12 07/08/2026', 'Khoa': 'Cấp cứu', 'Research key': 'S1' },
      { 'Mã BN': 'BN990006', 'T/G vào': '13:52 10/08/2026', 'Khoa': 'Gây mê', 'Research key': 'S2' },
      { 'Mã BN': 'BN990006', 'T/G vào': '10:11 19/08/2026', 'Khoa': 'Khám bệnh', 'Research key': 'S3' },
    ],
    hchanhProfileRows: [
      { 'Mã BN': 'BN990006', 'Research key': 'H1', 'Ngày vào viện': '10:11 19/08/2026', 'Ngày ra viện': '13:00 22/08/2026' },
      { 'Mã BN': 'BN990006', 'Research key': 'H3', 'Ngày vào viện': '10:11 19/08/2026', 'Ngày ra viện': '13:00 22/08/2026' },
    ],
    hchanhDischargeRows: [
      { 'Mã BN': 'BN990006', 'Research key': 'H1', 'Ngày vào viện': '12:12 07/08/2026', 'Ngày ra viện': '13:00 12/08/2026', 'Chẩn đoán ra viện': 'S42.20' },
      { 'Mã BN': 'BN990006', 'Research key': 'H3', 'Ngày vào viện': '15:10 20/08/2026', 'Ngày ra viện': '12:11 20/08/2026', 'Chẩn đoán ra viện': 'Z09.4' },
    ],
  });
  const full = rows.filter(r => r['Mã BN'] === 'BN990006');
  const stays = full.map(r => [String(r['Ngày vào viện'] || r['T/G vào']), String(r['Ngày ra viện'] || '')]);
  assert.strictEqual(stays.length, 2, JSON.stringify(stays));
  assert.match(stays[0][0], /07\/08\/2026|2026-08-07/);
  assert.match(stays[0][1], /12\/08\/2026|2026-08-12/);
  assert.match(stays[1][0], /19\/08\/2026|2026-08-19/);
  assert.match(stays[1][1], /22\/08\/2026|2026-08-22/);
  assert.notStrictEqual(full[1]['Chẩn đoán ra viện'], 'S42.20', 'chẩn đoán đợt 07/08 không dính sang đợt 19/08');
  assert.notStrictEqual(full[1]['Khoa'], 'Cấp cứu', 'khoa đợt 07/08 không dính sang đợt 19/08');
  assert.strictEqual(full[0]['Chẩn đoán ra viện'], 'S42.20');
});

// Ca thật (BN đã ẩn): đợt nhiễm trùng 14/01 → 28/01 (A41) hiện chẩn đoán ra "M81.8 loãng xương" của đợt
// 06/07 → 08/07. Trang ra viện lấy cho lượt tháng 01 mang giờ vào 14/01 của lượt yêu cầu nhưng ngày ra
// 08/07 và chẩn đoán của đợt tháng 07; trước đây dòng đó ghép theo giờ vào vào đợt tháng 01.
test('trang ra viện mang giờ vào đợt trước nhưng ngày ra + chẩn đoán đợt sau → về đợt sau', () => {
  const BN = 'BN990010';
  const src = [['S7', '08:38 06/07/2026'], ['S22', '21:10 22/01/2026'], ['S19', '20:40 19/01/2026'], ['S15', '18:52 15/01/2026'], ['S14', '09:00 14/01/2026']];
  const initialRows = src.map(([k, t]) => ({ 'Mã BN': BN, 'Research key': k, 'T/G vào': t }));
  const jan = ['O1', 'O2', 'O3', 'O4'];
  const julOther = ['P5', 'P6', 'P7', 'P8', 'P9', 'P10', 'P11', 'P12'];
  const hchanhProfileRows = [
    ...jan.map(k => ({ 'Mã BN': BN, 'Research key': k, 'Ngày vào viện': '09:00 14-01-2026', 'Ngày ra viện': '13:00 28-01-2026', 'Chẩn đoán': 'Nhiễm trùng khác (A41)' })),
    ...[...julOther, 'S22', 'S19', 'S15', 'S7', 'S14'].map(k => ({ 'Mã BN': BN, 'Research key': k, 'Ngày vào viện': '08:38 06-07-2026', 'Ngày ra viện': '13:00 08-07-2026', 'Chẩn đoán': 'Loãng xương tự phát (M81.5)' })),
  ];
  const janT = ['21:10 22/01/2026', '20:40 19/01/2026', '18:52 15/01/2026', '09:00 14/01/2026'];
  const mixT = [...janT, '21:10 22/01/2026', '20:40 19/01/2026', '09:00 14/01/2026'];
  const M818 = 'M81.8- Các bệnh loãng xương khác';
  const hchanhDischargeRows = [
    ...jan.map((k, i) => ({ 'Mã BN': BN, 'Research key': k, 'Ngày vào viện': janT[i], 'Ngày ra viện': '2026-06-08', 'Chẩn đoán ra viện': 'A41- Nhiễm trùng khác' })),
    ...julOther.slice(0, 7).map((k, i) => ({ 'Mã BN': BN, 'Research key': k, 'Ngày vào viện': mixT[i], 'Ngày ra viện': '13:00 08/07/2026', 'Chẩn đoán ra viện': M818 })),
    ...['P12', 'S22', 'S19', 'S15', 'S7', 'S14'].map(k => ({ 'Mã BN': BN, 'Research key': k, 'Ngày vào viện': '08:38 06-07-2026', 'Ngày ra viện': '13:00 08/07/2026', 'Chẩn đoán ra viện': M818 })),
  ];
  const rows = combineEncounterSources({ initialRows, hchanhProfileRows, hchanhDischargeRows }).filter(r => r['Mã BN'] === BN);
  assert.strictEqual(rows.length, 2, JSON.stringify(rows.map(r => r['Ngày vào viện'])));
  const [janStay, julStay] = rows;
  assert.match(String(janStay['Ngày vào viện']), /2026-01-14|14\/01\/2026/);
  assert.strictEqual(janStay['Chẩn đoán ra viện'], 'A41- Nhiễm trùng khác', 'đợt nhiễm trùng không mang chẩn đoán loãng xương');
  assert.match(String(julStay['Ngày vào viện']), /2026-07-06|06\/07\/2026/);
  assert.strictEqual(julStay['Chẩn đoán ra viện'], M818);
});

console.log(`research_ward_exit_discharge_test: ${passed} test(s) passed`);
if (process.exitCode) process.exit(1);
