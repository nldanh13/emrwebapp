#!/usr/bin/env node
'use strict';

// Mở/quay lại tab Hành chánh luôn gọi đồng bộ danh sách. Trước đây đồng bộ LUÔN ghi lại
// hchanh/index.json (dù danh sách không đổi) → máy chủ báo màn hình "đã đổi" → dựng lại cả bảng
// thêm một lần. Kiểm: danh sách không đổi thì không ghi file; có đổi thì vẫn ghi.
// Chạy: node scripts/hchanh_sync_no_change_test.js

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { sync_index_from_patients, hchanh_index_path, read_index } = require('../server/hchanh_data_contract');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hchanh_sync_test_'));
const ctx = { dir, sid: 's1' };
const rows = [
  { ma_bn: '100', ho_ten: 'NGUYỄN VĂN A', so_phong: 'P1', thoi_gian_vao_khoa: '2026-10-01 08:00', ten_khoa_dieu_tri: 'Nội' },
  { ma_bn: '200', ho_ten: 'TRẦN THỊ B', so_phong: 'P2', thoi_gian_vao_khoa: '2026-10-02 09:00', ten_khoa_dieu_tri: 'Nội', xu_tri: 'Ra viện' },
];

try {
  sync_index_from_patients(ctx, rows);
  const file = hchanh_index_path(ctx);
  const first = fs.readFileSync(file, 'utf8');
  const firstMtime = fs.statSync(file).mtimeMs;

  // Đồng bộ lại cùng danh sách (lần mở tab sau): không ghi file.
  const again = sync_index_from_patients(ctx, rows);
  assert.strictEqual(fs.readFileSync(file, 'utf8'), first, 'danh sách không đổi thì không ghi lại index');
  assert.strictEqual(fs.statSync(file).mtimeMs, firstMtime);
  assert.strictEqual(Object.keys(again.patients).length, 2);
  assert.ok(again.updatedAt, 'vẫn trả index có updatedAt');
  console.log('  ✓ đồng bộ lại cùng danh sách không ghi file');

  // Có đổi (đổi phòng) thì ghi.
  sync_index_from_patients(ctx, [{ ...rows[0], so_phong: 'P9' }, rows[1]]);
  assert.strictEqual(read_index(ctx).patients['100'].phong, 'P9');
  console.log('  ✓ đổi phòng thì ghi file');

  // Người bệnh rời danh sách thì ghi (đánh dấu stale).
  sync_index_from_patients(ctx, [rows[1]]);
  assert.strictEqual(read_index(ctx).patients['100'].active, false);
  console.log('  ✓ người bệnh rời danh sách thì ghi file');
  console.log('hchanh_sync_no_change_test: ok');
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
