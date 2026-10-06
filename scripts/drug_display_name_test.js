#!/usr/bin/env node
'use strict';
// Tên thuốc ở bản xem trước "Nhập dịch truyền" (server/utils/patient_helpers/drugs.js).
// Lỗi cũ: từ điển tên khác có "NATRI", "0,9%" khớp cả phần dung môi → "VANCOMYCIN 1G + Natri clorid
// 0.9%" hiện thành "Natri clorid 0,9% 100ml" (mất tên thuốc chính).
const assert = require('assert');
const { buildDrugDisplayName, resolveCanonicalDrugName } = require('../server/utils/patient_helpers/drugs');

let failed = 0;
const test = (name, fn) => { try { fn(); console.log(`  ok - ${name}`); } catch (e) { failed += 1; console.error(`  FAIL - ${name}\n`, e); } };
console.log('drug_display_name_test');
const show = t => buildDrugDisplayName({ ten_hien_thi: t, ten_thuoc: t });

test('thuốc pha Natri clorid giữ tên thuốc chính', () => {
  assert.strictEqual(show('VANCOMYCIN 1G + Natri clorid 0.9%'), 'VANCOMYCIN 1G + Natri clorid 0.9%');
  assert.strictEqual(show('MEROVIA 1G + Natri clorid 0.9%'), 'MEROVIA 1G + Natri clorid 0.9%');
  assert.strictEqual(show('CEFTRIAXONE 1G + Natri clorid 0.9%'), 'CEFTRIAXONE 1G + Natri clorid 0.9%');
});
test('Nefopam pha Natri clorid → tên chuẩn Nefopam', () => {
  assert.strictEqual(show('NEFOPAM MEDISOL 20MG/2ML + Natri clorid 0.9%'), 'Nefopam 20MG');
});
test('"natri" trong tên hoạt chất không thành Natri clorid', () => {
  assert.strictEqual(resolveCanonicalDrugName('Diclofenac natri 75mg'), null);
});
test('giữ các tên chuẩn đã đúng', () => {
  assert.strictEqual(show('THERMODOL'), 'Paracetamol 10mg/ml');
  assert.strictEqual(show('DEGEVIC'), 'Paracetamol + Tramadol');
  assert.strictEqual(show('SOLU-MEDROL 40MG'), 'Methylprednisolon 40MG');
  assert.strictEqual(show('NATRI CLORID 0,9% 100ml'), 'Natri clorid 0,9% 100ml');
});
test('chai Natri clorid 500ml không hiện thành 100ml mặc định', () => {
  assert.strictEqual(show('NATRI CLORID 0,9% 500ml'), 'Natri clorid 0,9% 500ml');
  assert.strictEqual(show('NATRI CLORID 0,9%'), 'Natri clorid 0,9% 100ml');
  assert.strictEqual(show('Glucose 5% 500ml'), 'Glucose 5% 500ml');
});
if (failed) { console.error(`${failed} test lỗi`); process.exit(1); }
