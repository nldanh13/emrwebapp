#!/usr/bin/env node
'use strict';

// Lấy trực tiếp nhiều Mã BN: ca mà bước lấy dữ liệu báo lỗi qua kết quả (Python dừng giữa chừng,
// phần hành chánh lỗi) phải được tính là lỗi, không phải "đã xong".
// Chạy: node scripts/research_collection_batch_test.js

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
process.env.EMR_RUNTIME_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'collection_batch_'));
const { caseErrorsFromResults } = require('../server/routes/research_collection_batch')._test;

let passed = 0;
function test(name, fn) {
  try { fn(); passed += 1; console.log(`  ok - ${name}`); } catch (err) { console.error(`  FAIL - ${name}`); console.error(err); process.exitCode = 1; }
}

test('XN/CĐHA dừng vì lỗi Selenium (TimeoutException) → ca lỗi, chỉ giữ dòng đầu của thông báo', () => {
  const errors = caseErrorsFromResults({ hchanh: { ok: 1, error: 0 }, xn_cdha: { error: 'Lấy XN/CĐHA lỗi: TimeoutException\nTraceback ...' } });
  assert.deepStrictEqual(errors, ['XN/CĐHA: Lấy XN/CĐHA lỗi: TimeoutException']);
});
test('phần hành chánh lỗi → ca lỗi', () => {
  assert.deepStrictEqual(caseErrorsFromResults({ hchanh: { ok: 2, error: 1 } }), ['Hồ sơ/y lệnh: 1 phần lỗi']);
});
test('không lỗi → ca xong', () => {
  assert.deepStrictEqual(caseErrorsFromResults({ hchanh: { ok: 4, error: 0 }, xn_cdha: { ok: true, stopped: false } }), []);
  assert.deepStrictEqual(caseErrorsFromResults({}), []);
});

fs.rmSync(process.env.EMR_RUNTIME_ROOT, { recursive: true, force: true });
console.log(`\n${passed} test(s) passed.`);
