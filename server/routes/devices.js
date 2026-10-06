// server/routes/devices.js — /api/devices: đăng ký, duyệt, thu hồi thiết bị tin cậy.
// Mọi người đăng nhập đều đăng ký được thiết bị của mình; duyệt thiết bị bằng mã 8 số (thiết bị
// đầu tiên) hoặc bởi quản trị đang dùng một thiết bị đã tin cậy.

'use strict';

const router = require('express').Router();
const td = require('../services/trusted_devices');
const { hasRole } = require('../services/authz');
const { appendActivity } = require('../services/activity_logger');
const { getRuntimePaths } = require('../services/session');

const fail = (res, status, message) => res.status(status).json({ status: 'error', message });

router.get('/devices/me', (req, res) => {
  res.json({
    status: 'ok',
    trusted: Boolean(req.deviceTrusted),
    local_only: req.auth?.auth_type === 'local_only',
    device: req.device || (req.get('x-device-id') ? td.getDevice(req.get('x-device-id')) : null),
    any_trusted: td.hasTrustedDevice(),
  });
});

router.get('/devices', (req, res) => {
  const all = hasRole(req.auth, 'admin');
  res.json({ status: 'ok', devices: td.listDevices({ userId: all ? null : req.auth.id }) });
});

router.post('/devices/register', (req, res) => {
  try {
    const d = td.registerDevice({ userId: req.auth.id, name: req.body?.name, publicKeyJwk: req.body?.public_key });
    appendActivity(getRuntimePaths(req), { kind: 'devices.register', actor: req.auth, target_id: d.id });
    return res.json({ status: 'ok', device: d });
  } catch (e) {
    return fail(res, 400, String(e.message || e));
  }
});

router.post('/devices/:id/approve', (req, res) => {
  try {
    let d;
    if (req.body?.setup_code) {
      d = td.approveWithSetupCode(req.params.id, { code: req.body.setup_code, userId: req.auth.id });
    } else {
      if (!hasRole(req.auth, 'admin')) return fail(res, 403, 'Chỉ quản trị duyệt được thiết bị.');
      if (!req.deviceTrusted) return fail(res, 403, 'Hãy duyệt từ một thiết bị đã tin cậy (vd. điện thoại của quản trị), hoặc dùng mã xác nhận lấy trên máy chủ.');
      d = td.approveDevice(req.params.id, { by: req.auth.id });
    }
    appendActivity(getRuntimePaths(req), { kind: 'devices.approve', actor: req.auth, target_id: d.id });
    return res.json({ status: 'ok', device: d });
  } catch (e) {
    return fail(res, 400, String(e.message || e));
  }
});

router.post('/devices/:id/revoke', (req, res) => {
  const d = td.getDevice(req.params.id);
  if (!d) return fail(res, 404, 'Không tìm thấy thiết bị.');
  if (!hasRole(req.auth, 'admin') && d.user_id !== req.auth.id) return fail(res, 403, 'Chỉ thu hồi được thiết bị của chính bạn.');
  try {
    const out = td.revokeDevice(req.params.id, { by: req.auth.id });
    appendActivity(getRuntimePaths(req), { kind: 'devices.revoke', actor: req.auth, target_id: out.id });
    return res.json({ status: 'ok', device: out });
  } catch (e) {
    return fail(res, 400, String(e.message || e));
  }
});

module.exports = router;
