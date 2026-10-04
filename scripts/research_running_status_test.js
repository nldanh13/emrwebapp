#!/usr/bin/env node
'use strict';

// /research/running: tác vụ nghiên cứu đang chạy được liệt kê trong suốt thời gian handler chạy
// (kể cả khi giao diện đã rời tab), và biến mất ngay khi xong hoặc lỗi.
// Chạy: node scripts/research_running_status_test.js

const assert = require('assert');
const { lockedResearchRoute, listRunningResearch, withScopeRunning } = require('../server/research/research_http');

let passed = 0;
async function test(name, fn) {
  try { await fn(); passed += 1; console.log(`  ok - ${name}`); } catch (err) { console.error(`  FAIL - ${name}`); console.error(err); process.exitCode = 1; }
}

const routes = {};
const fakeRouter = { post: (p, h) => { routes[p] = h; } };
lockedResearchRoute(fakeRouter, 'post', '/research/archive/run', 'Lấy dữ liệu', async (_req, res) => { await res.wait; res.done = true; });
lockedResearchRoute(fakeRouter, 'post', '/research/studies/:studyId/normalize', 'Chuẩn hóa', async () => { throw new Error('hỏng'); });

const deferred = () => { let resolve; const wait = new Promise(r => { resolve = r; }); return { wait, resolve }; };
const fakeRes = (extra = {}) => ({ status() { return this; }, json(body) { this.body = body; return this; }, ...extra });

(async () => {
  await test('không có gì chạy → danh sách rỗng', () => {
    assert.deepStrictEqual(listRunningResearch(), []);
  });

  await test('đang chạy → có trong danh sách, kèm thời gian đã chạy và thông tin phạm vi', async () => {
    const d = deferred();
    const res = fakeRes({ wait: d.wait });
    const pending = routes['/research/archive/run']({ params: {}, path: '/research/archive/run', body: {} }, res, () => {});
    const now = Date.now() + 5000;
    const list = listRunningResearch(key => ({ study_name: key === 'archive' ? 'Kho' : '', task: { message: 'Đang lấy 3/10' } }), now);
    assert.strictEqual(list.length, 1);
    assert.strictEqual(list[0].kind, 'archive');
    assert.strictEqual(list[0].label, 'Lấy dữ liệu');
    assert.ok(list[0].elapsed_ms >= 4000, 'thời gian đã chạy tính từ lúc bắt đầu');
    assert.strictEqual(list[0].task.message, 'Đang lấy 3/10');
    d.resolve();
    await pending;
    assert.strictEqual(res.done, true);
    assert.deepStrictEqual(listRunningResearch(), [], 'xong thì biến mất');
  });

  await test('handler lỗi vẫn nhả khóa; lỗi của describeScope không làm hỏng danh sách', async () => {
    const d = deferred();
    const res = fakeRes({ wait: d.wait });
    const pending = routes['/research/archive/run']({ params: {}, path: '/research/archive/run', body: {} }, res, () => {});
    const list = listRunningResearch(() => { throw new Error('không đọc được'); });
    assert.strictEqual(list.length, 1);
    d.resolve(); await pending;
    await routes['/research/studies/:studyId/normalize']({ params: { studyId: 'nc_1' }, path: '/x', body: {} }, fakeRes(), () => {}).catch(() => {});
    assert.deepStrictEqual(listRunningResearch(), []);
  });

  await test('tiến độ: đang chạy thì không báo "đã dừng giữa chừng", ca đang quét không bị coi là cũ', async () => {
    const snap = { active_task: null, stopped: { hint: 'dừng' }, current_case: { ma_bn: '26033731' } };
    const d = deferred();
    const pending = routes['/research/archive/run']({ params: {}, path: '/research/archive/run', body: {} }, fakeRes({ wait: d.wait }), () => {});
    const running = withScopeRunning(snap, 'archive');
    assert.strictEqual(running.stopped, null);
    assert.strictEqual(running.scope_running.label, 'Lấy dữ liệu');
    assert.strictEqual(running.current_case.stale, false);
    d.resolve(); await pending;
    const idle = withScopeRunning(snap, 'archive');
    assert.deepStrictEqual(idle.stopped, { hint: 'dừng' });
    assert.strictEqual(idle.scope_running, null);
    assert.strictEqual(idle.current_case.stale, true, 'không chạy: ca trong file là của lần chạy trước');
    assert.strictEqual(withScopeRunning({ ...snap, active_task: { status: 'running' } }, 'archive').stopped, null);
  });

  console.log(`\n${passed} test(s) passed.`);
})();
