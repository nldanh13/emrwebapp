#!/usr/bin/env node
'use strict';

// Lấy trực tiếp nhiều Mã BN (lấy cả lô trong cùng phiên đăng nhập): ca có bước lấy dữ liệu báo lỗi
// qua kết quả (Python dừng giữa chừng, phần hành chánh lỗi) phải được tính là lỗi, không phải "đã xong".
// Chạy: node scripts/research_collection_batch_test.js

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
process.env.EMR_RUNTIME_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'collection_batch_'));
const { caseErrorsForBatch } = require('../server/routes/research_collection_batch')._test;

let passed = 0;
function test(name, fn) {
  try { fn(); passed += 1; console.log(`  ok - ${name}`); } catch (err) { console.error(`  FAIL - ${name}`); console.error(err); process.exitCode = 1; }
}

const metaOf = row => ({ source_key: row.key });
const rows = [{ key: 'k1' }, { key: 'k2' }];

test('XN/CĐHA của cả lô dừng vì lỗi Selenium → ca nào cũng tính lỗi, chỉ giữ dòng đầu thông báo', () => {
  const errors = caseErrorsForBatch({ rows, hcProgress: {}, results: { hchanh: { ok: 2 }, xn_cdha: { error: 'Lấy XN/CĐHA lỗi: TimeoutException\nTraceback ...' } }, metaOf });
  assert.deepStrictEqual(errors, ['XN/CĐHA: Lấy XN/CĐHA lỗi: TimeoutException']);
});
test('phần hành chánh của đúng ca bị lỗi → ca đó lỗi; ca khác không', () => {
  const hcProgress = { k1: { status: 'done' }, k2: { status: 'error', error: 'Không tìm thấy BN\nchi tiết' }, k3: { status: 'done' } };
  assert.deepStrictEqual(caseErrorsForBatch({ rows, hcProgress, results: { hchanh: {} }, metaOf }), ['Hồ sơ/y lệnh: Không tìm thấy BN']);
  assert.deepStrictEqual(caseErrorsForBatch({ rows: [{ key: 'k3' }], hcProgress, results: { hchanh: {} }, metaOf }), []);
});
test('không lỗi → ca xong', () => {
  assert.deepStrictEqual(caseErrorsForBatch({ rows, hcProgress: { k1: { status: 'done' }, k2: { status: 'partial' } }, results: { hchanh: {}, xn_cdha: { ok: true } }, metaOf }), []);
});

fs.rmSync(process.env.EMR_RUNTIME_ROOT, { recursive: true, force: true });
console.log(`\n${passed} test(s) passed.`);
