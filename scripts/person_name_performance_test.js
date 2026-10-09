#!/usr/bin/env node
'use strict';

// Lọc tên người bệnh chạy trên MỌI phản hồi JSON (patientNameResponseMiddleware). Trước đây mỗi
// khóa của mỗi object bị chuẩn hóa lại (NFD + nhiều regex) nên gói dashboard lớn mất lâu hơn cả
// JSON.stringify. Kiểm: kết quả vẫn đúng, và mỗi tên khóa chỉ chuẩn hóa một lần.
// Chạy: node scripts/person_name_performance_test.js

const assert = require('assert');
const { sanitizePatientNameFields } = require('../server/utils/person_name');

let passed = 0;
function test(name, fn) {
  try { fn(); passed += 1; console.log(`  ✓ ${name}`); }
  catch (err) { console.error(`  ✗ ${name}`); throw err; }
}

test('vẫn bỏ hậu tố phòng ở trường tên, kể cả khóa có dấu/hoa thường', () => {
  const body = {
    patients: [
      { ma_bn: '1', ho_ten: 'ĐOÀN THỊ VÂN - PM: PHÒNG PHẪU THUẬT', ten: 'A - PM: X', ghi_chu: 'B - PM: Y' },
      { 'Họ tên': 'NGUYỄN VĂN B – PM: HỒI SỨC', name: 'không có mã BN - PM: Z' },
    ],
  };
  sanitizePatientNameFields(body);
  assert.strictEqual(body.patients[0].ho_ten, 'ĐOÀN THỊ VÂN');
  assert.strictEqual(body.patients[0].ten, 'A', 'ten cạnh ma_bn là tên người bệnh');
  assert.strictEqual(body.patients[0].ghi_chu, 'B - PM: Y', 'trường khác giữ nguyên');
  assert.strictEqual(body.patients[1]['Họ tên'], 'NGUYỄN VĂN B');
  assert.strictEqual(body.patients[1].name, 'không có mã BN - PM: Z', 'name không cạnh mã BN thì giữ nguyên');
});

test('gói lớn: mỗi tên khóa chỉ chuẩn hóa một lần, không chuẩn hóa lại theo từng dòng', () => {
  const row = i => ({ ngay: '01/01/2026', ten_thuoc: 'Paracetamol 500mg', so_luong: i, don_vi: 'viên', bac_si: 'BS A', khoa: 'Nội', ghi_chu: 'x', ma: `P${i}`, thanh_tien: 2000 });
  const body = {
    status: 'ok',
    patients: Array.from({ length: 50 }, (_, p) => ({
      ma_bn: String(p), ho_ten: 'NGUYỄN VĂN A - PM: PHÒNG',
      order_history: { rows: Array.from({ length: 400 }, (_, i) => row(i)) },
    })),
  };
  // Đếm số lần chuẩn hóa Unicode (bước tốn nhất của chuẩn hóa tên khóa) — đo đếm, không đo giờ,
  // để test không chập chờn theo tải máy.
  const original = String.prototype.normalize;
  let calls = 0;
  String.prototype.normalize = function countNormalize(...args) { calls += 1; return original.apply(this, args); };
  try { sanitizePatientNameFields(body); }
  finally { String.prototype.normalize = original; }
  assert.strictEqual(body.patients[49].ho_ten, 'NGUYỄN VĂN A');
  // 20.000 dòng × 9 khóa; số khóa khác nhau chỉ khoảng 15.
  assert.ok(calls < 100, `chuẩn hóa ${calls} lần cho khoảng 15 tên khóa khác nhau`);
});

console.log(`person_name_performance_test: ${passed} test đạt`);
