#!/usr/bin/env node
'use strict';
// Hai người cùng sửa ở kho chung: người lưu sau mà đang cầm bản cũ bị chặn, và được biết ai vừa lưu.
// - Bản nháp VTYT: kiểm phiên bản (If-Match); không còn bỏ qua im lặng bản mới hơn khi đồng hồ máy lệch.
// - Checklist kiểm HSBA: mục đã bị người khác sửa thì không ghi đè; ghi lại người kiểm.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shared-edit-'));
process.env.EMR_RUNTIME_ROOT = root;

const express = require('express');
const { resourceConcurrency } = require('../server/middleware/resource_concurrency');
const { applyManualReviewPatch, manualReviewConflict, manualReviewSummary } = require('../server/services/hchanh/manual_review');

const USERS = { an: { id: 'an', name: 'Điều dưỡng An', role: 'operator' }, binh: { id: 'binh', name: 'Điều dưỡng Bình', role: 'operator' } };
const SID = 'kho-chung-test';

(async () => {
  const app = express();
  app.use(express.json({ limit: '5mb' }));
  app.use((req, _res, next) => { req.auth = USERS[req.get('x-test-user') || 'an']; next(); });
  app.use('/api', resourceConcurrency);
  app.use('/api', require('../server/routes/hchanh'));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(r => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}/api/hchanh/vtyt-draft`;
  const call = (method, user, { version, body } = {}) => fetch(base, {
    method,
    headers: {
      'content-type': 'application/json',
      'x-session-id': SID,
      'x-test-user': user,
      'x-client-concurrency': '1',
      ...(version ? { 'if-match': `"${version}"` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const draft = (note, updatedAt) => ({ draft: { updated_at: updatedAt, patients: [], jobs: [], note } });

  let failed = 0;
  const test = async (name, fn) => { try { await fn(); console.log(`  ok - ${name}`); } catch (e) { failed += 1; console.error(`  FAIL - ${name}\n`, e); } };
  console.log('shared_editing_test');

  await test('bản nháp VTYT: người lưu sau cầm bản cũ bị chặn, biết ai vừa lưu', async () => {
    const getA = await call('GET', 'an');
    const getB = await call('GET', 'binh');
    const vA = getA.headers.get('x-resource-version');
    const vB = getB.headers.get('x-resource-version');
    assert.ok(vA && vA === vB, 'hai máy cùng thấy một phiên bản');

    const saveA = await call('POST', 'an', { version: vA, body: draft('A', '2026-10-09T08:00:00.000Z') });
    assert.strictEqual(saveA.status, 200);

    const saveB = await call('POST', 'binh', { version: vB, body: draft('B', '2026-10-09T08:00:05.000Z') });
    assert.strictEqual(saveB.status, 409);
    const body = await saveB.json();
    assert.match(body.message, /Điều dưỡng An lưu lúc/);
    assert.strictEqual(body.last_writer.name, 'Điều dưỡng An');
  });

  await test('bản nháp VTYT: máy có đồng hồ chậm vẫn lưu được bản mới (không bị bỏ qua im lặng)', async () => {
    const v = (await call('GET', 'binh')).headers.get('x-resource-version');
    // Đồng hồ máy Bình chậm 1 giờ: updated_at nhỏ hơn bản của An nhưng đây là thao tác mới hơn.
    const res = await call('POST', 'binh', { version: v, body: draft('B2', '2026-10-09T07:00:00.000Z') });
    assert.strictEqual(res.status, 200);
    const out = await res.json();
    assert.notStrictEqual(out.ignored_stale, true);
    // Máy chủ đã ghi bản mới: phiên bản đổi so với lúc Bình đọc.
    const after = (await call('GET', 'an')).headers.get('x-resource-version');
    assert.ok(after && after !== v);
  });

  await test('xoá bản nháp bằng bản cũ cũng bị chặn', async () => {
    const stale = (await call('GET', 'an')).headers.get('x-resource-version');
    const v = (await call('GET', 'binh')).headers.get('x-resource-version');
    assert.strictEqual((await call('POST', 'binh', { version: v, body: draft('B3', '2026-10-09T09:00:00.000Z') })).status, 200);
    assert.strictEqual((await call('DELETE', 'an', { version: stale })).status, 409);
  });

  await test('checklist: mục đã được người khác sửa thì không ghi đè, có tên người kiểm', async () => {
    const t0 = '2026-10-09T08:00:00.000Z';
    const afterAn = applyManualReviewPatch(null, { items: { orders: { status: 'pass', note: '' } } }, t0, 'Điều dưỡng An');
    const row = manualReviewSummary(afterAn).rows.find(r => r.key === 'orders');
    assert.strictEqual(row.updated_by, 'Điều dưỡng An');

    // Bình mở checklist trước khi An lưu (base rỗng) rồi đổi mục này.
    const conflict = manualReviewConflict(afterAn, { items: { orders: { status: 'issue', base_updated_at: '' } } });
    assert.ok(conflict, 'phải báo trùng');
    assert.strictEqual(conflict.by, 'Điều dưỡng An');

    // Bình đã thấy bản của An (base đúng) → được lưu.
    assert.strictEqual(manualReviewConflict(afterAn, { items: { orders: { status: 'issue', base_updated_at: t0 } } }), null);
    // Mục khác chưa ai sửa → không trùng.
    assert.strictEqual(manualReviewConflict(afterAn, { items: { billing: { status: 'pass', base_updated_at: '' } } }), null);
    // Giao diện cũ không gửi base → giữ hành vi cũ.
    assert.strictEqual(manualReviewConflict(afterAn, { items: { orders: { status: 'issue' } } }), null);
  });

  server.close();
  fs.rmSync(root, { recursive: true, force: true });
  if (failed) { console.error(`${failed} test lỗi`); process.exit(1); }
  process.exit(0);
})();
