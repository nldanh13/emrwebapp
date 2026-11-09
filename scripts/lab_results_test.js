#!/usr/bin/env node
'use strict';
// Kết quả xét nghiệm trong ngày (server/services/lab_results_store.js + server/routes/lab_results.js):
// - ca đã đủ kết quả không mở lại EMR; ca còn phiếu chờ / lỗi / "không có" quá 1 giờ thì đọc lại;
// - lần đọc lỗi không xóa kết quả tốt đã có;
// - worker chỉ nhận người bệnh cần đọc, đúng ngày; dừng giữa chừng vẫn lưu phần đã đọc;
// - thông báo lỗi bằng tiếng Việt.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lab-results-'));
process.env.EMR_RUNTIME_ROOT = root;

const store = require('../server/services/lab_results_store');

// Worker giả: ghi kết quả cho từng người bệnh trong input.
const runs = [];
let workerBehaviour = 'ok';
const pythonRunnerPath = require.resolve('../server/services/python_runner');
require.cache[pythonRunnerPath] = {
  id: pythonRunnerPath, filename: pythonRunnerPath, loaded: true,
  exports: {
    fmtPyError: prefix => `${prefix} (giả lập)`,
    runScript: async () => ({ code: 0 }),
    runWorker: async (cmd, args) => {
      assert.strictEqual(cmd, 'lab-day');
      const input = JSON.parse(fs.readFileSync(args[args.indexOf('--input') + 1], 'utf8'));
      const out = args[args.indexOf('--out') + 1];
      const day = args[args.indexOf('--day') + 1];
      runs.push({ day, ids: input.map(r => r['Mã BN'] || r.ma_bn) });
      const results = {};
      for (const [i, r] of input.entries()) {
        const id = r['Mã BN'] || r.ma_bn;
        if (workerBehaviour === 'stop-after-first' && i > 0) break;
        if (workerBehaviour === 'error') { results[id] = { status: 'error', phieu: [], error: 'Không mở được cửa sổ Xem kết quả', fetched_at: new Date().toISOString() }; continue; }
        results[id] = id === 'BN_NONE'
          ? { status: 'none', phieu: [], fetched_at: new Date().toISOString() }
          : { status: 'ok', parser: 2, fetched_at: new Date().toISOString(), phieu: [
            { ma_phieu: `${id}-1`, tg_chi_dinh: '07:00 09/11/2026', hoan_tat: true, ket_qua: [{ chi_so: 'WBC', ket_qua: '15', bat_thuong: 'bat_thuong' }] },
            ...(id === 'BN_PENDING' ? [{ ma_phieu: `${id}-2`, tg_chi_dinh: '07:00 09/11/2026', hoan_tat: false, ket_qua: [] }] : []),
          ] };
      }
      fs.writeFileSync(out, JSON.stringify({ ngay: day, results }));
      return workerBehaviour === 'stop-after-first' ? { code: 1, stderr: 'dừng' } : { code: 0 };
    },
  },
};

const express = require('express');
const SID = 'lab-test';

let failed = 0;
const test = async (name, fn) => { try { await fn(); console.log(`  ok - ${name}`); } catch (e) { failed += 1; console.error(`  FAIL - ${name}\n`, e); } };

function call(server, method, url, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : '';
    const req = http.request({ host: '127.0.0.1', port: server.address().port, method, path: url, headers: { 'content-type': 'application/json', 'x-session-id': SID, 'content-length': Buffer.byteLength(data) } }, res => {
      let buf = '';
      res.on('data', c => { buf += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(buf || '{}') }));
    });
    req.on('error', reject);
    req.end(data);
  });
}

(async () => {
  console.log('lab_results_test');
  const NOW = Date.parse('2026-11-09T12:00:00');

  await test('needsFetch: đủ kết quả không đọc lại; còn chờ, lỗi, chưa có thì đọc', () => {
    const done = { status: 'ok', parser: store.PARSER_VERSION, phieu: [{ hoan_tat: true }] };
    assert.strictEqual(store.needsFetch({ status: 'ok', phieu: [{ hoan_tat: true }] }, { now: NOW }), true, 'đọc bằng bản cũ (lệch cột) thì đọc lại');
    assert.strictEqual(store.needsFetch(done, { now: NOW }), false);
    assert.strictEqual(store.needsFetch(done, { now: NOW, force: true }), true);
    assert.strictEqual(store.needsFetch({ status: 'ok', parser: store.PARSER_VERSION, phieu: [{ hoan_tat: true }, { hoan_tat: false }] }, { now: NOW }), true);
    assert.strictEqual(store.needsFetch({ status: 'error' }, { now: NOW }), true);
    assert.strictEqual(store.needsFetch(null, { now: NOW }), true);
    assert.strictEqual(store.needsFetch({ status: 'none', fetched_at: '2026-11-09T11:30:00' }, { now: NOW }), false);
    assert.strictEqual(store.needsFetch({ status: 'none', fetched_at: '2026-11-09T10:30:00' }, { now: NOW }), true);
  });

  await test('mergeResults: lỗi lần này không xóa kết quả tốt; giữ tối đa 14 ngày', () => {
    let s = store.mergeResults({ days: {} }, '9/11/2026', { A: { status: 'ok', phieu: [{ hoan_tat: true }], fetched_at: 't1' } });
    s = store.mergeResults(s, '09/11/2026', { A: { status: 'error', error: 'mất kết nối', fetched_at: 't2' } });
    assert.strictEqual(s.days['09/11/2026'].A.status, 'ok');
    assert.strictEqual(s.days['09/11/2026'].A.fetched_at, 't1');
    assert.strictEqual(s.days['09/11/2026'].A.last_error, 'mất kết nối');
    for (let d = 1; d <= 20; d += 1) s = store.mergeResults(s, `${String(d).padStart(2, '0')}/10/2026`, { A: { status: 'none' } });
    assert.strictEqual(Object.keys(s.days).length, 14);
    assert.ok(s.days['09/11/2026'], 'giữ ngày mới nhất');
    assert.ok(!s.days['01/10/2026'], 'bỏ ngày cũ nhất');
  });

  const app = express();
  app.use(express.json());
  app.use('/api', require('../server/routes/lab_results'));
  const server = app.listen(0);
  try {
    await test('ngày sai dạng → 400 tiếng Việt', async () => {
      const r = await call(server, 'GET', '/api/lab-results?date=2026-11-09');
      assert.strictEqual(r.status, 400);
      assert.match(r.body.message, /dd\/mm\/yyyy/);
    });

    await test('lấy lần đầu: worker đọc đúng ngày, lưu theo người bệnh', async () => {
      const r = await call(server, 'POST', '/api/lab-results/fetch', { date: '09/11/2026', patients: [{ ma_bn: 'BN_OK', ho_ten: 'A' }, { ma_bn: 'BN_PENDING' }, { ma_bn: 'BN_NONE' }] });
      assert.strictEqual(r.status, 200, JSON.stringify(r.body));
      assert.deepStrictEqual(runs.at(-1), { day: '09/11/2026', ids: ['BN_OK', 'BN_PENDING', 'BN_NONE'] });
      assert.strictEqual(r.body.items.BN_OK.status, 'ok');
      assert.strictEqual(r.body.items.BN_NONE.status, 'none');
      const g = await call(server, 'GET', '/api/lab-results?date=09/11/2026');
      assert.deepStrictEqual(Object.keys(g.body.items).sort(), ['BN_NONE', 'BN_OK', 'BN_PENDING']);
    });

    await test('bấm lại: chỉ mở EMR cho ca còn phiếu chờ (ca đủ và ca "không có" vừa đọc thì bỏ qua)', async () => {
      const before = runs.length;
      const r = await call(server, 'POST', '/api/lab-results/fetch', { date: '09/11/2026', patients: [{ ma_bn: 'BN_OK' }, { ma_bn: 'BN_PENDING' }, { ma_bn: 'BN_NONE' }] });
      assert.strictEqual(r.status, 200);
      assert.strictEqual(runs.length, before + 1);
      assert.deepStrictEqual(runs.at(-1).ids, ['BN_PENDING']);
      assert.strictEqual(r.body.skipped, 2);
    });

    await test('đủ hết: không mở EMR; "Lấy lại" một người thì đọc người đó', async () => {
      const before = runs.length;
      const r = await call(server, 'POST', '/api/lab-results/fetch', { date: '09/11/2026', patients: [{ ma_bn: 'BN_OK' }] });
      assert.strictEqual(r.status, 200);
      assert.strictEqual(runs.length, before, 'không chạy worker');
      assert.match(r.body.message, /không cần mở EMR/);
      await call(server, 'POST', '/api/lab-results/fetch', { date: '09/11/2026', patients: [{ ma_bn: 'BN_OK' }], force_ids: ['BN_OK'] });
      assert.deepStrictEqual(runs.at(-1).ids, ['BN_OK']);
    });

    await test('đọc lỗi: giữ kết quả cũ, báo lỗi người bệnh mới', async () => {
      workerBehaviour = 'error';
      const r = await call(server, 'POST', '/api/lab-results/fetch', { date: '09/11/2026', patients: [{ ma_bn: 'BN_OK' }, { ma_bn: 'BN_NEW' }], force_ids: ['BN_OK'] });
      assert.strictEqual(r.status, 200);
      assert.strictEqual(r.body.items.BN_OK.status, 'ok');
      assert.match(r.body.items.BN_OK.last_error, /Xem kết quả/);
      assert.strictEqual(r.body.items.BN_NEW.status, 'error');
      assert.match(r.body.warning, /chưa đọc được/);
    });

    await test('dừng giữa chừng: lưu phần đã đọc, báo bấm lại để lấy tiếp', async () => {
      workerBehaviour = 'stop-after-first';
      const r = await call(server, 'POST', '/api/lab-results/fetch', { date: '10/11/2026', patients: [{ ma_bn: 'X1' }, { ma_bn: 'X2' }] });
      assert.strictEqual(r.status, 200);
      assert.deepStrictEqual(Object.keys(r.body.items), ['X1']);
      assert.match(r.body.warning, /Còn 1 người bệnh chưa đọc tới/);
    });

    await test('không chọn người bệnh → 400', async () => {
      const r = await call(server, 'POST', '/api/lab-results/fetch', { date: '09/11/2026', patients: [] });
      assert.strictEqual(r.status, 400);
      assert.match(r.body.message, /Chưa chọn người bệnh/);
    });
  } finally {
    server.close();
    fs.rmSync(root, { recursive: true, force: true });
  }

  if (failed) { console.error(`lab_results_test: ${failed} lỗi`); process.exit(1); }
  console.log('lab_results_test: OK');
})();
