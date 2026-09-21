// server/utils/nurse_emr_accounts.js — Tài khoản EMR thật riêng theo TÊN điều dưỡng.
//
// Khác với config/users.json (tài khoản đăng nhập Data Hub, gắn theo người vận
// hành app): file này chỉ ánh xạ TÊN điều dưỡng trong lịch trực (config.json ->
// ten_dieu_duong/ds_dieu_duong) sang tài khoản EMR của chính người đó — dùng
// khi nhập chăm sóc để mỗi ca (làm/trực) được ghi nhận đúng tài khoản EMR của
// điều dưỡng phụ trách ca đó, không phải tài khoản chung.
//
// worker/nurse_emr_accounts.py đọc CÙNG file này — path và định dạng
// ([{name, emr_username, emr_password}]) phải khớp giữa 2 bên.

'use strict';

const path = require('path');
const { ROOT_DIR } = require('../constants');
const { readJsonSafe, writeJsonAtomic } = require('./file');

const DEFAULT_NURSE_EMR_ACCOUNTS_FILE = path.join(ROOT_DIR, 'config', 'nurse_emr_accounts.json');

// Cho phép override đường dẫn khi test (giống EMR_USERS_FILE ở authz.js) —
// đọc lại mỗi lần gọi thay vì cache ở module scope để test đổi env giữa các
// lần gọi vẫn có tác dụng.
function nurseEmrAccountsFilePath() {
  const configured = String(process.env.EMR_NURSE_ACCOUNTS_FILE || '').trim();
  if (!configured) return DEFAULT_NURSE_EMR_ACCOUNTS_FILE;
  return path.isAbsolute(configured) ? configured : path.join(ROOT_DIR, configured);
}

function normalizeAccountRow(row) {
  if (!row || typeof row !== 'object') return null;
  const name = String(row.name || '').trim();
  if (!name) return null;
  return {
    name,
    emr_username: String(row.emr_username || '').trim(),
    emr_password: String(row.emr_password || ''),
  };
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

module.exports = {
  NURSE_EMR_ACCOUNTS_FILE: DEFAULT_NURSE_EMR_ACCOUNTS_FILE,
  nurseEmrAccountsFilePath,
  normalizeAccountRow,
  readNurseEmrAccounts,
  writeNurseEmrAccounts,
};
