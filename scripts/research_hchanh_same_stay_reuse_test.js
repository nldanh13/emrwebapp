#!/usr/bin/env node
'use strict';

// Kiểm thử fetchHchanhForResearchRun: nhiều dòng nguồn của CÙNG một đợt nằm viện
// (cùng mã BN, ngày vào lệch vài ngày do chuyển khoa) chỉ được mở EMR 1 lần, các
// dòng sau dùng lại kết quả. Đợt nằm viện khác của cùng BN vẫn phải lấy riêng.
// Chạy: node scripts/research_hchanh_same_stay_reuse_test.js

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const RUNTIME_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'research_same_stay_test_'));
process.env.EMR_RUNTIME_ROOT = RUNTIME_ROOT;

// Stub worker Python: ghi output lô theo _progress_key, ngày vào/ra lấy theo mã BN.
const STAYS = {
  '111': { vao: '08:00 20-02-2026', ra: '10/03/2026' },
  '222': { vao: '09:00 05-01-2026', ra: '09/01/2026' },
};
const spawned = [];
const runnerPath = require.resolve('../server/services/python_runner');
const realRunner = require(runnerPath);
require.cache[runnerPath].exports = {
  ...realRunner,
  runScript: async (script, args) => {
    const input = JSON.parse(fs.readFileSync(args[args.indexOf('--input') + 1], 'utf-8'));
    const out = {};
    for (const item of input) {
      spawned.push(`${item.ma_bn}@${item.date_from}`);
      const stay = item.ma_bn === '111' && item.date_from >= '2026-05-01'
        ? { vao: '08:00 02-05-2026', ra: '12/05/2026' }
        : STAYS[item.ma_bn];
      out[item._progress_key] = {
        profile: { _fetch_status: 'ok', ngay_vao_vien: stay.vao, bhyt_code: 'X' },
        discharge: { _fetch_status: 'ok', ngay_ra: stay.ra, xu_tri: 'Ra viện' },
        surgery: { _fetch_status: 'ok', surgeries: [] },
        order_history: { _fetch_status: 'ok', rows: [{ ten_y_lenh: `YL ${item.ma_bn}`, ngay: stay.ra }] },
      };
    }
    fs.writeFileSync(args[args.indexOf('--out') + 1], JSON.stringify(out), 'utf-8');
    return { code: 0 };
  },
};

const router = require('../server/routes/research');
const fetchRun = router._fetchHchanhForResearchRun;

(async () => {
  const runDir = fs.mkdtempSync(path.join(RUNTIME_ROOT, 'run_'));
  const row = (bn, vao, nc) => ({ 'Mã BN': bn, 'Họ tên': `BN ${bn}`, 'Mã NC': nc, 'Ngày vào viện': vao, 'Ngày ra viện': '' });
  const sourceRows = [
    row('111', '20/02/2026', 'NC1'),
    row('222', '05/01/2026', 'NC2'),
    row('111', '25/02/2026', 'NC3'), // cùng đợt 20/02 → 10/03: dùng lại
    row('111', '04/03/2026', 'NC4'), // cùng đợt: dùng lại
    row('111', '02/05/2026', 'NC5'), // đợt khác: phải lấy riêng
  ];
  const ctx = { sid: 'test_same_stay', dir: runDir, LOGS_DIR: path.join(runDir, 'logs') };
  const stats = await fetchRun(ctx, runDir, { sourceRows, sourceRunId: 'r1' });

  assert.deepStrictEqual(spawned.sort(), ['111@2026-02-20', '111@2026-05-02', '222@2026-01-05'].sort(),
    `Chỉ được mở EMR 3 lần, thực tế: ${spawned.join(', ')}`);
  assert.strictEqual(stats.reused, 2);
  assert.strictEqual(stats.error, 0);

  const progress = JSON.parse(fs.readFileSync(path.join(runDir, 'hchanh_auto_progress.json'), 'utf-8'));
  const reused = Object.values(progress).filter(p => p.reused_from);
  assert.strictEqual(reused.length, 2);
  assert.ok(reused.every(p => p.status === 'done'));

  // Mỗi dòng nguồn vẫn có dòng riêng (Research key riêng, Mã NC riêng) trong CSV.
  const orders = fs.readFileSync(path.join(runDir, 'hchanh_order_history.csv'), 'utf-8');
  for (const nc of ['NC1', 'NC2', 'NC3', 'NC4', 'NC5']) assert.ok(orders.includes(nc), `thiếu ${nc} trong hchanh_order_history.csv`);

  // Chạy lại: mọi ca đã done → không mở EMR thêm lần nào.
  spawned.length = 0;
  await fetchRun(ctx, runDir, { sourceRows, sourceRunId: 'r1' });
  assert.strictEqual(spawned.length, 0);

  console.log('  ok - cùng đợt nằm viện chỉ lấy 1 lần, đợt khác lấy riêng, mỗi dòng giữ key riêng');
})().catch(err => { console.error('  FAIL -', err); process.exitCode = 1; });
