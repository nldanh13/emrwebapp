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
let poisonId = '';
const pythonRunnerPath = require.resolve('../server/services/python_runner');
require.cache[pythonRunnerPath] = {
  id: pythonRunnerPath, filename: pythonRunnerPath, loaded: true,
  exports: {
    fmtPyError: (prefix) => `${prefix} (giả lập)`,
    runScript: async () => ({ code: 0 }),
    runWorker: async (cmd, args, opts = {}) => {
      const input = args[args.indexOf('--input') + 1];
      const out = args[args.indexOf('--out') + 1];
      const helperId = opts.extraEnv?.EMR_BRIDGE_ID || '';
      const user = helperId ? `helper:${helperId}` : (opts.extraEnv?.EMR_USERNAME || 'tk.chung');
      if (helperId) assert.strictEqual(opts.extraEnv.DETAILS_SKIP_UNREADABLE, '1', 'máy góp sức phải trả lại ca không đọc được');
      if (opts.extraEnv) assert.strictEqual(opts.extraEnv.DETAILS_SKIP_V2, '1', 'phần song song không tự dựng v2');
      active.set(user, (active.get(user) || 0) + 1);
      assert.ok(active.get(user) <= 1, `tài khoản ${user} chạy hai phần cùng lúc`);
      const total = [...active.values()].reduce((a, b) => a + b, 0);
      maxActive = Math.max(maxActive, total);
      await new Promise(r => setTimeout(r, 30));
      const rows = JSON.parse(fs.readFileSync(input, 'utf8'));
      runs.push({ user, ids: rows.map(r => r['Mã BN']) });
      active.set(user, active.get(user) - 1);
      if (user === failUser || rows.some(r => r['Mã BN'] === poisonId)) return { code: 1 };
      // Máy góp sức không đọc được BN2 (vd. vừa ra viện): trả lại cho máy chủ.
      const skipped = helperId ? rows.map(r => r['Mã BN']).filter(id => id === 'BN2') : [];
      if (helperId) fs.writeFileSync(`${out}.skipped.json`, JSON.stringify(skipped));
      fs.writeFileSync(out, JSON.stringify(rows.filter(r => !skipped.includes(r['Mã BN'])).map(r => ({ 'Mã BN': r['Mã BN'], ngay_lam: '01/10/2026', 'Y lệnh': `y lệnh mới ${r['Mã BN']}`, 'Diễn biến': '' }))));
      return { code: 0 };
    },
  },
};

const express = require('express');
const fa = require('../server/services/fetch_accounts');
const { runDetailsQueue } = require('../server/services/details_parallel');
const { runExclusiveByAccount } = require('../server/services/task_queue');

const SID = 'song-song-test';
const patients = (n) => Array.from({ length: n }, (_, i) => ({ 'Mã BN': `BN${i + 1}`, 'Họ tên': `Người ${i + 1}`, Vi_Tri: 'P01' }));

let failed = 0;
const test = async (name, fn) => { try { await fn(); console.log(`  ok - ${name}`); } catch (e) { failed += 1; console.error(`  FAIL - ${name}\n`, e); } };

(async () => {
  console.log('details_parallel_test');

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

  const acct = (key, main = false) => ({ key, label: key, kind: 'account', direct: true, main });
  const helper = (key) => ({ key, label: key, kind: 'helper', direct: false, main: false });
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  await test('hàng đợi: mỗi ca có đúng một kết quả; máy góp sức lỗi thì nghỉ, lô chuyển người khác; ca không đọc được về máy chủ', async () => {
    const busy = new Map();
    const takenBy = new Map(); // mã ca → người làm đã nộp kết quả
    const triedBy = [];
    const result = await runDetailsQueue({
      rows: patients(30),
      runners: [acct('default', true), acct('read:doc1'), helper('h1'), helper('h2')],
      laneRunner: runExclusiveByAccount,
      getId: r => r['Mã BN'],
      pollMs: 5,
      runBatch: async (runner, rows) => {
        busy.set(runner.key, (busy.get(runner.key) || 0) + 1);
        assert.ok(busy.get(runner.key) <= 1, `${runner.key} nhận hai lô cùng lúc`);
        triedBy.push({ key: runner.key, ids: rows.map(r => r['Mã BN']) });
        await sleep(runner.kind === 'helper' ? 3 : 10);
        busy.set(runner.key, busy.get(runner.key) - 1);
        if (runner.key === 'h2') return { ok: false, message: 'EMR đã đăng xuất' };
        const skippedIds = runner.kind === 'helper' ? rows.map(r => r['Mã BN']).filter(id => id === 'BN5') : [];
        for (const r of rows) if (!skippedIds.includes(r['Mã BN'])) takenBy.set(r['Mã BN'], runner.key);
        // Thêm một dòng lạ ngoài lô: phải bị bỏ.
        return { ok: true, skippedIds, records: [...rows.map(r => ({ 'Mã BN': r['Mã BN'] })), { 'Mã BN': 'BN-LA' }] };
      },
    });
    const ids = result.records.map(r => r['Mã BN']).sort();
    assert.deepStrictEqual(ids, patients(30).map(r => r['Mã BN']).sort(), 'đủ 30 ca, không trùng, không có ca lạ');
    assert.strictEqual(result.okIds.size, 30);
    assert.strictEqual(result.failedRows.length, 0);
    assert.ok(['default', 'read:doc1'].includes(takenBy.get('BN5')), 'ca máy góp sức không đọc được do tài khoản máy chủ làm');
    const h2 = result.runners.find(r => r.key === 'h2');
    assert.strictEqual(h2.retired, true);
    assert.strictEqual(h2.patients, 0);
    assert.ok(result.runners.find(r => r.key === 'h1').patients > 0, 'máy góp sức tốt có làm');
    // Lô đã lỗi ở h2 không quay lại h2.
    const h2Ids = triedBy.filter(t => t.key === 'h2').map(t => t.ids.join(','));
    assert.strictEqual(new Set(h2Ids).size, h2Ids.length);
  });

  await test('hàng đợi: máy góp sức nối giữa chừng cũng được nhận việc', async () => {
    let joined = false;
    setTimeout(() => { joined = true; }, 10);
    const result = await runDetailsQueue({
      rows: patients(40),
      runners: [acct('default', true), acct('read:doc1')],
      discoverRunners: () => (joined ? [helper('h-moi')] : []),
      laneRunner: runExclusiveByAccount,
      getId: r => r['Mã BN'],
      pollMs: 5,
      batchSize: 3,
      runBatch: async (runner, rows) => { await sleep(runner.kind === 'account' ? 40 : 5); return { ok: true, records: rows.map(r => ({ 'Mã BN': r['Mã BN'] })) }; },
    });
    assert.strictEqual(result.okIds.size, 40);
    assert.ok(result.runners.find(r => r.key === 'h-moi')?.patients > 0);
  });

  await test('hàng đợi: một ca làm hỏng lô thì chỉ lô đó thất bại sau 3 lần, các lô khác vẫn xong', async () => {
    const result = await runDetailsQueue({
      rows: patients(24),
      runners: [acct('default', true), acct('read:doc1'), acct('read:doc2')],
      laneRunner: runExclusiveByAccount,
      getId: r => r['Mã BN'],
      pollMs: 5,
      batchSize: 3,
      runBatch: async (_runner, rows) => {
        await sleep(2);
        if (rows.some(r => r['Mã BN'] === 'BN7')) return { ok: false, message: 'worker lỗi' };
        return { ok: true, records: rows.map(r => ({ 'Mã BN': r['Mã BN'] })) };
      },
    });
    assert.deepStrictEqual(result.failedRows.map(r => r['Mã BN']), ['BN7', 'BN8', 'BN9']);
    assert.strictEqual(result.okIds.size, 21);
  });

  await test('hàng đợi: bấm Dừng thì không nhận lô mới', async () => {
    let cancelled = false;
    let started = 0;
    const result = await runDetailsQueue({
      rows: patients(30),
      runners: [acct('default', true), acct('read:doc1')],
      laneRunner: runExclusiveByAccount,
      isCancelled: () => cancelled,
      getId: r => r['Mã BN'],
      pollMs: 5,
      batchSize: 3,
      runBatch: async (_runner, rows) => { started += 1; cancelled = true; await sleep(5); return { ok: true, records: rows.map(r => ({ 'Mã BN': r['Mã BN'] })) }; },
    });
    assert.strictEqual(result.cancelled, true);
    assert.ok(started <= 2, `đã chạy ${started} lần sau khi dừng`);
  });

  await test('hàng đợi: chỉ một người làm hoặc ít ca thì không chia', async () => {
    const opts = { laneRunner: runExclusiveByAccount, getId: r => r['Mã BN'], runBatch: async () => ({ ok: true, records: [] }) };
    assert.strictEqual(await runDetailsQueue({ ...opts, rows: patients(30), runners: [acct('default', true)] }), null);
    assert.strictEqual(await runDetailsQueue({ ...opts, rows: patients(5), runners: [acct('default', true), helper('h')] }), null);
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
    assert.deepStrictEqual([...new Set(runs.map(r => r.user))].sort(), ['doc1', 'doc2', 'tk.chung']);
    const ids = runs.flatMap(r => r.ids).sort();
    assert.deepStrictEqual(ids, patients(12).map(r => r['Mã BN']).sort());
    const final = JSON.parse(fs.readFileSync(ctx.FINAL_PATH, 'utf8'));
    assert.strictEqual(final.length, 12);
    assert.ok(!fs.existsSync(path.join(ctx.dir, 'details_parts')) || !fs.readdirSync(path.join(ctx.dir, 'details_parts')).length, 'dọn thư mục tạm');
  });

  await test('route: lô lỗi ở mọi tài khoản thì giữ dữ liệu cũ của người bệnh đó và báo rõ; tài khoản lỗi không làm mất lô', async () => {
    runs.length = 0; failUser = 'doc2'; poisonId = 'BN12';
    const old = JSON.parse(fs.readFileSync(ctx.FINAL_PATH, 'utf8')).map(r => ({ ...r, 'Y lệnh': `y lệnh cũ ${r['Mã BN']}` }));
    fs.writeFileSync(ctx.FINAL_PATH, JSON.stringify(old));
    try {
      const body = await runDetails(patients(12));
      assert.strictEqual(body.status, 'ok', body.message);
      assert.deepStrictEqual(body.failed_patient_ids, ['BN10', 'BN11', 'BN12']);
      assert.match(body.warning, /chưa lấy được/);
      const final = JSON.parse(fs.readFileSync(ctx.FINAL_PATH, 'utf8'));
      const byId = Object.fromEntries(final.map(r => [r['Mã BN'], r['Y lệnh']]));
      for (const id of body.failed_patient_ids) assert.strictEqual(byId[id], `y lệnh cũ ${id}`);
      assert.strictEqual(byId.BN1, 'y lệnh mới BN1');
      assert.strictEqual(final.length, 12);
    } finally {
      failUser = ''; poisonId = '';
    }
  });

  await test('route: máy góp sức nhận lô qua tab EMR, ca nó không đọc được do máy chủ lấy', async () => {
    const bridge = require('../server/services/emr_bridge');
    bridge.hello({ bridgeId: 'tab-cua-an', role: 'helper', userId: 'an', userName: 'Điều dưỡng An', emrOrigin: 'http://emr.benhvien.local' });
    fs.writeFileSync(process.env.EMR_READ_ACCOUNTS_FILE, JSON.stringify({ max_parallel: 3, accounts: [] }));
    runs.length = 0;
    try {
      const body = await runDetails(patients(16));
      assert.strictEqual(body.status, 'ok', body.message);
      const helperRuns = runs.filter(r => r.user === 'helper:tab-cua-an');
      assert.ok(helperRuns.length > 0, 'máy góp sức có nhận việc');
      const final = JSON.parse(fs.readFileSync(ctx.FINAL_PATH, 'utf8'));
      assert.deepStrictEqual(final.map(r => r['Mã BN']).sort(), patients(16).map(r => r['Mã BN']).sort());
      const bn2Runs = runs.filter(r => r.ids.includes('BN2'));
      if (helperRuns.some(r => r.ids.includes('BN2'))) {
        assert.ok(bn2Runs.some(r => r.user === 'tk.chung'), 'BN2 bị máy góp sức trả lại phải do tài khoản máy chủ lấy');
      }
      assert.ok(body.workers.some(w => w.who === 'Điều dưỡng An' && w.kind === 'helper'));
      assert.match(body.message, /Điều dưỡng An/);
      assert.ok(bridge.status().helpers[0].patients_done > 0, 'màn hình thấy số ca máy góp sức đã làm');
      assert.ok(!JSON.stringify(bridge.status()).includes('tab-cua-an'), 'không lộ mã cầu nối ra trạng thái công khai');
    } finally {
      bridge.disconnect('tab-cua-an');
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
