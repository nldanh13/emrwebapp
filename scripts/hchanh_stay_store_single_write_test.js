#!/usr/bin/env node
'use strict';

// Dữ liệu hành chánh chỉ ghi 1 nơi: Kho người bệnh (SQLite). File JSON hchanh_stays chỉ còn để đọc
// dữ liệu cũ, và là chỗ giữ tạm khi kho tắt hoặc không xếp được đợt (để không mất dữ liệu).
// Chạy: node scripts/hchanh_stay_store_single_write_test.js

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const RUNTIME_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'hchanh_single_write_'));
process.env.EMR_RUNTIME_ROOT = RUNTIME_ROOT;
const patientDb = require('../server/services/patient_db');
const store = require('../server/services/hchanh_stay_store');
const { RESEARCH_STORE_DIR } = require('../server/constants');

if (!patientDb.available()) {
  console.log(`hchanh_stay_store_single_write_test: bỏ qua — ${patientDb.unavailableReason()}`);
  process.exit(process.env.REQUIRE_PATIENT_DB === '1' ? 1 : 0);
}

let failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ok - ${name}`); } catch (err) { failed += 1; console.error(`  FAIL - ${name}\n${err.stack}`); }
}
const jsonFile = maBn => path.join(RESEARCH_STORE_DIR, 'hchanh_stays', `${maBn}.json`);
const files = (vao, ra, extra = {}) => ({
  profile: { _fetch_status: 'ok', ho_ten: 'Người Bệnh Thử', ngay_vao_vien: vao, ...extra },
  discharge: { _fetch_status: 'ok', raw_time: ra, ngay_ra: ra.slice(-10), xu_tri: 'Ra viện' },
});

try {
  test('Lấy dữ liệu hành chánh → ghi vào Kho người bệnh, không tạo file JSON', () => {
    const res = store.recordHchanhFetch('99000101', files('08:00 01/09/2026', '09:00 05/09/2026'), { admission: '08:00 01/09/2026', source: 'hanh_chanh' });
    assert.strictEqual(res.saved, true);
    assert.deepStrictEqual(res.files.sort(), ['discharge', 'profile']);
    assert.ok(res.luot_id, 'trả mã đợt trong kho');
    assert.strictEqual(fs.existsSync(jsonFile('99000101')), false, 'không ghi trùng sang hchanh_stays');
    const hit = store.findStoredStay('99000101', '2026-09-03', ['profile', 'discharge']);
    assert.ok(hit, 'Kho nghiên cứu vẫn tìm thấy đợt để dùng lại');
    assert.deepStrictEqual([hit.from, hit.to], ['2026-09-01', '2026-09-05']);
  });

  test('Dữ liệu gốc của Kho nghiên cứu vẫn thắng dữ liệu tạm thời lấy sau', () => {
    store.recordHchanhFetch('99000102', files('08:00 10/09/2026', '09:00 15/09/2026', { khoa: 'Khoa Gốc' }), { source: 'kho_nghien_cuu' });
    store.recordHchanhFetch('99000102', files('08:00 10/09/2026', '09:00 15/09/2026', { khoa: 'Khoa Tạm' }), { source: 'kiem_ho_so' });
    const hit = store.findStoredStay('99000102', '2026-09-12', ['profile']);
    assert.strictEqual(hit.output.profile.khoa, 'Khoa Gốc');
    assert.strictEqual(hit.sourceKey, 'kho_nghien_cuu_goc');
  });

  test('Không xếp được đợt (khớp 2 đợt) → giữ tạm trong JSON để không mất dữ liệu', () => {
    store.recordHchanhFetch('99000103', files('08:00 01/10/2026', '09:00 03/10/2026'), { source: 'hanh_chanh' });
    store.recordHchanhFetch('99000103', files('15:00 03/10/2026', '10:00 06/10/2026'), { source: 'hanh_chanh' });
    const res = store.recordHchanhFetch('99000103', { discharge: { _fetch_status: 'ok', ngay_ra: '03/10/2026', xu_tri: 'Không rõ đợt' } },
      { admission: '03/10/2026', source: 'kiem_ho_so' });
    assert.strictEqual(res.saved, true);
    assert.strictEqual(res.reason, 'can_xem_dot');
    assert.strictEqual(fs.existsSync(jsonFile('99000103')), true);
  });

  test('Dữ liệu cũ chỉ có trong JSON vẫn đọc được', () => {
    fs.mkdirSync(path.dirname(jsonFile('99000104')), { recursive: true });
    fs.writeFileSync(jsonFile('99000104'), JSON.stringify({ ma_bn: '99000104', stays: [{ from: '2026-08-01', to: '2026-08-05', sources: ['hanh_chanh'],
      files: { discharge: { data: { ngay_ra: '05/08/2026' }, status: 'ok', tier: 'tam_thoi', source: 'hanh_chanh' } } }] }));
    const hit = store.findStoredStay('99000104', '2026-08-02', ['discharge']);
    assert.ok(hit);
    assert.strictEqual(hit.output.discharge.ngay_ra, '05/08/2026');
  });

  test('Tóm tắt kho đếm các đợt trong Kho người bệnh', () => {
    const s = store.storeSummary();
    assert.ok(s.stays >= 4, `có ${s.stays} đợt`);
    assert.ok(s.patients >= 3);
    assert.ok(s.closed_stays >= 4);
  });
} finally {
  patientDb.close();
  fs.rmSync(RUNTIME_ROOT, { recursive: true, force: true });
}

if (failed) { console.error(`hchanh_stay_store_single_write_test: ${failed} lỗi`); process.exit(1); }
console.log('hchanh_stay_store_single_write_test: ok');
