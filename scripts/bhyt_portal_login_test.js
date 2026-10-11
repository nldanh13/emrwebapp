#!/usr/bin/env node
'use strict';

// Nghỉ ốm: lưu tài khoản cổng BHXH một lần, mỗi lần nhập chỉ gõ CAPTCHA; mật khẩu không về giao diện.
// Chạy: node scripts/bhyt_portal_login_test.js

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bhyt-acc-'));
process.env.EMR_BHYT_PORTAL_ACCOUNT_FILE = path.join(tmp, 'bhyt_portal_account.json');

const { publicBhytPortalAccount, readBhytPortalAccount, saveBhytPortalAccount } = require('../server/utils/bhyt_portal_account');
const { loginWithCaptcha } = require('../server/services/bhyt_portal_login');

(async () => {
  assert.strictEqual(publicBhytPortalAccount().ready, false);
  assert.throws(() => saveBhytPortalAccount({ facility_code: '92001', username: 'bv' }), /mật khẩu/);
  const saved = saveBhytPortalAccount({ facility_code: '92001', username: 'bv', password: 'pw-1' });
  assert.deepStrictEqual(saved, { facility_code: '92001', username: 'bv', has_password: true, emr_account_name: '', ready: true });
  assert.ok(!JSON.stringify(saved).includes('pw-1'), 'giao diện không nhận mật khẩu');
  // Lưu lại không gõ mật khẩu: giữ mật khẩu cũ.
  saveBhytPortalAccount({ facility_code: '92001', username: 'bv2', emr_account_name: '@lich' });
  assert.strictEqual(readBhytPortalAccount().password, 'pw-1');
  assert.strictEqual(readBhytPortalAccount().username, 'bv2');

  const calls = [];
  const fakeFetch = (emrLoggedIn, portalOk = true) => async (url, opts = {}) => {
    const body = opts.body ? JSON.parse(opts.body) : null;
    calls.push([url.replace('http://127.0.0.1:5005', ''), body]);
    const reply = (data) => ({ ok: true, status: 200, json: async () => data });
    if (url.endsWith('/api/browser/login')) return reply({ logged_in: portalOk, message: portalOk ? 'OK' : 'Sai mã' });
    if (url.endsWith('/api/emr/status')) return reply({ logged_in: emrLoggedIn });
    if (url.endsWith('/api/emr/login')) return reply({ logged_in: true, message: 'Đăng nhập EMR thành công.' });
    throw new Error(`không mong gọi ${url}`);
  };
  const account = readBhytPortalAccount();
  const resolveEmr = () => ({ username: 'emr-u', password: 'emr-p', label: 'tài khoản EMR chung' });

  const out = await loginWithCaptcha({ captcha: ' AB12 ', account, resolveEmr, fetchImpl: fakeFetch(false) });
  assert.strictEqual(out.portal.logged_in, true);
  assert.strictEqual(out.emr.logged_in, true);
  assert.deepStrictEqual(calls[0], ['/api/browser/login', { facility_code: '92001', username: 'bv2', password: 'pw-1', captcha: 'AB12' }]);
  assert.deepStrictEqual(calls[2], ['/api/emr/login', { username: 'emr-u', password: 'emr-p' }]);

  calls.length = 0;
  const again = await loginWithCaptcha({ captcha: 'X', account, resolveEmr, fetchImpl: fakeFetch(true) });
  assert.strictEqual(again.emr.logged_in, true);
  assert.ok(!calls.some(([u]) => u === '/api/emr/login'), 'EMR đã có phiên thì không đăng nhập lại');

  const wrong = await loginWithCaptcha({ captcha: 'X', account, resolveEmr, fetchImpl: fakeFetch(true, false) });
  assert.strictEqual(wrong.portal.logged_in, false);
  assert.strictEqual(wrong.emr, null);

  const noEmr = await loginWithCaptcha({ captcha: 'X', account, fetchImpl: fakeFetch(false),
    resolveEmr: () => { throw new Error('Chưa có tài khoản EMR chung.'); } });
  assert.strictEqual(noEmr.portal.logged_in, true);
  assert.match(noEmr.emr.message, /Chưa có tài khoản EMR/);

  await assert.rejects(loginWithCaptcha({ captcha: '', account, resolveEmr }), /CAPTCHA/);
  await assert.rejects(loginWithCaptcha({ captcha: 'X', account: {}, resolveEmr }), /Chưa lưu tài khoản/);
  await assert.rejects(loginWithCaptcha({ captcha: 'X', account, resolveEmr, fetchImpl: async () => { throw new Error('ECONNREFUSED'); } }),
    /chưa chạy/);

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('bhyt_portal_login_test: ok');
})().catch(err => { console.error(err); process.exit(1); });
