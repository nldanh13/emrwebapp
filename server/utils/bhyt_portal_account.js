// server/utils/bhyt_portal_account.js — Tài khoản cổng BHXH (gdbhyt) cho tab Nghỉ ốm.
//
// Lưu một lần ở secrets/bhyt_portal_account.json để mỗi lần nhập nghỉ ốm người dùng chỉ phải gõ
// mã CAPTCHA: máy chủ điền Mã cơ sở KCB, tên đăng nhập, mật khẩu rồi gửi sang công cụ nhập cổng
// (tools/bhyt_selenium_app). Mật khẩu không bao giờ trả về giao diện hay ghi log.
// emr_account_name: tài khoản EMR công cụ dùng để đọc giấy (tên bác sĩ đã lưu, '@lich', hoặc trống
// = tài khoản EMR chung).

'use strict';

const { resolveSecretFile } = require('../services/secret_store');
const { readJsonSafe, writeJsonAtomic } = require('./file');

function bhytPortalAccountPath() {
  return resolveSecretFile('bhyt_portal_account.json').path;
}

function text(value) {
  return value === undefined || value === null ? '' : String(value).trim();
}

function readBhytPortalAccount() {
  const raw = readJsonSafe(bhytPortalAccountPath(), {}) || {};
  return {
    facility_code: text(raw.facility_code),
    username: text(raw.username),
    password: raw.password ? String(raw.password) : '',
    emr_account_name: text(raw.emr_account_name),
  };
}

/** Phần an toàn để trả về giao diện (không có mật khẩu). */
function publicBhytPortalAccount(account = readBhytPortalAccount()) {
  return {
    facility_code: account.facility_code,
    username: account.username,
    has_password: Boolean(account.password),
    emr_account_name: account.emr_account_name,
    ready: Boolean(account.facility_code && account.username && account.password),
  };
}

/** Lưu tài khoản. Mật khẩu để trống = giữ mật khẩu đã lưu. */
function saveBhytPortalAccount(input = {}) {
  const current = readBhytPortalAccount();
  const next = {
    facility_code: text(input.facility_code),
    username: text(input.username),
    password: input.password ? String(input.password) : current.password,
    emr_account_name: text(input.emr_account_name),
  };
  if (!next.facility_code || !next.username) throw new Error('Cần nhập Mã cơ sở KCB và tên đăng nhập cổng BHXH.');
  if (!next.password) throw new Error('Cần nhập mật khẩu cổng BHXH.');
  writeJsonAtomic(bhytPortalAccountPath(), next);
  return publicBhytPortalAccount(next);
}

module.exports = {
  bhytPortalAccountPath,
  readBhytPortalAccount,
  publicBhytPortalAccount,
  saveBhytPortalAccount,
};
