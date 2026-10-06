#!/usr/bin/env node
'use strict';
// Quy tắc pha thuốc trong Danh mục thuốc: máy chủ chỉ lưu dữ liệu đúng dạng worker đọc được
// (worker/processing/medication_catalog.py catalog_dilution_rule), báo lỗi tiếng Việt khi sai.
const assert = require('assert');
const { normalizeDilution } = require('../server/routes/medication_catalog');

let failed = 0;
const test = (name, fn) => { try { fn(); console.log(`  ok - ${name}`); } catch (e) { failed += 1; console.error(`  FAIL - ${name}\n`, e); } };
console.log('medication_dilution_rule_test');

test('rỗng → bỏ quy tắc', () => {
  assert.strictEqual(normalizeDilution(null), undefined);
  assert.strictEqual(normalizeDilution(''), undefined);
  assert.strictEqual(normalizeDilution({ solvent: '' }), undefined);
});
test('NaCl 100 ml, chỉ khi truyền', () => {
  assert.deepStrictEqual(normalizeDilution({ solvent: 'nacl_0.9', volume_ml: '100', apply: 'infusion_only' }),
    { solvent: 'NACL_0.9', volume_ml: 100, apply: 'infusion_only' });
});
test('cách áp dụng lạ → luôn pha; ghi chú giữ lại', () => {
  assert.deepStrictEqual(normalizeDilution({ solvent: 'GLUCOSE_5', volume_ml: '250,5', apply: 'x', note: ' Không pha NaCl ' }),
    { solvent: 'GLUCOSE_5', volume_ml: 250.5, apply: 'always', note: 'Không pha NaCl' });
});
test('Không pha: bỏ thể tích', () => {
  assert.deepStrictEqual(normalizeDilution({ solvent: 'KHONG_PHA', volume_ml: 100 }), { solvent: 'KHONG_PHA' });
});
test('sai dung môi/thể tích → lỗi 400 tiếng Việt', () => {
  assert.throws(() => normalizeDilution({ solvent: 'RINGER' }), e => e.status === 400 && /Dung môi pha không hợp lệ/.test(e.message));
  assert.throws(() => normalizeDilution({ solvent: 'NACL_0.9', volume_ml: 5000 }), e => e.status === 400 && /1 đến 1000/.test(e.message));
  assert.throws(() => normalizeDilution('abc'), e => e.status === 400);
});

if (failed) { console.error(`${failed} test lỗi`); process.exit(1); }
