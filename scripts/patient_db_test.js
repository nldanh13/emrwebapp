#!/usr/bin/env node
'use strict';

// Kiểm thử Kho người bệnh (server/services/patient_db.js): gốc thắng tạm thời, không lưu trùng,
// ghép đợt nằm viện, lượt khám Phòng khám (đang khám → Hoàn tất), thao tác, chép từ kho hành chánh, API.
// Chạy: node scripts/patient_db_test.js  (cần Node.js >= 22.13)

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const RUNTIME_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'patient_db_test_'));
process.env.EMR_RUNTIME_ROOT = RUNTIME_ROOT;

const patientDb = require('../server/services/patient_db');

if (!patientDb.available()) {
  // Máy dev còn Node cũ: bỏ qua. CI đặt REQUIRE_PATIENT_DB=1 để bắt buộc chạy.
  console.log(`patient_db_test: bỏ qua — ${patientDb.unavailableReason()}`);
  process.exit(process.env.REQUIRE_PATIENT_DB === '1' ? 1 : 0);
}

const { recordHchanhFetch, syncAllToPatientDb } = require('../server/services/hchanh_stay_store');
const { syncClinicState } = require('../server/services/clinic_patient_sync');

let passed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ok - ${name}`);
  } catch (err) {
    console.error(`  FAIL - ${name}`);
    console.error(err);
    process.exitCode = 1;
  }
}

const conn = () => patientDb.open();
const discharge = (dx, extra = {}) => ({
  ngay_ra: '05/09/2026', gio_ra: '09:30', raw_time: '09:30 05/09/2026', tong_so_ngay_dt: '5',
  chan_doan_chinh: dx, chan_doan_chinh_icd: 'M51.1', chan_doan_vao: 'Đau thắt lưng', benh_kem: ['Tăng huyết áp'],
  xu_tri: 'Ra viện', tg_hen_kham: '12/09/2026', ...extra,
});
const profile = { ho_ten: 'Nguyễn Văn Kho', ngay_sinh: '01/02/1960', gioi_tinh: 'Nam', bhyt_code: 'HT123', khoa: 'Khoa Ngoại', ngay_vao_vien: '01/09/2026' };

async function main() {
  console.log('patient_db_test');

  await test('Nội trú: dữ liệu gốc thắng tạm thời, tạm thời quét sau không thay được; nội dung trùng không lưu lại', () => {
    patientDb.recordInpatient('BN1', { profile, discharge: discharge('Tạm thời') }, { from: '2026-09-01', to: '2026-09-05', source: 'hanh_chanh', now: '2026-09-05T10:00:00Z' });
    patientDb.recordInpatient('BN1', { discharge: discharge('Thoát vị đĩa đệm') }, { from: '2026-09-01', to: '2026-09-05', source: 'kho_nghien_cuu', now: '2026-09-20T10:00:00Z' });
    patientDb.recordInpatient('BN1', { discharge: discharge('Tạm thời mới hơn') }, { from: '2026-09-01', to: '2026-09-05', source: 'kiem_ho_so', now: '2026-09-25T10:00:00Z' });
    const again = patientDb.recordInpatient('BN1', { discharge: discharge('Tạm thời mới hơn') }, { from: '2026-09-01', to: '2026-09-05', source: 'kiem_ho_so', now: '2026-09-26T10:00:00Z' });
    assert.strictEqual(again.new_scans, 0, 'cùng nội dung → không lưu thêm bản');

    const visits = conn().prepare("SELECT * FROM luot WHERE ma_bn = 'BN1'").all();
    assert.strictEqual(visits.length, 1, 'cùng đợt → 1 lượt');
    const l = visits[0];
    assert.strictEqual(l.loai, 'noi_tru');
    assert.strictEqual(l.chan_doan_chinh, 'Thoát vị đĩa đệm');
    assert.strictEqual(l.icd_chinh, 'M51.1');
    assert.strictEqual(l.muc, 'goc');
    assert.strictEqual(l.gio_vao, '2026-09-01');
    assert.strictEqual(l.gio_ra, '2026-09-05 09:30');
    assert.strictEqual(l.trang_thai, 'da_ket_thuc');
    assert.strictEqual(l.hen_tai_kham, '2026-09-12');
    assert.strictEqual(l.khoa, 'Khoa Ngoại');
    assert.strictEqual(l.co_bhyt, 1);
    const scans = conn().prepare('SELECT COUNT(*) n FROM lan_quet WHERE luot_id = ?').get(l.id).n;
    assert.strictEqual(Number(scans), 4, 'profile + 3 bản ra viện khác nhau, không bản nào bị xoá');
    const dx = conn().prepare('SELECT loai, icd, ten FROM chan_doan WHERE luot_id = ? ORDER BY id').all(l.id).map(r => `${r.loai}:${r.ten}`);
    assert.deepStrictEqual(dx, ['ra:Thoát vị đĩa đệm', 'vao:Đau thắt lưng', 'kem:Tăng huyết áp']);
    const bn = conn().prepare("SELECT * FROM benh_nhan WHERE ma_bn = 'BN1'").get();
    assert.strictEqual(bn.nam_sinh, '1960');
    assert.strictEqual(bn.ho_ten_khong_dau, 'nguyen van kho');
  });

  await test('Nội trú: đợt đang nằm rồi ra viện ghép thành 1 lượt; đợt tái nhập viện sau đó là lượt mới', () => {
    patientDb.recordInpatient('BN2', { profile: { ...profile, ngay_vao_vien: '10/09/2026' } }, { from: '2026-09-10', source: 'hanh_chanh', now: '2026-09-11T08:00:00Z' });
    let l = conn().prepare("SELECT * FROM luot WHERE ma_bn = 'BN2'").all();
    assert.strictEqual(l.length, 1);
    assert.strictEqual(l[0].trang_thai, 'dang_dieu_tri');
    patientDb.recordInpatient('BN2', { discharge: discharge('A', { raw_time: '08:00 14/09/2026', ngay_ra: '14/09/2026', gio_ra: '08:00', tong_so_ngay_dt: '5' }) },
      { from: '2026-09-10', to: '2026-09-14', source: 'hanh_chanh', now: '2026-09-14T09:00:00Z' });
    patientDb.recordInpatient('BN2', { profile: { ...profile, ngay_vao_vien: '01/10/2026' } }, { from: '2026-10-01', source: 'hanh_chanh', now: '2026-10-01T09:00:00Z' });
    l = conn().prepare("SELECT * FROM luot WHERE ma_bn = 'BN2' ORDER BY gio_vao").all();
    assert.strictEqual(l.length, 2);
    assert.strictEqual(l[0].trang_thai, 'da_ket_thuc');
    assert.strictEqual(l[0].gio_ra, '2026-09-14 08:00');
    assert.strictEqual(l[1].gio_vao, '2026-10-01');
  });

  const clinicRow = over => ({
    khambenhid: 'KB100', ma_bn: 'BN3', ho_ten: 'Trần Thị Khám', nam_sinh: '1975', has_bhyt: true, doi_tuong: 'BHYT',
    thoi_gian: '08:12 28/09/2026', ly_do: 'Đau gối', trang_thai: 'Đang thực hiện', xu_tri: 'Cho về', noi_thuc_hien: 'Phòng khám Ngoại',
    services: [{ code: 'XN', label: 'Xét nghiệm', done: 1, total: 2 }], stage: 'dang_kham', case: 'cho_ve',
    imaging_orders: [{ kind: 'MRI', name: 'Chụp MRI khớp gối', time: '08:40 28/09/2026' }],
    check: { status: 'waiting', at: 'x' }, next_action: 'Hoàn tất khám', ...over,
  });
  const details = over => ({
    status: 'ok', stage: 'dang_kham', cd_chinh: 'M17.1 - Thoái hóa khớp gối', cd_kem_theo: ['I10 - Tăng huyết áp'],
    ly_do: 'Đau gối phải', thoi_gian_ra: '', hen_tai_kham: '05/10/2026', xu_tri_fields: [{ label: 'Ngày hẹn', value: '05/10/2026' }],
    at: '2026-09-28T08:50:00', ...over,
  });

  await test('Phòng khám: lượt khám đang khám là tạm thời, Hoàn tất thì chốt thành gốc; thao tác gắn đúng lượt', () => {
    const s1 = syncClinicState({ updated_at: '2026-09-28T08:50:00', rows: [clinicRow({ details: details() })], action_log: [] }, { sid: 't' });
    assert.strictEqual(s1.visits, 1);
    let l = conn().prepare("SELECT * FROM luot WHERE khoa_emr = 'kb:KB100'").get();
    assert.strictEqual(l.loai, 'kham');
    assert.strictEqual(l.muc, 'tam_thoi');
    assert.strictEqual(l.trang_thai, 'dang_dieu_tri');
    assert.strictEqual(l.gio_vao, '2026-09-28 08:12');
    assert.strictEqual(l.chan_doan_chinh, 'Thoái hóa khớp gối');
    assert.strictEqual(l.icd_chinh, 'M17.1');
    assert.strictEqual(l.hen_tai_kham, '2026-10-05');

    // Trạng thái không đổi → không chép lại.
    assert.strictEqual(syncClinicState({ updated_at: '2026-09-28T08:50:00', rows: [clinicRow({ details: details() })], action_log: [] }, { sid: 't' }).skipped, true);
    // Chỉ đổi phần hiển thị (check, next_action) → không sinh bản quét mới.
    const s2 = syncClinicState({ updated_at: '2026-09-28T08:53:00', rows: [clinicRow({ details: details(), check: { status: 'ready', at: 'y' }, next_action: 'Khác' })], action_log: [] }, { sid: 't' });
    assert.strictEqual(s2.new_scans, 0);

    const done = clinicRow({ trang_thai: 'Hoàn tất', stage: 'xong', services: [{ code: 'XN', label: 'Xét nghiệm', done: 2, total: 2 }],
      details: details({ stage: 'xong', thoi_gian_ra: '09:30 28/09/2026' }) });
    const log = [{ at: '2026-09-28T09:31:00', kind: 'hoan_tat_kham', khambenhid: 'KB100', ma_bn: 'BN3', ho_ten: 'x', result: 'done', message: 'Đã hoàn tất', steps: ['Lưu'] }];
    const s3 = syncClinicState({ updated_at: '2026-09-28T09:32:00', rows: [done], action_log: log }, { sid: 't' });
    assert.strictEqual(s3.actions, 1);
    l = conn().prepare("SELECT * FROM luot WHERE khoa_emr = 'kb:KB100'").get();
    assert.strictEqual(l.muc, 'goc');
    assert.strictEqual(l.trang_thai, 'da_ket_thuc');
    assert.strictEqual(l.gio_ra, '2026-09-28 09:30');
    const sv = conn().prepare('SELECT nhom, ten, so_da_xong, so_chi_dinh FROM dich_vu WHERE luot_id = ? ORDER BY id').all(l.id);
    assert.deepStrictEqual(sv.map(r => `${r.nhom}:${r.ten}:${r.so_da_xong ?? ''}/${r.so_chi_dinh ?? ''}`), ['XN:Xét nghiệm:2/2', 'MRI:Chụp MRI khớp gối:/']);
    const tt = conn().prepare('SELECT * FROM thao_tac WHERE luot_id = ?').all(l.id);
    assert.strictEqual(tt.length, 1);
    assert.strictEqual(tt[0].loai, 'hoan_tat_kham');
    // Nhật ký cũ gửi lại (vẫn nằm trong action_log) → không ghi trùng.
    syncClinicState({ updated_at: '2026-09-28T09:35:00', rows: [done], action_log: log }, { sid: 't' });
    assert.strictEqual(conn().prepare('SELECT COUNT(*) n FROM thao_tac').get().n, 1);
  });

  await test('Hành chánh lấy dữ liệu → tự chép sang kho; chép toàn bộ kho đợt nằm viện cũ không tạo trùng', () => {
    const output = { profile: { ...profile, ho_ten: 'Lê Văn Chép', _fetch_status: 'ok' }, discharge: { ...discharge('Gãy xương'), _fetch_status: 'ok' } };
    recordHchanhFetch('BN4', output, { source: 'hanh_chanh', now: '2026-09-06T00:00:00Z' });
    const l = conn().prepare("SELECT * FROM luot WHERE ma_bn = 'BN4'").all();
    assert.strictEqual(l.length, 1);
    assert.strictEqual(l[0].chan_doan_chinh, 'Gãy xương');
    const before = Number(conn().prepare('SELECT COUNT(*) n FROM lan_quet').get().n);
    const res = syncAllToPatientDb();
    assert.ok(res.ok);
    assert.strictEqual(res.new_scans, 0, 'kho đã có đủ → không thêm bản nào');
    assert.strictEqual(Number(conn().prepare('SELECT COUNT(*) n FROM lan_quet').get().n), before);
  });

  await test('Tra cứu: tìm không dấu, hành trình theo thời gian, danh sách lượt theo ngày/loại, API', async () => {
    const found = patientDb.searchPatients('tran thi');
    assert.deepStrictEqual(found.map(r => r.ma_bn), ['BN3']);
    const j = patientDb.patientJourney('BN2');
    assert.strictEqual(j.luot.length, 2);
    assert.ok(j.luot[0].gio_vao < j.luot[1].gio_vao);
    const kham = patientDb.listVisits({ tu: '2026-09-28', den: '2026-09-28', loai: 'kham' });
    assert.strictEqual(kham.total, 1);

    const express = require('express');
    const app = express();
    app.use((req, _res, next) => { req.auth = { role: 'admin' }; next(); });
    app.use('/api', require('../server/routes/patient_db'));
    const server = await new Promise(resolve => { const s = app.listen(0, () => resolve(s)); });
    const base = `http://127.0.0.1:${server.address().port}/api`;
    try {
      const r1 = await (await fetch(`${base}/kho/benh-nhan/BN3`)).json();
      assert.strictEqual(r1.luot[0].chan_doan.map(d => d.icd).join(','), 'M17.1,I10');
      assert.strictEqual(r1.luot[0].thao_tac.length, 1);
      const r2 = await fetch(`${base}/kho/benh-nhan/KHONGCO`);
      assert.strictEqual(r2.status, 404);
      const r3 = await (await fetch(`${base}/kho/tong-quan`)).json();
      assert.strictEqual(r3.benh_nhan, 4);
      const r4 = await (await fetch(`${base}/kho/dong-bo`, { method: 'POST' })).json();
      assert.strictEqual(r4.status, 'ok');
    } finally {
      server.close();
    }
  });

  patientDb.close();
  fs.rmSync(RUNTIME_ROOT, { recursive: true, force: true });
  console.log(`\n${passed} kịch bản pass.`);
  if (process.exitCode) process.exit(1);
}

main();
