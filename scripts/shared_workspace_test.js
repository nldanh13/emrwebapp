#!/usr/bin/env node
'use strict';
// Kho chung (/api/workspace): đặt/bỏ, máy chưa có dữ liệu, người bị giới hạn session không thấy kho
// chung, không xoá được kho chung qua "Đổi dữ liệu", và chỉ giám sát được đặt/bỏ.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shared-ws-'));
process.env.EMR_RUNTIME_ROOT = root;
const usersFile = path.join(root, 'users.json');
fs.writeFileSync(usersFile, JSON.stringify([{ id: 'gs', name: 'Giám sát', role: 'supervisor', token: 'g'.repeat(32) }]));
process.env.EMR_USERS_FILE = usersFile;

const express = require('express');
const shared = require('../server/services/shared_workspace');
const { requiredRoleForRequest } = require('../server/services/authz');

const SHARED = 'kho-chung-khoa';
const OTHER = 'rieng-may-hai';

const PRINCIPALS = {
  supervisor: { id: 'gs', name: 'Giám sát', role: 'supervisor', sessions: null },
  operator: { id: 'dd', name: 'Điều dưỡng', role: 'operator', sessions: null },
  restricted: { id: 'nc', name: 'Nghiên cứu', role: 'operator', sessions: [OTHER] },
};

(async () => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.auth = PRINCIPALS[req.get('x-test-user') || 'supervisor']; next(); });
  app.use('/api', require('../server/routes/workspace'));
  app.use('/api', require('../server/routes/board'));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(r => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const call = (method, url, { sid = OTHER, user = 'supervisor', body } = {}) => fetch(base + url, {
    method,
    headers: { 'content-type': 'application/json', 'x-session-id': sid, 'x-test-user': user },
    body: body ? JSON.stringify(body) : undefined,
  });

  let failed = 0;
  const test = async (name, fn) => { try { await fn(); console.log(`  ok - ${name}`); } catch (e) { failed += 1; console.error(`  FAIL - ${name}\n`, e); } };
  console.log('shared_workspace_test');

  await test('chưa đặt kho chung → shared = null, workspace trống chưa có dữ liệu', async () => {
    const r = await (await call('GET', '/workspace')).json();
    assert.strictEqual(r.shared, null);
    assert.strictEqual(r.current.sid, OTHER);
    assert.strictEqual(r.current.has_data, false);
    assert.strictEqual(r.can_manage, true);
  });

  await test('có file danh sách quét → có dữ liệu', async () => {
    const dir = path.join(root, 'sessions', SHARED, 'data');
    fs.mkdirSync(dir, { recursive: true });
    const { buildRuntimeDataPaths } = require('../server/data_contract');
    const rawPath = buildRuntimeDataPaths(path.join(root, 'sessions', SHARED)).RAW_PATH;
    fs.mkdirSync(path.dirname(rawPath), { recursive: true });
    fs.writeFileSync(rawPath, JSON.stringify([{ 'Mã BN': 'BN1' }]));
    assert.strictEqual(shared.workspaceHasData(SHARED), true);
    assert.strictEqual(shared.workspaceHasData(OTHER), false);
  });

  await test('giám sát đặt workspace đang mở làm kho chung', async () => {
    const res = await call('PUT', '/workspace/shared', { sid: SHARED });
    assert.strictEqual(res.status, 200);
    const r = await res.json();
    assert.strictEqual(r.shared.sid, SHARED);
    assert.strictEqual(r.shared.has_data, true);
    assert.strictEqual(r.current.is_shared, true);
    assert.strictEqual(r.shared.set_by, 'Giám sát');
  });

  await test('máy khác thấy kho chung, biết mình không ở kho chung', async () => {
    const r = await (await call('GET', '/workspace', { user: 'operator' })).json();
    assert.strictEqual(r.shared.sid, SHARED);
    assert.strictEqual(r.current.is_shared, false);
    assert.strictEqual(r.can_manage, false);
  });

  await test('người bị giới hạn session không thấy kho chung ngoài quyền', async () => {
    const r = await (await call('GET', '/workspace', { user: 'restricted' })).json();
    assert.strictEqual(r.shared, null);
  });

  await test('mã workspace lạ → 400 tiếng Việt', async () => {
    const res = await call('PUT', '/workspace/shared', { body: { sid: '../etc' } });
    assert.strictEqual(res.status, 400);
    assert.match((await res.json()).message, /không hợp lệ/);
  });

  await test('Đổi dữ liệu: kho chung có nhãn, không xoá được', async () => {
    const list = await (await call('GET', '/data-sessions')).json();
    const item = list.sessions.find(s => s.sid === SHARED);
    assert.ok(item, 'kho chung có trong danh sách');
    assert.strictEqual(item.is_shared, true);
    assert.strictEqual(item.label, 'Kho chung');
    const res = await call('DELETE', `/data-sessions/${SHARED}`);
    assert.strictEqual(res.status, 409);
    assert.ok(fs.existsSync(path.join(root, 'sessions', SHARED)), 'dữ liệu kho chung vẫn còn');
  });

  await test('bỏ kho chung không xoá dữ liệu', async () => {
    const res = await call('DELETE', '/workspace/shared');
    assert.strictEqual(res.status, 200);
    assert.strictEqual((await res.json()).shared, null);
    assert.strictEqual(shared.getSharedWorkspace(), null);
    assert.strictEqual(shared.workspaceHasData(SHARED), true);
  });

  await test('chỉ giám sát được đặt/bỏ kho chung; xem thì ai cũng được', async () => {
    const req = (method, p) => ({ method, path: p });
    assert.strictEqual(requiredRoleForRequest(req('PUT', '/workspace/shared')), 'supervisor');
    assert.strictEqual(requiredRoleForRequest(req('DELETE', '/workspace/shared')), 'supervisor');
    assert.strictEqual(requiredRoleForRequest(req('GET', '/workspace')), 'viewer');
  });

  server.close();
  fs.rmSync(root, { recursive: true, force: true });
  if (failed) { console.error(`${failed} test lỗi`); process.exit(1); }
})();
