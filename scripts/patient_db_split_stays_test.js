#!/usr/bin/env node
'use strict';

// Tách các đợt nằm viện bị gộp nhầm bởi quy tắc cũ (ghép theo ngày giao nhau).
// Chạy: node scripts/patient_db_split_stays_test.js

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const RUNTIME_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'patient_db_split_'));
process.env.EMR_RUNTIME_ROOT = RUNTIME_ROOT;
const patientDb = require('../server/services/patient_db');

if (!patientDb.available()) {
  console.log(`patient_db_split_stays_test: bỏ qua — ${patientDb.unavailableReason()}`);
  process.exit(process.env.REQUIRE_PATIENT_DB === '1' ? 1 : 0);
}

let failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ok - ${name}`); } catch (err) { failed += 1; console.error(`  FAIL - ${name}\n${err.stack}`); }
}
const conn = patientDb.open();
const stays = maBn => conn.prepare("SELECT * FROM luot WHERE ma_bn = ? AND loai = 'noi_tru' ORDER BY gio_vao, id").all(maBn);
const scanCount = luotId => Number(conn.prepare('SELECT COUNT(*) n FROM lan_quet WHERE luot_id = ?').get(luotId).n);

// Dựng lại đúng trạng thái kho cũ: 1 lượt chứa 2 lần ghi của 2 đợt khác giờ vào viện.
function legacyMergedStay(maBn) {
  const luotId = Number(conn.prepare(`INSERT INTO luot (ma_bn, loai, khoa_emr, gio_vao, gio_ra, trang_thai, tao_luc, cap_nhat_luc)
    VALUES (?, 'noi_tru', NULL, '2026-09-01', '2026-09-08 11:00', 'da_ket_thuc', 'x', 'x')`).run(maBn).lastInsertRowid);
  const ins = conn.prepare(`INSERT INTO lan_quet (ma_bn, luot_id, loai, nguon, muc, lay_luc, trang_thai, hash, du_lieu)
    VALUES (?, ?, ?, 'hanh_chanh', 'tam_thoi', ?, 'ok', ?, ?)`);
  const put = (loai, at, data) => ins.run(maBn, luotId, loai, at, patientDb.contentHash(data), JSON.stringify(data));
  // Đợt 1: vào 08:00 01/09, ra 09:00 05/09.
  put('profile', '2026-09-05T10:00:00Z', { ho_ten: 'Người Bệnh Thử', khoa: 'Khoa Ngoại', ngay_vao_vien: '08:00 01/09/2026' });
  put('discharge', '2026-09-05T10:00:00Z', { raw_time: '09:00 05/09/2026', chan_doan_chinh: 'Đợt một' });
  put('cls', '2026-09-05T10:00:00Z', { status: 'ok', results: [{ ten_dv: 'XN đợt một' }] });
  // Đợt 2: vào 15:00 05/09, ra 11:00 08/09.
  put('profile', '2026-09-08T12:00:00Z', { ho_ten: 'Người Bệnh Thử', khoa: 'Khoa Nội', ngay_vao_vien: '15:00 05/09/2026' });
  put('discharge', '2026-09-08T12:00:00Z', { raw_time: '11:00 08/09/2026', chan_doan_chinh: 'Đợt hai' });
  put('cls', '2026-09-08T12:00:00Z', { status: 'ok', results: [{ ten_dv: 'XN đợt hai' }] });
  // Lần ghi không có giờ vào viện, phiếu ra viện 08/09 → chỉ thuộc đợt 2.
  put('discharge', '2026-09-09T08:00:00Z', { raw_time: '11:00 08/09/2026', chan_doan_chinh: 'Đợt hai', ghi_chu: 'bản sau' });
  put('bed_days', '2026-09-09T08:00:00Z', { status: 'ok', so_ngay: 4 });
  // Lần ghi không có gì để xác định đợt → giữ ở đợt vào sớm nhất và được báo.
  put('billing', '2026-09-10T08:00:00Z', { status: 'ok', tong: 1 });
  return luotId;
}

try {
  const oldId = legacyMergedStay('BNTACH');
  patientDb.recordInpatient('BNDUNG', { profile: { ho_ten: 'Người Bệnh Khác', ngay_vao_vien: '07:00 02/09/2026' } },
    { from: '2026-09-02', source: 'hanh_chanh', now: '2026-09-02T08:00:00Z' });

  test('Đếm: chỉ báo lượt gộp nhầm, không sửa gì', () => {
    const r = patientDb.splitMergedStays();
    assert.strictEqual(r.so_luot_gop_nham, 1);
    assert.strictEqual(r.so_dot_sau_tach, 2);
    assert.strictEqual(r.so_nguoi_benh, 1);
    assert.strictEqual(r.da_tach, false);
    assert.strictEqual(stays('BNTACH').length, 1);
    assert.strictEqual(scanCount(oldId), 9);
    assert.strictEqual(r.so_ban_chua_xac_dinh, 1);
  });

  test('Tách: mỗi giờ vào viện thành 1 đợt, dữ liệu thô đi theo đợt của nó', () => {
    const before = conn.prepare('SELECT id, hash, du_lieu FROM lan_quet ORDER BY id').all().map(r => [r.id, r.hash, r.du_lieu]);
    const r = patientDb.splitMergedStays({ apply: true, now: '2026-11-08T00:00:00Z' });
    assert.strictEqual(r.da_tach, true);
    assert.strictEqual(r.luot_moi.length, 1);
    const l = stays('BNTACH');
    assert.deepStrictEqual(l.map(x => [x.gio_vao, x.gio_ra, x.chan_doan_chinh, x.khoa]),
      [['2026-09-01 08:00', '2026-09-05 09:00', 'Đợt một', 'Khoa Ngoại'], ['2026-09-05 15:00', '2026-09-08 11:00', 'Đợt hai', 'Khoa Nội']]);
    assert.strictEqual(l[0].id, oldId, 'đợt vào sớm nhất giữ mã lượt cũ');
    assert.strictEqual(scanCount(l[0].id), 4, '3 bản đợt 1 + 1 bản không xác định');
    assert.strictEqual(scanCount(l[1].id), 5, 'lần ghi không có giờ vào viện theo ngày ra về đợt 2');
    const svc = id => conn.prepare('SELECT ten FROM dich_vu WHERE luot_id = ?').all(id).map(x => x.ten);
    assert.deepStrictEqual([svc(l[0].id), svc(l[1].id)], [['XN đợt một'], ['XN đợt hai']]);
    const after = conn.prepare('SELECT id, hash, du_lieu FROM lan_quet ORDER BY id').all().map(r => [r.id, r.hash, r.du_lieu]);
    assert.deepStrictEqual(after, before, 'không sửa, không xoá nội dung thô');
  });

  test('Chạy lại không tách thêm; đợt bình thường không bị đụng', () => {
    const r = patientDb.splitMergedStays({ apply: true });
    assert.strictEqual(r.so_luot_gop_nham, 0);
    assert.strictEqual(stays('BNTACH').length, 2);
    assert.strictEqual(stays('BNDUNG').length, 1);
  });

  test('Sau khi tách, lần quét mới của đợt 2 ghép đúng vào đợt 2', () => {
    const res = patientDb.recordInpatient('BNTACH', { profile: { ho_ten: 'Người Bệnh Thử', ngay_vao_vien: '15:00 05/09/2026', khoa: 'Khoa Nội' } },
      { from: '2026-09-05', source: 'kho_nghien_cuu', now: '2026-11-08T01:00:00Z' });
    assert.strictEqual(res.saved, true);
    assert.strictEqual(res.luot_id, stays('BNTACH')[1].id);
  });
} finally {
  patientDb.close();
  fs.rmSync(RUNTIME_ROOT, { recursive: true, force: true });
}

if (failed) {
  console.error(`patient_db_split_stays_test: ${failed} lỗi`);
  process.exit(1);
}
console.log('patient_db_split_stays_test: ok');
