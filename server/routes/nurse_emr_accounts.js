// server/routes/nurse_emr_accounts.js — /api/nurse-emr-accounts (GET, POST)
//
// Tài khoản EMR thật riêng theo TÊN điều dưỡng trong lịch trực (khác với
// config/users.json — tài khoản đăng nhập Data Hub). Dùng khi nhập chăm sóc
// để mỗi ca (làm/trực) được ghi nhận đúng tài khoản EMR của người phụ trách
// ca đó — xem worker/nurse_emr_accounts.py. Chỉ role admin vì chứa mật khẩu
// thật (xem authz.requiredRoleForRequest()).

'use strict';

const router = require('express').Router();
const { readNurseEmrAccounts, writeNurseEmrAccounts } = require('../utils/nurse_emr_accounts');
const { appendActivity } = require('../services/activity_logger');
const { getRuntimePaths } = require('../services/session');

router.get('/nurse-emr-accounts', (req, res) => {
  return res.json({ status: 'ok', accounts: readNurseEmrAccounts() });
});

router.post('/nurse-emr-accounts', (req, res) => {
  const body = req.body || {};
  if (!Array.isArray(body.accounts)) {
    return res.status(400).json({ status: 'error', message: 'Thiếu danh sách accounts (mảng).' });
  }
  try {
    const accounts = writeNurseEmrAccounts(body.accounts);
    const ctx = getRuntimePaths(req);
    appendActivity(ctx, { kind: 'nurse_emr_accounts.update', actor: req.auth, count: accounts.length });
    return res.json({ status: 'ok', accounts });
  } catch (e) {
    return res.status(400).json({ status: 'error', message: String(e.message || e) });
  }
});

module.exports = router;
