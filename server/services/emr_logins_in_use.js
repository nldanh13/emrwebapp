// server/services/emr_logins_in_use.js — Tài khoản EMR đang được một tiến trình chạy NGOÀI hàng đợi
// tác vụ nặng giữ phiên đăng nhập (hiện là Theo dõi phòng khám, chạy suốt ngày bằng tài khoản bác sĩ).
// Lấy chi tiết song song bỏ qua các tài khoản này để hai bên không đăng xuất lẫn nhau.
// Tác vụ nặng (nhập liệu, lấy chi tiết, quét...) đã chạy lần lượt qua làn 'default' nên không cần ghi ở đây.

'use strict';

const inUse = new Map(); // owner -> { username, label }

function key(username) {
  return String(username || '').trim().toLowerCase();
}

function markEmrLoginInUse(owner, username, label = '') {
  if (!key(username)) return;
  inUse.set(String(owner), { username: key(username), label });
}

function releaseEmrLogin(owner) {
  inUse.delete(String(owner));
}

/** Lý do tài khoản đang bận ('' nếu không ai giữ). */
function emrLoginInUseReason(username) {
  const k = key(username);
  for (const v of inUse.values()) if (v.username === k) return v.label || 'Đang dùng ở tác vụ khác.';
  return '';
}

module.exports = { markEmrLoginInUse, releaseEmrLogin, emrLoginInUseReason };
