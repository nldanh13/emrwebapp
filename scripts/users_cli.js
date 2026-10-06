#!/usr/bin/env node
'use strict';
// Quản lý tài khoản đăng nhập Data Hub từ dòng lệnh — dùng lần đầu trên máy chủ (VPS), khi chưa
// ai đăng nhập được giao diện. Mật khẩu nhập ẩn, không hiện trên màn hình, không ghi vào lịch sử
// lệnh; file tài khoản chỉ lưu bản băm.
//
//   node scripts/users_cli.js tao-admin <ten_dang_nhap> "<Họ tên>"
//   node scripts/users_cli.js dat-mat-khau <ten_dang_nhap>
//   node scripts/users_cli.js danh-sach
//
// Đọc/ghi đúng file máy chủ dùng: EMR_USERS_FILE nếu có, không thì secrets/users.json.

const readline = require('readline');
const authz = require('../server/services/authz');

function askHidden(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    rl._writeToOutput = (s) => { if (s.includes(question)) rl.output.write(s); };
    rl.question(question, (answer) => { rl.close(); process.stdout.write('\n'); resolve(answer); });
  });
}

async function askNewPassword() {
  const a = await askHidden('Mật khẩu mới (ít nhất 8 ký tự): ');
  const b = await askHidden('Nhập lại mật khẩu: ');
  if (a !== b) throw new Error('Hai lần nhập mật khẩu không giống nhau.');
  if (a.length < authz.PASSWORD_MIN_LENGTH) throw new Error(`Mật khẩu phải có ít nhất ${authz.PASSWORD_MIN_LENGTH} ký tự.`);
  return a;
}

async function main() {
  const [cmd, id, name] = process.argv.slice(2);
  const info = authz.getUsersFileInfo();
  if (cmd === 'danh-sach') {
    const { users, error } = authz.listAllUsersRaw();
    if (error) throw new Error(error);
    console.log(`File tài khoản: ${info.path || '(biến môi trường EMR_USERS_JSON)'}`);
    for (const u of users) console.log(`- ${u.id}\t${u.role}\t${u.enabled ? 'đang dùng' : 'đã tắt'}\t${u.passwordHash ? 'có mật khẩu' : 'chưa đặt mật khẩu'}\t${u.name}`);
    return;
  }
  if (cmd === 'tao-admin') {
    if (!id) throw new Error('Thiếu tên đăng nhập. Ví dụ: node scripts/users_cli.js tao-admin quantri "Quản trị"');
    const password = await askNewPassword();
    const u = authz.createUser({ id, name: name || id, role: 'admin', password });
    console.log(`Đã tạo tài khoản quản trị "${u.id}" trong ${info.path}. Đăng nhập trên web bằng tên này và mật khẩu vừa đặt.`);
    return;
  }
  if (cmd === 'dat-mat-khau') {
    if (!id) throw new Error('Thiếu tên đăng nhập. Ví dụ: node scripts/users_cli.js dat-mat-khau quantri');
    const password = await askNewPassword();
    authz.updateUser(id, { password });
    console.log(`Đã đặt mật khẩu mới cho "${id}". Máy chủ đang chạy sẽ nhận ngay khi khởi động lại.`);
    return;
  }
  console.log('Cách dùng:\n  node scripts/users_cli.js tao-admin <ten_dang_nhap> "<Họ tên>"\n  node scripts/users_cli.js dat-mat-khau <ten_dang_nhap>\n  node scripts/users_cli.js danh-sach');
  process.exitCode = 1;
}

main().catch((err) => { console.error(`Lỗi: ${err.message}`); process.exit(1); });
