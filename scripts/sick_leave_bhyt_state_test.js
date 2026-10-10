#!/usr/bin/env node
'use strict';

// Trạng thái nghỉ ốm giữ kết quả nhập Cổng BHYT (Số KCB bổ sung, đã lưu/lỗi) qua lần lưu kế tiếp.
// Chạy: node scripts/sick_leave_bhyt_state_test.js

const assert = require('assert');
const { normalizeState } = require('../server/routes/sick_leave');

const out = normalizeState({ entries: {
  a: { submitted: true, note: 'x', bhyt_fields: { so_kcb: ' K1 ', 'bad key': 'y', ma_ct: '' }, bhyt_status: 'success', bhyt_message: 'Đã lưu lên cổng BHYT.', bhyt_at: '2026-10-10T11:00:00Z' },
  b: { bhyt_status: 'running', bhyt_message: 'không giữ' },
  c: { note: 'chỉ ghi chú' },
} });

assert.deepStrictEqual(out.entries.a.bhyt_fields, { so_kcb: 'K1' });
assert.strictEqual(out.entries.a.bhyt_status, 'success');
assert.strictEqual(out.entries.a.bhyt_message, 'Đã lưu lên cổng BHYT.');
assert.strictEqual(out.entries.a.submitted, true);
assert.strictEqual(out.entries.b.bhyt_status, undefined);
assert.deepStrictEqual(Object.keys(out.entries.c).sort(), ['note', 'submitted', 'updated_at']);
console.log('sick_leave_bhyt_state_test: ok');
