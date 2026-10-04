#!/usr/bin/env node
'use strict';

// Tra cứu có định danh đang khóa: máy chủ chỉ ra đúng bước còn thiếu để bật
// EMR_ALLOW_IDENTIFIED_RESEARCH_EXPORT (không có .env, lỡ lưu .env.txt, thiếu dòng, giá trị tắt,
// chưa khởi động lại). Không trả nội dung file.
// Chạy: node scripts/research_identified_env_test.js

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { identifiedEnvDiagnosis } = require('../server/research/research_http');

let passed = 0;
function test(name, fn) {
  try { fn(); passed += 1; console.log(`  ok - ${name}`); } catch (err) { console.error(`  FAIL - ${name}`); console.error(err); process.exitCode = 1; }
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'identified_env_'));
const env = (text) => fs.writeFileSync(path.join(dir, '.env'), text);

test('không có .env', () => assert.strictEqual(identifiedEnvDiagnosis(dir).reason, 'no_env_file'));
test('Notepad lưu thành .env.txt', () => {
  fs.writeFileSync(path.join(dir, '.env.txt'), 'EMR_ALLOW_IDENTIFIED_RESEARCH_EXPORT=1');
  assert.strictEqual(identifiedEnvDiagnosis(dir).reason, 'saved_as_txt');
});
test('có .env nhưng thiếu dòng', () => { env('PORT=3001\n'); assert.strictEqual(identifiedEnvDiagnosis(dir).reason, 'missing_key'); });
test('giá trị tắt', () => { env('EMR_ALLOW_IDENTIFIED_RESEARCH_EXPORT=0\n'); assert.strictEqual(identifiedEnvDiagnosis(dir).reason, 'value_off'); });
const started = (msAgo) => ({ runtimeValue: undefined, serverStartedAt: Date.now() - msAgo });
test('đã bật (kể cả BOM, khoảng trắng, CRLF), sửa sau lúc máy chủ khởi động → cần khởi động lại', () => {
  env('\uFEFFEMR_ALLOW_IDENTIFIED_RESEARCH_EXPORT = 1\r\n');
  const d = identifiedEnvDiagnosis(dir, started(60000));
  assert.strictEqual(d.reason, 'restart_needed');
  assert.ok(!JSON.stringify(d).includes(dir), 'không lộ đường dẫn máy');
});
test('đã khởi động lại nhưng biến môi trường Windows đặt giá trị khác che mất .env', () => {
  const d = identifiedEnvDiagnosis(dir, { runtimeValue: '0', serverStartedAt: Date.now() + 60000 });
  assert.strictEqual(d.reason, 'overridden_by_env');
  assert.strictEqual(d.runtime_value, '0');
});
test('dòng trùng: dòng sau cùng (giá trị tắt) thắng như lúc máy chủ đọc', () => {
  env('EMR_ALLOW_IDENTIFIED_RESEARCH_EXPORT=1\nPORT=3001\nEMR_ALLOW_IDENTIFIED_RESEARCH_EXPORT=0\n');
  assert.strictEqual(identifiedEnvDiagnosis(dir, started(60000)).reason, 'duplicate_key');
});
test('file lưu bằng mã hóa UTF-16 (Unicode của Notepad)', () => {
  fs.writeFileSync(path.join(dir, '.env'), Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('EMR_ALLOW_IDENTIFIED_RESEARCH_EXPORT=1\n', 'utf16le')]));
  assert.strictEqual(identifiedEnvDiagnosis(dir, started(60000)).reason, 'utf16');
});
test('đã bật, máy chủ khởi động sau khi sửa file mà vẫn không nhận → not_loaded', () => {
  env('EMR_ALLOW_IDENTIFIED_RESEARCH_EXPORT=1\n');
  assert.strictEqual(identifiedEnvDiagnosis(dir, { runtimeValue: undefined, serverStartedAt: Date.now() + 60000 }).reason, 'not_loaded');
});

fs.rmSync(dir, { recursive: true, force: true });
console.log(`\n${passed} test(s) passed.`);
