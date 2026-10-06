#!/usr/bin/env node
'use strict';
// POST /api/auth/login: đúng → 200 + mã truy cập; sai → 401 câu tiếng Việt; khóa → 429;
// sau proxy cùng máy thì khóa theo IP thật (X-Forwarded-For), không khóa chung mọi người.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'auth-route-'));
const usersFile = path.join(dir, 'users.json');
fs.writeFileSync(usersFile, JSON.stringify([{ id: 'dd', name: 'ĐD', role: 'operator', token: 't'.repeat(32) }]));
process.env.EMR_USERS_FILE = usersFile;
const authz = require('../server/services/authz');
authz.updateUser('dd', { password: 'MatKhau#2026' });
const express = require('express');
const { router } = require('../server/routes/auth_login');

(async () => {
  const app = express();
  app.use('/api', router);
  const server = app.listen(0, '127.0.0.1');
  await new Promise(r => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}/api/auth/login`;
  const post = (body, headers = {}) => fetch(base, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
  let failed = 0;
  const test = async (name, fn) => { try { await fn(); console.log(`  ok - ${name}`); } catch (e) { failed += 1; console.error(`  FAIL - ${name}\n`, e); } };

  console.log('auth_login_route_test');
  await test('đúng → 200, có mã truy cập', async () => {
    const r = await post({ username: 'dd', password: 'MatKhau#2026' });
    assert.strictEqual(r.status, 200);
    assert.strictEqual((await r.json()).token, 't'.repeat(32));
  });
  await test('thiếu thông tin → 400 tiếng Việt', async () => {
    const r = await post({ username: 'dd' });
    assert.strictEqual(r.status, 400);
    assert.match((await r.json()).message, /Nhập tên đăng nhập và mật khẩu/);
  });
  await test('sau proxy: người A sai 5 lần bị khóa, người B (IP khác) vẫn đăng nhập được', async () => {
    for (let i = 0; i < 5; i += 1) await post({ username: 'dd', password: 'sai' }, { 'x-forwarded-for': '10.0.0.1' });
    const locked = await post({ username: 'dd', password: 'MatKhau#2026' }, { 'x-forwarded-for': '10.0.0.1' });
    assert.strictEqual(locked.status, 429);
    const other = await post({ username: 'dd', password: 'MatKhau#2026' }, { 'x-forwarded-for': '10.0.0.2' });
    assert.strictEqual(other.status, 200);
  });
  server.close();
  fs.rmSync(dir, { recursive: true, force: true });
  if (failed) process.exit(1);
  console.log('3 test(s) passed.');
})();
