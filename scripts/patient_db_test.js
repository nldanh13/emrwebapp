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

  await test('Nối lượt: tái khám đúng hẹn (±3 ngày), trễ hẹn, khám → nhập viện, tái nhập viện trong 30 ngày, quá hẹn', () => {
    const kham = (kb, time, xuTri, hen, stage = 'xong') => patientDb.recordClinicVisit({
      khambenhid: kb, ma_bn: 'BN10', ho_ten: 'Phạm Văn Hẹn', thoi_gian: time, trang_thai: 'Hoàn tất', xu_tri: xuTri, stage, case: 'cho_ve', services: [],
      details: { status: 'ok', stage, cd_chinh: 'M54.5 - Đau thắt lưng', hen_tai_kham: hen },
    }, { now: '2026-10-30T00:00:00Z' });
    kham('K1', '08:00 01/08/2026', 'Cho về', '15/08/2026');
    kham('K2', '08:00 17/08/2026', 'Cho về', '30/08/2026');          // +2 ngày → đúng hẹn
    kham('K3', '08:00 10/09/2026', 'Nhập viện', '');                  // +11 ngày → trễ hẹn
    patientDb.recordInpatient('BN10', { profile: { ...profile, ngay_vao_vien: '11/09/2026' },
      discharge: discharge('Thoát vị', { raw_time: '08:00 15/09/2026', ngay_ra: '15/09/2026', gio_ra: '08:00', tong_so_ngay_dt: '5', tg_hen_kham: '' }) },
      { from: '2026-09-11', to: '2026-09-15', source: 'kho_nghien_cuu', now: '2026-10-30T00:00:00Z' });
    patientDb.recordInpatient('BN10', { profile: { ...profile, ngay_vao_vien: '01/10/2026' },
      discharge: discharge('Thoát vị tái phát', { raw_time: '08:00 03/10/2026', ngay_ra: '03/10/2026', gio_ra: '08:00', tong_so_ngay_dt: '3', tg_hen_kham: '20/10/2026' }) },
      { from: '2026-10-01', to: '2026-10-03', source: 'kho_nghien_cuu', now: '2026-10-30T00:00:00Z' });

    const links = conn().prepare(`SELECT k.loai, a.khoa_emr ta, b.khoa_emr tb, a.loai la, b.loai lb, k.so_ngay, k.lech_hen
      FROM lien_ket_luot k JOIN luot a ON a.id = k.luot_truoc JOIN luot b ON b.id = k.luot_sau WHERE k.ma_bn = 'BN10' ORDER BY a.gio_vao, k.id`).all()
      .map(r => `${r.loai}:${r.ta || r.la}>${r.tb || r.lb}:${r.so_ngay}:${r.lech_hen ?? ''}`);
    assert.deepStrictEqual(links, [
      'tai_kham_dung_hen:kb:K1>kb:K2:16:2',
      'tai_kham_tre_hen:kb:K2>kb:K3:24:11',
      'kham_nhap_vien:kb:K3>noi_tru:1:',
      'tai_nhap_vien_30:noi_tru>noi_tru:16:',
    ]);

    const rep = patientDb.appointmentReport({ tu: '2026-08-01', den: '2026-10-31', homNay: '2026-10-30' });
    assert.deepStrictEqual(rep.rows.filter(r => r.ma_bn === 'BN10').map(r => `${r.ngay_hen}:${r.trang_thai}`),
      ['2026-08-15:dung_hen', '2026-08-30:tre_hen', '2026-10-20:qua_hen']);
    const early = patientDb.appointmentReport({ tu: '2026-10-20', den: '2026-10-20', homNay: '2026-10-22' });
    assert.strictEqual(early.rows[0].trang_thai, 'chua_den_hen', 'còn trong ±3 ngày → chưa tính quá hẹn');
    assert.strictEqual(rep.tong_ket.ti_le_dung_hen !== null, true);

    const re = patientDb.readmissionReport({ tu: '2026-09-01', den: '2026-10-31', homNay: '2026-10-30' });
    const mine = re.rows.filter(r => r.ma_bn === 'BN10');
    assert.deepStrictEqual(mine.map(r => `${r.gio_ra.slice(0, 10)}:${r.trang_thai}`), ['2026-09-15:tai_nhap_vien', '2026-10-03:chua_du_30_ngay']);
    assert.strictEqual(mine[0].tai_nhap.so_ngay, 16);

    const j = patientDb.patientJourney('BN10');
    assert.strictEqual(j.luot[0].trang_thai_hen.trang_thai, 'dung_hen');
    assert.ok(j.luot[0].lien_ket.length >= 1);
  });

  await test('Tái khám: cùng ngày có cả lượt khám và đợt nhập viện → lượt khám là lượt tái khám', () => {
    patientDb.recordClinicVisit({ khambenhid: 'T1', ma_bn: 'BN12', ho_ten: 'X', thoi_gian: '08:00 01/08/2026', stage: 'xong', xu_tri: 'Cho về', services: [],
      details: { status: 'ok', stage: 'xong', hen_tai_kham: '15/08/2026' } }, { now: '2026-09-01T00:00:00Z' });
    patientDb.recordInpatient('BN12', { profile: { ...profile, ngay_vao_vien: '15/08/2026' } }, { from: '2026-08-15', source: 'hanh_chanh', now: '2026-09-01T00:00:00Z' });
    patientDb.recordClinicVisit({ khambenhid: 'T2', ma_bn: 'BN12', ho_ten: 'X', thoi_gian: '09:00 15/08/2026', stage: 'xong', xu_tri: 'Nhập viện', services: [] }, { now: '2026-09-01T00:00:00Z' });
    const link = conn().prepare(`SELECT b.loai, b.khoa_emr FROM lien_ket_luot k JOIN luot b ON b.id = k.luot_sau
      WHERE k.ma_bn = 'BN12' AND k.loai = 'tai_kham_dung_hen'`).get();
    assert.strictEqual(link.khoa_emr, 'kb:T2');
  });

  await test('Kho tạo từ bản trước (chưa có bảng nối lượt) → mở lại tự tính nối lượt cho mọi người bệnh', () => {
    conn().prepare("UPDATE meta SET value = '1' WHERE key = 'schema_version'").run();
    conn().prepare('DELETE FROM lien_ket_luot').run();
    patientDb.close();
    const n = Number(conn().prepare("SELECT COUNT(*) n FROM lien_ket_luot WHERE ma_bn = 'BN10'").get().n);
    assert.strictEqual(n, 4);
    assert.strictEqual(conn().prepare("SELECT value FROM meta WHERE key = 'schema_version'").get().value, '2');
  });

  await test('Đọc chung: findStay lấy bản gốc trước, onlyGoc bỏ tạm thời, thiếu file thì không trả; findStoredStay đọc kho trước, JSON dự phòng', () => {
    const hit = patientDb.findStay('BN1', '2026-09-03', ['discharge']);
    assert.strictEqual(hit.output.discharge.chan_doan_chinh, 'Thoát vị đĩa đệm');
    assert.deepStrictEqual(hit.provisional_files, []);
    assert.strictEqual(hit.sourceKey, 'kho_nghien_cuu_goc');
    const all = patientDb.findStay('BN1', '2026-09-03', ['profile', 'discharge']);
    assert.deepStrictEqual(all.provisional_files, ['profile']);
    assert.strictEqual(patientDb.findStay('BN1', '2026-09-03', ['profile'], { onlyGoc: true }), null);
    assert.strictEqual(patientDb.findStay('BN1', '2026-09-03', ['surgery']), null);
    assert.strictEqual(patientDb.findStay('BN1', '2026-08-01', ['discharge']), null, 'ngoài đợt');
    assert.strictEqual(patientDb.findStay('BN2', '2026-10-02', ['profile']), null, 'đợt chưa ra viện');

    const { findStoredStay, findStoredStayJson } = require('../server/services/hchanh_stay_store');
    const viaStore = findStoredStay('BN4', '2026-09-03', ['discharge']);
    assert.strictEqual(viaStore.luot_id > 0, true, 'đọc từ kho người bệnh');
    // Đợt chỉ có trong file JSON (vd kho mới tạo) → vẫn tìm được.
    const storeFile = path.join(RUNTIME_ROOT, 'research', 'research_store', 'hchanh_stays', 'JSONONLY.json');
    fs.writeFileSync(storeFile, JSON.stringify({ ma_bn: 'JSONONLY', stays: [{ from: '2026-07-01', to: '2026-07-05', sources: ['hanh_chanh'],
      files: { discharge: { data: { ngay_ra: '05/07/2026' }, tier: 'tam_thoi', source: 'hanh_chanh' } } }] }));
    const fallback = findStoredStay('JSONONLY', '2026-07-02', ['discharge']);
    assert.ok(fallback && !fallback.luot_id, 'dự phòng JSON');
    assert.ok(findStoredStayJson('JSONONLY', '2026-07-02', ['discharge']));
  });

  await test('Lịch sử cho Phòng khám / Hành chánh: hẹn tái khám (đúng / trễ / trước hẹn), tái nhập viện ≤ 30 ngày, bỏ lượt đang xem', () => {
    // BN10: K1 01/08 (hẹn 15/08), K2 17/08 (hẹn 30/08), K3 10/09 (nhập viện), nội trú 11–15/09, nội trú 01–03/10 (hẹn 20/10).
    const onTime = patientDb.patientContext('BN10', { day: '2026-10-21', excludeKhoaEmr: 'kb:NEW' });
    assert.strictEqual(onTime.hen.trang_thai, 'dung_hen');
    assert.strictEqual(onTime.hen.lech_hen, 1);
    assert.strictEqual(onTime.so_luot_kham, 3);
    assert.strictEqual(onTime.so_dot_noi_tru, 2);
    assert.strictEqual(onTime.lan_truoc.loai, 'noi_tru');
    assert.strictEqual(patientDb.patientContext('BN10', { day: '2026-10-30' }).hen.trang_thai, 'tre_hen');
    assert.strictEqual(patientDb.patientContext('BN10', { day: '2026-10-10' }).hen.trang_thai, 'truoc_hen');
    assert.strictEqual(patientDb.patientContext('BN10', { day: '2027-03-01' }).hen, null, 'hẹn quá cũ không còn liên quan');

    // Hành chánh đang xem đợt 01/10: bỏ chính đợt đó; lần ra viện trước 15/09 → tái nhập sau 16 ngày.
    const stay = patientDb.patientContext('BN10', { day: '2026-10-01', loai: 'noi_tru' });
    assert.strictEqual(stay.so_dot_noi_tru, 1);
    assert.strictEqual(stay.ra_vien_gan_nhat.so_ngay, 16);
    assert.strictEqual(stay.ra_vien_gan_nhat.trong_30_ngay, true);
    assert.strictEqual(patientDb.patientContext('KHONGCO', { day: '2026-10-01' }), null);

    const { attachHistory } = require('../server/services/clinic_patient_sync');
    const out = attachHistory({ updated_at: 'x', rows: [{ khambenhid: 'NEW', ma_bn: 'BN10', thoi_gian: '08:00 21/10/2026' }, { khambenhid: 'NEW2', ma_bn: 'KHONGCO', thoi_gian: '08:00 21/10/2026' }] }, { sid: 'h' });
    assert.strictEqual(out.rows[0].lich_su.hen.trang_thai, 'dung_hen');
    assert.strictEqual(out.rows[1].lich_su, null);
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
      assert.strictEqual(r3.benh_nhan, 6);
      const r5 = await (await fetch(`${base}/kho/tai-kham?tu=2026-08-01&den=2026-08-31&trang_thai=tre_hen`)).json();
      assert.deepStrictEqual(r5.rows.map(r => r.ngay_hen), ['2026-08-30']);
      const r6 = await (await fetch(`${base}/kho/tai-nhap-vien?tu=2026-09-01&den=2026-09-30`)).json();
      assert.ok(r6.rows.some(r => r.trang_thai === 'tai_nhap_vien'));
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
