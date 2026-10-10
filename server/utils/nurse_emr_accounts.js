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
  // kind 'doctor': tài khoản EMR bác sĩ, dùng để đăng nhập ở Phòng khám / Nghỉ ốm (không dùng khi
  // nhập liệu theo Lịch điều dưỡng). Dòng không có kind là điều dưỡng như trước.
  if (row.kind === 'doctor') out.kind = 'doctor';
  return out;
}

function stripVietnamese(text) {
  return String(text || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D');
}

// Tên đăng nhập EMR theo quy ước của viện: chữ cái đầu của họ + tên đệm, cộng nguyên tên, không dấu,
// chữ thường. Vd. "Hoàng Minh Tú" → "hmtu", "Hồ Điền" → "hdien".
function emrUsernameFromName(name) {
  const words = stripVietnamese(name).toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean);
  if (!words.length) return '';
  return words.slice(0, -1).map(w => w[0]).join('') + words[words.length - 1];
}

/**
 * Thêm nhiều bác sĩ một lần: tự tạo tên đăng nhập (emrUsernameFromName), cùng một mật khẩu.
 * Người đã có thì giữ tên đăng nhập đang có, chỉ đổi mật khẩu nếu có nhập. Tên đăng nhập trùng
 * người khác thì thêm số (hmtu2) để không hai người chung một tài khoản.
 */
function addDoctorAccounts(names, password = '') {
  const list = [...new Set((Array.isArray(names) ? names : []).map(n => String(n || '').trim()).filter(Boolean))];
  if (!list.length) throw new Error('Chưa có tên bác sĩ nào.');
  if (list.length > 100) throw new Error('Tối đa 100 bác sĩ mỗi lần.');
  const rows = readNurseEmrAccounts();
  const taken = new Set(rows.map(r => r.emr_username.toLowerCase()).filter(Boolean));
  const next = [...rows];
  for (const name of list) {
    const idx = next.findIndex(r => r.name === name);
    if (idx >= 0) {
      const cur = next[idx];
      let username = cur.emr_username;
      if (!username) {
        username = uniqueUsername(emrUsernameFromName(name), taken);
        taken.add(username);
      }
      next[idx] = { ...cur, kind: 'doctor', emr_username: username, ...(password ? { emr_password: String(password) } : {}) };
    } else {
      const username = uniqueUsername(emrUsernameFromName(name), taken);
      if (!username) throw new Error(`Không tạo được tên đăng nhập cho "${name}".`);
      taken.add(username);
      next.push({ name, kind: 'doctor', emr_username: username, emr_password: String(password || '') });
    }
  }
  return writeNurseEmrAccounts(next);
}

function uniqueUsername(base, taken) {
  if (!base || !taken.has(base)) return base;
  let n = 2;
  while (taken.has(`${base}${n}`)) n += 1;
  return `${base}${n}`;
}

/** Tài khoản bác sĩ để đăng nhập phòng khám theo tên (null nếu chưa khai đủ). */
function findDoctorAccount(name) {
  const nameTrim = String(name || '').trim();
  const row = readNurseEmrAccounts().find(r => r.kind === 'doctor' && r.name === nameTrim);
  if (!row || !row.emr_username || !row.emr_password) return null;
  return { username: row.emr_username, password: row.emr_password };
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
function updateNurseEmrAccount(name, { emr_username, emr_password, kind } = {}) {
  const nameTrim = String(name || '').trim();
  if (!nameTrim) throw new Error('Thiếu tên điều dưỡng.');
  const rows = readNurseEmrAccounts();
  const patch = {};
  if (emr_username !== undefined) patch.emr_username = String(emr_username || '').trim();
  if (emr_password !== undefined) patch.emr_password = String(emr_password || '');
  const exists = rows.some(r => r.name === nameTrim);
  const next = exists
    ? rows.map(r => (r.name === nameTrim ? { ...r, ...patch } : r))
    : [...rows, { name: nameTrim, emr_username: '', emr_password: '', ...(kind === 'doctor' ? { kind } : {}), ...patch }];
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
  emrUsernameFromName,
  addDoctorAccounts,
  findDoctorAccount,
};
