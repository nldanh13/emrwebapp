#!/usr/bin/env node
'use strict';

// Khung tiến độ nói rõ lần chạy gần nhất kết thúc ra sao, và không báo mãi "đã dừng giữa chừng"
// vì một cảnh báo fatal cũ của lần chạy trước đó.
// Chạy: node scripts/research_last_run_status_test.js

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
process.env.EMR_RUNTIME_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'last_run_'));
const ps = require('../server/research/progress_snapshot');

let passed = 0;
function test(name, fn) {
  try { fn(); passed += 1; console.log(`  ok - ${name}`); } catch (err) { console.error(`  FAIL - ${name}`); console.error(err); process.exitCode = 1; }
}

const runDir = path.join(process.env.EMR_RUNTIME_ROOT, 'run1');
fs.mkdirSync(runDir, { recursive: true });
const snap = () => ps.buildResearchProgressSnapshot(runDir, { id: 'archive' }, { isArchive: true });
const writeFatal = (msAgo) => {
  const file = path.join(runDir, 'fatal_alert.json');
  fs.writeFileSync(file, JSON.stringify({ ma_bn: '26033731', ho_ten: 'TRẦN VĂN TỰ' }));
  const t = new Date(Date.now() - msAgo);
  fs.utimesSync(file, t, t);
};

test('lần chạy lỗi: last_task có trạng thái, thời điểm và thông báo lỗi', () => {
  const task = ps.beginResearchTask(runDir, { type: 'collect_auto', label: 'Thu thập tự động' });
  ps.finishResearchTask(runDir, task.id, 'error', { message: 'EMR không phản hồi' });
  const s = snap();
  assert.strictEqual(s.stopped, null);
  assert.strictEqual(s.last_task.status, 'error');
  assert.strictEqual(s.last_task.message, 'EMR không phản hồi');
  assert.ok(s.last_task.finished_at);
});

test('cảnh báo fatal cũ hơn lần chạy gần nhất thì bỏ qua', () => {
  writeFatal(60 * 60 * 1000);
  const task = ps.beginResearchTask(runDir, { type: 'collect_auto', label: 'Thu thập tự động' });
  ps.finishResearchTask(runDir, task.id, 'done', { message: 'Xong' });
  const s = snap();
  assert.strictEqual(s.stopped, null, 'fatal của lần trước không còn đúng');
  assert.strictEqual(s.last_task.status, 'done');
});

test('cảnh báo fatal ghi trong lần chạy gần nhất vẫn báo, kèm ca và thời điểm', () => {
  const task = ps.beginResearchTask(runDir, { type: 'collect_auto', label: 'Thu thập tự động' });
  writeFatal(0);
  ps.finishResearchTask(runDir, task.id, 'error', { message: 'fatal' });
  const s = snap();
  assert.strictEqual(s.stopped.reason, 'fatal');
  assert.strictEqual(s.stopped.ma_bn, '26033731');
  assert.ok(s.stopped.at);
});

test('dừng theo yêu cầu: lý do cancelled và nhãn tác vụ', () => {
  fs.unlinkSync(path.join(runDir, 'fatal_alert.json'));
  const task = ps.beginResearchTask(runDir, { type: 'collect_auto', label: 'Thu thập tự động' });
  ps.finishResearchTask(runDir, task.id, 'cancelled', { message: 'Đã dừng' });
  const s = snap();
  assert.strictEqual(s.stopped.reason, 'cancelled');
  assert.strictEqual(s.stopped.label, 'Thu thập tự động');
});

fs.rmSync(process.env.EMR_RUNTIME_ROOT, { recursive: true, force: true });
console.log(`\n${passed} test(s) passed.`);
