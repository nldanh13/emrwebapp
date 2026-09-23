#!/usr/bin/env node
'use strict';

// Kiểm thử điều phối thu thập tự động (runCollectionOrchestration) với worker GIẢ:
// không mở Chrome/EMR, chỉ ghi progress như worker thật. Dữ liệu giả, không có BN thật.
//  1. Lần đầu lấy đủ mọi lượt; lỗi kỹ thuật được thử lại ngay trong lần chạy.
//  2. Lần sau chỉ lấy phần còn lỗi; lượt không đổi bị bỏ qua.
//  3. Hết số lần thử → không gọi worker nữa, nằm trong danh sách ngoại lệ.
//  4. Danh sách EMR thay đổi ở một lượt → chỉ lấy lại lượt đó.
//  5. XN lỗi nhưng CĐHA lấy được: lần sau chỉ gửi yêu cầu lấy lại XN.
// Chạy: node scripts/research_collection_orchestration_test.js

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const RUNTIME_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'research_collection_orch_test_'));
process.env.EMR_RUNTIME_ROOT = RUNTIME_ROOT;

const research = require('../server/routes/research');
const R = research._test;

let passed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ok - ${name}`);
  } catch (err) {
    console.error(`  FAIL - ${name}`);
    console.error(err);
    process.exitCode = 1;
  }
}

function writeCsv(file, cols, rows) {
  const esc = v => (/[",\n]/.test(String(v ?? '')) ? `"${String(v).replace(/"/g, '""')}"` : String(v ?? ''));
  fs.writeFileSync(file, `﻿${[cols.join(','), ...rows.map(r => cols.map(c => esc(r[c])).join(','))].join('\n')}\n`, 'utf-8');
}

function readJson(file, fallback = {}) {
  try { return JSON.parse(fs.readFileSync(file, 'utf-8')); } catch (_) { return fallback; }
}

let clock = Date.parse('2026-03-01T00:00:00Z');
function tick() {
  clock += 1000;
  return new Date(clock).toISOString();
}

const INITIAL_COLS = ['T/G vào', 'Mã BN', 'Mã nội trú', 'Họ tên', 'Tuổi', 'GT', 'Trạng thái', 'Khoa chuyển đến', 'Xử trí'];
function initialRows(overrides = {}) {
  return [
    { 'T/G vào': '02/03/2026 08:00', 'Mã BN': 'BNA', 'Mã nội trú': 'NTA', 'Họ tên': 'Gia A', 'Tuổi': '60', 'GT': 'Nam', 'Trạng thái': 'Hoàn tất', 'Khoa chuyển đến': '', 'Xử trí': 'Ra viện', ...(overrides.A || {}) },
    { 'T/G vào': '03/03/2026 09:00', 'Mã BN': 'BNB', 'Mã nội trú': 'NTB', 'Họ tên': 'Gia B', 'Tuổi': '70', 'GT': 'Nữ', 'Trạng thái': 'Hoàn tất', 'Khoa chuyển đến': '', 'Xử trí': 'Ra viện', ...(overrides.B || {}) },
    { 'T/G vào': '04/03/2026 10:00', 'Mã BN': 'BNC', 'Mã nội trú': 'NTC', 'Họ tên': 'Gia C', 'Tuổi': '80', 'GT': 'Nữ', 'Trạng thái': 'Hoàn tất', 'Khoa chuyển đến': '', 'Xử trí': 'Ra viện', ...(overrides.C || {}) },
  ];
}

// Worker giả. behavior(code, part, callNo) → 'ok' | 'empty' | 'timeout' | 'tab_load'
function fakeRunners(runDir, behavior) {
  const calls = { hchanh: [], xn: [] };
  const callCount = {};
  const next = (code, part) => {
    const k = `${code}|${part}`;
    callCount[k] = (callCount[k] || 0) + 1;
    return behavior(code, part, callCount[k]);
  };
  return {
    calls,
    runners: {
      hchanh: async (_ctx, opts) => {
        const file = opts.mode === 'order_history_auto' ? 'order_history_auto_progress.json' : 'hchanh_auto_progress.json';
        const progressPath = path.join(runDir, file);
        const progress = readJson(progressPath);
        calls.hchanh.push({ mode: opts.mode, files: opts.files.slice(), codes: opts.sourceRows.map(r => r['Mã BN']) });
        for (const row of opts.sourceRows) {
          const key = row['Research key'];
          const at = tick();
          const fileStatus = {};
          for (const f of opts.files) {
            const b = next(row['Mã BN'], f);
            fileStatus[f] = b === 'ok' ? { fetch_status: 'ok', rows: 2, at } : b === 'empty' ? { fetch_status: 'ok', rows: 0, at } : { fetch_status: 'timeout', rows: 0, at };
          }
          progress[key] = {
            ...(progress[key] || {}), status: 'done', files: [...new Set([...(progress[key]?.files || []), ...opts.files])],
            finished_at: at, file_status: { ...(progress[key]?.file_status || {}), ...fileStatus },
          };
        }
        fs.writeFileSync(progressPath, JSON.stringify(progress), 'utf-8');
        return { cancelled: false };
      },
      xnCdha: async (_ctx, opts) => {
        const progressPath = path.join(runDir, 'progress.json');
        const progress = readJson(progressPath);
        calls.xn.push(opts.rows.map(r => `${r['Mã BN']}:${r.refetch_parts}`));
        for (const row of opts.rows) {
          const key = `${row['Mã BN']}|treatment:${String(row['Mã nội trú']).toLowerCase()}`;
          const item = progress[key] || { tab_saved: {}, counts: {}, tab_reason: {}, tab_at: {} };
          item['Research key'] = row['Research key'];
          item['Mã BN'] = row['Mã BN'];
          item['Mã NC'] = row['Mã NC'];
          item.popup = 'done';
          for (const tab of String(row.refetch_parts).split(';')) {
            const b = next(row['Mã BN'], tab);
            item.tab_at[tab] = tick();
            if (b === 'ok' || b === 'empty') {
              item[tab] = b === 'ok' ? 'done' : 'empty';
              item.counts[tab] = b === 'ok' ? 5 : 0;
              item.tab_saved[tab] = true;
              delete item.tab_reason[tab];
            } else {
              item[tab] = 'error';
              item.tab_reason[tab] = 'tab_load: Tab không tải xong nội dung';
              delete item.tab_saved[tab];
            }
          }
          item.committed = ['xn', 'cdha'].every(t => item.tab_saved[t]);
          item.status = item.committed ? 'done' : 'incomplete';
          item.updated_at = tick();
          progress[key] = item;
        }
        fs.writeFileSync(progressPath, JSON.stringify(progress), 'utf-8');
        return { ok: true };
      },
      normalize: () => ({ fake: true }),
    },
  };
}

const runDir = path.join(RUNTIME_ROOT, 'fixture', 'collect_run');
fs.mkdirSync(runDir, { recursive: true });
const CTX = { sid: 'collection-test' };

function sourceRows(force = false) {
  return R.ensureResearchSourceRows(runDir, { sourceRunId: 'collect_run', dateDefaults: { from_date: '2026-03-01', to_date: '2026-03-31' }, force }).rows;
}

// B: XN lỗi lần đầu rồi được; C: Ra viện luôn timeout; còn lại OK. CĐHA của A: EMR không có.
const behavior = (code, part, n) => {
  if (code === 'BNB' && part === 'xn' && n === 1) return 'tab_load';
  if (code === 'BNC' && part === 'discharge') return 'timeout';
  if (code === 'BNA' && part === 'cdha') return 'empty';
  return 'ok';
};
const fake = fakeRunners(runDir, behavior);
const opts = rows => ({ runDir, runId: 'collect_run', scope: 'du_lieu_goc', isArchive: true, sourceRows: rows, maxAttempts: 3, maxPasses: 2 });

(async () => {
  writeCsv(path.join(runDir, 'du_lieu_ban_dau.csv'), INITIAL_COLS, initialRows());

  await test('Lần đầu: lấy đủ 3 lượt, lỗi kỹ thuật được thử lại ngay trong lần chạy', async () => {
    const rows = sourceRows(true);
    assert.strictEqual(rows.length, 3);
    assert.ok(rows.every(r => /^[0-9a-f]{10}:/.test(r.list_row_signatures)), 'research_source có chữ ký danh sách');
    const { report, ledger } = await R.runCollectionOrchestration(CTX, opts(rows), fake.runners);
    assert.strictEqual(report.new_encounters, 3);
    assert.strictEqual(report.fetched_encounters, 3);
    // Lần thử lại trong cùng lần chạy: XN của B (và Ra viện của C).
    assert.deepStrictEqual(fake.calls.xn[1], ['BNB:xn']);
    const retryHc = fake.calls.hchanh.find((c, i) => i > 0 && c.files.join() === 'discharge');
    assert.deepStrictEqual(retryHc.codes, ['BNC']);
    const b = Object.values(ledger.encounters).find(e => e.patient_code === 'BNB');
    assert.strictEqual(b.parts.xn.status, 'ok');
    const a = Object.values(ledger.encounters).find(e => e.patient_code === 'BNA');
    assert.strictEqual(a.parts.cdha.status, 'empty', 'EMR không có CĐHA được ghi là empty, không phải lỗi');
    const c = Object.values(ledger.encounters).find(e => e.patient_code === 'BNC');
    assert.deepStrictEqual([c.parts.discharge.status, c.parts.discharge.attempts], ['failed', 2]);
    assert.strictEqual(report.selenium_errors_open, 1);
    assert.strictEqual(report.exceptions[0].patient_code, 'BNC');
    assert.ok(fs.existsSync(path.join(runDir, 'collection_report.json')));
    assert.ok(fs.existsSync(path.join(runDir, 'collection_exceptions.csv')));
    assert.ok(fs.existsSync(path.join(runDir, 'collection_ledger.json')));
  });

  await test('Lần hai: chỉ lấy lại Ra viện của C, 2 lượt không đổi được bỏ qua', async () => {
    fake.calls.hchanh.length = 0;
    fake.calls.xn.length = 0;
    const { report, ledger } = await R.runCollectionOrchestration(CTX, opts(sourceRows()), fake.runners);
    assert.strictEqual(report.skipped_unchanged, 2);
    assert.deepStrictEqual(fake.calls.hchanh.map(c => [c.files.join(), c.codes.join()]), [['discharge', 'BNC']]);
    assert.strictEqual(fake.calls.xn.length, 0);
    const c = Object.values(ledger.encounters).find(e => e.patient_code === 'BNC');
    assert.strictEqual(c.parts.discharge.attempts, 3);
    assert.strictEqual(report.retry_exhausted, 1);
  });

  await test('Hết lượt thử: không gọi worker nữa, vẫn nằm trong ngoại lệ', async () => {
    fake.calls.hchanh.length = 0;
    fake.calls.xn.length = 0;
    const { report } = await R.runCollectionOrchestration(CTX, opts(sourceRows()), fake.runners);
    assert.strictEqual(fake.calls.hchanh.length + fake.calls.xn.length, 0);
    assert.strictEqual(report.fetched_encounters, 0);
    assert.strictEqual(report.exceptions.length, 1);
    assert.strictEqual(report.exceptions[0].category, 'retry_exhausted');
    const history = fs.readFileSync(path.join(runDir, 'collection_history.jsonl'), 'utf-8').trim().split('\n');
    assert.strictEqual(history.length, 3);
    assert.ok(!history[2].includes('BNC'), 'lịch sử chỉ ghi số đếm, không ghi mã BN');
  });

  await test('Danh sách EMR đổi ở lượt A → chỉ lấy lại lượt A', async () => {
    fake.calls.hchanh.length = 0;
    fake.calls.xn.length = 0;
    writeCsv(path.join(runDir, 'du_lieu_ban_dau.csv'), INITIAL_COLS, initialRows({ A: { 'Xử trí': 'Chuyển viện' } }));
    const { report } = await R.runCollectionOrchestration(CTX, opts(sourceRows(true)), fake.runners);
    assert.deepStrictEqual(fake.calls.xn, [['BNA:xn;cdha']]);
    assert.ok(fake.calls.hchanh.every(c => c.codes.join() === 'BNA'));
    assert.strictEqual(report.skipped_unchanged, 1, 'B không đổi; C còn lỗi nên không tính là không đổi');
    assert.strictEqual(report.parts_backfilled, 6);
  });

  await test('Đủ dùng theo nghiên cứu trên run thật: C thiếu Ra viện chỉ ảnh hưởng đề tài cần Ra viện', async () => {
    const rows = sourceRows();
    const needDischarge = R.studyReadinessForRun({ data_requirements: { parts: ['discharge'] } }, runDir, rows);
    const onlyXn = R.studyReadinessForRun({ data_requirements: { parts: ['xn'] } }, runDir, rows);
    const byCode = res => Object.fromEntries(res.rows.map(r => [r.research_code, r.readiness]));
    const codeOf = code => rows.find(r => r['Mã BN'] === code)['Mã NC'];
    assert.strictEqual(byCode(needDischarge)[codeOf('BNC')], 'incomplete');
    assert.strictEqual(byCode(onlyXn)[codeOf('BNC')], 'usable');
  });

  await test('Trạng thái riêng từng file hành chánh: EMR nay rỗng mà trước có dữ liệu → cần xem', () => {
    const patch = R.hchanhFileStatusPatch(
      { discharge: { _fetch_status: 'ok' }, surgery: { _fetch_status: 'timeout' } },
      { discharge: 0, surgery: 0 }, ['discharge', 'surgery'], { discharge: 1 }, 't',
    );
    assert.strictEqual(patch.discharge.override_status, 'blocked');
    assert.strictEqual(R.hchanhEntryFileStatus({ file_status: patch }, 'discharge'), 'blocked');
    assert.strictEqual(R.hchanhEntryFileStatus({ file_status: patch }, 'surgery'), 'error');
    assert.strictEqual(R.hchanhEntryFileStatus({ file_status: { surgery: { fetch_status: 'ok', rows: 0 } } }, 'surgery'), 'empty');
  });

  console.log(`\n${passed} kịch bản pass.`);
})();
