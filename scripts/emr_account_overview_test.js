#!/usr/bin/env node
'use strict';
// Thiết lập tài khoản → Tài khoản EMR:
// - bảng gom mọi tài khoản EMR chỉ ra tài khoản khai ở nhiều chỗ và người trong lịch chưa có tài khoản,
//   không bao giờ trả mật khẩu;
// - sửa tài khoản EMR của một điều dưỡng không làm mất chữ ký hay dòng của người khác (hai màn hình
//   cùng sửa file nurse_emr_accounts.json, gửi cả danh sách từ bản cũ sẽ ghi đè mất phần vừa sửa).
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'emracc-'));
process.env.EMR_RUNTIME_ROOT = path.join(dir, 'runtime');
process.env.EMR_USERS_FILE = path.join(dir, 'users.json');
process.env.EMR_NURSE_ACCOUNTS_FILE = path.join(dir, 'nurse_emr_accounts.json');
process.env.EMR_READ_ACCOUNTS_FILE = path.join(dir, 'emr_read_accounts.json');
process.env.EMR_USERNAME = 'chung';
process.env.EMR_PASSWORD = 'mat-khau-chung';
const ADMIN = 'a'.repeat(32);
const VIEWER = 'v'.repeat(32);
fs.writeFileSync(process.env.EMR_USERS_FILE, JSON.stringify([
  { id: 'quantri', name: 'QT', role: 'admin', token: ADMIN, emr_username: 'lan.nt', emr_password: 'pw-lan-2' },
  { id: 'xem', name: 'Người xem', role: 'viewer', token: VIEWER },
]));
fs.writeFileSync(process.env.EMR_NURSE_ACCOUNTS_FILE, JSON.stringify([
  { name: 'Nguyễn Thị Lan', emr_username: 'lan.nt', emr_password: 'pw-lan', signature_file: 'lan.png' },
  { name: 'Trần Văn Bình', emr_username: 'binh.tv', emr_password: 'pw-binh' },
]));
fs.writeFileSync(process.env.EMR_READ_ACCOUNTS_FILE, JSON.stringify({ accounts: [{ name: 'Đọc 1', emr_username: 'CHUNG', emr_password: 'x' }] }));

const express = require('express');
const authz = require('../server/services/authz');
const { buildEmrAccountOverview } = require('../server/services/emr_account_overview');
const nurseAccounts = require('../server/utils/nurse_emr_accounts');

let failed = 0;
const test = async (name, fn) => { try { await fn(); console.log(`  ok - ${name}`); } catch (e) { failed += 1; console.error(`  FAIL - ${name}\n`, e); } };

(async () => {
  console.log('emr_account_overview_test');

  await test('gộp theo tên đăng nhập EMR, đánh dấu tài khoản khai ở nhiều chỗ', () => {
    const o = buildEmrAccountOverview({
      roster: ['Nguyễn Thị Lan', 'Trần Văn Bình', 'Lê Thị Chưa Có'],
      nurseAccounts: nurseAccounts.readNurseEmrAccounts(),
      readAccounts: [{ name: 'Đọc 1', emr_username: 'CHUNG', has_password: true }],
      shared: { username: 'chung', source: 'env', has_password: true },
      hchanh: { username: '', source: '', has_password: false },
    });
    const lan = o.accounts.find(a => a.username === 'lan.nt');
    assert.ok(!lan.duplicate);
    assert.deepStrictEqual(lan.uses.map(u => u.use), ['nurse'], 'tài khoản EMR cũ trong users.json không còn được tính');
    const chung = o.accounts.find(a => a.username.toLowerCase() === 'chung');
    assert.ok(chung.duplicate, 'tài khoản đọc trùng tài khoản chung (khác hoa/thường) phải bị đánh dấu');
    assert.ok(chung.notes.some(n => /đọc song song/.test(n)));
    assert.strictEqual(o.accounts.find(a => a.username === 'binh.tv').duplicate, false);
    assert.strictEqual(o.duplicate_count, 1);
    assert.deepStrictEqual(o.nurses_missing, ['Lê Thị Chưa Có']);
    assert.ok(!JSON.stringify(o).includes('pw-'), 'không được trả mật khẩu');
  });

  await test('tài khoản EMR cũ trong users.json không còn được đọc, lần lưu kế tiếp xoá khỏi file', () => {
    const u = authz.listAllUsersRaw().users.find(x => x.id === 'quantri');
    assert.strictEqual(u.emrUsername, undefined);
    assert.strictEqual(u.emrPassword, undefined);
    authz.updateUser('xem', { name: 'Người xem 2' });
    const raw = fs.readFileSync(process.env.EMR_USERS_FILE, 'utf8');
    assert.ok(!raw.includes('emr_username') && !raw.includes('pw-lan-2'));
  });

  await test('sửa tài khoản EMR một người giữ nguyên chữ ký và người khác', () => {
    nurseAccounts.updateNurseEmrAccount('Nguyễn Thị Lan', { emr_username: 'lan.moi', emr_password: 'pw-moi' });
    const rows = nurseAccounts.readNurseEmrAccounts();
    const lan = rows.find(r => r.name === 'Nguyễn Thị Lan');
    assert.strictEqual(lan.emr_username, 'lan.moi');
    assert.strictEqual(lan.signature_file, 'lan.png');
    assert.strictEqual(rows.find(r => r.name === 'Trần Văn Bình').emr_username, 'binh.tv');
  });

  await test('chỉ đổi tên đăng nhập thì giữ mật khẩu cũ; người chưa có dòng thì thêm mới', () => {
    nurseAccounts.updateNurseEmrAccount('Trần Văn Bình', { emr_username: 'binh2' });
    nurseAccounts.updateNurseEmrAccount('Lê Thị Mới', { emr_username: 'moi' });
    const rows = nurseAccounts.readNurseEmrAccounts();
    assert.strictEqual(rows.find(r => r.name === 'Trần Văn Bình').emr_password, 'pw-binh');
    assert.strictEqual(rows.find(r => r.name === 'Lê Thị Mới').emr_username, 'moi');
  });

  const app = express();
  app.use('/api', authz.authenticateRequest, express.json());
  app.use('/api', authz.authorizeRequest, require('../server/routes/nurse_emr_accounts'), require('../server/routes/emr_accounts'), require('../server/routes/clinic'));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(r => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, url, { token = ADMIN, body } = {}) => {
    const r = await fetch(base + url, { method, headers: { 'x-app-token': token, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, json: await r.json() };
  };

  await test('GET /api/emr-accounts/overview: quản trị xem được, không có mật khẩu', async () => {
    const r = await call('GET', '/api/emr-accounts/overview');
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.json.shared.username, 'chung');
    assert.ok(Array.isArray(r.json.accounts));
    assert.ok(!JSON.stringify(r.json).includes('pw-') && !JSON.stringify(r.json).includes('mat-khau-chung'));
  });

  await test('GET /api/emr-accounts/overview: người xem bị chặn', async () => {
    const r = await call('GET', '/api/emr-accounts/overview', { token: VIEWER });
    assert.strictEqual(r.status, 403);
  });

  await test('PUT/DELETE /api/nurse-emr-accounts/account/:name chỉ đụng đúng một người', async () => {
    const put = await call('PUT', `/api/nurse-emr-accounts/account/${encodeURIComponent('Nguyễn Thị Lan')}`, { body: { emr_username: 'lan.3' } });
    assert.strictEqual(put.status, 200);
    const lan = put.json.accounts.find(a => a.name === 'Nguyễn Thị Lan');
    assert.strictEqual(lan.emr_username, 'lan.3');
    assert.strictEqual(lan.signature_file, 'lan.png');
    const del = await call('DELETE', `/api/nurse-emr-accounts/account/${encodeURIComponent('Lê Thị Mới')}`);
    assert.strictEqual(del.status, 200);
    assert.ok(!del.json.accounts.some(a => a.name === 'Lê Thị Mới'));
    assert.ok(del.json.accounts.some(a => a.name === 'Trần Văn Bình'));
    const viewer = await call('PUT', `/api/nurse-emr-accounts/account/x`, { token: VIEWER, body: { emr_username: 'y' } });
    assert.strictEqual(viewer.status, 403);
  });

  await test('tên đăng nhập bác sĩ tự tạo: chữ đầu họ + tên đệm + tên, không dấu', () => {
    const want = {
      'Hồ Điền': 'hdien', 'Nguyễn Lê Hoàn': 'nlhoan', 'Phan Văn Tuấn': 'pvtuan', 'Hoàng Minh Tú': 'hmtu',
      'Nguyễn Tư Thái Bảo': 'nttbao', 'Trần Nguyễn Anh Duy': 'tnaduy', 'Trần Quang Sơn': 'tqson',
      'Trần Quốc Toản': 'tqtoan', 'Nguyễn Chí Nguyện': 'ncnguyen', 'Phạm Việt Tân': 'pvtan',
    };
    for (const [name, user] of Object.entries(want)) assert.strictEqual(nurseAccounts.emrUsernameFromName(name), user, name);
  });

  await test('thêm nhiều bác sĩ một lần: cùng mật khẩu, trùng tên đăng nhập thì thêm số, giữ điều dưỡng', () => {
    nurseAccounts.addDoctorAccounts(['Hoàng Minh Tú', 'Hà Minh Tú', 'Hồ Điền'], 'mk-bs');
    const rows = nurseAccounts.readNurseEmrAccounts();
    const doctors = rows.filter(r => r.kind === 'doctor');
    assert.deepStrictEqual(doctors.map(r => r.emr_username), ['hmtu', 'hmtu2', 'hdien']);
    assert.ok(doctors.every(r => r.emr_password === 'mk-bs'));
    assert.ok(rows.some(r => r.name === 'Trần Văn Bình' && !r.kind));
    // Thêm lại: giữ tên đăng nhập đã sửa, chỉ đổi mật khẩu.
    nurseAccounts.updateNurseEmrAccount('Hồ Điền', { emr_username: 'dien.ho' });
    nurseAccounts.addDoctorAccounts(['Hồ Điền'], 'mk-moi');
    const dien = nurseAccounts.readNurseEmrAccounts().find(r => r.name === 'Hồ Điền');
    assert.strictEqual(dien.emr_username, 'dien.ho');
    assert.strictEqual(dien.emr_password, 'mk-moi');
    assert.strictEqual(dien.kind, 'doctor');
    assert.deepStrictEqual(nurseAccounts.findDoctorAccount('Hồ Điền'), { username: 'dien.ho', password: 'mk-moi' });
    assert.strictEqual(nurseAccounts.findDoctorAccount('Trần Văn Bình'), null, 'điều dưỡng không phải tài khoản phòng khám');
  });

  await test('phòng khám chọn bác sĩ: máy chủ tự điền tài khoản, báo rõ khi chưa khai', () => {
    const { withDoctorAccount } = require('../server/routes/clinic');
    const body = withDoctorAccount({ account_name: 'Hồ Điền', username: '', password: '', loginUrl: 'http://x' });
    assert.strictEqual(body.username, 'dien.ho');
    assert.strictEqual(body.password, 'mk-moi');
    assert.throws(() => withDoctorAccount({ account_name: 'Không Có' }), /chưa có đủ tài khoản/);
    assert.deepStrictEqual(withDoctorAccount({ username: 'tay', password: 'p' }), { username: 'tay', password: 'p' });
  });

  await test('POST /api/nurse-emr-accounts/doctors và GET /api/clinic/doctor-accounts (không có mật khẩu)', async () => {
    const add = await call('POST', '/api/nurse-emr-accounts/doctors', { body: { names: ['Phạm Việt Tân'], password: 'mk-tan' } });
    assert.strictEqual(add.status, 200);
    assert.ok(add.json.accounts.some(a => a.name === 'Phạm Việt Tân' && a.emr_username === 'pvtan' && a.kind === 'doctor'));
    const list = await call('GET', '/api/clinic/doctor-accounts', { token: VIEWER });
    assert.strictEqual(list.status, 200);
    assert.ok(list.json.doctors.some(d => d.name === 'Phạm Việt Tân' && d.ready));
    assert.ok(!JSON.stringify(list.json).includes('mk-'));
    const viewerAdd = await call('POST', '/api/nurse-emr-accounts/doctors', { token: VIEWER, body: { names: ['X'] } });
    assert.strictEqual(viewerAdd.status, 403);
  });

  server.close();
  fs.rmSync(dir, { recursive: true, force: true });
  if (failed) { console.error(`${failed} test lỗi`); process.exit(1); }
  console.log('Tất cả test đạt.');
})();
