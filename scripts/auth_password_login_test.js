#!/usr/bin/env node
'use strict';
// Đăng nhập bằng tên + mật khẩu (dùng khi chạy trên VPS, mọi máy trong BV mở một link):
// mật khẩu chỉ lưu dạng băm scrypt, sai nhiều lần thì khóa tạm, không lộ tài khoản nào tồn tại.
// Chạy: node scripts/auth_password_login_test.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'auth-pw-'));
const usersFile = path.join(dir, 'users.json');
fs.writeFileSync(usersFile, JSON.stringify([
  { id: 'dieuduong', name: 'Điều dưỡng A', role: 'operator', token: 'a'.repeat(32) },
  { id: 'tat', name: 'Đã tắt', role: 'operator', token: 'b'.repeat(32), enabled: false },
]));
process.env.EMR_USERS_FILE = usersFile;
const authz = require('../server/services/authz');

let passed = 0;
function test(name, fn) {
  try { fn(); passed += 1; console.log(`  ok - ${name}`); } catch (err) { console.error(`  FAIL - ${name}`); console.error(err); process.exitCode = 1; }
}

console.log('auth_password_login_test');
test('đặt mật khẩu: file chỉ lưu bản băm, không lưu mật khẩu rõ', () => {
  authz.updateUser('dieuduong', { password: 'MatKhau#2026' });
  const raw = fs.readFileSync(usersFile, 'utf8');
  assert.ok(!raw.includes('MatKhau#2026'));
  assert.match(JSON.parse(raw)[0].password_hash, /^scrypt\$/);
});

test('đúng tên + mật khẩu → trả mã truy cập của người đó', () => {
  const r = authz.loginWithPassword({ username: 'DieuDuong', password: 'MatKhau#2026', ip: '1.1.1.1' });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.token, 'a'.repeat(32));
  assert.strictEqual(r.user.id, 'dieuduong');
  assert.strictEqual(r.user.token, undefined);
});

test('sai mật khẩu, sai tên, tài khoản tắt: cùng một câu báo (không lộ tài khoản nào có)', () => {
  const a = authz.loginWithPassword({ username: 'dieuduong', password: 'sai', ip: '2.2.2.2' });
  const b = authz.loginWithPassword({ username: 'khongco', password: 'sai', ip: '2.2.2.3' });
  const c = authz.loginWithPassword({ username: 'tat', password: 'gi-cung-duoc', ip: '2.2.2.4' });
  for (const r of [a, b, c]) {
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.message, 'Tên đăng nhập hoặc mật khẩu không đúng.');
  }
});

test('sai 5 lần → khóa tạm, kể cả khi sau đó nhập đúng', () => {
  for (let i = 0; i < 5; i += 1) authz.loginWithPassword({ username: 'dieuduong', password: 'sai', ip: '3.3.3.3' });
  const r = authz.loginWithPassword({ username: 'dieuduong', password: 'MatKhau#2026', ip: '3.3.3.3' });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.locked, true);
  assert.match(r.message, /thử lại sau \d+ phút/);
});

test('mật khẩu quá ngắn bị từ chối, bằng tiếng Việt', () => {
  assert.throws(() => authz.updateUser('dieuduong', { password: '123' }), /ít nhất 8 ký tự/);
});

test('người chưa đặt mật khẩu không đăng nhập bằng mật khẩu được', () => {
  fs.writeFileSync(usersFile, JSON.stringify([{ id: 'moi', name: 'Mới', role: 'operator', token: 'c'.repeat(32) }]));
  authz.reloadUsers();
  assert.strictEqual(authz.loginWithPassword({ username: 'moi', password: '', ip: '4.4.4.4' }).ok, false);
});

fs.rmSync(dir, { recursive: true, force: true });
if (process.exitCode) process.exit(process.exitCode);
console.log(`${passed} test(s) passed.`);
