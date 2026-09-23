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
  assert.deepStrictEqual(c.classifyFetchStatus('no_table', 0), { status: 'blocked', reason: 'emr_ui_changed' });
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
  const entry = { 'Mã BN': 'BN_A', 'Ngày vào viện': '05/01/2026', xn: 'done', cdha: 'done', committed: true, counts: { xn: 3, cdha: 1 } };
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

console.log(`\n${passed} kịch bản pass.`);
