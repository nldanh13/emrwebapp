#!/usr/bin/env node
'use strict';

// Phòng khám → khung "Xin nghỉ ốm": khóa người bệnh khớp giao diện (clinicBoard.js sickLeaveKey),
// từ chối dữ liệu thiếu/lạ, bỏ bản ghi quá cũ.
// Chạy: node scripts/clinic_sick_leave_test.js

const assert = require('assert');
const { sanitizeSickLeavePatient, pruneSickLeave } = require('../server/routes/clinic');

const p = sanitizeSickLeavePatient({ khambenhid: 'K-1', ma_bn: ' 99000001 ', ho_ten: 'NGUYỄN  VĂN A', thoi_gian: '08:05 11/10/2026', extra: 'bỏ' });
assert.strictEqual(p.key, 'K-1');
assert.strictEqual(p.ngay, '2026-10-11');
assert.strictEqual(p.ho_ten, 'NGUYỄN VĂN A');
assert.strictEqual(p.ma_bn, '99000001');
assert.strictEqual(p.extra, undefined);

const noId = sanitizeSickLeavePatient({ ma_bn: '1', ho_ten: 'B', thoi_gian: '09:00 1/9/2026' });
assert.strictEqual(noId.key, '1:2026-09-01');

assert.throws(() => sanitizeSickLeavePatient({ ho_ten: 'C' }), /Thiếu mã/);
assert.throws(() => sanitizeSickLeavePatient({ ma_bn: '1', ho_ten: 'C', khambenhid: '../x' }), /không hợp lệ/);

const kept = pruneSickLeave({ old: { ngay: '2000-01-01' }, now: { ngay: new Date().toISOString().slice(0, 10) } });
assert.deepStrictEqual(Object.keys(kept), ['now']);
console.log('clinic_sick_leave_test: ok');
