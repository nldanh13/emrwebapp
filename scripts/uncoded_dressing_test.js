#!/usr/bin/env node
'use strict';

// "Thay băng vết mổ (CHƯA LÊN MÃ)" không được ghi vào phiếu chăm sóc ở màn xem
// trước; chỉ hiện cảnh báo bên ngoài. Worker nhập EMR cùng quy tắc
// (tests/test_uncoded_dressing.py).
// Chạy: node scripts/uncoded_dressing_test.js

const assert = require('assert');
const { buildPatientDayBundle, stripUncodedDressing } = require('../server/utils/patient_helpers/bundle');
const { fingerprintRecords } = require('../server/utils/done_state');

const base = {
  ma_bn: 'X1',
  ngay_lam: '20/10/2026',
  care_mode: 'normal',
  thuoc: { thuoc_tiem: [{ ten_thuoc: 'Cefazolin 1g', gio_dung: '08:00 20/10/2026' }] },
};

// Dữ liệu cũ: còn mục giữ chỗ trong thay_bang_cat_chi.
const oldRecord = {
  ...base,
  chi_dinh_khac: {
    thay_bang_cat_chi: [{ ten: 'Thay băng vết mổ (CHƯA LÊN MÃ)', gio: '08:00 20/10/2026' }],
    canh_bao: ["⚠ CẢNH BÁO: Có y lệnh 'Thay băng' nhưng chưa lên Mã DVKT!"],
  },
};
const bundle = buildPatientDayBundle([oldRecord], 'X1', '20/10/2026', {});
const previewText = JSON.stringify(bundle.preview);
assert.ok(!/CHƯA LÊN MÃ/i.test(previewText), 'xem trước không còn chữ CHƯA LÊN MÃ');
assert.strictEqual(bundle.dressing_without_dvkt, true, 'có cờ cảnh báo bên ngoài');
assert.ok(bundle.processing_warnings.some(w => w.code === 'dressing_without_dvkt'));
assert.deepStrictEqual(bundle.task_hashes.care, fingerprintRecords([oldRecord], 'care'), 'không đổi dấu đã nhập');

// Dữ liệu mới: bộ phân loại chỉ để lại cảnh báo.
const newRecord = { ...base, chi_dinh_khac: { thay_bang_cat_chi: [], canh_bao: oldRecord.chi_dinh_khac.canh_bao } };
assert.strictEqual(buildPatientDayBundle([newRecord], 'X1', '20/10/2026', {}).dressing_without_dvkt, true);

// Đã lên mã thay băng trong DVKT: không cảnh báo, giữ mục có mã.
const coded = {
  ...base,
  chi_dinh_dvkt: [{ ten: 'Thay băng vết mổ chiều dài ≤ 15cm', gio: '08:00 20/10/2026' }],
  chi_dinh_khac: { thay_bang_cat_chi: [
    { ten: 'Thay băng vết mổ chiều dài ≤ 15cm', gio: '08:00 20/10/2026' },
    { ten: 'Thay băng vết mổ (CHƯA LÊN MÃ)', gio: '08:00 20/10/2026' },
  ] },
};
const { rows, warning } = stripUncodedDressing([coded]);
assert.strictEqual(warning, null);
assert.deepStrictEqual(rows[0].chi_dinh_khac.thay_bang_cat_chi.map(x => x.ten), ['Thay băng vết mổ chiều dài ≤ 15cm']);

// Không có thay băng: giữ nguyên bản ghi, không cảnh báo.
const plain = stripUncodedDressing([base]);
assert.strictEqual(plain.rows[0], base);
assert.strictEqual(plain.warning, null);

console.log('uncoded_dressing_test: OK');
