#!/usr/bin/env node
'use strict';

// Lô lấy hành chánh của Kho nghiên cứu bị dừng vì hết giờ (ảnh người dùng 08/11/2026: ca 98–100/386
// báo "timeout"). Trước đây cả lô 25 ca chỉ có 30 phút cố định; EMR chậm là các ca cuối lô bị ghi lỗi
// dù không ca nào treo. Giờ: thời gian theo số ca + hẹn giờ "im lặng"; ca chưa tới lượt không bị tính lỗi.
// Chạy: node scripts/research_hchanh_batch_timeout_test.js

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const RUNTIME_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'research_batch_timeout_'));
process.env.EMR_RUNTIME_ROOT = RUNTIME_ROOT;

const calls = [];
const runnerPath = require.resolve('../server/services/python_runner');
const realRunner = require(runnerPath);
require.cache[runnerPath].exports = {
  ...realRunner,
  // Giả lập lô bị dừng vì hết giờ: ca 1 xong, ca 2 đang làm dở, ca 3 chưa tới lượt.
  runScript: async (_script, args, opts) => {
    calls.push(opts);
    const input = JSON.parse(fs.readFileSync(args[args.indexOf('--input') + 1], 'utf-8'));
    const progressPath = args[args.indexOf('--progress-file') + 1];
    const progress = JSON.parse(fs.readFileSync(progressPath, 'utf-8'));
    const [first, second] = input;
    progress[second._progress_key] = { ...progress[second._progress_key], status: 'running' };
    fs.writeFileSync(progressPath, JSON.stringify(progress));
    fs.writeFileSync(args[args.indexOf('--out') + 1], JSON.stringify({
      [first._progress_key]: {
        profile: { _fetch_status: 'ok', ngay_vao_vien: '08:00 20/09/2026', _admission_vitals_status: 'ok' },
        discharge: { _fetch_status: 'ok', ngay_ra: '28/09/2026', xu_tri: 'Ra viện' },
        surgery: { _fetch_status: 'ok', surgeries: [] },
        billing: { _fetch_status: 'ok', rows: [], tong_hop: { tong_chi_phi: 0 } },
      },
    }));
    return { code: null, killedByTimeout: true, timeoutKind: 'idle', stderrTail: [] };
  },
};

const fetchMod = require('../server/research/hchanh_fetch');
const router = require('../server/routes/research');
const fetchRun = router._fetchHchanhForResearchRun;
const { PY_TIMEOUT_MS } = require('../server/constants');

let failed = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ok - ${name}`); } catch (err) { failed += 1; console.error(`  FAIL - ${name}\n${err.stack}`); }
}

(async () => {
  await test('Thời gian chờ của lô tăng theo số ca, có hẹn giờ im lặng', () => {
    const one = fetchMod.hchanhBatchTimeouts(1);
    const big = fetchMod.hchanhBatchTimeouts(25);
    assert.strictEqual(one.timeoutMs, PY_TIMEOUT_MS, 'lô nhỏ giữ mức mặc định');
    assert.ok(big.timeoutMs >= 25 * 6 * 60 * 1000, `lô 25 ca phải có ít nhất 150 phút, thực tế ${big.timeoutMs / 60000} phút`);
    assert.strictEqual(big.idleTimeoutMs, 10 * 60 * 1000);
  });

  await test('Tiến trình im lặng quá lâu bị dừng với lý do "idle"; còn in ra thì không bị dừng', async () => {
    const silent = await realRunner.runPython(['-c', 'import time; time.sleep(30)'], { timeoutMs: 60000, idleTimeoutMs: 5000 });
    assert.strictEqual(silent.killedByTimeout, true);
    assert.strictEqual(silent.timeoutKind, 'idle');
    const chatty = await realRunner.runPython(['-c', 'import time\nfor i in range(4):\n    print(i, flush=True); time.sleep(2)'], { timeoutMs: 60000, idleTimeoutMs: 5000 });
    assert.strictEqual(chatty.killedByTimeout, false, 'in ra đều đặn thì không bị coi là treo dù chạy lâu hơn hẹn giờ im lặng');
  });

  await test('Lô hết giờ: ca xong giữ kết quả, ca dở báo lỗi hết giờ rõ ràng, ca chưa tới lượt để lần sau', async () => {
    const runDir = fs.mkdtempSync(path.join(RUNTIME_ROOT, 'run_'));
    const row = (bn, nc) => ({ 'Mã BN': bn, 'Họ tên': `BN ${bn}`, 'Mã NC': nc, 'Ngày vào viện': '21/09/2026', 'Ngày ra viện': '' });
    const ctx = { sid: 'test_batch_timeout', dir: runDir, LOGS_DIR: path.join(runDir, 'logs') };
    const stats = await fetchRun(ctx, runDir, { sourceRows: [row('99000201', 'NC1'), row('99000202', 'NC2'), row('99000203', 'NC3')], sourceRunId: 'r1' });

    assert.ok(calls[0].timeoutMs >= 3 * 6 * 60 * 1000 && calls[0].idleTimeoutMs > 0, 'worker được gọi với thời gian theo số ca');
    const progress = JSON.parse(fs.readFileSync(path.join(runDir, 'hchanh_auto_progress.json'), 'utf-8'));
    const byBn = bn => Object.values(progress).find(p => p.ma_bn === bn);
    assert.ok(['done', 'partial'].includes(byBn('99000201').status), `ca 1 đã xong, thực tế ${byBn('99000201').status}`);
    assert.strictEqual(byBn('99000202').status, 'error');
    assert.match(byBn('99000202').error, /Hết giờ chờ: EMR không phản hồi quá 10 phút/);
    assert.strictEqual(byBn('99000203').status, 'pending_refetch', 'ca chưa tới lượt không bị ghi lỗi');
    assert.strictEqual(stats.error, 1, 'chỉ ca đang dở tính là lỗi');

    const trace = JSON.parse(fs.readFileSync(path.join(runDir, 'research_case_trace_recent.json'), 'utf-8'));
    assert.ok(trace.every(c => (c.events || []).every(e => !/^(server|worker)\//.test(e.screen || ''))), 'không ghi đường dẫn code vào ô màn hình EMR');
  });

  fs.rmSync(RUNTIME_ROOT, { recursive: true, force: true });
  if (failed) { console.error(`research_hchanh_batch_timeout_test: ${failed} lỗi`); process.exit(1); }
  console.log('research_hchanh_batch_timeout_test: ok');
})();
