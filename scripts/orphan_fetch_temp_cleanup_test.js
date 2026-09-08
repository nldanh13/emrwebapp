#!/usr/bin/env node
'use strict';

// Kiểm thử: cleanOrphanFetchTempFiles() (server/services/session.js) chỉ xoá
// file fetch_input_*/fetch_output_* đã đủ cũ trong hchanh/ của mọi session —
// không đụng vào file mới (có thể đang được worker Python xử lý dở) và không
// đụng vào file khác tên.
// Chạy: node scripts/orphan_fetch_temp_cleanup_test.js

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const RUNTIME_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'orphan_fetch_temp_test_'));
process.env.EMR_RUNTIME_ROOT = RUNTIME_ROOT;

const { cleanOrphanFetchTempFiles } = require('../server/services/session');

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

function touch(file, ageMs) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '{}');
  if (ageMs) {
    const past = new Date(Date.now() - ageMs);
    fs.utimesSync(file, past, past);
  }
}

function main() {
  console.log('orphan_fetch_temp_cleanup_test');

  const DAY = 24 * 60 * 60 * 1000;
  const oldInputDefault = path.join(RUNTIME_ROOT, 'hchanh', 'fetch_input_OLD001.json');
  const oldOutputSession = path.join(RUNTIME_ROOT, 'sessions', 'abc123', 'hchanh', 'fetch_output_OLD002.json');
  const freshInput = path.join(RUNTIME_ROOT, 'hchanh', 'fetch_input_FRESH001.json');
  const unrelatedFile = path.join(RUNTIME_ROOT, 'hchanh', 'index.json');

  touch(oldInputDefault, 2 * DAY);
  touch(oldOutputSession, 3 * DAY);
  touch(freshInput, 5 * 60 * 1000);
  touch(unrelatedFile, 2 * DAY);

  const result = cleanOrphanFetchTempFiles();

  test('xoá file fetch_input cũ ở session mặc định (.runtime/hchanh)', () => {
    assert.strictEqual(fs.existsSync(oldInputDefault), false);
  });

  test('xoá file fetch_output cũ ở session con (sessions/<sid>/hchanh)', () => {
    assert.strictEqual(fs.existsSync(oldOutputSession), false);
  });

  test('không đụng file fetch_input mới tạo (có thể đang xử lý dở)', () => {
    assert.strictEqual(fs.existsSync(freshInput), true);
  });

  test('không đụng file khác tên (index.json)', () => {
    assert.strictEqual(fs.existsSync(unrelatedFile), true);
  });

  test('kết quả trả về đúng số lượng đã xoá', () => {
    assert.strictEqual(result.removed, 2);
  });

  fs.rmSync(RUNTIME_ROOT, { recursive: true, force: true });

  console.log(`\n${passed} kịch bản pass.`);
  if (process.exitCode) {
    console.error('CÓ KỊCH BẢN FAIL.');
    process.exit(1);
  }
}

main();
