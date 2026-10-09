// server/utils/nurse_emr_accounts.js — Tài khoản EMR thật riêng theo TÊN điều dưỡng.
//
// Khác với secrets/users.json (tài khoản đăng nhập Data Hub, gắn theo người vận
// hành app): file này chỉ ánh xạ TÊN điều dưỡng trong lịch trực (config.json ->
// ten_dieu_duong/ds_dieu_duong) sang tài khoản EMR của chính người đó — dùng
// khi nhập chăm sóc để mỗi ca (làm/trực) được ghi nhận đúng tài khoản EMR của
// điều dưỡng phụ trách ca đó, không phải tài khoản chung.
//
// worker/nurse_emr_accounts.py đọc CÙNG file này (qua secret_store) — path và định dạng
// ([{name, emr_username, emr_password}]) phải khớp giữa 2 bên.

'use strict';

const { resolveSecretFile } = require('../services/secret_store');
const { readJsonSafe, writeJsonAtomic } = require('./file');

// Mặc định secrets/nurse_emr_accounts.json (máy chưa chuyển thì vẫn đọc
// config/nurse_emr_accounts.json cũ); EMR_NURSE_ACCOUNTS_FILE ghi đè được (test
// dùng). Đọc lại mỗi lần gọi thay vì cache ở module scope để test đổi env giữa
// các lần gọi vẫn có tác dụng.
function nurseEmrAccountsFilePath() {
  return resolveSecretFile('nurse_emr_accounts.json').path;
}

function normalizeAccountRow(row) {
  if (!row || typeof row !== 'object') return null;
  const name = String(row.name || '').trim();
  if (!name) return null;
  const out = {
    name,
    emr_username: String(row.emr_username || '').trim(),
    emr_password: String(row.emr_password || ''),
  };
  // Tên file ảnh chữ ký trong config/signatures/ (xem server/utils/nurse_signatures.js) —
  // tùy chọn, không bắt buộc phải có emr_username/emr_password đi kèm.
  const signatureFile = String(row.signature_file || '').trim();
  if (signatureFile) out.signature_file = signatureFile;
  return out;
}

function readNurseEmrAccounts() {
  const raw = readJsonSafe(nurseEmrAccountsFilePath(), []);
  if (!Array.isArray(raw)) return [];
  return raw.map(normalizeAccountRow).filter(Boolean);
}

// Ghi danh sách tài khoản EMR theo tên. Gộp theo tên (dòng sau ghi đè dòng
// trước nếu trùng tên, không phân biệt hoa/thường/khoảng trắng thừa vì đã
// normalize ở normalizeAccountRow), bỏ các dòng thiếu tên.
function writeNurseEmrAccounts(list) {
  const rows = (Array.isArray(list) ? list : []).map(normalizeAccountRow).filter(Boolean);
  const byName = new Map();
  for (const row of rows) byName.set(row.name, row);
  const result = [...byName.values()];
  writeJsonAtomic(nurseEmrAccountsFilePath(), result);
  return result;
}

// Sửa tài khoản EMR của MỘT người, giữ nguyên chữ ký và các dòng khác. Hai màn hình cùng sửa
// file này (Thiết lập tài khoản: tài khoản EMR; Lịch điều dưỡng: chữ ký), nên không gửi cả danh
// sách: bản cũ đang giữ ở màn hình kia sẽ ghi đè mất phần vừa sửa.
function updateNurseEmrAccount(name, { emr_username, emr_password } = {}) {
  const nameTrim = String(name || '').trim();
  if (!nameTrim) throw new Error('Thiếu tên điều dưỡng.');
  const rows = readNurseEmrAccounts();
  const patch = {};
  if (emr_username !== undefined) patch.emr_username = String(emr_username || '').trim();
  if (emr_password !== undefined) patch.emr_password = String(emr_password || '');
  const exists = rows.some(r => r.name === nameTrim);
  const next = exists
    ? rows.map(r => (r.name === nameTrim ? { ...r, ...patch } : r))
    : [...rows, { name: nameTrim, emr_username: '', emr_password: '', ...patch }];
  return writeNurseEmrAccounts(next);
}

// Bỏ hẳn dòng của MỘT người (tài khoản EMR và chữ ký), dùng khi xoá điều dưỡng khỏi danh sách.
function removeNurseEmrAccount(name) {
  const nameTrim = String(name || '').trim();
  const rows = readNurseEmrAccounts();
  return writeNurseEmrAccounts(rows.filter(r => r.name !== nameTrim));
}

module.exports = {
  nurseEmrAccountsFilePath,
  normalizeAccountRow,
  readNurseEmrAccounts,
  writeNurseEmrAccounts,
  updateNurseEmrAccount,
  removeNurseEmrAccount,
};
