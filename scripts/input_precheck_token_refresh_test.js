#!/usr/bin/env node
'use strict';

// Token tiền kiểm phải khớp khi tiền kiểm vừa cập nhật/phân loại lại dữ liệu:
// /run-input-* chuẩn hóa lại targets theo file phân loại MỚI, nên token phải
// được cấp theo targets chuẩn hóa từ chính file mới đó.
// Chạy: node scripts/input_precheck_token_refresh_test.js

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { normalizeInputTargets } = require('../server/utils/patient_helpers/targets');
const {
  issueInputPrecheckToken,
  validateAndConsumeInputPrecheckToken,
} = require('../server/services/input_precheck_tokens');

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ok - ${name}`);
  } catch (err) {
    console.error(`  FAIL - ${name}`);
    console.error(err);
    process.exitCode = 1;
  }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'precheck-token-'));
const ctx = { dir: tmp, STATE_DIR: tmp };

// Chế độ nhập theo phòng: UI gửi BN + phòng, server lọc ngày theo file phân loại.
const rawBody = {
  taskName: 'input_care',
  patientIds: ['BN1', 'BN2'],
  selectedDates: ['24/09/2026', '25/09/2026'],
  targetRooms: ['P08', 'P10'],
};
const before = [
  { ma_bn: 'BN1', ngay_lam: '24/09/2026', so_phong: 'P08' },
  { ma_bn: 'BN2', ngay_lam: '24/09/2026', so_phong: 'P10' },
];
// Tiền kiểm phát hiện y lệnh mới → phân loại lại → BN2 có thêm ngày 25/09.
const after = [
  ...before,
  { ma_bn: 'BN2', ngay_lam: '25/09/2026', so_phong: 'P10' },
];

test('token cấp theo targets cũ (trước khi cập nhật) bị từ chối — tái hiện lỗi', () => {
  const issued = issueInputPrecheckToken(ctx, 'input_care', normalizeInputTargets(rawBody, before));
  const runTargets = { ...normalizeInputTargets(rawBody, after), precheck_token: issued.precheck_token };
  const check = validateAndConsumeInputPrecheckToken(ctx, 'input_care', runTargets);
  assert.strictEqual(check.ok, false);
  assert.match(check.message, /không khớp danh sách BN\/ngày/);
});

test('token cấp theo targets chuẩn hóa từ file mới thì nhập được', () => {
  const issued = issueInputPrecheckToken(ctx, 'input_care', normalizeInputTargets(rawBody, after));
  const runTargets = { ...normalizeInputTargets(rawBody, after), precheck_token: issued.precheck_token };
  const check = validateAndConsumeInputPrecheckToken(ctx, 'input_care', runTargets);
  assert.strictEqual(check.ok, true);
});

test('route tiền kiểm cấp token theo targets chuẩn hóa lại sau khi cập nhật', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server', 'routes', 'patients.js'), 'utf8');
  const start = src.indexOf("if (result.status === 'changed')");
  const block = src.slice(start, src.indexOf('appendActivity', start));
  assert.ok(block.includes('targetsFromCurrentProcessed(ctx, rawBody)'));
  assert.ok(/issueInputPrecheckToken\([\s\S]*issueTargets/.test(block));
});

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${passed} test(s) passed.`);
