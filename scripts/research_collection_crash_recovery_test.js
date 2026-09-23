#!/usr/bin/env node
'use strict';

// Kiểm thử giao dịch làm mới có thể khôi phục (server/routes/research.js):
// mô phỏng tiến trình chết ở từng thời điểm của một lần làm mới XN, rồi chạy lại và kiểm
// tra dữ liệu hiện tại + lịch sử phiên bản nhất quán: không mất bản cũ, không tạo bản trùng.
// Worker là GIẢ (ghi CSV/progress như worker thật), dữ liệu giả, không có BN thật.
// Chạy: node scripts/research_collection_crash_recovery_test.js

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const RUNTIME_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'research_collection_crash_test_'));
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
const INITIAL = [
  { 'T/G vào': '02/03/2026 08:00', 'Mã BN': 'BNA', 'Mã nội trú': 'NTA', 'Họ tên': 'Gia A', 'Tuổi': '60', 'GT': 'Nam', 'Trạng thái': 'Hoàn tất', 'Xử trí': 'Ra viện' },
  { 'T/G vào': '04/03/2026 10:00', 'Mã BN': 'BNC', 'Mã nội trú': 'NTC', 'Họ tên': 'Gia C', 'Tuổi': '80', 'GT': 'Nữ', 'Trạng thái': 'Hoàn tất', 'Xử trí': 'Ra viện' },
];
const CTX = { sid: 'crash-test' };
const SIMULATED = err => err && err.code === 'SIMULATED_CRASH';

// Một môi trường run riêng cho mỗi kịch bản.
function makeEnv(name, { xnWritesProgress = true } = {}) {
  const runDir = path.join(RUNTIME_ROOT, 'fixture', name);
  fs.mkdirSync(runDir, { recursive: true });
  writeCsv(path.join(runDir, 'du_lieu_ban_dau.csv'), INITIAL_COLS, INITIAL);
  const emr = { BNA: '120', BNC: '5' }; // kết quả Hb trên "EMR"
  const env = { runDir, emr, xnWritesProgress };
  env.rows = () => R.ensureResearchSourceRows(runDir, { sourceRunId: name, dateDefaults: { from_date: '2026-03-01', to_date: '2026-03-31' } }).rows;
  env.codeOf = code => env.rows().find(r => r['Mã BN'] === code)['Mã NC'];
  env.keyOf = code => env.rows().find(r => r['Mã BN'] === code)['Research key'];
  env.runners = {
    hchanh: async (_ctx, opts) => {
      const file = opts.mode === 'order_history_auto' ? 'order_history_auto_progress.json' : 'hchanh_auto_progress.json';
      const progress = readJson(path.join(runDir, file));
      for (const row of opts.sourceRows) {
        const at = tick();
        const fs0 = {};
        for (const f of opts.files) fs0[f] = { fetch_status: 'ok', rows: 0, at };
        const key = row['Research key'];
        progress[key] = { ...(progress[key] || {}), status: 'done', files: [...new Set([...(progress[key]?.files || []), ...opts.files])], finished_at: at, file_status: { ...(progress[key]?.file_status || {}), ...fs0 } };
      }
      fs.writeFileSync(path.join(runDir, file), JSON.stringify(progress), 'utf-8');
      return {};
    },
    // Giống script thật: commit CSV của lượt trước, rồi mới ghi progress.
    xnCdha: async (_ctx, opts) => {
      const csv = path.join(runDir, 'lich_su_xn.csv');
      let xnRows = fs.existsSync(csv) ? [...R.readCollectionPartRows(runDir).xn.values()].flat() : [];
      const progress = readJson(path.join(runDir, 'progress.json'));
      for (const row of opts.rows) {
        const code = row['Mã BN'];
        xnRows = xnRows.filter(r => r['Mã NC'] !== row['Mã NC']).concat([{ 'Mã NC': row['Mã NC'], 'Mã BN': code, 'Chỉ số': 'Hb', 'Kết quả': emr[code] }]);
        const key = `${code}|treatment:${String(row['Mã nội trú']).toLowerCase()}`;
        const item = progress[key] || { tab_saved: {}, counts: {}, tab_at: {} };
        Object.assign(item, { 'Research key': row['Research key'], 'Mã BN': code, 'Mã NC': row['Mã NC'], popup: 'done' });
        for (const tab of String(row.refetch_parts).split(';')) {
          item.tab_at[tab] = tick();
          item[tab] = tab === 'xn' ? 'done' : 'empty';
          item.counts[tab] = tab === 'xn' ? 1 : 0;
          item.tab_saved[tab] = true;
        }
        item.committed = Boolean(item.tab_saved.xn && item.tab_saved.cdha);
        item.status = item.committed ? 'done' : 'incomplete';
        item.updated_at = tick();
        progress[key] = item;
      }
      writeCsv(csv, ['Mã NC', 'Mã BN', 'Chỉ số', 'Kết quả'], xnRows);
      if (env.xnWritesProgress) fs.writeFileSync(path.join(runDir, 'progress.json'), JSON.stringify(progress), 'utf-8');
      return { ok: true };
    },
    normalize: () => ({ fake: true }),
  };
  env.run = (extra = {}) => R.runCollectionOrchestration(CTX, {
    runDir, runId: name, scope: 'nc_test', isArchive: false, sourceRows: env.rows(), maxAttempts: 3, maxPasses: 1,
    now: new Date(clock + 86400000).toISOString(), ...extra,
  }, env.runners);
  env.versions = () => {
    const file = path.join(runDir, 'collection_versions.jsonl');
    if (!fs.existsSync(file)) return [];
    return fs.readFileSync(file, 'utf-8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch (_) { return null; } }).filter(Boolean);
  };
  env.changes = () => {
    const file = path.join(runDir, 'collection_changes.csv');
    return fs.existsSync(file) ? fs.readFileSync(file, 'utf-8').replace(/^﻿/, '').trim().split('\n').slice(1) : [];
  };
  env.ledgerPart = (code, part) => readJson(path.join(runDir, 'collection_ledger.json')).encounters[env.keyOf(code)].parts[part];
  env.currentXn = code => (R.readCollectionPartRows(runDir).xn.get(env.codeOf(code)) || []).map(r => r['Kết quả']);
  env.txnDirs = () => {
    const root = path.join(runDir, '.collection_txn');
    return fs.existsSync(root) ? fs.readdirSync(root) : [];
  };
  env.txnLog = () => {
    const file = path.join(runDir, 'collection_txn_log.jsonl');
    return fs.existsSync(file) ? fs.readFileSync(file, 'utf-8').trim().split('\n').map(l => JSON.parse(l)) : [];
  };
  return env;
}

// Trạng thái cuối mong đợi sau khi làm mới XN của C (5 → 50) thành công một lần.
function assertConsistentAfterChange(env) {
  const cVersions = env.versions().filter(v => v.research_code === env.codeOf('BNC') && v.part === 'xn');
  assert.deepStrictEqual(
    cVersions.map(v => [v.version, v.role, v.rows.map(r => r['Kết quả']).join()]),
    [[1, 'before_change', '5'], [2, 'after_change', '50']],
    'lịch sử: đúng 1 bản cũ (5) + 1 bản mới (50), không trùng',
  );
  assert.strictEqual(env.versions().filter(v => v.research_code === env.codeOf('BNA')).length, 0, 'A không đổi → không có phiên bản');
  const changes = env.changes();
  assert.strictEqual(changes.length, 1, 'đúng 1 dòng thay đổi');
  assert.ok(changes[0].includes(env.codeOf('BNC')));
  const p = env.ledgerPart('BNC', 'xn');
  assert.deepStrictEqual([p.content_version, p.history_stored_version], [2, 2]);
  assert.deepStrictEqual(env.currentXn('BNC'), ['50'], 'dữ liệu hiện tại là bản mới');
  assert.deepStrictEqual(env.currentXn('BNA'), ['120']);
  assert.deepStrictEqual(env.txnDirs(), [], 'không còn staging/journal');
}

async function baseline(env) {
  await env.run();
  assert.deepStrictEqual(env.currentXn('BNC'), ['5']);
  assert.strictEqual(env.ledgerPart('BNC', 'xn').content_version, 1);
  env.emr.BNC = '50'; // EMR sửa kết quả; dòng danh sách không đổi
}

async function crashDuringRefresh(env, point) {
  let crashed = false;
  try {
    await env.run({ refreshParts: ['xn'], faults: { crashAt: point } });
  } catch (err) {
    if (!SIMULATED(err)) throw err;
    crashed = true;
  }
  assert.ok(crashed, `phải dừng tại ${point}`);
  assert.strictEqual(env.txnDirs().length, 1, 'giao dịch dở dang còn journal để khôi phục');
}

(async () => {
  await test('Dừng TRƯỚC khi ghi CSV: chạy lại không tạo phiên bản giả; làm mới lại thì lưu đúng một lần', async () => {
    const env = makeEnv('crash_before_csv');
    await baseline(env);
    await crashDuringRefresh(env, 'before_csv');
    assert.deepStrictEqual(env.currentXn('BNC'), ['5'], 'worker chưa chạy, dữ liệu cũ nguyên vẹn');
    const { report } = await env.run(); // khôi phục (không có gì để hoàn tất)
    assert.strictEqual(report.recovered_transactions, 1);
    assert.strictEqual(env.versions().length, 0);
    assert.deepStrictEqual(env.txnDirs(), []);
    await env.run({ refreshParts: ['xn'] });
    assertConsistentAfterChange(env);
  });

  await test('Dừng SAU khi ghi CSV (chưa lưu phiên bản, chưa ghi sổ): khôi phục lưu bản cũ từ ảnh chụp', async () => {
    const env = makeEnv('crash_after_csv');
    await baseline(env);
    await crashDuringRefresh(env, 'after_csv');
    assert.deepStrictEqual(env.currentXn('BNC'), ['50'], 'CSV đã bị thay');
    assert.strictEqual(env.versions().length, 0, 'chưa có lịch sử');
    const journalDir = path.join(env.runDir, '.collection_txn', env.txnDirs()[0]);
    const snap = readJson(path.join(journalDir, 'before_rows.json'));
    assert.ok(JSON.stringify(snap).includes('"5"'), 'ảnh chụp giữ bản cũ trước khi worker thay dữ liệu');
    const { report } = await env.run();
    assert.strictEqual(report.recovered_transactions, 1);
    assert.strictEqual(report.parts_changed, 1, 'thay đổi được báo trong lần chạy khôi phục');
    assertConsistentAfterChange(env);
    assert.ok(env.txnLog().some(l => l.recovered === true));
  });

  await test('Dừng SAU khi lưu phiên bản (chưa ghi thay đổi/sổ): chạy lại không ghi trùng phiên bản', async () => {
    const env = makeEnv('crash_after_versions');
    await baseline(env);
    await crashDuringRefresh(env, 'after_versions');
    assert.strictEqual(env.versions().length, 2, 'phiên bản đã ghi trước khi dừng');
    assert.strictEqual(env.changes().length, 0);
    assert.strictEqual(env.ledgerPart('BNC', 'xn').content_version, 1, 'sổ chưa cập nhật');
    await env.run();
    assertConsistentAfterChange(env);
  });

  await test('Dừng TRƯỚC khi cập nhật sổ (đã lưu phiên bản + thay đổi): chạy lại chỉ hoàn tất sổ', async () => {
    const env = makeEnv('crash_before_ledger');
    await baseline(env);
    await crashDuringRefresh(env, 'before_ledger');
    assert.strictEqual(env.versions().length, 2);
    assert.strictEqual(env.changes().length, 1);
    await env.run();
    assertConsistentAfterChange(env);
    // Làm mới thêm lần nữa, EMR không đổi → không phiên bản mới.
    await env.run({ refreshParts: ['xn'] });
    assertConsistentAfterChange(env);
    assert.strictEqual(env.ledgerPart('BNC', 'xn').last_check_outcome, 'unchanged');
  });

  await test('Xem trạng thái (đồng bộ sổ) cũng hoàn tất giao dịch dở trước khi đọc progress', async () => {
    const env = makeEnv('crash_then_status');
    await baseline(env);
    await crashDuringRefresh(env, 'after_csv');
    R.syncCollectionLedger(env.runDir, env.rows());
    assertConsistentAfterChange(env);
  });

  await test('Worker ghi CSV nhưng chết trước khi ghi progress: thay đổi vẫn được lưu phiên bản', async () => {
    const env = makeEnv('crash_csv_no_progress');
    await baseline(env);
    env.xnWritesProgress = false;
    await crashDuringRefresh(env, 'after_csv');
    await env.run();
    const cVersions = env.versions().filter(v => v.research_code === env.codeOf('BNC'));
    assert.deepStrictEqual(cVersions.map(v => [v.version, v.role]), [[1, 'before_change'], [2, 'after_change']]);
    const p = env.ledgerPart('BNC', 'xn');
    assert.deepStrictEqual([p.content_version, p.last_check_outcome], [2, 'changed_unconfirmed']);
    assert.deepStrictEqual(env.txnDirs(), []);
  });

  await test('Commit dở của script XN/CĐHA (.commit_*) được trả lại bản backup trước khi so sánh', () => {
    const env = makeEnv('python_staging');
    const csv = path.join(env.runDir, 'lich_su_xn.csv');
    writeCsv(csv, ['Mã NC', 'Kết quả'], [{ 'Mã NC': 'NC1', 'Kết quả': 'moi-do-dang' }]);
    const staging = path.join(env.runDir, '.commit_20260301T000000');
    fs.mkdirSync(staging);
    writeCsv(path.join(staging, 'lich_su_xn.csv.backup'), ['Mã NC', 'Kết quả'], [{ 'Mã NC': 'NC1', 'Kết quả': 'cu' }]);
    fs.writeFileSync(path.join(staging, 'state.json'), JSON.stringify({ phase: 'replacing', replace_targets: ['lich_su_xn.csv'] }));
    assert.strictEqual(R.recoverPythonPatientCommits(env.runDir), 1);
    assert.ok(fs.readFileSync(csv, 'utf-8').includes(',cu'));
    assert.ok(!fs.existsSync(staging));
  });

  await test('Dòng lịch sử bị cắt dở khi dừng không làm hỏng lần ghi sau', () => {
    const env = makeEnv('partial_line');
    const file = path.join(env.runDir, 'collection_versions.jsonl');
    fs.writeFileSync(file, `${JSON.stringify({ key: 'k', part: 'xn', version: 1, content_hash: 'h1', version_id: 'k|xn|v1|h1' })}\n{"key":"k","part":"xn","vers`);
    const v2 = { version_id: 'k|xn|v2|h2', key: 'k', part: 'xn', version: 2, content_hash: 'h2', rows: [] };
    assert.strictEqual(R.appendCollectionVersions(env.runDir, [v2]), 1);
    assert.strictEqual(R.appendCollectionVersions(env.runDir, [v2]), 0, 'không ghi trùng');
    const ids = R.readCollectionVersionIds(env.runDir);
    assert.deepStrictEqual([...ids].sort(), ['k|xn|v1|h1', 'k|xn|v2|h2']);
  });

  await test('Journal/ảnh chụp chỉ chủ sở hữu đọc được (quyền 600/700) và bị xóa sau khi hoàn tất', async () => {
    const env = makeEnv('permissions');
    await baseline(env);
    await crashDuringRefresh(env, 'after_csv');
    const dir = path.join(env.runDir, '.collection_txn', env.txnDirs()[0]);
    if (process.platform !== 'win32') {
      assert.strictEqual(fs.statSync(dir).mode & 0o777, 0o700);
      for (const f of ['journal.json', 'before_rows.json', 'before_ledger.json']) {
        assert.strictEqual(fs.statSync(path.join(dir, f)).mode & 0o777, 0o600, f);
      }
    }
    await env.run();
    assert.ok(!fs.existsSync(path.join(env.runDir, '.collection_txn')));
    const log = fs.readFileSync(path.join(env.runDir, 'collection_txn_log.jsonl'), 'utf-8');
    assert.ok(!log.includes('BNC') && !log.includes('Gia C'), 'nhật ký giao dịch không chứa định danh');
  });

  console.log(`\n${passed} kịch bản pass.`);
})();
