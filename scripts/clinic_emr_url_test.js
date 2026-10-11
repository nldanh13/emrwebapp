#!/usr/bin/env node
'use strict';

// Phòng khám không bắt nhập URL: địa chỉ đăng nhập lấy từ config/config.json (url_login), URL
// Danh sách Khám bệnh để trống thì worker tự dựng sau khi đăng nhập.
// Chạy: node scripts/clinic_emr_url_test.js

const assert = require('assert');
const { resolveEmrUrls, emrUrlDefaults } = require('../server/routes/clinic');

const defaults = emrUrlDefaults({ url_login: 'http://192.168.2.26:2026/login.aspx' });
assert.deepStrictEqual(defaults, { loginUrl: 'http://192.168.2.26:2026/login.aspx', listUrl: '' });
assert.deepStrictEqual(emrUrlDefaults({ url_login: 'khong-phai-url' }).loginUrl, '');

// Không gửi gì → dùng địa chỉ đã khai, không cần URL danh sách.
assert.deepStrictEqual(resolveEmrUrls({}, defaults), { loginUrl: 'http://192.168.2.26:2026/login.aspx', listUrl: '' });
// Gửi URL riêng → dùng URL riêng.
assert.strictEqual(resolveEmrUrls({ loginUrl: 'https://emr.khac/login.aspx' }, defaults).loginUrl, 'https://emr.khac/login.aspx');
// Chưa khai ở đâu → báo rõ cách khai.
assert.throws(() => resolveEmrUrls({}, { loginUrl: '', listUrl: '' }), /config\/config\.json/);
assert.throws(() => resolveEmrUrls({ listUrl: 'abc' }, defaults), /không hợp lệ/);
console.log('clinic_emr_url_test: ok');
