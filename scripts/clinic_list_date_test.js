#!/usr/bin/env node
'use strict';

// Phòng khám chọn ngày danh sách: mặc định hôm nay; ngày đã qua thì worker đọc lại ngày đó (chỉ xem).
// Chạy: node scripts/clinic_list_date_test.js

const assert = require('assert');
const { pastListDate, sanitizeMonitorRequest } = require('../server/routes/clinic');

assert.strictEqual(pastListDate('2026-10-09', '2026-10-11'), '2026-10-09');
assert.strictEqual(pastListDate('2026-10-11', '2026-10-11'), '', 'hôm nay = theo dõi bình thường');
assert.strictEqual(pastListDate('2026-10-12', '2026-10-11'), '', 'ngày tới không có danh sách');
assert.strictEqual(pastListDate('', '2026-10-11'), '');
assert.strictEqual(pastListDate('09/10/2026', '2026-10-11'), '');
assert.strictEqual(pastListDate('2026-13-45', '2026-10-11'), '');

const base = { username: 'u', password: 'p', loginUrl: 'http://emr/login.aspx' };
assert.strictEqual(sanitizeMonitorRequest(base).listDate, '');
assert.strictEqual(sanitizeMonitorRequest({ ...base, listDate: '2020-01-03' }).listDate, '2020-01-03');
assert.strictEqual(sanitizeMonitorRequest({ ...base, listDate: '2999-01-01' }).listDate, '');
console.log('clinic_list_date_test: ok');
