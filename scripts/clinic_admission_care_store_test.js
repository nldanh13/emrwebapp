#!/usr/bin/env node
'use strict';

// Phòng khám → Nhập viện · nhập chăm sóc: lưu danh sách đã tìm và nội dung đã sửa theo ngày.
// Chạy: node scripts/clinic_admission_care_store_test.js

const assert = require('assert');
const { sanitizeAdmissionCareRows, pruneAdmissionCare } = require('../server/routes/clinic');

const [row] = sanitizeAdmissionCareRows([
  { ma_bn: ' 26100091 ', ho_ten: 'A', care_time_str: '09:22 12/10/2026', dien_bien: 'Đau gối phải', vitals: { mach: '92', la: 'x' },
    sheets_done: { kham: true }, skip: true, password: 'không lưu', nursing_url: 'http://emr/?usid=x' },
  { ho_ten: 'không có mã' },
]);
assert.strictEqual(row.ma_bn, '26100091');
assert.strictEqual(row.dien_bien, 'Đau gối phải');
assert.deepStrictEqual(row.vitals, { mach: '92', nhiet_do: '', huyet_ap: '', nhip_tho: '' });
assert.deepStrictEqual(row.sheets_done, { kham: true, khoa: false });
assert.strictEqual(row.skip, true);
assert.strictEqual(row.password, undefined);
assert.strictEqual(row.nursing_url, undefined); // không lưu link có mã phiên EMR
assert.strictEqual(sanitizeAdmissionCareRows([{ ma_bn: '1' }])[0].sheets_done, null);
assert.strictEqual(sanitizeAdmissionCareRows('x').length, 0);

const today = new Date().toISOString().slice(0, 10);
const kept = pruneAdmissionCare({ '2000-01-01': {}, [today]: { rows: [] }, 'bad': {} });
assert.deepStrictEqual(Object.keys(kept), [today]);
console.log('clinic_admission_care_store_test: ok');
