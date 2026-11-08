#!/usr/bin/env node
'use strict';

// Kho người bệnh: phân biệt đợt nằm viện bằng giờ vào viện và giờ ra viện (quyết định ngày
// 08/11/2026). Trước đây đợt được ghép theo khoảng NGÀY giao nhau, nên ra viện sáng rồi nhập viện
// lại chiều cùng ngày bị gộp thành 1 đợt. Chạy: node scripts/patient_db_stay_key_test.js

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const RUNTIME_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'patient_db_stay_key_'));
process.env.EMR_RUNTIME_ROOT = RUNTIME_ROOT;
const patientDb = require('../server/services/patient_db');

if (!patientDb.available()) {
  console.log(`patient_db_stay_key_test: bỏ qua — ${patientDb.unavailableReason()}`);
  process.exit(process.env.REQUIRE_PATIENT_DB === '1' ? 1 : 0);
}

let failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ok - ${name}`); } catch (err) { failed += 1; console.error(`  FAIL - ${name}\n${err.stack}`); }
}
const stays = maBn => patientDb.open().prepare("SELECT * FROM luot WHERE ma_bn = ? AND loai = 'noi_tru' ORDER BY gio_vao, id").all(maBn);
const profile = (vao, extra = {}) => ({ ho_ten: 'Người Bệnh Thử', khoa: 'Khoa Ngoại', ngay_vao_vien: vao, ...extra });
const discharge = (ra, extra = {}) => ({ raw_time: ra, chan_doan_chinh: 'Gãy xương', xu_tri: 'Ra viện', ...extra });

try {
  test('Ra viện sáng, nhập viện lại chiều cùng ngày → 2 đợt riêng', () => {
    patientDb.recordInpatient('BNA', { profile: profile('08:00 01/09/2026'), discharge: discharge('09:00 05/09/2026') },
      { from: '2026-09-01', to: '2026-09-05', source: 'hanh_chanh', now: '2026-09-05T10:00:00Z' });
    patientDb.recordInpatient('BNA', { profile: profile('15:00 05/09/2026') },
      { from: '2026-09-05', source: 'hanh_chanh', now: '2026-09-05T16:00:00Z' });
    const l = stays('BNA');
    assert.strictEqual(l.length, 2, 'hai đợt khác giờ vào viện không được gộp');
    assert.deepStrictEqual(l.map(x => [x.gio_vao, x.gio_ra]), [['2026-09-01 08:00', '2026-09-05 09:00'], ['2026-09-05 15:00', '']]);
    assert.deepStrictEqual(l.map(x => x.trang_thai), ['da_ket_thuc', 'dang_dieu_tri']);
  });

  test('Lần quét sau của cùng đợt (cùng giờ vào viện, chuyển khoa) → vẫn 1 đợt, giữ giờ vào viện đến phút', () => {
    patientDb.recordInpatient('BNB', { profile: profile('07:30 10/09/2026') }, { from: '2026-09-10', source: 'hanh_chanh', now: '2026-09-10T08:00:00Z' });
    patientDb.recordInpatient('BNB', { profile: profile('07:30 10/09/2026', { khoa: 'Khoa Hồi sức' }) }, { from: '2026-09-10', source: 'hanh_chanh', now: '2026-09-12T08:00:00Z' });
    patientDb.recordInpatient('BNB', { discharge: discharge('10:00 15/09/2026', { ngay_vao_vien: '07:30 10/09/2026' }) },
      { from: '2026-09-10', to: '2026-09-15', source: 'kiem_ho_so', now: '2026-09-16T08:00:00Z' });
    const l = stays('BNB');
    assert.strictEqual(l.length, 1);
    assert.deepStrictEqual([l[0].gio_vao, l[0].gio_ra, l[0].khoa], ['2026-09-10 07:30', '2026-09-15 10:00', 'Khoa Hồi sức']);
  });

  test('Bản chỉ có ngày (không giờ) ghép vào đợt chứa ngày đó', () => {
    const res = patientDb.recordInpatient('BNB', { discharge: discharge('15/09/2026', { chan_doan_chinh: 'Bản chỉ có ngày' }) },
      { from: '2026-09-12', to: '2026-09-15', source: 'kho_nghien_cuu', now: '2026-09-20T08:00:00Z' });
    assert.strictEqual(res.saved, true);
    assert.strictEqual(stays('BNB').length, 1);
    assert.strictEqual(stays('BNB')[0].gio_vao, '2026-09-10 07:30', 'không làm mất giờ vào viện');
  });

  test('Ra viện sáng, nhập lại chiều cùng ngày → tính là tái nhập viện 0 ngày', () => {
    const l = stays('BNA');
    const links = patientDb.open().prepare("SELECT luot_truoc, luot_sau, so_ngay FROM lien_ket_luot WHERE ma_bn = 'BNA' AND loai = 'tai_nhap_vien_30'").all();
    assert.deepStrictEqual(links.map(x => [x.luot_truoc, x.luot_sau, x.so_ngay]), [[l[0].id, l[1].id, 0]]);
    const report = patientDb.readmissionReport({ tu: '2026-09-05', den: '2026-09-05', homNay: '2026-11-08' });
    assert.strictEqual(report.tong_ket.tai_nhap_vien, 1);
  });

  test('Vào viện trước giờ ra viện của đợt khác (dữ liệu chồng giờ) → không tính tái nhập', () => {
    patientDb.recordInpatient('BND', { profile: profile('08:00 01/10/2026'), discharge: discharge('16:00 03/10/2026') },
      { from: '2026-10-01', to: '2026-10-03', source: 'hanh_chanh', now: '2026-10-03T17:00:00Z' });
    patientDb.recordInpatient('BND', { profile: profile('10:00 03/10/2026'), discharge: discharge('09:00 06/10/2026') },
      { from: '2026-10-03', to: '2026-10-06', source: 'hanh_chanh', now: '2026-10-06T10:00:00Z' });
    assert.strictEqual(stays('BND').length, 2);
    const n = patientDb.open().prepare("SELECT COUNT(*) n FROM lien_ket_luot WHERE ma_bn = 'BND' AND loai = 'tai_nhap_vien_30'").get().n;
    assert.strictEqual(Number(n), 0);
  });

  test('Bản chỉ có ngày mà ngày đó thuộc 2 đợt → không tự gộp, báo cần xem', () => {
    const before = stays('BNA').length;
    const res = patientDb.recordInpatient('BNA', { discharge: discharge('05/09/2026', { chan_doan_chinh: 'Không rõ đợt' }) },
      { from: '2026-09-05', to: '2026-09-05', source: 'kiem_ho_so', now: '2026-09-21T08:00:00Z' });
    assert.strictEqual(res.saved, false);
    assert.strictEqual(res.reason, 'can_xem_dot');
    assert.strictEqual(stays('BNA').length, before, 'không tạo đợt mới, không gộp nhầm');
  });

  test('Đợt cũ lưu chỉ có ngày vào được nâng lên giờ vào viện khi biết, không tạo đợt trùng', () => {
    patientDb.recordInpatient('BNC', { discharge: discharge('09:00 20/09/2026') }, { from: '2026-09-18', to: '2026-09-20', source: 'kiem_ho_so', now: '2026-09-20T10:00:00Z' });
    patientDb.recordInpatient('BNC', { profile: profile('22:15 18/09/2026') }, { from: '2026-09-18', to: '2026-09-20', source: 'kho_nghien_cuu', now: '2026-09-25T10:00:00Z' });
    const l = stays('BNC');
    assert.strictEqual(l.length, 1);
    assert.strictEqual(l[0].gio_vao, '2026-09-18 22:15');
  });
} finally {
  patientDb.close();
  fs.rmSync(RUNTIME_ROOT, { recursive: true, force: true });
}

if (failed) { console.error(`patient_db_stay_key_test: ${failed} lỗi`); process.exit(1); }
console.log('patient_db_stay_key_test: OK');
