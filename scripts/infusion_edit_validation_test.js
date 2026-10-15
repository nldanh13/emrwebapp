'use strict';
const assert = require('node:assert/strict');
const { infusionItemKey, parsePositiveInfusionValue, matchAndUpdateInfusions } = require('../server/utils/infusion_edit_validation');

assert.equal(parsePositiveInfusionValue('2,5', 'Thể tích'), 2.5);
assert.equal(parsePositiveInfusionValue('30', 'Tốc độ'), 30);
for (const bad of ['', '0', '-5', '20giọt', 'Infinity', 'NaN']) {
  assert.throws(() => parsePositiveInfusionValue(bad, 'Thể tích'));
}
const example = {
  ten_thuoc: 'TEST-DRUG', bac_si: 'DOCTOR',
  tg_bat_dau: '08:00 15/10/2026', tg_ket_thuc: '09:07 15/10/2026',
  the_tich: 100, toc_do: 30, toc_do_inferred: true,
};
const row = (list, bn = 'FAKE001') => ({ma_bn: bn, ngay_lam: '15/10/2026', thuoc: {dich_truyen:list}});
const id = r => r.ma_bn;
const date = r => r.ngay_lam;
const wrong = [row([{...example}])];
assert.deepEqual(matchAndUpdateInfusions(wrong, 'FAKE002', '15/10/2026', example,
  {toc_do:25}, id, date), {matched:0, updated:false});
const duplicate = [row([{...example},{...example}])];
assert.deepEqual(matchAndUpdateInfusions(duplicate, 'FAKE001', '15/10/2026', example,
  {toc_do:25}, id,date), {matched:2, updated:false});
assert.equal(duplicate[0].thuoc.dich_truyen[0].toc_do, 30);
const selected = [row([{...example}])];
assert.deepEqual(matchAndUpdateInfusions(selected, 'FAKE001', '15/10/2026', example,
  {toc_do:25,the_tich:120}, id,date), {matched:1, updated:true});
assert.equal(selected[0].thuoc.dich_truyen[0].toc_do, 25);
assert.equal(selected[0].thuoc.dich_truyen[0].toc_do_inferred, false);
assert.equal(selected[0].thuoc.dich_truyen[0].infusion_schedule_stale, true);
assert.equal(selected[0].thuoc.dich_truyen[0].tg_ket_thuc, '09:07 15/10/2026');
assert.ok(infusionItemKey(example).includes('test-drug'));
console.log('infusion edit safety: OK');
