#!/usr/bin/env node
'use strict';
// Dọn các mục rác "X + Natri clorid 0.9%" trong Danh mục thuốc (ảnh chụp danh mục thật 06/10/2026).
const assert = require('assert');
const { planCleanup, applyCleanup } = require('../server/services/catalog_cleanup');

let failed = 0;
const test = (name, fn) => { try { fn(); console.log(`  ok - ${name}`); } catch (e) { failed += 1; console.error(`  FAIL - ${name}\n`, e); } };
console.log('catalog_cleanup_test');

const CATALOG = [
  { canonical: 'VANCOMYCIN', aliases: ['VANCOMYCIN', 'VANCOMYCIN 1G'], default_volume_ml: 100, default_rate: '30' },
  { canonical: 'BIRONEM 500', aliases: ['BIRONEM 500', 'BIRONEM'], default_volume_ml: 100 },
  { canonical: 'BIRONEM 500 + Natri clorid 0.9%', default_volume_ml: 100, default_rate: '20' },
  { canonical: 'VANCOMYCIN + Natri clorid 0.9%', default_volume_ml: 100, default_rate: '30' },
  { canonical: 'VANCOMYCIN + Sodium chloride 0.9%', default_volume_ml: 250, default_rate: '50' },
  { canonical: 'VANCOMYCIN 500mg + Sodium chloride 0.9%', default_volume_ml: 300, default_rate: '30' },
  { canonical: 'BACQURE 500MG + Natri clorid 0.9%', default_volume_ml: 100, default_rate: '20' },
  { canonical: 'NATRI CLORID 0,9%', default_volume_ml: 500 },
  { canonical: 'CLASTIZOL', dilution: { solvent: 'KHONG_PHA' } },
];

test('chỉ nhận mục "X + dung môi", không đụng NATRI CLORID 0,9% hay thuốc thường', () => {
  const keys = planCleanup(CATALOG).map(p => p.key);
  assert.deepStrictEqual(keys, ['BIRONEM 500 + Natri clorid 0.9%', 'VANCOMYCIN + Natri clorid 0.9%',
    'VANCOMYCIN + Sodium chloride 0.9%', 'VANCOMYCIN 500mg + Sodium chloride 0.9%', 'BACQURE 500MG + Natri clorid 0.9%']);
});

test('gộp vào thuốc gốc; thể tích khác thành cách pha gợi ý; tên mới thành tên khác', () => {
  const plan = planCleanup(CATALOG);
  const p500 = plan.find(p => p.key === 'VANCOMYCIN 500mg + Sodium chloride 0.9%');
  assert.strictEqual(p500.action, 'merge');
  assert.strictEqual(p500.target, 'VANCOMYCIN');
  assert.strictEqual(p500.alias, 'VANCOMYCIN 500mg');
  assert.deepStrictEqual(p500.suggestion, { solvent: 'NACL_0.9', volume_ml: 300, rate: 30, tu: 'VANCOMYCIN 500mg + Sodium chloride 0.9%' });
  const { medications, applied } = applyCleanup(CATALOG, plan);
  assert.strictEqual(applied.length, 5);
  const vanco = medications.find(m => m.canonical === 'VANCOMYCIN');
  assert.ok(vanco.aliases.includes('VANCOMYCIN 500mg'));
  assert.deepStrictEqual(vanco.dilution_suggestions.map(s => s.volume_ml).sort((a, b) => a - b), [100, 250, 300]);
  assert.strictEqual(vanco.sua_tay, true);
  assert.ok(!medications.some(m => /\+/.test(m.canonical)));
});

test('thuốc gốc chưa có → đổi tên, thể tích/tốc độ cũ thành quy tắc pha "chỉ khi truyền"', () => {
  const plan = planCleanup(CATALOG);
  const { medications } = applyCleanup(CATALOG, plan, ['BACQURE 500MG + Natri clorid 0.9%']);
  const bac = medications.find(m => m.canonical === 'BACQURE 500MG');
  assert.deepStrictEqual(bac.dilution, { solvent: 'NACL_0.9', volume_ml: 100, apply: 'infusion_only', rate: 20 });
  assert.strictEqual(bac.default_volume_ml, undefined);
  assert.strictEqual(medications.length, CATALOG.length);   // chỉ áp mục được chọn
});

test('không có gì để dọn', () => {
  assert.deepStrictEqual(planCleanup([{ canonical: 'THERMODOL' }]), []);
});

(async () => {
  // Phát hiện thuốc mới: chạy worker/catalog_gaps.py thật, có bản đệm.
  const fs = require('fs'); const os = require('os'); const path = require('path');
  const { computeNewDrugs } = require('../server/routes/medication_catalog');
  try {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'newdrugs-'));
    const processed = path.join(dir, 'DuLieu_PhanLoai.json');
    fs.writeFileSync(processed, JSON.stringify([{ ngay_lam: '06/10/2026', thuoc: { thuoc_uong: [
      { ten_thuoc: 'THUOC CHUA CO TRONG DANH MUC 10MG', hoat_chat: 'Abc', duong_dung: 'UONG', dang: 'Viên' },
      { ten_thuoc: 'THERMODOL', duong_dung: 'TTM' },
    ] } }]));
    const first = await computeNewDrugs({ dir, PROCESSED_PATH: processed });
    const names = first.drugs.map(d => d.name);
    assert.ok(names.includes('THUOC CHUA CO TRONG DANH MUC 10MG'));
    assert.ok(!names.includes('THERMODOL'));     // đã có trong danh mục
    const second = await computeNewDrugs({ dir, PROCESSED_PATH: processed });
    assert.strictEqual(second.computed_at, first.computed_at);
    fs.rmSync(dir, { recursive: true, force: true });
    console.log('  ok - phát hiện thuốc mới chưa có trong danh mục + bản đệm');
  } catch (e) {
    failed += 1;
    console.error('  FAIL - phát hiện thuốc mới\n', e);
  }
  if (failed) { console.error(`${failed} test lỗi`); process.exit(1); }
})();
