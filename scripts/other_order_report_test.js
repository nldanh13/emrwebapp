#!/usr/bin/env node
'use strict';

// Báo cáo "Y lệnh khác": máy chủ trả nguyên văn ô Y lệnh khác của từng phiếu trong
// ngày (y_lenh_khac_goc), gộp đủ các phiếu, bỏ trùng, xếp theo giờ phiếu.
// Worker: tests/test_other_order_report.py. Giao diện: src/components/report/otherOrderReport.test.js.
// Chạy: node scripts/other_order_report_test.js

const assert = require('assert');
const { buildPatientDayBundle } = require('../server/utils/patient_helpers/bundle');

const a = { ma_bn: 'X1', ngay_lam: '07/11/2026', y_lenh_khac_goc: [
  { gio_y_lenh: '14:30', bac_si: 'BS B', noi_dung: 'Chụp X-quang kiểm tra sau mổ' },
] };
const b = { ma_bn: 'X1', ngay_lam: '07/11/2026', y_lenh_khac_goc: [
  { gio_y_lenh: '08:00', bac_si: 'BS A', noi_dung: 'Nhịn ăn chuẩn bị mổ' },
  { gio_y_lenh: '14:30', bac_si: 'BS B', noi_dung: 'Chụp X-quang kiểm tra sau mổ' },
  { gio_y_lenh: '09:00', bac_si: 'BS A', noi_dung: '  ' },
] };
const bundle = buildPatientDayBundle([a, b], 'X1', '07/11/2026', {});
assert.deepStrictEqual(bundle.y_lenh_khac_goc, [
  { gio_y_lenh: '08:00', bac_si: 'BS A', noi_dung: 'Nhịn ăn chuẩn bị mổ' },
  { gio_y_lenh: '14:30', bac_si: 'BS B', noi_dung: 'Chụp X-quang kiểm tra sau mổ' },
]);

// Dữ liệu cũ chưa xử lý lại: không có trường này thì trả mảng rỗng, không lỗi.
assert.deepStrictEqual(buildPatientDayBundle([{ ma_bn: 'X2', ngay_lam: '07/11/2026' }], 'X2', '07/11/2026', {}).y_lenh_khac_goc, []);

console.log('other_order_report_test: OK');
