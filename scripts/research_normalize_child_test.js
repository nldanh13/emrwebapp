#!/usr/bin/env node
'use strict';

// Chuẩn hóa chạy ở tiến trình riêng: cho cùng kết quả như chạy trực tiếp, và trong lúc chạy
// máy chủ (event loop) vẫn trả lời được yêu cầu khác — trước đây bị chặn cả vài phút.
// Chạy: node scripts/research_normalize_child_test.js

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.EMR_RUNTIME_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'research_normalize_child_'));
delete process.env.EMR_NORMALIZE_INLINE;
const { runNormalizeJob } = require('../server/research/normalize_runner');

function writeCsv(file, cols, rows) {
  const esc = v => (/[",\n]/.test(String(v ?? '')) ? `"${String(v).replace(/"/g, '""')}"` : String(v ?? ''));
  fs.writeFileSync(file, `﻿${[cols.join(','), ...rows.map(r => cols.map(c => esc(r[c])).join(','))].join('\n')}\n`);
}

(async () => {
  const runDir = path.join(process.env.EMR_RUNTIME_ROOT, 'store', 'kho', 'runs', 'r1');
  fs.mkdirSync(runDir, { recursive: true });
  const rows = Array.from({ length: 60 }, (_, i) => ({
    'T/G vào': `08:00 ${String(1 + (i % 27)).padStart(2, '0')}/02/2026`, 'Mã BN': `10${String(i % 40).padStart(5, '0')}`,
    'Mã nội trú': `nt-${i}`, 'Họ tên': `BN GIA LAP ${i}`, 'Ngày ra viện': '28/02/2026',
  }));
  writeCsv(path.join(runDir, 'du_lieu_ban_dau.csv'), ['T/G vào', 'Mã BN', 'Mã nội trú', 'Họ tên', 'Ngày ra viện'], rows);

  // Đồng hồ đo event loop: nếu chuẩn hóa chạy trong tiến trình này, các tick bị dồn lại.
  let ticks = 0;
  const timer = setInterval(() => { ticks += 1; }, 5);
  const started = Date.now();
  const result = await runNormalizeJob({ kind: 'run', runDir, options: { sourceRunId: 'r1', force: true } });
  const elapsed = Date.now() - started;
  clearInterval(timer);

  assert.ok(result && result.cached === false, 'trả về kết quả chuẩn hóa từ tiến trình con');
  assert.strictEqual(Number(result.encounters), 60);
  assert.ok(fs.existsSync(path.join(runDir, 'analysis_ready.csv')), 'đã ghi bảng chuẩn');
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(runDir, 'normalize_state.json'), 'utf8')).status, 'complete');
  // Event loop vẫn chạy trong lúc chờ: số tick ~ thời gian / 5 ms (cho phép máy CI chậm).
  assert.ok(ticks >= Math.floor(elapsed / 5) * 0.3, `event loop không bị chặn (${ticks} tick trong ${elapsed} ms)`);
  console.log(`  ok - chuẩn hóa ở tiến trình riêng: ${result.encounters} lượt, ${elapsed} ms, ${ticks} tick`);

  await assert.rejects(runNormalizeJob({ kind: 'study', studyId: 'khong_ton_tai' }), 'lỗi ở tiến trình con được trả về');
  console.log('  ok - lỗi trong tiến trình con được báo lại cho máy chủ');

  fs.rmSync(process.env.EMR_RUNTIME_ROOT, { recursive: true, force: true });
  console.log('\n2 test(s) passed.');
})().catch(err => { console.error(err); process.exitCode = 1; });
