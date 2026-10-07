#!/usr/bin/env node
'use strict';

// Kiểm tra sổ thu thập (server/research/collection.js): trạng thái riêng từng phần,
// lấy bù đúng phần thiếu/lỗi/thay đổi, giới hạn thử lại, báo cáo và "đủ dùng" theo nghiên cứu.
// Chạy: node scripts/research_collection_test.js

const assert = require('assert');
const c = require('../server/research/collection');

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ok - ${name}`);
  } catch (err) {
    console.error(`  FAIL - ${name}`);
    console.error(err.stack || err.message || err);
    process.exitCode = 1;
  }
}

// Dữ liệu giả, không phải người bệnh thật.
function src(key, rc, code, extra = {}) {
  const row = {
    'Research key': key, 'Mã NC': rc, 'Mã BN': code, 'Mã nội trú': `NT_${key}`,
    'Ngày vào viện': '2026-01-05', 'T/G vào': '05/01/2026 08:00', 'Trạng thái': 'Hoàn tất', 'Xử trí': 'Ra viện',
    'Họ tên': 'Nguoi Benh Gia', 'Tuổi': '70', 'GT': 'Nữ', ...extra,
  };
  row.list_row_signatures = c.listRowSignature(row);
  return row;
}

function xnEntry(key, rc, code, tabs, at = '2026-01-10T00:00:00Z') {
  return {
    'Research key': key, 'Mã NC': rc, 'Mã BN': code, 'Mã nội trú': `NT_${key}`,
    popup: 'done', ...tabs.status, counts: tabs.counts || {}, tab_saved: tabs.saved || {},
    tab_reason: tabs.reason || {}, tab_at: { xn: at, cdha: at }, committed: Boolean(tabs.committed), updated_at: at,
  };
}

function hcEntry(files, at = '2026-01-10T00:00:00Z') {
  const file_status = {};
  for (const [f, v] of Object.entries(files)) file_status[f] = { ...v, at };
  return { status: 'done', files: Object.keys(files), file_status, finished_at: at };
}

const OK_HC = { profile: { fetch_status: 'ok', rows: 1 }, discharge: { fetch_status: 'ok', rows: 1 }, surgery: { fetch_status: 'ok', rows: 0 } };
const OK_OH = { order_history: { fetch_status: 'ok', rows: 12 } };
const XN_OK = { status: { xn: 'done', cdha: 'empty' }, counts: { xn: 20, cdha: 0 }, saved: { xn: true, cdha: true }, committed: true };

function fullyCollected(sources) {
  const xn = {}; const hc = {}; const oh = {};
  for (const s of sources) {
    xn[`${s['Mã BN']}|treatment:x${s['Research key']}`] = xnEntry(s['Research key'], s['Mã NC'], s['Mã BN'], XN_OK);
    hc[s['Research key']] = hcEntry(OK_HC);
    oh[s['Research key']] = hcEntry(OK_OH);
  }
  return { xn, hc, oh };
}

test('Phân loại kết quả hành chánh: có dữ liệu / EMR không có / lỗi kỹ thuật / không tìm thấy / giao diện lạ', () => {
  assert.strictEqual(c.classifyFetchStatus('ok', 3).status, 'ok');
  assert.strictEqual(c.classifyFetchStatus('ok', 0).status, 'empty');
  assert.deepStrictEqual(c.classifyFetchStatus('timeout', 0), { status: 'failed', reason: 'timeout' });
  assert.deepStrictEqual(c.classifyFetchStatus('no_session', 0), { status: 'failed', reason: 'session' });
  assert.deepStrictEqual(c.classifyFetchStatus('no_url', 0), { status: 'failed', reason: 'not_found' });
  assert.deepStrictEqual(c.classifyFetchStatus('empty', 0), { status: 'failed', reason: 'no_content' });
  assert.deepStrictEqual(c.classifyFetchStatus('no_table', 0), { status: 'blocked', reason: 'emr_ui_changed', detail: 'no_table' });
});

test('Chẩn đoán lỗi thu thập chỉ rõ bước tìm BN, mở lượt, mở dữ liệu và đọc dữ liệu', () => {
  assert.deepStrictEqual(c.diagnosticFor('not_found'), {
    diagnostic_stage: 'patient_search',
    diagnostic_stage_label: '1. Tìm người bệnh',
    diagnostic_message: 'Không tìm thấy người bệnh theo Mã BN trên EMR.',
  });
  assert.strictEqual(c.diagnosticFor('popup_error').diagnostic_stage, 'encounter_open');
  assert.strictEqual(c.diagnosticFor('emr_ui_changed', 'no_table').diagnostic_stage, 'data_open');
  assert.strictEqual(c.diagnosticFor('no_content').diagnostic_stage, 'data_read');
  assert.strictEqual(c.diagnosticFor('session').diagnostic_stage, 'emr_session');
});

test('Tóm tắt chẩn đoán cho biết phần nào lỗi và ví dụ lượt để truy ngược', () => {
  const rows = [
    { key: 'enc_a', research_code: 'NC0001', category: 'selenium_error', part: 'xn', part_label: 'Xét nghiệm', reason: 'no_result' },
    { key: 'enc_a', research_code: 'NC0001', category: 'selenium_error', part: 'cdha', part_label: 'CĐHA', reason: 'no_result' },
    { key: 'enc_b', research_code: 'NC0002', category: 'retry_exhausted', part: 'xn', part_label: 'Xét nghiệm', reason: 'no_result' },
  ].map(r => ({ ...r, ...c.diagnosticFor(r.reason) }));
  const summary = c.summarizeDiagnostics(rows);
  assert.strictEqual(summary.length, 1);
  assert.strictEqual(summary[0].encounters, 2);
  assert.strictEqual(summary[0].rows, 3);
  assert.deepStrictEqual(summary[0].by_part.map(x => [x.part, x.rows, x.encounters]), [
    ['xn', 2, 2],
    ['cdha', 1, 1],
  ]);
  assert.deepStrictEqual(summary[0].states, ['error', 'waiting']);
  assert.deepStrictEqual(summary[0].samples.map(x => x.research_code), ['NC0001', 'NC0002']);
});

test('Phân loại tab XN/CĐHA: "0 dòng" bản cũ chưa được tin là EMR không có', () => {
  const legacy = { xn: 'done', cdha: 'done', committed: true, counts: { xn: 0, cdha: 4 }, updated_at: 't1' };
  assert.strictEqual(c.classifyXnTab(legacy, 'xn').reason, 'legacy_empty_unverified');
  assert.strictEqual(c.classifyXnTab(legacy, 'cdha').status, 'ok');
  const fresh = { xn: 'empty', cdha: 'error', tab_saved: { xn: true }, tab_reason: { cdha: 'tab_load: Tab CĐHA không tải xong' }, tab_at: { xn: 't2', cdha: 't2' } };
  assert.strictEqual(c.classifyXnTab(fresh, 'xn').status, 'empty');
  assert.deepStrictEqual([c.classifyXnTab(fresh, 'cdha').status, c.classifyXnTab(fresh, 'cdha').reason], ['failed', 'tab_load']);
  const notCommitted = { xn: 'done', cdha: 'error', committed: false, counts: { xn: 5 } };
  assert.strictEqual(c.classifyXnTab(notCommitted, 'xn').reason, 'interrupted', 'XN done mà chưa commit không được coi là đã có');
  const blocked = { xn: 'blocked', cdha: 'blocked', tab_reason: { xn: 'encounter_not_identified: x', cdha: 'encounter_not_identified: x' } };
  assert.deepStrictEqual([c.classifyXnTab(blocked, 'xn').status, c.classifyXnTab(blocked, 'xn').reason], ['blocked', 'encounter_not_identified']);
});

test('Chỉ lấy lại đúng phần lỗi; ca đủ và không đổi thì bỏ qua', () => {
  const sources = [src('enc_a', 'NC0001', 'BN_A'), src('enc_b', 'NC0002', 'BN_B')];
  const { xn, hc, oh } = fullyCollected(sources);
  xn['BN_B|treatment:xenc_b'] = xnEntry('enc_b', 'NC0002', 'BN_B', {
    status: { xn: 'error', cdha: 'done' }, counts: { cdha: 2 }, saved: { cdha: true },
    reason: { xn: 'tab_load: Tab XN không tải xong nội dung' },
  });
  const ledger = c.buildLedger({ sourceRows: sources, xnProgress: xn, hchanhProgress: hc, orderProgress: oh });
  const plan = c.planCollection(ledger);
  assert.strictEqual(plan.summary.unchanged, 1);
  assert.strictEqual(plan.tasks.length, 1);
  assert.deepStrictEqual(plan.tasks[0].parts, ['xn']);
  assert.strictEqual(plan.tasks[0].reasons.xn, 'retry');
  const groups = c.groupTasksByFetcher(plan.tasks);
  assert.strictEqual(groups.xn_cdha.length, 1);
  assert.strictEqual(groups.hchanh.size, 0);
  assert.strictEqual(groups.order_history.length, 0);
});

test('Ca mới lấy đủ 6 phần; ca đã có mà thiếu một phần hành chánh chỉ lấy phần đó', () => {
  const sources = [src('enc_a', 'NC0001', 'BN_A'), src('enc_new', 'NC0003', 'BN_N')];
  const { xn, hc, oh } = fullyCollected([sources[0]]);
  hc.enc_a = hcEntry({ profile: OK_HC.profile, discharge: OK_HC.discharge, surgery: { fetch_status: 'timeout', rows: 0 } });
  const ledger = c.buildLedger({ sourceRows: sources, xnProgress: xn, hchanhProgress: hc, orderProgress: oh });
  const plan = c.planCollection(ledger);
  const byKey = Object.fromEntries(plan.tasks.map(t => [t.key, t]));
  assert.deepStrictEqual(byKey.enc_a.parts, ['surgery']);
  assert.strictEqual(byKey.enc_new.parts.length, 6);
  assert.strictEqual(byKey.enc_new.is_new, true);
  const groups = c.groupTasksByFetcher(plan.tasks);
  assert.deepStrictEqual([...groups.hchanh.keys()].sort(), ['discharge,profile,surgery', 'surgery']);
});

test('Danh sách EMR thay đổi → lấy lại; chỉ đổi họ tên/tuổi → chỉ lấy lại hồ sơ nền', () => {
  const sources = [src('enc_a', 'NC0001', 'BN_A'), src('enc_b', 'NC0002', 'BN_B')];
  const { xn, hc, oh } = fullyCollected(sources);
  const first = c.buildLedger({ sourceRows: sources, xnProgress: xn, hchanhProgress: hc, orderProgress: oh });
  assert.strictEqual(c.planCollection(first).tasks.length, 0);

  const changed = [src('enc_a', 'NC0001', 'BN_A', { 'Xử trí': 'Chuyển viện' }), src('enc_b', 'NC0002', 'BN_B', { 'Tuổi': '71' })];
  const second = c.buildLedger({ sourceRows: changed, xnProgress: xn, hchanhProgress: hc, orderProgress: oh, previous: first });
  const plan = c.planCollection(second);
  const byKey = Object.fromEntries(plan.tasks.map(t => [t.key, t]));
  assert.strictEqual(byKey.enc_a.parts.length, 6);
  assert.ok(Object.values(byKey.enc_a.reasons).every(r => r === 'changed'));
  assert.deepStrictEqual(byKey.enc_b.parts, ['profile']);

  // Worker lấy lại xong (progress có mốc mới) → hết "đã thay đổi".
  const later = '2026-02-01T00:00:00Z';
  const xn2 = { ...xn, 'BN_A|treatment:xenc_a': xnEntry('enc_a', 'NC0001', 'BN_A', XN_OK, later) };
  const hc2 = { ...hc, enc_a: hcEntry(OK_HC, later), enc_b: hcEntry(OK_HC, later) };
  const oh2 = { ...oh, enc_a: hcEntry(OK_OH, later) };
  const third = c.buildLedger({ sourceRows: changed, xnProgress: xn2, hchanhProgress: hc2, orderProgress: oh2, previous: second });
  assert.strictEqual(c.planCollection(third).tasks.length, 0);
});

test('Dòng bị gộp khỏi danh sách hoặc lần đầu có chữ ký thì không bị coi là thay đổi', () => {
  const sources = [src('enc_a', 'NC0001', 'BN_A')];
  const { xn, hc, oh } = fullyCollected(sources);
  const noSig = sources.map(r => ({ ...r, list_row_signatures: '' }));
  const first = c.buildLedger({ sourceRows: noSig, xnProgress: xn, hchanhProgress: hc, orderProgress: oh });
  const second = c.buildLedger({ sourceRows: sources, xnProgress: xn, hchanhProgress: hc, orderProgress: oh, previous: first });
  assert.strictEqual(c.planCollection(second).tasks.length, 0, 'chữ ký đầu tiên chỉ làm mốc');
  const transfer = src('enc_a', 'NC0001', 'BN_A', { 'T/G vào': '07/01/2026 10:00', 'Khoa chuyển đến': 'Hồi sức' });
  const merged = [{ ...sources[0], list_row_signatures: c.mergeSignatures(sources[0].list_row_signatures, transfer.list_row_signatures) }];
  const third = c.buildLedger({ sourceRows: merged, xnProgress: xn, hchanhProgress: hc, orderProgress: oh, previous: second });
  assert.strictEqual(c.planCollection(third).tasks[0].parts.length, 6, 'thêm dòng chuyển khoa mới = EMR đã thay đổi');
  const fourth = c.buildLedger({ sourceRows: sources, xnProgress: xn, hchanhProgress: hc, orderProgress: oh, previous: { ...third, encounters: { enc_a: { ...third.encounters.enc_a, change_seq: 0, parts: Object.fromEntries(Object.entries(third.encounters.enc_a.parts).map(([k, p]) => [k, { ...p, seen_seq: 0 }])) } } } });
  assert.strictEqual(c.planCollection(fourth).tasks.length, 0, 'dòng bị gộp khỏi file không phải là thay đổi');
});

test('Lỗi kỹ thuật thử lại có giới hạn, rồi vào danh sách ngoại lệ', () => {
  const sources = [src('enc_a', 'NC0001', 'BN_A')];
  const { xn, hc, oh } = fullyCollected(sources);
  let ledger = null;
  for (let i = 1; i <= 3; i += 1) {
    hc.enc_a = hcEntry({ ...OK_HC, discharge: { fetch_status: 'timeout', rows: 0 } }, `2026-01-1${i}T00:00:00Z`);
    ledger = c.buildLedger({ sourceRows: sources, xnProgress: xn, hchanhProgress: hc, orderProgress: oh, previous: ledger });
  }
  assert.strictEqual(ledger.encounters.enc_a.parts.discharge.attempts, 3);
  const plan = c.planCollection(ledger, { maxAttempts: 3 });
  assert.strictEqual(plan.tasks.length, 0);
  assert.strictEqual(plan.summary.exhausted_parts, 1);
  const ex = c.exceptionRows(ledger, { maxAttempts: 3 });
  assert.strictEqual(ex.length, 1);
  assert.strictEqual(ex[0].category, 'retry_exhausted');
  assert.strictEqual(ex[0].auto_retry, 'no');
  assert.strictEqual(ex[0].diagnostic_stage, 'technical');
  assert.match(ex[0].diagnostic_message, /EMR không phản hồi kịp/);
  // Hết lỗi → đếm lại từ 0.
  hc.enc_a = hcEntry(OK_HC, '2026-01-20T00:00:00Z');
  ledger = c.buildLedger({ sourceRows: sources, xnProgress: xn, hchanhProgress: hc, orderProgress: oh, previous: ledger });
  assert.strictEqual(ledger.encounters.enc_a.parts.discharge.attempts, 0);
  assert.strictEqual(ledger.encounters.enc_a.parts.discharge.status, 'ok');
});

test('Giao việc mà worker không trả kết quả → ghi lỗi no_result một lần, không đếm trùng', () => {
  const sources = [src('enc_a', 'NC0001', 'BN_A')];
  const { xn, hc, oh } = fullyCollected(sources);
  delete oh.enc_a;
  const before = c.buildLedger({ sourceRows: sources, xnProgress: xn, hchanhProgress: hc, orderProgress: oh });
  const after = c.buildLedger({ sourceRows: sources, xnProgress: xn, hchanhProgress: hc, orderProgress: oh, previous: before });
  c.applyDispatchOutcome(before, after, [{ key: 'enc_a', part: 'order_history' }]);
  assert.deepStrictEqual([after.encounters.enc_a.parts.order_history.status, after.encounters.enc_a.parts.order_history.reason, after.encounters.enc_a.parts.order_history.attempts], ['failed', 'no_result', 1]);
  const rebuilt = c.buildLedger({ sourceRows: sources, xnProgress: xn, hchanhProgress: hc, orderProgress: oh, previous: after });
  assert.strictEqual(rebuilt.encounters.enc_a.parts.order_history.status, 'failed');
  assert.strictEqual(rebuilt.encounters.enc_a.parts.order_history.attempts, 1);
});

test('Ledger cũ: XN/CĐHA no_result đã hết retry được mở lại đúng một lần sau sửa lỗi worker cấp lô', () => {
  const sources = [src('enc_a', 'NC0001', 'BN_A')];
  const legacy = c.buildLedger({ sourceRows: sources });
  legacy.version = 1;
  for (const part of ['xn', 'cdha']) {
    legacy.encounters.enc_a.parts[part] = {
      ...legacy.encounters.enc_a.parts[part],
      status: 'failed',
      reason: 'no_result',
      detail: 'Đã giao cho worker nhưng không nhận được kết quả mới cho phần này',
      attempts: 3,
      no_result_at: '2026-10-07T00:00:00Z',
    };
  }

  const migrated = c.buildLedger({ sourceRows: sources, previous: legacy });
  assert.strictEqual(migrated.version, 2);
  assert.deepStrictEqual(
    ['xn', 'cdha'].map(part => [migrated.encounters.enc_a.parts[part].status, migrated.encounters.enc_a.parts[part].reason, migrated.encounters.enc_a.parts[part].attempts]),
    [['failed', 'no_result', 0], ['failed', 'no_result', 0]],
  );
  const retry = c.planCollection(migrated, { parts: ['xn', 'cdha'], maxAttempts: 3 });
  assert.deepStrictEqual(retry.tasks.map(t => [t.key, t.parts]), [['enc_a', ['xn', 'cdha']]]);

  // Migration chỉ chạy từ ledger v1 → v2. Sau v2, nếu một ca thật sự lại hết 3
  // lần thử thì không được reset vô hạn ở mỗi lần dựng sổ.
  const exhausted = JSON.parse(JSON.stringify(migrated));
  exhausted.encounters.enc_a.parts.xn.attempts = 3;
  exhausted.encounters.enc_a.parts.cdha.attempts = 3;
  const rebuilt = c.buildLedger({ sourceRows: sources, previous: exhausted });
  assert.deepStrictEqual(['xn', 'cdha'].map(part => rebuilt.encounters.enc_a.parts[part].attempts), [3, 3]);
  assert.strictEqual(c.planCollection(rebuilt, { parts: ['xn', 'cdha'], maxAttempts: 3 }).tasks.length, 0);
});

test('Không tìm thấy BN để cuối; không xác định chắc lượt thì dừng, không tự thử lại', () => {
  const sources = [src('enc_a', 'NC0001', 'BN_A'), src('enc_b', 'NC0002', 'BN_B'), src('enc_c', 'NC0003', 'BN_C')];
  const { xn, hc, oh } = fullyCollected(sources);
  hc.enc_a = hcEntry({ ...OK_HC, profile: { fetch_status: 'no_url', rows: 0 } });
  hc.enc_b = hcEntry({ ...OK_HC, discharge: { fetch_status: 'timeout', rows: 0 } });
  delete xn['BN_C|treatment:xenc_c'];
  xn['source:enc_c'] = xnEntry('enc_c', 'NC0003', 'BN_C', {
    status: { xn: 'blocked', cdha: 'blocked' },
    reason: { xn: 'encounter_not_identified: không lượt nào khớp', cdha: 'encounter_not_identified: không lượt nào khớp' },
  });
  const ledger = c.buildLedger({ sourceRows: sources, xnProgress: xn, hchanhProgress: hc, orderProgress: oh });
  const plan = c.planCollection(ledger);
  assert.deepStrictEqual(plan.tasks.map(t => t.key), ['enc_b', 'enc_a'], 'ca không tìm thấy BN xếp cuối');
  assert.strictEqual(plan.tasks[1].deferred, true);
  assert.ok(!plan.tasks.some(t => t.key === 'enc_c'), 'ca không ghép chắc lượt không tự thử lại');
  const report = c.buildRunReport({ before: ledger, after: ledger, plan });
  assert.strictEqual(report.unmatched_encounters, 1);
  assert.strictEqual(report.selenium_errors_open, 2);
});

test('Progress không ghép chắc về một dòng nguồn thì bỏ, không đoán', () => {
  const a = src('enc_a', 'NC0001', 'BN_A', { 'Mã nội trú': '' });
  const b = src('enc_b', 'NC0002', 'BN_A', { 'Mã nội trú': '' });
  const entry = { 'Mã BN': 'BN_A', 'Mã NC': 'NC0001', 'Ngày vào viện': '05/01/2026', xn: 'done', cdha: 'done', committed: true, counts: { xn: 3, cdha: 1 } };
  const { matches, unmatched } = c.matchXnEntriesToSources({ 'BN_A|2026-01-05|x': entry }, [a, b].map(r => ({
    key: r['Research key'], research_code: r['Mã NC'], patient_code: r['Mã BN'], noitru: '', treatment: '', admission_date: '2026-01-05',
  })));
  assert.strictEqual(matches.size, 0);
  assert.strictEqual(unmatched.length, 1);
  assert.strictEqual(unmatched[0].ambiguous, true);
});

test('Báo cáo vận hành: số ca lấy, bỏ qua vì không đổi, phần lấy bù, lỗi còn tồn', () => {
  const sources = [src('enc_a', 'NC0001', 'BN_A'), src('enc_b', 'NC0002', 'BN_B'), src('enc_new', 'NC0003', 'BN_N')];
  const { xn, hc, oh } = fullyCollected(sources.slice(0, 2));
  hc.enc_b = hcEntry({ ...OK_HC, surgery: { fetch_status: 'timeout', rows: 0 } });
  const before = c.buildLedger({ sourceRows: sources, xnProgress: xn, hchanhProgress: hc, orderProgress: oh });
  const plan = c.planCollection(before);
  const later = '2026-02-01T00:00:00Z';
  const xn2 = { ...xn, 'BN_N|treatment:xenc_new': xnEntry('enc_new', 'NC0003', 'BN_N', XN_OK, later) };
  const hc2 = { ...hc, enc_b: hcEntry(OK_HC, later), enc_new: hcEntry({ ...OK_HC, discharge: { fetch_status: 'no_session', rows: 0 } }, later) };
  const oh2 = { ...oh, enc_new: hcEntry(OK_OH, later) };
  const after = c.buildLedger({ sourceRows: sources, xnProgress: xn2, hchanhProgress: hc2, orderProgress: oh2, previous: before });
  const report = c.buildRunReport({ before, after, plan });
  assert.strictEqual(report.skipped_unchanged, 1);
  assert.strictEqual(report.fetched_encounters, 2);
  assert.strictEqual(report.parts_backfilled, 1);
  assert.strictEqual(report.parts_new, 5);
  assert.strictEqual(report.selenium_errors_open, 1);
  assert.strictEqual(report.exceptions[0].part, 'discharge');
});

test('Đủ dùng theo từng nghiên cứu: thiếu CT vẫn dùng được cho đề tài không cần CT', () => {
  const sources = [src('enc_ct', 'NC0001', 'BN_A'), src('enc_noct', 'NC0002', 'BN_B'), src('enc_fail', 'NC0003', 'BN_C'), src('enc_review', 'NC0004', 'BN_D')];
  const { xn, hc, oh } = fullyCollected(sources);
  xn['BN_C|treatment:xenc_fail'] = xnEntry('enc_fail', 'NC0003', 'BN_C', {
    status: { xn: 'done', cdha: 'error' }, counts: { xn: 3 }, saved: { xn: true }, reason: { cdha: 'tab_load: x' },
  });
  xn['BN_D|treatment:xenc_review'] = xnEntry('enc_review', 'NC0004', 'BN_D', {
    status: { xn: 'done', cdha: 'blocked' }, counts: { xn: 3 }, saved: { xn: true }, reason: { cdha: 'emr_ui_changed: bảng lạ' },
  });
  const ledger = c.buildLedger({ sourceRows: sources, xnProgress: xn, hchanhProgress: hc, orderProgress: oh });
  const tables = {
    encounters: sources.map(s => ({ encounter_id: s['Research key'], research_code: s['Mã NC'] })),
    imaging_results: [{ encounter_id: 'enc_ct', research_code: 'NC0001', modality: 'CT', service_name_raw: 'CT sọ não' }],
    lab_results: [],
  };
  const needCt = c.requirementsFromStudy({ data_requirements: { parts: ['profile'], items: [{ kind: 'imaging_modality', value: 'CT', label: 'Có CT' }] } });
  assert.ok(needCt.parts.includes('cdha'), 'yêu cầu CT tự kéo theo phần CĐHA');
  const r1 = c.evaluateStudyReadiness({ ledger, requirements: needCt, tables });
  const s1 = Object.fromEntries(r1.rows.map(r => [r.key, r.readiness]));
  assert.deepStrictEqual(s1, { enc_ct: 'usable', enc_noct: 'not_eligible', enc_fail: 'incomplete', enc_review: 'needs_review' });

  const noCt = c.requirementsFromStudy({ data_requirements: { parts: ['xn', 'profile', 'discharge'] } });
  const r2 = c.evaluateStudyReadiness({ ledger, requirements: noCt, tables });
  const s2 = Object.fromEntries(r2.rows.map(r => [r.key, r.readiness]));
  assert.deepStrictEqual(s2, { enc_ct: 'usable', enc_noct: 'usable', enc_fail: 'usable', enc_review: 'usable' });
});

test('Yêu cầu dữ liệu suy ra từ biến đã chọn của đề cương', () => {
  const req = c.requirementsFromStudy({
    variable_selection: {
      selected_variables: [{ id: 'v1', table: 'lab_results', name: 'lab:Hb' }, { id: 'v2', table: 'encounters', name: 'admission_date' }],
      conditions: [{ id: 'c1', variable_id: 'v3', table: 'imaging_results', name: 'imaging_modality:CT', virtual_kind: 'imaging_modality', operator: 'not_empty' }],
    },
  });
  assert.strictEqual(req.source, 'variables');
  assert.deepStrictEqual(req.parts.sort(), ['cdha', 'discharge', 'profile', 'xn']);
  assert.strictEqual(req.conditions.length, 1);
  assert.deepStrictEqual(c.requirementsFromStudy({}).parts, c.PART_KEYS);
});

test('Chính sách làm mới riêng từng phần: chỉ phần quá hạn; phần không đặt hạn thì không tự kiểm tra lại', () => {
  const sources = [src('enc_a', 'NC0001', 'BN_A')];
  const { xn, hc, oh } = fullyCollected(sources); // mốc kiểm tra 2026-01-10
  const ledger = c.buildLedger({ sourceRows: sources, xnProgress: xn, hchanhProgress: hc, orderProgress: oh });
  const now = '2026-01-25T00:00:00Z';
  assert.strictEqual(c.planCollection(ledger, { now }).tasks.length, 0, 'không có chính sách → không tự kiểm tra lại');
  const plan = c.planCollection(ledger, { now, refreshPolicy: { xn: 14, cdha: 30, surgery: 0, bogus: 3 } });
  assert.deepStrictEqual(plan.tasks[0].parts, ['xn'], 'XN quá 14 ngày; CĐHA chưa quá 30 ngày; 0 = không đặt');
  assert.strictEqual(plan.tasks[0].reasons.xn, 'refresh_due');
  assert.strictEqual(plan.tasks[0].refresh_only, true);
  assert.strictEqual(plan.summary.unchanged, 0);
  assert.deepStrictEqual(c.sanitizeRefreshPolicy({ xn: 14, cdha: '30', surgery: 0, bogus: 3 }), { xn: 14, cdha: 30 });
  const manual = c.planCollection(ledger, { now, refreshParts: ['cdha'], refreshKeys: ['enc_a'] });
  assert.deepStrictEqual([manual.tasks[0].parts, manual.tasks[0].reasons.cdha], [['cdha'], 'manual_refresh']);
  assert.strictEqual(c.planCollection(ledger, { now, refreshParts: ['cdha'], refreshKeys: ['enc_khac'] }).tasks.length, 0);
});

test('Lấy lại: không đổi thì giữ nguyên phiên bản; đổi thì lưu bản cũ + bản mới, ghi phần nào đổi', () => {
  const sources = [src('enc_a', 'NC0001', 'BN_A')];
  const { xn, hc, oh } = fullyCollected(sources);
  const v0 = c.buildLedger({ sourceRows: sources, xnProgress: xn, hchanhProgress: hc, orderProgress: oh });
  const target = [{ key: 'enc_a', part: 'xn' }];
  const rowsV1 = [{ 'Mã NC': 'NC0001', 'Chỉ số': 'Hb', 'Kết quả': '120', source_run_id: 'r1' }, { 'Mã NC': 'NC0001', 'Chỉ số': 'CRP', 'Kết quả': '5' }];
  const recheck = at => {
    const xn2 = { ...xn, 'BN_A|treatment:xenc_a': xnEntry('enc_a', 'NC0001', 'BN_A', XN_OK, at) };
    return c.buildLedger({ sourceRows: sources, xnProgress: xn2, hchanhProgress: hc, orderProgress: oh, previous: v0 });
  };
  // 1) Lấy lại, nội dung giống (chỉ khác cột kỹ thuật source_run_id) → không đổi.
  const same = recheck('2026-02-01T00:00:00Z');
  const r1 = c.applyContentVersions({
    before: v0, after: same, targets: target,
    beforeRows: new Map([['enc_a|xn', rowsV1]]),
    afterRows: new Map([['enc_a|xn', rowsV1.map(r => ({ ...r, source_run_id: 'r2' }))]]),
    now: '2026-02-01T00:00:00Z',
  });
  assert.deepStrictEqual([r1.rechecked, r1.unchanged, r1.changes.length, r1.versions.length], [1, 1, 0, 0]);
  assert.strictEqual(same.encounters.enc_a.parts.xn.last_check_outcome, 'unchanged');
  assert.strictEqual(same.encounters.enc_a.parts.xn.content_version, 1);
  // 2) Kết quả CRP được sửa trên EMR (danh sách không đổi) → phiên bản 2.
  const edited = [rowsV1[0], { ...rowsV1[1], 'Kết quả': '50' }];
  const changed = c.buildLedger({ sourceRows: sources, xnProgress: { ...xn, 'BN_A|treatment:xenc_a': xnEntry('enc_a', 'NC0001', 'BN_A', XN_OK, '2026-03-01T00:00:00Z') }, hchanhProgress: hc, orderProgress: oh, previous: same });
  const r2 = c.applyContentVersions({
    before: same, after: changed, targets: target,
    beforeRows: new Map([['enc_a|xn', rowsV1]]), afterRows: new Map([['enc_a|xn', edited]]),
    reasons: { 'enc_a|xn': 'refresh_due' }, now: '2026-03-01T00:00:00Z',
  });
  assert.strictEqual(r2.changes.length, 1);
  assert.deepStrictEqual([r2.changes[0].from_version, r2.changes[0].to_version, r2.changes[0].rows_added, r2.changes[0].rows_removed, r2.changes[0].trigger], [1, 2, 1, 1, 'refresh_due']);
  assert.deepStrictEqual(r2.versions.map(v => [v.version, v.role, v.rows.length]), [[1, 'before_change', 2], [2, 'after_change', 2]]);
  const pxn = changed.encounters.enc_a.parts.xn;
  assert.deepStrictEqual([pxn.content_version, pxn.last_check_outcome, pxn.content_changed_at], [2, 'changed', '2026-03-01T00:00:00Z']);
  // 3) Dựng lại sổ không làm mất thông tin phiên bản.
  const rebuilt = c.buildLedger({ sourceRows: sources, xnProgress: { ...xn, 'BN_A|treatment:xenc_a': xnEntry('enc_a', 'NC0001', 'BN_A', XN_OK, '2026-03-01T00:00:00Z') }, hchanhProgress: hc, orderProgress: oh, previous: changed });
  assert.strictEqual(rebuilt.encounters.enc_a.parts.xn.content_version, 2);
  // 4) Đổi lần nữa: bản 2 đã lưu → chỉ ghi thêm bản 3.
  const later = c.buildLedger({ sourceRows: sources, xnProgress: { ...xn, 'BN_A|treatment:xenc_a': xnEntry('enc_a', 'NC0001', 'BN_A', XN_OK, '2026-04-01T00:00:00Z') }, hchanhProgress: hc, orderProgress: oh, previous: rebuilt });
  const r3 = c.applyContentVersions({
    before: rebuilt, after: later, targets: target,
    beforeRows: new Map([['enc_a|xn', edited]]), afterRows: new Map([['enc_a|xn', [...edited, { 'Chỉ số': 'PLT', 'Kết quả': '200' }]]]),
  });
  assert.deepStrictEqual(r3.versions.map(v => [v.version, v.role]), [[3, 'after_change']]);
});

test('Báo cáo: phần kiểm tra lại không tính là lấy bù; đếm số phần có thay đổi', () => {
  const sources = [src('enc_a', 'NC0001', 'BN_A')];
  const { xn, hc, oh } = fullyCollected(sources);
  const before = c.buildLedger({ sourceRows: sources, xnProgress: xn, hchanhProgress: hc, orderProgress: oh });
  const plan = c.planCollection(before, { now: '2026-03-01T00:00:00Z', refreshPolicy: { xn: 7 } });
  const after = c.buildLedger({ sourceRows: sources, xnProgress: { ...xn, 'BN_A|treatment:xenc_a': xnEntry('enc_a', 'NC0001', 'BN_A', XN_OK, '2026-03-01T00:00:00Z') }, hchanhProgress: hc, orderProgress: oh, previous: before });
  const report = c.buildRunReport({ before, after, plan, content: { rechecked: 1, unchanged: 0, changes: [{ key: 'enc_a', part: 'xn' }] } });
  assert.strictEqual(report.parts_backfilled, 0);
  assert.strictEqual(report.parts_rechecked, 1);
  assert.strictEqual(report.parts_changed, 1);
  assert.strictEqual(report.fetched_encounters, 1);
});

test('Kho cũ: các dòng chuyển khoa (không Mã nội trú) gom về 1 lượt; tiến độ nằm rải ở các dòng vẫn được nhận', () => {
  // Một lượt 02/03 → 10/03 có 3 dòng danh sách (3 khoa); một lượt khác 20/04 → 25/04.
  const row = (key, tg, extra = {}) => src(key, '', 'BN_X', { 'Mã nội trú': '', 'T/G vào': tg, 'Ngày vào viện': '', ...extra });
  const rows = [
    row('k1', '02/03/2026 08:00'), row('k2', '05/03/2026 09:00', { 'Khoa chuyển đến': 'Hồi sức' }), row('k3', '08/03/2026 10:00'),
    row('k4', '20/04/2026 07:00'),
  ];
  const encounterRows = [
    { encounter_id: 'enc_stay1', research_code: 'NC0100', patient_code: 'BN_X', admission_date: '2026-03-02 08:00', discharge_date: '2026-03-10 09:00' },
    { encounter_id: 'enc_stay2', research_code: 'NC0101', patient_code: 'BN_X', admission_date: '2026-04-20 07:00', discharge_date: '2026-04-25 09:00' },
  ];
  const units = c.buildCollectionUnits({ sourceRows: rows, encounterRows });
  const byKey = Object.fromEntries(units.map(u => [u.key, u]));
  assert.deepStrictEqual(Object.keys(byKey).sort(), ['enc_stay1', 'enc_stay2']);
  assert.deepStrictEqual(byKey.enc_stay1.members.sort(), ['k1', 'k2', 'k3']);
  assert.strictEqual(byKey.enc_stay1.row['Research key'], 'k1', 'dòng giao cho worker là dòng vào sớm nhất');
  assert.strictEqual(byKey.enc_stay1.signatures.split(' ').length, 3);

  // XN (bản cũ, không Research key) ghi ngày vào của lượt; hành chánh nằm ở dòng k2 (dòng giữa).
  const xn = { 'BN_X|treatment:abc': { 'Mã BN': 'BN_X', 'Mã NC': 'NC0007', 'Ngày vào viện': '02/03/2026 08:00', xn: 'done', cdha: 'done', committed: true, counts: { xn: 12, cdha: 2 }, updated_at: 't1' } };
  const hc = { k2: hcEntry(OK_HC) };
  const oh = { k3: hcEntry(OK_OH) };
  const ledger = c.buildLedger({ units, xnProgress: xn, hchanhProgress: hc, orderProgress: oh });
  const stay1 = ledger.encounters.enc_stay1;
  assert.ok(c.PART_KEYS.every(k => c.partIsCurrent(stay1, k)), 'lượt đủ 6 phần dù tiến độ nằm ở các dòng khác nhau');
  assert.ok(stay1.data_codes.includes('NC0007'), 'nhớ Mã NC script XN đã dùng để so dữ liệu thô');
  const plan = c.planCollection(ledger);
  assert.strictEqual(plan.summary.encounters, 2);
  assert.strictEqual(plan.summary.unchanged, 1);
  assert.deepStrictEqual(plan.tasks.map(t => [t.key, t.parts.length]), [['enc_stay2', 6]]);
});

test('Lượt chưa có ngày ra (đang nằm/chưa lấy ra viện): dòng chuyển khoa ngày sau vẫn ghép, không lấn sang lượt sau', () => {
  // Nguồn không còn Mã nội trú để ghép (chỉ Mã BN + thời gian): trước đây khoảng của lượt chưa ra
  // viện chỉ gồm đúng ngày vào, nên mọi dòng chuyển khoa ngày sau thành "chưa ghép chắc".
  const row = (key, code, tg) => src(key, '', code, { 'Mã nội trú': '', 'T/G vào': tg, 'Ngày vào viện': '' });
  const rows = [
    row('o1', 'BN_OPEN', '02/03/2026 08:00'), row('o2', 'BN_OPEN', '05/03/2026 09:00'),
    row('p1', 'BN_PREV', '01/02/2026 08:00'), row('p2', 'BN_PREV', '03/02/2026 10:00'), row('p3', 'BN_PREV', '12/02/2026 07:00'),
  ];
  const encounterRows = [
    { encounter_id: 'e_open', patient_code: 'BN_OPEN', admission_date: '2026-03-02 08:00', discharge_date: '' },
    // Lượt cũ thiếu ngày ra + lượt mới: khoảng của lượt cũ dừng trước lượt mới.
    { encounter_id: 'e_prev_old', patient_code: 'BN_PREV', admission_date: '2026-02-01 08:00', discharge_date: '' },
    { encounter_id: 'e_prev_new', patient_code: 'BN_PREV', admission_date: '2026-02-12 07:00', discharge_date: '' },
  ];
  const units = c.buildCollectionUnits({ sourceRows: rows, encounterRows });
  const byKey = Object.fromEntries(units.map(u => [u.key, u]));
  assert.deepStrictEqual(Object.keys(byKey).sort(), ['e_open', 'e_prev_new', 'e_prev_old']);
  assert.deepStrictEqual(byKey.e_open.members.sort(), ['o1', 'o2']);
  assert.deepStrictEqual(byKey.e_prev_old.members.sort(), ['p1', 'p2']);
  assert.deepStrictEqual(byKey.e_prev_new.members, ['p3']);
  assert.ok(units.every(u => u.match_status === 'matched'));
});

test('Dòng không ghép chắc về đúng 1 lượt (2 lượt chồng ngày, hoặc khác Mã nội trú) thì đứng riêng', () => {
  const rows = [
    src('k1', '', 'BN_Y', { 'Mã nội trú': '', 'T/G vào': '05/03/2026 09:00' }),
    src('k2', '', 'BN_Y', { 'Mã nội trú': 'NT_KHAC', 'T/G vào': '15/04/2026 09:00' }),
  ];
  const encounterRows = [
    { encounter_id: 'e1', patient_code: 'BN_Y', admission_date: '2026-03-01', discharge_date: '2026-03-10' },
    { encounter_id: 'e2', patient_code: 'BN_Y', admission_date: '2026-03-04', discharge_date: '2026-03-06' },
    { encounter_id: 'e3', patient_code: 'BN_Y', admission_date: '2026-04-10', discharge_date: '2026-04-20', emr_noitru_id: 'nt_goc' },
  ];
  const units = c.buildCollectionUnits({ sourceRows: rows, encounterRows });
  assert.deepStrictEqual(units.map(u => u.key).sort(), ['k1', 'k2']);
  assert.deepStrictEqual(units.map(u => u.unmatched_reason).sort(), ['ambiguous_date_range', 'identity_conflict']);
});

test('Hai lượt chồng ngày: ghép bằng thời điểm vào chính xác, lượt chưa chắc không bao giờ được tự thu thập', () => {
  const rows = [
    src('k_dung', '', 'BN_TIME', { 'Mã nội trú': '', 'T/G vào': '05/03/2026 09:15', 'Ngày vào viện': '' }),
    src('k_mo', '', 'BN_AMBIG', { 'Mã nội trú': '', 'T/G vào': '05/03/2026 10:00', 'Ngày vào viện': '' }),
  ];
  const encounterRows = [
    { encounter_id: 'e_time_1', patient_code: 'BN_TIME', admission_date: '2026-03-01 07:00', discharge_date: '2026-03-10' },
    { encounter_id: 'e_time_2', patient_code: 'BN_TIME', admission_date: '2026-03-05 09:15', discharge_date: '2026-03-06' },
    { encounter_id: 'e_ambig_1', patient_code: 'BN_AMBIG', admission_date: '2026-03-01 07:00', discharge_date: '2026-03-10' },
    { encounter_id: 'e_ambig_2', patient_code: 'BN_AMBIG', admission_date: '2026-03-04 08:00', discharge_date: '2026-03-06' },
  ];
  const units = c.buildCollectionUnits({ sourceRows: rows, encounterRows });
  const exact = units.find(u => u.key === 'e_time_2');
  const unresolved = units.find(u => u.key === 'k_mo');
  assert.strictEqual(exact.match_method, 'admission_time');
  assert.strictEqual(unresolved.unmatched_reason, 'ambiguous_date_range');

  const ledger = c.buildLedger({ units });
  for (const options of [{}, { force: true }, { retryBlocked: true }, { force: true, retryBlocked: true }]) {
    const plan = c.planCollection(ledger, options);
    assert.deepStrictEqual(plan.tasks.map(t => t.key), ['e_time_2']);
    assert.strictEqual(plan.summary.unmatched_encounters, 1);
  }
});

test('Lựa chọn thủ công chỉ ghép được lượt cùng người bệnh; lựa chọn hỏng vẫn bị chặn', () => {
  const rows = [src('k_manual', '', 'BN_MANUAL', { 'Mã nội trú': 'NT_SAI', 'T/G vào': '05/03/2026 10:00', 'Ngày vào viện': '' })];
  const encounterRows = [
    { encounter_id: 'e_manual', patient_code: 'BN_MANUAL', admission_date: '2026-03-01 08:00', discharge_date: '2026-03-10', emr_noitru_id: 'NT_DUNG' },
    { encounter_id: 'e_other', patient_code: 'BN_KHAC', admission_date: '2026-03-01 08:00', discharge_date: '2026-03-10' },
  ];
  const linked = c.buildCollectionUnits({ sourceRows: rows, encounterRows, encounterOverrides: { k_manual: { encounter_id: 'e_manual' } } });
  assert.deepStrictEqual([linked[0].key, linked[0].match_method, linked[0].match_status], ['e_manual', 'manual', 'matched']);

  for (const encounter_id of ['e_other', 'e_missing']) {
    const invalid = c.buildCollectionUnits({ sourceRows: rows, encounterRows, encounterOverrides: { k_manual: { encounter_id } } });
    assert.strictEqual(invalid[0].match_status, 'unmatched');
    assert.strictEqual(invalid[0].unmatched_reason, 'invalid_manual_override');
    assert.strictEqual(c.planCollection(c.buildLedger({ units: invalid }), { force: true }).tasks.length, 0);
  }
});

test('Mã NC không được dùng để phân biệt hai lượt cùng Mã BN; thiếu bằng chứng thì để unmatched', () => {
  const rows = [
    src('k1', 'NC_A', 'BN_R', { 'Mã nội trú': '', 'T/G vào': '05/03/2026 09:00' }),
    src('k2', 'NC_B', 'BN_R', { 'Mã nội trú': '', 'T/G vào': '05/03/2026 10:00' }),
  ];
  const encounterRows = [
    { encounter_id: 'e1', research_code: 'NC_A', patient_code: 'BN_R', admission_date: '2026-03-05', discharge_date: '2026-03-10' },
    { encounter_id: 'e2', research_code: 'NC_B', patient_code: 'BN_R', admission_date: '2026-03-05', discharge_date: '2026-03-12' },
  ];
  const units = c.buildCollectionUnits({ sourceRows: rows, encounterRows });
  assert.ok(units.every(u => !u.encounter_id));
  assert.ok(units.every(u => u.unmatched_reason === 'ambiguous_date_range'));
  assert.deepStrictEqual(c.collectionUnitMatchSummary(units), {
    total: 2, matched: 0, unmatched: 2, source_only: 0, by_method: {}, by_reason: { ambiguous_date_range: 2 },
  });

  const sameResearchCode = c.buildCollectionUnits({
    sourceRows: [src('k3', 'NC_DUP', 'BN_D', { 'Mã nội trú': '', 'T/G vào': '05/03/2026 09:00' })],
    encounterRows: [
      { encounter_id: 'd1', research_code: 'NC_DUP', patient_code: 'BN_D', admission_date: '2026-03-05', discharge_date: '2026-03-10' },
      { encounter_id: 'd2', research_code: 'NC_DUP', patient_code: 'BN_D', admission_date: '2026-03-05', discharge_date: '2026-03-12' },
    ],
  });
  assert.strictEqual(sameResearchCode[0].encounter_id, '');
  assert.strictEqual(sameResearchCode[0].unmatched_reason, 'ambiguous_date_range');
});

test('Progress hành chánh theo khóa dòng cũ (không còn trong nguồn) vẫn ghép được vào lượt theo Mã BN + ngày vào', () => {
  const rows = [src('k_moi', '', 'BN_Z', { 'Mã nội trú': '', 'T/G vào': '02/03/2026 08:00' })];
  const encounterRows = [{ encounter_id: 'e_z', patient_code: 'BN_Z', admission_date: '2026-03-02', discharge_date: '2026-03-09' }];
  const units = c.buildCollectionUnits({ sourceRows: rows, encounterRows });
  const hc = { k_cu: { ...hcEntry(OK_HC), ma_bn: 'BN_Z', admission_date: '04/03/2026' } };
  const hcKhac = { k_khac: { ...hcEntry(OK_HC), ma_bn: 'BN_Z', admission_date: '20/05/2026' } };
  const ok = c.buildLedger({ units, hchanhProgress: hc });
  assert.strictEqual(ok.encounters.e_z.parts.discharge.status, 'ok');
  const none = c.buildLedger({ units, hchanhProgress: hcKhac });
  assert.strictEqual(none.encounters.e_z.parts.discharge.status, 'pending', 'ngày ngoài lượt → không ghép');
});

test('Kế hoạch thu thập cộng lại đúng tổng: lấy + đủ + chờ người xem + chưa ghép chắc = số lượt', () => {
  // Màn hình người dùng: "lấy 2.965, bỏ qua 32, 44 chưa ghép chắc" không khớp tổng nào vì lượt chỉ
  // còn phần hết lượt thử / cần người xem không được đếm vào đâu.
  const sources = [src('enc_a', 'NC0001', 'BN_A'), src('enc_b', 'NC0002', 'BN_B'), src('enc_c', 'NC0003', 'BN_C'), src('enc_d', 'NC0004', 'BN_D')];
  const { xn, hc, oh } = fullyCollected(sources.slice(0, 3));
  const ledger = c.buildLedger({ sourceRows: sources, xnProgress: xn, hchanhProgress: hc, orderProgress: oh });
  ledger.encounters.enc_b.parts.xn = { ...ledger.encounters.enc_b.parts.xn, status: 'failed', attempts: 3, reason: 'tab_load' };
  ledger.encounters.enc_c.match_status = 'unmatched';
  const s = c.planCollection(ledger, { maxAttempts: 3 }).summary;
  assert.deepStrictEqual(
    { to_fetch: s.to_fetch, unchanged: s.unchanged, waiting: s.waiting_encounters, unmatched: s.unmatched_encounters },
    { to_fetch: 1, unchanged: 1, waiting: 1, unmatched: 1 },
  );
  assert.strictEqual(s.to_fetch + s.unchanged + s.waiting_encounters + s.unmatched_encounters, s.encounters);
});

console.log(`\n${passed} kịch bản pass.`);
