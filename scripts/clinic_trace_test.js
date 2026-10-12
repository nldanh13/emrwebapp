#!/usr/bin/env node
'use strict';

// Phòng khám → "Tải nhật ký quét": chọn đúng file clinic_trace_YYYYMMDD.jsonl (mới nhất hoặc ngày yêu cầu),
// không trả file khác trong thư mục.
// Chạy: node scripts/clinic_trace_test.js

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { clinicTraceFile } = require('../server/routes/clinic');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clinic-trace-'));
assert.strictEqual(clinicTraceFile(dir), '');
for (const name of ['clinic_trace_20261011.jsonl', 'clinic_trace_20261012.jsonl', 'clinic_monitor_state.json', 'clinic_trace_x.jsonl']) {
  fs.writeFileSync(path.join(dir, name), '{}\n');
}
assert.strictEqual(clinicTraceFile(dir), 'clinic_trace_20261012.jsonl');
assert.strictEqual(clinicTraceFile(dir, '2026-10-11'), 'clinic_trace_20261011.jsonl');
assert.strictEqual(clinicTraceFile(dir, '2026-10-01'), '');
assert.strictEqual(clinicTraceFile(dir, '../x'), '');
assert.strictEqual(clinicTraceFile(path.join(dir, 'khong_co')), '');
fs.rmSync(dir, { recursive: true, force: true });
console.log('clinic_trace_test: ok');
