// server/routes/fetch_accounts.js — /api/fetch-accounts (GET, PUT)
//
// Tài khoản EMR thêm, chỉ dùng để "Lấy chi tiết" chạy song song (server/services/fetch_accounts.js).
// Chỉ admin (authz.requiredRoleForRequest). Không bao giờ trả mật khẩu về giao diện.

'use strict';

const router = require('express').Router();
const { publicFetchAccounts, saveFetchAccounts } = require('../services/fetch_accounts');
const { appendActivity } = require('../services/activity_logger');
const { getRuntimePaths } = require('../services/session');

router.get('/fetch-accounts', (req, res) => {
  return res.json({ status: 'ok', ...publicFetchAccounts() });
});

router.put('/fetch-accounts', (req, res) => {
  try {
    const out = saveFetchAccounts(req.body || {});
    appendActivity(getRuntimePaths(req), {
      kind: 'fetch_accounts.update',
      actor: req.auth,
      count: out.accounts.length,
      max_parallel: out.max_parallel,
    });
    return res.json({ status: 'ok', ...out });
  } catch (e) {
    return res.status(400).json({ status: 'error', message: String(e.message || e) });
  }
});

module.exports = router;
