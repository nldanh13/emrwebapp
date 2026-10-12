// server/services/bhyt_portal_login.js — Đăng nhập công cụ nhập cổng BHXH chỉ bằng mã CAPTCHA.
//
// Người dùng gõ mã CAPTCHA ở tab Nghỉ ốm; máy chủ lấy tài khoản cổng đã lưu
// (server/utils/bhyt_portal_account.js) gửi sang công cụ (tools/bhyt_selenium_app, cổng 5005),
// rồi đăng nhập luôn EMR cho công cụ (để đọc phiếu/giấy ra viện) nếu công cụ chưa có phiên EMR.
// Mật khẩu chỉ đi giữa máy chủ và công cụ trên cùng máy, không về trình duyệt.

'use strict';

const { BHYT_TOOL_URL, callTool } = require('./bhyt_tool');

/**
 * @param {object} opts
 * @param {string} opts.captcha mã người dùng gõ
 * @param {{facility_code,username,password}} opts.account tài khoản cổng đã lưu
 * @param {() => {username,password,label}} opts.resolveEmr tài khoản EMR cho công cụ (ném lỗi nếu chưa có)
 * @param {Function} [opts.fetchImpl]
 */
async function loginWithCaptcha({ captcha, account, resolveEmr, fetchImpl = fetch }) {
  const code = String(captcha || '').trim();
  if (!code) throw new Error('Cần gõ mã CAPTCHA.');
  if (!account?.facility_code || !account?.username || !account?.password) {
    throw new Error('Chưa lưu tài khoản cổng BHXH. Mở "Tài khoản cổng BHXH" và lưu một lần.');
  }
  const portal = await callTool(fetchImpl, '/api/browser/login', {
    facility_code: account.facility_code, username: account.username, password: account.password, captcha: code,
  });
  if (!portal.logged_in) {
    return { portal: { logged_in: false, message: portal.message || 'Mã CAPTCHA chưa đúng. Gõ lại mã mới.' }, emr: null };
  }

  let emr;
  try {
    const status = await callTool(fetchImpl, '/api/emr/status');
    if (status.logged_in) {
      emr = { logged_in: true, message: 'EMR đã đăng nhập sẵn.' };
    } else {
      const creds = resolveEmr();
      const r = await callTool(fetchImpl, '/api/emr/login', { username: creds.username, password: creds.password });
      emr = { logged_in: Boolean(r.logged_in), message: r.message || (r.logged_in ? `Đã đăng nhập EMR (${creds.label}).` : 'Chưa đăng nhập được EMR.') };
    }
  } catch (err) {
    emr = { logged_in: false, message: String(err.message || err) };
  }
  return { portal: { logged_in: true, message: portal.message || 'Đã đăng nhập cổng BHXH, giữ phiên.' }, emr };
}

module.exports = { BHYT_TOOL_URL, callTool, loginWithCaptcha };
