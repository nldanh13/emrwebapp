#!/usr/bin/env node
'use strict';
// Quy tắc pha thuốc trong Danh mục thuốc: máy chủ chỉ lưu dữ liệu đúng dạng worker đọc được
// (worker/processing/medication_catalog.py catalog_dilution_rule), báo lỗi tiếng Việt khi sai.
const assert = require('assert');
const { normalizeDilution, cleanCheckItems, runDilutionCheck } = require('../server/routes/medication_catalog');

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

test('tốc độ truyền 1–300 giọt/phút', () => {
  assert.strictEqual(normalizeDilution({ solvent: 'NACL_0.9', volume_ml: 100, rate: '40' }).rate, 40);
  assert.throws(() => normalizeDilution({ solvent: 'NACL_0.9', rate: 999 }), e => e.status === 400 && /giọt\/phút/.test(e.message));
});
test('kiểm tra thử chỉ nhận trường cần thiết, tối đa 20 dòng', () => {
  const items = cleanCheckItems([{ ten_thuoc: ' VANCOMYCIN 1G ', mat_khau: 'x' }, null, ...Array(30).fill({ ten_thuoc: 'A' })]);
  assert.deepStrictEqual(items[0], { ten_thuoc: 'VANCOMYCIN 1G' });
  assert.ok(items.length <= 20);
});

(async () => {
  // Chạy worker thật: cùng hàm bước xử lý dữ liệu dùng.
  try {
    const data = await runDilutionCheck(null, { items: [{ ten_thuoc: 'VANCOMYCIN 1G', dang: 'Lọ', duong_dung_goc: 'Tiêm truyền TM' }], catalog_names: [] });
    assert.strictEqual(data.items[0].moved_to_infusion, true);
    assert.strictEqual(data.items[0].dung_moi, 'NACL_0.9');
    assert.ok(['danh_muc', 'luat_san_co'].includes(data.items[0].nguon_pha));
    assert.ok(Array.isArray(data.builtin) && data.builtin.length > 0);
    console.log('  ok - kiểm tra thử chạy đúng bước xử lý của worker');
  } catch (e) {
    failed += 1;
    console.error('  FAIL - kiểm tra thử chạy worker\n', e);
  }
  if (failed) { console.error(`${failed} test lỗi`); process.exit(1); }
})();
