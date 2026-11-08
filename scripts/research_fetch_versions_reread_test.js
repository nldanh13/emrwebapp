'use strict';
// Bản Hồ sơ nền đọc "Phiếu vào viện" lỗi và bản bảng kê đọc nhầm trang (0 dòng) phải được lấy lại
// đúng một lần; bản đã đọc tốt và bản worker mới không bị lấy lại.
const assert = require('assert');
const { hchanhPayloadComplete, hchanhPayloadContentVersion } = require('../server/research/fetch_versions');

// Hồ sơ nền
assert.strictEqual(hchanhPayloadComplete('profile', { _admission_vitals_status: 'error', _admission_vitals_error: 'Message:' }), false);
assert.strictEqual(hchanhPayloadComplete('profile', { _admission_vitals_status: 'ok', mach_vao_vien: '80' }), true);
assert.strictEqual(hchanhPayloadComplete('profile', { _admission_vitals_status: 'empty' }), true);
assert.strictEqual(hchanhPayloadComplete('profile', { _admission_vitals_status: 'no_link', _admission_vitals_read: 2 }), true);
assert.strictEqual(hchanhPayloadComplete('profile', { _admission_vitals_status: 'error', _admission_vitals_read: 2 }), true);
assert.strictEqual(hchanhPayloadContentVersion('profile', { bhyt_code: 'X' }), 1);

// Bảng kê
const summary = { tong_chi_phi: null };
assert.strictEqual(hchanhPayloadComplete('billing', { tong_hop: summary, rows: [] }), false);
assert.strictEqual(hchanhPayloadComplete('billing', { tong_hop: summary, rows: [{ ten: 'Khám' }] }), true);
assert.strictEqual(hchanhPayloadComplete('billing', { tong_hop: summary, rows: [], _billing_page_checked: true }), true);
assert.strictEqual(hchanhPayloadContentVersion('billing', { rows: [] }), 1);

console.log('research_fetch_versions_reread_test: OK');
