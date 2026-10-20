#!/usr/bin/env node
'use strict';

// Ra viện chỉ có ngày, chưa rõ giờ: màn "Xem trước khi nhập" không được sinh
// phiếu chăm sóc/dịch truyền sau mốc giờ cuối cùng có căn cứ trong ngày ra viện.
// Ca mốc dùng chung với tests/test_discharge_unknown_time.py (worker nhập EMR).
// Chạy: node scripts/discharge_unknown_time_test.js

const assert = require('assert');
const path = require('path');
const { buildPreview, getInferredDischargeCutoff } = require('../server/utils/patient_helpers/preview');

const fixture = require(path.join(__dirname, '..', 'tests', 'fixtures', 'discharge_unknown_time_cases.json'));

function fmt(dt) {
  if (!dt) return null;
  const p = n => String(n).padStart(2, '0');
  return `${p(dt.getHours())}:${p(dt.getMinutes())} ${p(dt.getDate())}/${p(dt.getMonth() + 1)}/${dt.getFullYear()}`;
}

for (const c of fixture.cases) {
  const info = getInferredDischargeCutoff(c.record);
  assert.strictEqual(info ? fmt(info.lastEvidence) : null, c.last_evidence, c.name);
}

// Ca thực tế: ra viện 20/10/2026 chưa rõ giờ, có thuốc 08:00 và 20:00, thay băng,
// dịch truyền 08:00 và 14:00. Trước khi sửa: sinh 08:00, 16:00, 20:00 và cả 05:00 hôm sau.
const record = {
  ma_bn: 'X1',
  ngay_lam: '20/10/2026',
  ngay_ra_vien: '20/10/2026',
  ngay_ra_vien_date: '20/10/2026',
  xu_tri: 'Ra viện',
  care_mode: 'normal',
  thuoc: {
    thuoc_tiem: [{ ten_thuoc: 'Cefazolin 1g', gio_dung: '08:00 20/10/2026, 20:00 20/10/2026' }],
    dich_truyen: [
      { ten_thuoc: 'Natri clorid 0,9% 500ml', the_tich: '500', tg_bat_dau: '08:00 20/10/2026', tg_ket_thuc: '10:00 20/10/2026' },
      { ten_thuoc: 'Ringer lactat 500ml', the_tich: '500', tg_bat_dau: '14:00 20/10/2026', tg_ket_thuc: '16:00 20/10/2026' },
    ],
  },
  chi_dinh_khac: { thay_bang_cat_chi: [{ ten: 'Thay băng, cắt chỉ vết mổ', gio: '08:00 20/10/2026' }] },
};

const preview = buildPreview(record, record.thuoc.dich_truyen, {});
assert.deepStrictEqual(preview.care.map(x => x.time_full), ['08:00 20/10/2026'], 'chỉ còn phiếu chăm sóc 08:00');
assert.deepStrictEqual(preview.infusions.map(x => x.tg_bat_dau), ['20/10/2026 08:00'], 'bỏ dịch truyền bắt đầu sau mốc');

// Có y lệnh ra viện 13:10 trong ngày: giữ dịch truyền đã bắt đầu trước đó, bỏ phần sau.
const withOrders = {
  ...record,
  raw_order_events: [{ ngay_lam: '20/10/2026', gio_y_lenh: '13:10 20/10/2026', text: 'Cho xuất viện' }],
};
const preview2 = buildPreview(withOrders, withOrders.thuoc.dich_truyen, {});
assert.deepStrictEqual(preview2.care.map(x => x.time_full), ['08:00 20/10/2026']);
assert.deepStrictEqual(preview2.infusions.map(x => x.tg_bat_dau), ['20/10/2026 08:00']);

// Không đổi khi chưa ra viện: ngày thường vẫn đủ các mốc.
const normal = { ...record, ngay_ra_vien: '', ngay_ra_vien_date: '', xu_tri: '' };
const preview3 = buildPreview(normal, normal.thuoc.dich_truyen, {});
assert.deepStrictEqual(preview3.care.map(x => x.time_full), ['08:00 20/10/2026', '14:00 20/10/2026', '16:00 20/10/2026', '20:00 20/10/2026', '05:00 21/10/2026']);
assert.strictEqual(preview3.infusions.length, 2);

// Có giờ ra viện thật thì vẫn dùng giờ thật: giữ mục trước 15:00, bỏ chai chạy lố qua giờ ra viện.
const timed = { ...record, ngay_ra_vien: '15:00 20/10/2026', gio_ra_vien: '15:00' };
const preview4 = buildPreview(timed, timed.thuoc.dich_truyen, {});
assert.deepStrictEqual(preview4.care.map(x => x.time_full), ['08:00 20/10/2026', '14:00 20/10/2026']);
assert.deepStrictEqual(preview4.infusions.map(x => x.tg_bat_dau), ['20/10/2026 08:00']);

console.log('discharge_unknown_time_test: OK');
