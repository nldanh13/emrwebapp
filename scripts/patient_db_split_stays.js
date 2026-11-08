#!/usr/bin/env node
'use strict';

// Đếm / tách các đợt nằm viện bị gộp nhầm trong Kho người bệnh (dữ liệu ghi trước khi đợt được
// phân biệt bằng giờ vào viện). Mặc định chỉ đếm, không sửa gì.
//   npm run patient-db:tach-dot            → đếm
//   npm run patient-db:tach-dot -- --tach  → sao lưu kho rồi tách
// Nên chạy lúc không có tác vụ nào đang ghi vào kho (tốt nhất là tắt máy chủ).

const path = require('path');
const { RUNTIME_ROOT } = require('../server/constants');
const patientDb = require('../server/services/patient_db');

function stamp(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, '-');
}

function main() {
  if (!patientDb.available()) throw new Error(patientDb.unavailableReason());
  const apply = process.argv.includes('--tach');
  const r = patientDb.splitMergedStays({ apply: false });
  console.log(`Đợt nằm viện bị gộp nhầm: ${r.so_luot_gop_nham} lượt, của ${r.so_nguoi_benh} người bệnh.`);
  if (!r.so_luot_gop_nham) {
    console.log('Không có gì cần tách.');
    return;
  }
  console.log(`Sau khi tách sẽ thành ${r.so_dot_sau_tach} đợt.`);
  if (r.so_ban_chua_xac_dinh) {
    console.log(`${r.so_ban_chua_xac_dinh} bản dữ liệu không có giờ vào viện và không xác định được đợt: giữ ở đợt vào sớm nhất.`);
  }
  if (!apply) {
    console.log('Chưa sửa gì. Để tách: npm run patient-db:tach-dot -- --tach (sẽ sao lưu kho trước).');
    return;
  }
  const custom = String(process.env.EMR_PATIENT_DB_BACKUP_DIR || '').trim();
  const dir = custom ? path.resolve(custom) : path.join(RUNTIME_ROOT, 'backups', 'kho_benh_nhan');
  const backup = patientDb.backupTo(path.join(dir, `kho-truoc-tach-dot-${stamp()}.sqlite3`));
  console.log(`Đã sao lưu kho: ${backup.path}`);
  const done = patientDb.splitMergedStays({ apply: true });
  console.log(`Đã tách ${done.so_luot_gop_nham} lượt thành ${done.so_dot_sau_tach} đợt (thêm ${done.luot_moi.length} đợt mới).`);
  console.log('Nếu cần quay lại: tắt máy chủ, chép file sao lưu trên đè lên kho.sqlite3.');
}

try {
  main();
} catch (err) {
  console.error(`Không tách được đợt nằm viện: ${err.message}`);
  process.exitCode = 1;
} finally {
  patientDb.close();
}
