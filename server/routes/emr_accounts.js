// server/routes/emr_accounts.js — /api/emr-accounts/overview (GET)
//
// Bảng gom mọi tài khoản EMR app đang giữ (server/services/emr_account_overview.js) cho màn
// Thiết lập tài khoản → Tài khoản EMR. Chỉ admin (authz.requiredRoleForRequest). Không trả mật khẩu.

'use strict';

const router = require('express').Router();
const { emrAccountOverview } = require('../services/emr_account_overview');
const { readConfig, getNurseState } = require('../utils/nurse_config');

router.get('/emr-accounts/overview', (req, res) => {
  let roster = [];
  try { roster = getNurseState(readConfig(req)).roster || []; } catch (_) { /* chưa có lịch */ }
  return res.json({ status: 'ok', ...emrAccountOverview({ roster }) });
});

module.exports = router;
