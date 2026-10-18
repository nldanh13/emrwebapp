#!/usr/bin/env node
'use strict';

// Dải "Đang chạy" của Kho nghiên cứu: /research/running trả ca đang lấy + lần ghi tiến độ gần
// nhất (giờ sửa file tiến độ), không phải câu thông báo ghi một lần lúc bắt đầu.
// Chạy: node scripts/research_live_progress_test.js

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { readLiveProgress, CASE_TRACE_CURRENT_JSON } = require('../server/research/case_trace');

let passed = 0;
function test(name, fn) {
  try { fn(); passed += 1; console.log(`  ok - ${name}`); } catch (err) { console.error(`  FAIL - ${name}`); console.error(err); process.exitCode = 1; }
}

const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'live_progress_'));
const setMtime = (file, secondsAgo) => { const t = new Date(Date.now() - secondsAgo * 1000); fs.utimesSync(file, t, t); };

test('chưa có gì: null', () => {
  assert.strictEqual(readLiveProgress(runDir), null);
});

test('chọn ca đang chạy MỚI NHẤT giữa vết XN và Hồ sơ/Y lệnh; tuổi theo file tiến độ mới nhất', () => {
  const trace = path.join(runDir, CASE_TRACE_CURRENT_JSON);
  fs.writeFileSync(trace, JSON.stringify({ ma_bn: '1', ho_ten: 'CŨ', index: 3, total: 10, ts: new Date(Date.now() - 3600e3).toISOString(), events: [{ step: 'Mở popup XN' }] }));
  setMtime(trace, 3600);
  const order = path.join(runDir, 'order_history_auto_progress.json');
  fs.writeFileSync(order, JSON.stringify({ k: { status: 'running', ma_bn: '26038748', ho_ten: 'KHƯU THÚY LOAN', started_at: new Date(Date.now() - 5e3).toISOString() } }));
  setMtime(order, 5);
  const p = readLiveProgress(runDir);
  assert.strictEqual(p.ho_ten, 'KHƯU THÚY LOAN');
  assert.strictEqual(p.step, 'Đang lấy Y lệnh');
  const age = (Date.now() - Date.parse(p.updated_at)) / 1000;
  assert.ok(age < 60, `tuổi tiến độ phải theo file mới nhất, thực tế ${age}s`);
});

test('đang chạy tác vụ khác (Quét danh sách): ca XN/CĐHA của lần chạy trước không được hiện là "đang lấy"', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'live_progress_since_'));
  // Python ghi ts theo giờ máy, không có múi giờ.
  const oldTs = new Date(Date.now() - 8 * 86400e3);
  const pad = n => String(n).padStart(2, '0');
  const naive = `${oldTs.getFullYear()}-${pad(oldTs.getMonth() + 1)}-${pad(oldTs.getDate())}T${pad(oldTs.getHours())}:${pad(oldTs.getMinutes())}:${pad(oldTs.getSeconds())}`;
  fs.writeFileSync(path.join(dir, CASE_TRACE_CURRENT_JSON), JSON.stringify({ ma_bn: '26012256', ho_ten: 'CA CŨ', index: 19, total: 1030, ts: naive, events: [{ step: 'Đang tìm người bệnh trên danh sách Hoàn tất' }] }));
  fs.writeFileSync(path.join(dir, 'progress.json'), '{}');
  const since = new Date(Date.now() - 15 * 60e3).toISOString();
  const p = readLiveProgress(dir, { since });
  assert.strictEqual(p.ho_ten, '', 'không hiện ca của lần chạy trước');
  assert.strictEqual(p.total, 0);
  assert.strictEqual(p.step, '');
  assert.ok(p.updated_at, 'vẫn báo giờ ghi tiến độ gần nhất');
  // Đối chứng: ca bắt đầu sau giờ khóa vẫn hiện bình thường.
  fs.writeFileSync(path.join(dir, CASE_TRACE_CURRENT_JSON), JSON.stringify({ ma_bn: '1', ho_ten: 'CA MỚI', index: 2, total: 5, ts: new Date().toISOString(), events: [{ step: 'Mở popup XN' }] }));
  assert.strictEqual(readLiveProgress(dir, { since }).ho_ten, 'CA MỚI');
});

console.log(`\n${passed} test(s) passed.`);
