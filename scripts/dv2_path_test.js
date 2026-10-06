#!/usr/bin/env node
'use strict';
// Lỗi cũ: mỗi phiên chép d_v2.json một lần rồi dùng mãi → bản cập nhật luật thuốc không tới phiên cũ.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { resolveDv2Path, PROJECT_DV2 } = require('../server/utils/dv2_path');
const { ensureSessionAssets } = require('../server/services/session');
const { ROOT_DIR } = require('../server/constants');

let failed = 0;
const test = (name, fn) => { try { fn(); console.log(`  ok - ${name}`); } catch (e) { failed += 1; console.error(`  FAIL - ${name}\n`, e); } };
console.log('dv2_path_test');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dv2-'));
test('phiên mới không chép d_v2.json nữa', () => {
  ensureSessionAssets(dir, ROOT_DIR);
  assert.strictEqual(fs.existsSync(path.join(dir, 'd_v2.json')), false);
  assert.strictEqual(resolveDv2Path(dir), PROJECT_DV2);
});
test('bản chép cũ (không đánh dấu) bị bỏ qua → dùng file chung mới nhất', () => {
  fs.writeFileSync(path.join(dir, 'd_v2.json'), JSON.stringify({ '3_LUAT_AN_TOAN_DAC_BIET': {} }));
  assert.strictEqual(resolveDv2Path(dir), PROJECT_DV2);
});
test('bản riêng có "__dung_ban_rieng__": true → giữ', () => {
  fs.writeFileSync(path.join(dir, 'd_v2.json'), JSON.stringify({ __dung_ban_rieng__: true }));
  assert.strictEqual(resolveDv2Path(dir), path.join(dir, 'd_v2.json'));
});
test('không có thư mục phiên → file chung', () => assert.strictEqual(resolveDv2Path(''), PROJECT_DV2));
fs.rmSync(dir, { recursive: true, force: true });
if (failed) { console.error(`${failed} test lỗi`); process.exit(1); }
