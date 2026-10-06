// server/routes/auth_login.js — POST /api/auth/login (tên + mật khẩu → mã truy cập).
// Gắn TRƯỚC bước kiểm tra mã truy cập (requireAppToken) vì người dùng chưa có mã.
// Body nhỏ (tối đa 4 KB); sai nhiều lần thì authz khóa tạm theo IP + tên đăng nhập.

'use strict';

const express = require('express');
const authz = require('../services/authz');

const router = express.Router();

// Sau reverse proxy (Caddy/Nginx trên cùng máy) địa chỉ thật nằm ở X-Forwarded-For;
// chỉ tin header đó khi kết nối đến từ chính máy này.
function clientIp(req) {
  const remote = String(req.socket?.remoteAddress || '');
  const local = remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1';
  const forwarded = String(req.get('x-forwarded-for') || '').split(',')[0].trim();
  return local && forwarded ? forwarded : remote;
}

router.post('/auth/login', express.json({ limit: '4kb' }), (req, res) => {
  const { username, password } = req.body || {};
  if (!String(username || '').trim() || !String(password || '')) {
    return res.status(400).json({ status: 'error', message: 'Nhập tên đăng nhập và mật khẩu.' });
  }
  const result = authz.loginWithPassword({ username, password, ip: clientIp(req) });
  if (!result.ok) {
    return res.status(result.locked ? 429 : 401).json({ status: 'error', code: result.locked ? 'LOGIN_LOCKED' : 'LOGIN_FAILED', message: result.message });
  }
  return res.json({ status: 'ok', token: result.token, user: result.user });
});

module.exports = { router, clientIp };
