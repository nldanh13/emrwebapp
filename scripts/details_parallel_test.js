#!/usr/bin/env node
'use strict';
// "Lấy chi tiết" song song bằng nhiều tài khoản EMR:
// - không người bệnh nào bị lấy hai lần hoặc bị sót khi chia phần;
// - một tài khoản không bao giờ chạy hai phần cùng lúc; tài khoản dùng để nhập liệu không bị dùng;
// - phần lỗi chạy lại bằng tài khoản chung; vẫn lỗi thì dữ liệu cũ của người bệnh đó được giữ;
// - mật khẩu không trả về giao diện.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'details-parallel-'));
process.env.EMR_RUNTIME_ROOT = root;
process.env.EMR_READ_ACCOUNTS_FILE = path.join(root, 'emr_read_accounts.json');
process.env.EMR_NURSE_ACCOUNTS_FILE = path.join(root, 'nurse_emr_accounts.json');
process.env.EMR_USERS_FILE = path.join(root, 'users.json');
process.env.EMR_USERNAME = 'tk.chung';
process.env.EMR_PASSWORD = 'pw-chung';
fs.writeFileSync(process.env.EMR_NURSE_ACCOUNTS_FILE, JSON.stringify([{ name: 'ĐD A', emr_username: 'dd.a', emr_password: 'x' }]));
fs.writeFileSync(process.env.EMR_USERS_FILE, JSON.stringify({ users: [] }));

// Worker giả: ghi một dòng y lệnh cho mỗi người bệnh trong phần được giao, ghi lại tài khoản đã dùng.
const runs = [];
let active = new Map();
let maxActive = 0;
let failUser = '';
let callNo = 0;
let failOnCall = 0;
const pythonRunnerPath = require.resolve('../server/services/python_runner');
require.cache[pythonRunnerPath] = {
  id: pythonRunnerPath, filename: pythonRunnerPath, loaded: true,
  exports: {
    fmtPyError: (prefix) => `${prefix} (giả lập)`,
    runScript: async () => ({ code: 0 }),
    runWorker: async (cmd, args, opts = {}) => {
      const input = args[args.indexOf('--input') + 1];
      const out = args[args.indexOf('--out') + 1];
      const user = opts.extraEnv?.EMR_USERNAME || 'tk.chung';
      callNo += 1;
      const thisCall = callNo;
      if (opts.extraEnv) assert.strictEqual(opts.extraEnv.DETAILS_SKIP_V2, '1', 'phần song song không tự dựng v2');
      active.set(user, (active.get(user) || 0) + 1);
      assert.ok(active.get(user) <= 1, `tài khoản ${user} chạy hai phần cùng lúc`);
      const total = [...active.values()].reduce((a, b) => a + b, 0);
      maxActive = Math.max(maxActive, total);
      await new Promise(r => setTimeout(r, 30));
      const rows = JSON.parse(fs.readFileSync(input, 'utf8'));
      runs.push({ user, ids: rows.map(r => r['Mã BN']) });
      active.set(user, active.get(user) - 1);
      if (user === failUser || thisCall === failOnCall) return { code: 1 };
      fs.writeFileSync(out, JSON.stringify(rows.map(r => ({ 'Mã BN': r['Mã BN'], ngay_lam: '01/10/2026', 'Y lệnh': `y lệnh mới ${r['Mã BN']}`, 'Diễn biến': '' }))));
      return { code: 0 };
    },
  },
};

const express = require('express');
const fa = require('../server/services/fetch_accounts');
const { runDetailsInParts } = require('../server/services/details_parallel');
const { runExclusiveByAccount } = require('../server/services/task_queue');

const SID = 'song-song-test';
const patients = (n) => Array.from({ length: n }, (_, i) => ({ 'Mã BN': `BN${i + 1}`, 'Họ tên': `Người ${i + 1}`, Vi_Tri: 'P01' }));

let failed = 0;
const test = async (name, fn) => { try { await fn(); console.log(`  ok - ${name}`); } catch (e) { failed += 1; console.error(`  FAIL - ${name}\n`, e); } };

(async () => {
  console.log('details_parallel_test');

  await test('chia phần: mỗi người bệnh nằm đúng một phần, các phần lệch nhau tối đa 1', async () => {
    const rows = patients(13);
    const parts = fa.planParts(rows, 3);
    assert.deepStrictEqual(parts.map(p => p.length), [5, 4, 4]);
    assert.strictEqual(fa.planParts(patients(10), 3).length, 2, 'mỗi phần ít nhất 4 người bệnh');
    assert.deepStrictEqual(parts.flat().map(r => r['Mã BN']), rows.map(r => r['Mã BN']));
    assert.strictEqual(fa.planParts(patients(7), 3).length, 1, 'ít người bệnh thì không chia');
    assert.strictEqual(fa.planParts(patients(20), 1).length, 1);
  });

  await test('sổ tài khoản: bỏ tài khoản chung, tài khoản nhập liệu, thiếu mật khẩu, đang tắt', async () => {
    fs.writeFileSync(process.env.EMR_READ_ACCOUNTS_FILE, JSON.stringify({
      max_parallel: 3,
      accounts: [
        { name: 'Đọc 1', emr_username: 'doc1', emr_password: 'pw1' },
        { name: 'Trùng chung', emr_username: 'TK.CHUNG', emr_password: 'x' },
        { name: 'Của điều dưỡng', emr_username: 'dd.a', emr_password: 'x' },
        { name: 'Thiếu mật khẩu', emr_username: 'doc3', emr_password: '' },
        { name: 'Đang tắt', emr_username: 'doc4', emr_password: 'x', enabled: false },
        { name: 'Đọc 2', emr_username: 'doc2', emr_password: 'pw2' },
        { name: 'Đọc 5', emr_username: 'doc5', emr_password: 'pw5' },
      ],
    }));
    const pool = fa.fetchAccountPool();
    assert.deepStrictEqual(pool.map(a => a.key), ['default', 'read:doc1', 'read:doc2'], 'tối đa 3 luồng');
    assert.notStrictEqual(pool[1].env.EMR_HTTP_COOKIE_FILE, pool[2].env.EMR_HTTP_COOKIE_FILE, 'cookie riêng từng tài khoản');
    const pub = fa.publicFetchAccounts();
    const text = JSON.stringify(pub);
    assert.ok(!text.includes('pw1') && !text.includes('pw2') && !text.includes('emr_password'), 'không lộ mật khẩu');
    const byUser = Object.fromEntries(pub.accounts.map(a => [a.emr_username, a]));
    assert.match(byUser['dd.a'].note, /nhập liệu/);
    assert.match(byUser['TK.CHUNG'].note, /Trùng tài khoản chung/);
    assert.strictEqual(byUser.doc1.usable, true);
  });

  await test('lưu sổ: để trống mật khẩu thì giữ mật khẩu cũ, đổi tên đăng nhập thì không mang theo', async () => {
    const before = fa.publicFetchAccounts();
    const doc1 = before.accounts.find(a => a.emr_username === 'doc1');
    const out = fa.saveFetchAccounts({
      max_parallel: 9,
      accounts: [
        { id: doc1.id, name: 'Đọc 1', emr_username: 'doc1', emr_password: '' },
        { id: doc1.id, name: 'Đổi tên', emr_username: 'doc9', emr_password: '' },
      ],
    });
    assert.strictEqual(out.max_parallel, fa.MAX_PARALLEL_LIMIT);
    const saved = JSON.parse(fs.readFileSync(process.env.EMR_READ_ACCOUNTS_FILE, 'utf8'));
    assert.strictEqual(saved.accounts.find(a => a.emr_username === 'doc1').emr_password, 'pw1');
    assert.strictEqual(saved.accounts.find(a => a.emr_username === 'doc9').emr_password, '');
    assert.throws(() => fa.saveFetchAccounts({ accounts: [{ emr_username: 'a' }, { emr_username: 'A' }] }), /hai lần/);
  });

  // Sổ cho các test còn lại: tài khoản chung + 2 tài khoản đọc.
  fs.writeFileSync(process.env.EMR_READ_ACCOUNTS_FILE, JSON.stringify({
    max_parallel: 3,
    accounts: [{ name: 'Đọc 1', emr_username: 'doc1', emr_password: 'pw1' }, { name: 'Đọc 2', emr_username: 'doc2', emr_password: 'pw2' }],
  }));

  await test('chạy song song, phần lỗi chạy lại bằng tài khoản chung', async () => {
    const calls = [];
    const pool = fa.fetchAccountPool();
    const result = await runDetailsInParts({
      rows: patients(12),
      pool,
      laneRunner: runExclusiveByAccount,
      getId: r => r['Mã BN'],
      runPart: async ({ rows, account }) => {
        calls.push({ key: account.key, n: rows.length });
        if (account.key === 'read:doc2') return { ok: false, message: 'bị đăng xuất' };
        return { ok: true, records: rows.map(r => ({ 'Mã BN': r['Mã BN'] })) };
      },
    });
    assert.deepStrictEqual(calls.map(c => c.key), ['default', 'read:doc1', 'read:doc2', 'default']);
    assert.strictEqual(result.okIds.size, 12);
    assert.strictEqual(result.failedRows.length, 0);
    assert.strictEqual(result.records.length, 12);
    assert.strictEqual(result.retry.ok, true);
  });

  const app = express();
  app.use(express.json({ limit: '5mb' }));
  app.use((req, _res, next) => { req.auth = { id: 'admin', name: 'Quản trị', role: 'admin' }; next(); });
  app.use('/api', require('../server/routes/details'));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(r => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const { getRuntimePaths } = require('../server/services/session');
  const ctx = getRuntimePaths({ get: (h) => (h.toLowerCase() === 'x-session-id' ? SID : ''), query: {}, headers: { 'x-session-id': SID } });
  const runDetails = (rows) => fetch(`${base}/run-details?date_from=01/10/2026&date_to=01/10/2026`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-session-id': SID }, body: JSON.stringify(rows),
  }).then(r => r.json());

  await test('route: 12 người bệnh chia cho 3 tài khoản, đủ dữ liệu, không trùng, không tài khoản nào chạy chồng', async () => {
    runs.length = 0; maxActive = 0; failUser = '';
    const body = await runDetails(patients(12));
    assert.strictEqual(body.status, 'ok', body.message);
    assert.strictEqual(body.parallel_accounts, 3);
    assert.ok(maxActive >= 2, 'các phần phải chạy cùng lúc');
    assert.deepStrictEqual(runs.map(r => r.user).sort(), ['doc1', 'doc2', 'tk.chung']);
    const ids = runs.flatMap(r => r.ids).sort();
    assert.deepStrictEqual(ids, patients(12).map(r => r['Mã BN']).sort());
    const final = JSON.parse(fs.readFileSync(ctx.FINAL_PATH, 'utf8'));
    assert.strictEqual(final.length, 12);
    assert.ok(!fs.existsSync(path.join(ctx.dir, 'details_parts')) || !fs.readdirSync(path.join(ctx.dir, 'details_parts')).length, 'dọn thư mục tạm');
  });

  await test('route: một tài khoản lỗi cả khi chạy lại thì giữ dữ liệu cũ của người bệnh đó và báo rõ', async () => {
    runs.length = 0; failUser = 'doc2';
    const old = JSON.parse(fs.readFileSync(ctx.FINAL_PATH, 'utf8')).map(r => ({ ...r, 'Y lệnh': `y lệnh cũ ${r['Mã BN']}` }));
    fs.writeFileSync(ctx.FINAL_PATH, JSON.stringify(old));
    // Lần chạy lại bằng tài khoản chung (lần gọi thứ 4) cũng lỗi.
    callNo = 0; failOnCall = 4;
    try {
      const body = await runDetails(patients(12));
      assert.strictEqual(body.status, 'ok', body.message);
      assert.strictEqual(body.failed_patient_ids.length, 4);
      assert.match(body.warning, /chưa lấy được/);
      const final = JSON.parse(fs.readFileSync(ctx.FINAL_PATH, 'utf8'));
      const byId = Object.fromEntries(final.map(r => [r['Mã BN'], r['Y lệnh']]));
      for (const id of body.failed_patient_ids) assert.strictEqual(byId[id], `y lệnh cũ ${id}`);
      assert.strictEqual(byId.BN1, 'y lệnh mới BN1');
      assert.strictEqual(final.length, 12);
    } finally {
      failUser = ''; failOnCall = 0;
    }
  });

  await test('route: chỉ có tài khoản chung thì chạy một worker như cũ', async () => {
    fs.writeFileSync(process.env.EMR_READ_ACCOUNTS_FILE, JSON.stringify({ max_parallel: 3, accounts: [] }));
    runs.length = 0;
    const body = await runDetails(patients(12));
    assert.strictEqual(body.status, 'ok', body.message);
    assert.strictEqual(body.parallel_accounts, 1);
    assert.strictEqual(runs.length, 1);
  });

  server.close();
  fs.rmSync(root, { recursive: true, force: true });
  if (failed) { console.error(`${failed} test lỗi`); process.exit(1); }
  process.exit(0);
})();
