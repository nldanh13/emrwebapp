#!/usr/bin/env node
'use strict';
// Quy tắc pha thuốc trong Danh mục thuốc: máy chủ chỉ lưu dữ liệu đúng dạng worker đọc được
// (worker/processing/medication_catalog.py catalog_dilution_rule), báo lỗi tiếng Việt khi sai.
const assert = require('assert');
const { normalizeDilution, cleanCheckItems, runDilutionCheck, computeDilutionStats } = require('../server/routes/medication_catalog');
const fs = require('fs');
const os = require('os');
const path = require('path');

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

test('nhiều cách pha: chuẩn hoá và kiểm điều kiện', () => {
  const out = normalizeDilution({ solvent: 'NACL_0.9', volume_ml: 100, variants: [
    { route: 'se', solvent: 'NACL_0.9', volume_ml: '50' },
    { dose_min_mg: '501', solvent: 'NACL_0.9', volume_ml: 200, rate: 30 },
    { solvent: '' },
  ] });
  assert.deepStrictEqual(out.variants, [
    { solvent: 'NACL_0.9', route: 'SE', volume_ml: 50 },
    { solvent: 'NACL_0.9', dose_min_mg: 501, volume_ml: 200, rate: 30 },
  ]);
  assert.throws(() => normalizeDilution({ solvent: 'NACL_0.9', variants: [{ solvent: 'NACL_0.9', volume_ml: 50 }] }), e => /ít nhất một điều kiện/.test(e.message));
  assert.throws(() => normalizeDilution({ solvent: 'NACL_0.9', variants: [{ solvent: 'NACL_0.9', dose_min_mg: 900, dose_max_mg: 500 }] }), e => /lớn hơn/.test(e.message));
  assert.strictEqual(normalizeDilution({ solvent: 'KHONG_PHA', variants: [{ route: 'SE', solvent: 'NACL_0.9' }] }).variants, undefined);
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
  try {
    // Thống kê cách pha thực tế từ dữ liệu đã xử lý của phiên; lần 2 dùng bản đệm (không chạy lại Python).
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dstats-'));
    const processed = path.join(dir, 'DuLieu_PhanLoai.json');
    fs.writeFileSync(processed, JSON.stringify([{ thuoc: { dich_truyen: [
      { ten_thuoc: 'MEROVIA 1G', dung_moi: 'NACL_0.9', the_tich: 100, nguon_pha: 'y_lenh', duong_dung_goc: 'TTM', so_luong: '1', gio_dung: '8 giờ' },
    ] } }]));
    const ctx = { dir, PROCESSED_PATH: processed };
    const first = await computeDilutionStats(ctx);
    const mero = first.drugs.find(d => d.drug === 'MEROVIA 1G' || /MEROVIA/.test(d.drug));
    assert.ok(mero && mero.observed_total === 1);
    assert.ok(fs.existsSync(path.join(dir, 'dilution_stats_cache.json')));
    const second = await computeDilutionStats(ctx);
    assert.strictEqual(second.computed_at, first.computed_at);
    fs.rmSync(dir, { recursive: true, force: true });
    console.log('  ok - thống kê cách pha thực tế + bản đệm');
  } catch (e) {
    failed += 1;
    console.error('  FAIL - thống kê cách pha thực tế\n', e);
  }
  if (failed) { console.error(`${failed} test lỗi`); process.exit(1); }
})();
