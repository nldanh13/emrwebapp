// server/routes/admin_users.js — /api/admin/users
// Quản lý tài khoản đăng nhập Data Hub (token, mật khẩu, vai trò). Tài khoản EMR không còn
// gắn theo người dùng (xem /api/nurse-emr-accounts). Chỉ role admin —
// xem authz.requiredRoleForRequest(). Ghi trực tiếp vào secrets/users.json
// (hoặc EMR_USERS_FILE nếu có cấu hình) và nạp lại ngay, không cần khởi động
// lại server.

'use strict';

const router = require('express').Router();
const authz = require('../services/authz');
const { appendActivity } = require('../services/activity_logger');
const { getRuntimePaths } = require('../services/session');

function publicUser(u) {
  return {
    id: u.id,
    name: u.name,
    role: u.role,
    token: u.token,
    sessions: u.sessions == null ? '*' : u.sessions,
    enabled: u.enabled !== false,
    // Chỉ cho biết đã đặt mật khẩu đăng nhập hay chưa; bản băm không bao giờ gửi xuống trình duyệt.
    has_password: Boolean(u.passwordHash),
  };
}

router.get('/admin/users', (req, res) => {
  const { users, error } = authz.listAllUsersRaw();
  return res.json({
    status: 'ok',
    users: users.map(publicUser),
    file: authz.getUsersFileInfo(),
    parse_error: error,
    local_only_bypassed_users_count: authz.authStatus().local_only_bypassed_users_count,
  });
});

router.post('/admin/users', (req, res) => {
  const ctx = getRuntimePaths(req);
  const body = req.body || {};
  try {
    const created = authz.createUser({
      name: body.name,
      role: body.role,
      sessions: body.sessions,
      enabled: body.enabled,
      id: body.id || undefined,
      password: body.password || undefined,
    });
    appendActivity(ctx, { kind: 'admin.users.create', actor: req.auth, target_id: created.id });
    return res.json({ status: 'ok', user: publicUser(created) });
  } catch (e) {
    return res.status(400).json({ status: 'error', message: String(e.message || e) });
  }
});

router.patch('/admin/users/:id', (req, res) => {
  const ctx = getRuntimePaths(req);
  const body = req.body || {};
  try {
    const updated = authz.updateUser(req.params.id, {
      name: body.name,
      role: body.role,
      sessions: body.sessions,
      enabled: body.enabled,
      regenerateToken: body.regenerate_token === true,
      password: body.password || undefined,
      clearPassword: body.clear_password === true,
    });
    appendActivity(ctx, { kind: 'admin.users.update', actor: req.auth, target_id: updated.id, regenerated_token: body.regenerate_token === true, password_changed: Boolean(body.password || body.clear_password) });
    return res.json({ status: 'ok', user: publicUser(updated) });
  } catch (e) {
    return res.status(400).json({ status: 'error', message: String(e.message || e) });
  }
});

router.delete('/admin/users/:id', (req, res) => {
  const ctx = getRuntimePaths(req);
  try {
    authz.deleteUser(req.params.id);
    appendActivity(ctx, { kind: 'admin.users.delete', actor: req.auth, target_id: req.params.id });
    return res.json({ status: 'ok', id: req.params.id });
  } catch (e) {
    return res.status(400).json({ status: 'error', message: String(e.message || e) });
  }
});

module.exports = router;
