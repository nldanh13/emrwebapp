#!/usr/bin/env node
'use strict';

// Mô hình màn hình Thu thập dữ liệu (server/research/screen_model.js): mọi con số tính từ MỘT
// nguồn (sổ thu thập), các nhóm chia rời nhau và cộng lại đúng bằng tổng; kế hoạch cùng tổng.
// Tái hiện màn người dùng: 3.016 / 3.015 / 3.041 / 3.127 lượt trên cùng một màn hình.
// Chạy: node scripts/research_screen_model_test.js

const assert = require('assert');
const c = require('../server/research/collection');
const { buildCollectionScreen, encounterState } = require('../server/research/screen_model');

let passed = 0;
function test(name, fn) {
  try { fn(); passed += 1; console.log(`  ok - ${name}`); } catch (err) { console.error(`  FAIL - ${name}`); console.error(err); process.exitCode = 1; }
}

const ok = () => ({ status: 'ok', seen_seq: 0, seen_demo_seq: 0 });
function enc(key, overrides = {}, extra = {}) {
  const parts = Object.fromEntries(c.PART_KEYS.map(k => [k, ok()]));
  Object.assign(parts, overrides);
  return { key, research_code: `NC_${key}`, patient_code: `BN_${key}`, match_status: 'matched', change_seq: 0, demo_seq: 0, parts, ...extra };
}

const ledger = {
  encounters: {
    a: enc('a'),
    b: enc('b', { xn: { status: 'pending' } }),
    c: enc('c', { order_history: { status: 'failed', attempts: 1, reason: 'timeout' } }),
    d: enc('d', { surgery: { status: 'failed', attempts: 3, reason: 'tab_load' } }),
    e: enc('e', { profile: { status: 'blocked', reason: 'emr_ui_changed' } }),
    f: enc('f', {}, { match_status: 'unmatched', unmatched_reason: 'ambiguous_admission_time' }),
    g: enc('g', { xn: { status: 'failed', attempts: 1, reason: 'timeout' }, cdha: { status: 'pending' } }),
    // Đã thử hết lượt một phần, phần khác còn chưa lấy: máy không bao giờ tự lấy phần hết lượt →
    // phải là "Chờ người xem" (lỗi cũ: xếp vào "Còn thiếu", người dùng tưởng chạy thêm là đủ).
    h: enc('h', { surgery: { status: 'failed', attempts: 3, reason: 'tab_load' }, xn: { status: 'pending' } }),
  },
};
const sourceRows = [{ 'Mã BN': 'BN_c', 'Họ tên': 'NGUYỄN VĂN C' }];

test('mỗi lượt đúng một nhóm; các nhóm cộng lại đúng bằng tổng', () => {
  const s = buildCollectionScreen({ ledger, sourceRows, maxAttempts: 3 });
  assert.strictEqual(s.total, 8);
  assert.deepStrictEqual(s.counts, { done: 1, missing: 1, error: 2, waiting: 3, unmatched: 1 });
  const sum = Object.values(s.counts).reduce((a, b) => a + b, 0);
  assert.strictEqual(sum, s.total);
});

test('kế hoạch thu thập tính từ cùng sổ, cùng tổng', () => {
  const p = buildCollectionScreen({ ledger, maxAttempts: 3 }).plan;
  assert.strictEqual(p.encounters, 8);
  assert.strictEqual(p.to_fetch + p.unchanged + p.waiting_encounters + p.unmatched_encounters, 8);
});

test('tiến độ từng phần: mẫu số = số lượt đã ghép chắc', () => {
  const s = buildCollectionScreen({ ledger, maxAttempts: 3 });
  const xn = s.parts.find(p => p.key === 'xn');
  assert.strictEqual(xn.total, 7);
  assert.strictEqual(xn.done, 4);
});

test('danh sách: lỗi lên đầu, kèm phần thiếu và lý do bằng lời, có tên người bệnh', () => {
  const s = buildCollectionScreen({ ledger, sourceRows, maxAttempts: 3 });
  assert.deepStrictEqual(s.rows.map(r => r.state), ['error', 'error', 'waiting', 'waiting', 'waiting', 'unmatched', 'missing']);
  const rc = s.rows.find(r => r.key === 'c');
  assert.strictEqual(rc.patient_name, 'NGUYỄN VĂN C');
  assert.strictEqual(rc.missing, 'Y lệnh');
  assert.match(rc.reason, /^Y lệnh: Hết thời gian chờ EMR/);
  assert.match(s.rows.find(r => r.key === 'f').reason, /Thời điểm vào viện khớp nhiều lượt/);
});

test('lượt có phần đã thử hết lượt là "Chờ người xem" dù còn phần chưa lấy', () => {
  assert.strictEqual(encounterState(ledger.encounters.h, 3), 'waiting');
});

test('danh sách cần xử lý đếm cả theo lượt (khớp số trên màn hình), không chỉ theo dòng phần', () => {
  const s = buildCollectionScreen({ ledger, maxAttempts: 3, exceptions: c.exceptionRows(ledger, { maxAttempts: 3 }) });
  // c, d, e, g, h có phần lỗi/chặn; f chưa ghép → 6 lượt.
  assert.strictEqual(s.exceptions_encounters, 6);
  assert.strictEqual(s.exceptions_encounters, s.counts.error + s.counts.waiting + s.counts.unmatched);
});

test('"Cần người kiểm tra" đếm theo lượt, không theo dòng (cặp đợt ghi hai dòng)', () => {
  const { summarizeReviewRows } = require('../server/research/progress_snapshot');
  const review = [
    { encounter_id: 'E1', issue: 'possible_same_stay' }, { encounter_id: 'E2', issue: 'possible_same_stay' },
    { encounter_id: 'E1', issue: 'possible_same_stay' }, { encounter_id: 'E3', issue: 'possible_same_stay' },
    { encounter_id: 'E2', issue: 'future_date' },
  ];
  const r = summarizeReviewRows(review);
  assert.strictEqual(r.encounters, 3);
  assert.deepStrictEqual(r.byIssue, { possible_same_stay: 3, future_date: 1 });
});

test('phần đã lấy nhưng EMR đổi (stale) tính là còn thiếu, không phải đủ', () => {
  const e = enc('s', {}, { change_seq: 2 });
  assert.strictEqual(encounterState(e, 3), 'missing');
});

console.log(`\n${passed} test(s) passed.`);
