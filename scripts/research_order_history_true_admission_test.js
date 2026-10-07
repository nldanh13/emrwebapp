#!/usr/bin/env node
'use strict';

// Regression: dòng nguồn có T/G vào là ngày chuyển khoa (18/09) nhưng hồ sơ EMR đã
// xác minh lượt thật 05/09 → 21/09. Lịch sử y lệnh phải lấy theo toàn bộ lượt thật,
// không được cắt từ ngày chuyển khoa.
// Chạy: node scripts/research_order_history_true_admission_test.js

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const RUNTIME_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'research_order_true_admission_'));
process.env.EMR_RUNTIME_ROOT = RUNTIME_ROOT;

const spawned = [];
const runnerPath = require.resolve('../server/services/python_runner');
const realRunner = require(runnerPath);
require.cache[runnerPath].exports = {
  ...realRunner,
  runScript: async (_script, args) => {
    const input = JSON.parse(fs.readFileSync(args[args.indexOf('--input') + 1], 'utf-8'));
    const out = {};
    for (const item of input) {
      spawned.push({
        ma_bn: item.ma_bn,
        date_from: item.date_from,
        date_to: item.date_to,
        files: item._files_override || args[args.indexOf('--files') + 1].split(','),
      });
      out[item._progress_key] = {
        order_history: {
          _fetch_status: 'ok',
          rows: [{ tg_ylenh: '08:00 05/09/2026', ten_y_lenh: 'Y lệnh ngày vào viện' }],
        },
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

  // Mốc thật do worker đã đọc từ hồ sơ/ra viện EMR ở lần lấy hành chánh trước.
  fs.writeFileSync(path.join(runDir, 'hchanh_profile.csv'),
    '\ufeffMã BN,Ngày vào viện,Ngày ra viện,Research key\n' +
    '26082002,03:42 05-09-2026,17:40 21-09-2026,enc_actual\n', 'utf-8');
  fs.writeFileSync(path.join(runDir, 'hchanh_discharge.csv'),
    '\ufeffMã BN,Ngày vào viện,Ngày ra viện,Research key\n' +
    '26082002,03:42 05-09-2026,17:40 21/09/2026,enc_actual\n', 'utf-8');

  // Dòng scan là mốc CHUYỂN KHOA, không phải ngày vào viện thật.
  const sourceRows = [{
    'Mã NC': 'NC0001',
    'Mã BN': '26082002',
    'Họ tên': 'BN TEST',
    'T/G vào': '22:20 18/09/2026',
    'Ngày ra viện': '',
    fetch_from_date: '2026-09-18',
    fetch_to_date: '2026-10-06',
    'Research key': 'enc_transfer',
  }];

  // Mô phỏng dữ liệu cũ: progress đã "done" nhưng chưa có version parser/cửa sổ v4.
  fs.writeFileSync(path.join(runDir, 'order_history_auto_progress.json'), JSON.stringify({
    enc_transfer: {
      ma_bn: '26082002',
      status: 'done',
      files: ['order_history'],
      rows: { order_history: 87 },
    },
  }), 'utf-8');

  const ctx = { sid: 'test_order_true_admission', dir: runDir, LOGS_DIR: path.join(runDir, 'logs') };
  const stats = await fetchRun(ctx, runDir, {
    sourceRows,
    sourceRunId: 'r1',
    mode: 'order_history_auto',
    files: ['order_history'],
  });

  assert.strictEqual(stats.error, 0);
  assert.strictEqual(spawned.length, 1);
  assert.strictEqual(spawned[0].date_from, '2026-09-05',
    'date_from phải là ngày vào viện thật từ hchanh_profile, không phải ngày chuyển khoa 18/09');
  assert.strictEqual(spawned[0].date_to, '2026-09-21',
    'date_to phải dừng ở ngày ra viện thật khi hồ sơ đã xác minh');

  const orders = fs.readFileSync(path.join(runDir, 'hchanh_order_history.csv'), 'utf-8');
  assert.ok(orders.includes('05/09/2026'), 'phải giữ được y lệnh từ ngày vào viện thật');

  const progress = JSON.parse(fs.readFileSync(path.join(runDir, 'order_history_auto_progress.json'), 'utf-8'));
  assert.strictEqual(progress.enc_transfer.fetch_window_version, 4);
  assert.strictEqual(progress.enc_transfer.fetch_date_from, '2026-09-05');
  assert.strictEqual(progress.enc_transfer.fetch_date_to, '2026-09-21');

  // Sau khi đã sửa bằng version mới, chạy lại không được mở EMR lần nữa.
  spawned.length = 0;
  await fetchRun(ctx, runDir, {
    sourceRows,
    sourceRunId: 'r1',
    mode: 'order_history_auto',
    files: ['order_history'],
  });
  assert.strictEqual(spawned.length, 0, 'cửa sổ đã sửa rồi thì không được refetch lặp lại');

  // Regression parser v4: ca KHÔNG chuyển khoa vẫn phải refetch nếu progress cũ là v3.
  // Đây là đúng kiểu ca thực tế 26051766: kho cũ chỉ có Sismyodin, còn Thuốc/T-VT
  // chính chỉ xuất hiện sau khi parser mới đọc đủ hai nguồn.
  const runDirV4 = fs.mkdtempSync(path.join(RUNTIME_ROOT, 'run_parser_v4_'));
  const sourceRowsV4 = [{
    'Mã NC': 'NCV4001',
    'Mã BN': '26051766',
    'Họ tên': 'BN TEST V4',
    'T/G vào': '13:32 05/05/2026',
    'Ngày ra viện': '13:00 12/05/2026',
    fetch_from_date: '2026-05-05',
    fetch_to_date: '2026-05-12',
    'Research key': 'enc_parser_v4',
  }];
  fs.writeFileSync(path.join(runDirV4, 'hchanh_order_history.csv'),
    '\ufeffMã NC,Mã BN,TG y lệnh,Tên y lệnh,Y lệnh khác,Research key\n' +
    'NCV4001,26051766,05:00 12/05/2026,,(TT) Sismyodin 50mg 01v x3 uống mỗi 8h,enc_parser_v4\n', 'utf-8');
  fs.writeFileSync(path.join(runDirV4, 'order_history_auto_progress.json'), JSON.stringify({
    enc_parser_v4: {
      ma_bn: '26051766',
      status: 'done',
      files: ['order_history'],
      rows: { order_history: 7 },
      fetch_window_version: 3,
      fetch_date_from: '2026-05-05',
      fetch_date_to: '2026-05-12',
    },
  }), 'utf-8');

  spawned.length = 0;
  const ctxV4 = { sid: 'test_order_parser_v4', dir: runDirV4, LOGS_DIR: path.join(runDirV4, 'logs') };
  await fetchRun(ctxV4, runDirV4, {
    sourceRows: sourceRowsV4,
    sourceRunId: 'r1',
    mode: 'order_history_auto',
    files: ['order_history'],
  });
  assert.strictEqual(spawned.length, 1, 'progress v3 phải refetch dù ngày vào-ra không đổi');
  const progressV4 = JSON.parse(fs.readFileSync(path.join(runDirV4, 'order_history_auto_progress.json'), 'utf-8'));
  assert.strictEqual(progressV4.enc_parser_v4.fetch_window_version, 4);

  spawned.length = 0;
  await fetchRun(ctxV4, runDirV4, {
    sourceRows: sourceRowsV4,
    sourceRunId: 'r1',
    mode: 'order_history_auto',
    files: ['order_history'],
  });
  assert.strictEqual(spawned.length, 0, 'sau migration v4 không được refetch lặp lại');

  fs.rmSync(RUNTIME_ROOT, { recursive: true, force: true });
  console.log('research_order_history_true_admission_test: OK');
})().catch(err => {
  console.error(err);
  process.exit(1);
});
