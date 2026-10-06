#!/usr/bin/env node
'use strict';
// Mới cài trên VPS: đã khai EMR_USERS_FILE nhưng chưa tạo tài khoản nào. Trước đây máy chủ coi
// như "chỉ một máy dùng" và cho MỌI người vào với quyền quản trị (qua HTTPS là ai cũng vào được).
// Phải từ chối, kèm hướng dẫn tạo tài khoản đầu tiên.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'auth-empty-'));
process.env.EMR_USERS_FILE = path.join(dir, 'users.json'); // chưa có file
delete process.env.EMR_APP_TOKEN;
const authz = require('../server/services/authz');

function call(req) {
  let status = 200; let body = null; let nexted = false;
  const res = { status(c) { status = c; return this; }, json(b) { body = b; return this; } };
  authz.authenticateRequest({ method: 'GET', path: '/data', query: {}, get: () => '', ...req }, res, () => { nexted = true; });
  return { status, body, nexted };
}

const r = call({});
assert.strictEqual(r.nexted, false, 'không được cho vào khi chưa có tài khoản nào');
assert.strictEqual(r.status, 401);
assert.match(r.body.message, /Chưa có tài khoản/);
assert.match(r.body.message, /users_cli\.js tao-admin/);
fs.rmSync(dir, { recursive: true, force: true });
console.log('auth_empty_users_test\n  ok - khai EMR_USERS_FILE nhưng chưa có tài khoản: từ chối, chỉ cách tạo\n1 test(s) passed.');
