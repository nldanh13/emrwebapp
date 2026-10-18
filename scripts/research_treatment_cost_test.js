#!/usr/bin/env node
'use strict';

// Chi phí điều trị trong Kho nghiên cứu (dữ liệu giả lập, không có BN thật):
//  1. Tổng từ bảng kê: 16 ô Tổng hợp chi phí của EMR + tổng tự cộng dòng bảng kê; "chưa có" ≠ 0.
//  2. Bước ghi dòng thô và bước chuẩn hóa dùng chung một hàm: đọc lại dòng thô ra đúng số.
//  3. Chi phí là phần tùy chọn: không vào phần mặc định, chỉ lấy khi đề cương cần.
//  4. Chuẩn hóa: cột cost_* của analysis_ready gắn đúng đợt; 2 đợt của cùng BN không lẫn số;
//     dòng chuyển khoa dùng lại cùng bảng kê không bị cộng đôi; bảng kê khác nhau → để trống.
// Chạy: node scripts/research_treatment_cost_test.js

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const RUNTIME_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'research_treatment_cost_test_'));
process.env.EMR_RUNTIME_ROOT = RUNTIME_ROOT;

const research = require('../server/routes/research');
const R = research._test;
const billing = require('../server/research/billing_summary');
const { hchanhFetchOutputToRows } = require('../server/research/research_source');
const collection = require('../server/research/collection');
const { readCsvTable } = require('../server/research/table_io');
const { NORMALIZED_COLUMNS } = require('../server/research/normalized_schema');

let passed = 0;
function test(name, fn) {
  try {
    fn();
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

let runSeq = 0;
function newRunDir() {
  runSeq += 1;
  const dir = path.join(RUNTIME_ROOT, 'fixture', `r${runSeq}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

const SUMMARY = {
  tong_chi_phi: 26117752, chi_phi_bhyt: 18269470, bh_tra: 18269470, cung_chi_tra: 0,
  tu_tra: 2384349, nguon_khac: 0, chenh_lech: 4577600, thuc_thu: 6961949,
  tien_tam_ung: 27000000, mien_giam: 0, tien_quy_tra: 0, that_thu: 0,
  tien_hoan_tra: 27000000, bien_lai_thu: 6961949, ghi_no: 0, nb_nhan_lai: 0,
};
const ROWS = [
  { name: 'Ngày giường', sl: 3, don_gia: 300000, thanh_tien: 900000, payment_group: 'bhyt' },
  { name: 'Thuốc A', sl: 10, don_gia: 5000, thanh_tien: 50000, payment_group: 'self_pay' },
  { name: 'Vật tư trong gói', sl: 1, don_gia: 0, thanh_tien: 0, payment_group: 'zero' },
  { name: 'Khoản lạ', sl: 1, don_gia: 1234, thanh_tien: 1234, payment_group: 'unknown' },
];
const payload = (extra = {}) => ({ _fetch_status: 'ok', rows: ROWS, tong_hop: SUMMARY, ...extra });

test('Tổng hợp chi phí: đủ 16 ô EMR + tổng cộng dòng bảng kê theo đối tượng', () => {
  const t = billing.billingTotalsFromPayload(payload());
  for (const f of billing.BILLING_SUMMARY_FIELDS) assert.strictEqual(t[f.key], SUMMARY[f.key], f.key);
  assert.strictEqual(billing.BILLING_SUMMARY_FIELDS.length, 16);
  assert.strictEqual(t.itemized_total, 951234);
  assert.strictEqual(t.itemized_bhyt, 900000);
  assert.strictEqual(t.itemized_self_pay, 50000);
  assert.strictEqual(t.itemized_exempt, 0);
  assert.strictEqual(t.itemized_other, 1234);
  assert.strictEqual(t.item_lines, 4);
});

test('Chưa lấy / lỗi / trống không thành 0 đồng', () => {
  assert.strictEqual(billing.billingTotalsFromPayload(null), null);
  assert.strictEqual(billing.billingTotalsFromPayload({ _fetch_status: 'error', rows: ROWS, tong_hop: SUMMARY }), null);
  assert.strictEqual(billing.billingTotalsFromPayload({ _fetch_status: 'no_table', rows: [], tong_hop: {} }), null);
  assert.strictEqual(billing.billingTotalsFromPayload({ _fetch_status: 'ok', rows: [], tong_hop: {} }), null);
  // Bảng kê cũ (trước khi đọc khối Tổng hợp): ô EMR để trống, vẫn có tổng tự cộng.
  const old = billing.billingTotalsFromPayload({ _fetch_status: 'ok', rows: ROWS });
  assert.strictEqual(old.tong_chi_phi, null);
  assert.strictEqual(old.itemized_total, 951234);
  const fields = billing.treatmentCostFields(old);
  assert.strictEqual(fields.cost_total, '');
  assert.strictEqual(fields.cost_itemized_total, '951234');
  assert.ok(Object.values(billing.treatmentCostFields(null)).every(v => v === ''));
});

test('Dòng thô hchanh_billing.csv đọc lại ra đúng số đã tính (cùng một hàm)', () => {
  const src = { 'Mã BN': '501', 'Họ tên': 'BN GIA LAP C', 'T/G vào': '08:00 01/03/2026', 'Ngày ra viện': '05/03/2026' };
  const flat = hchanhFetchOutputToRows({ billing: payload() }, src, 'r');
  assert.strictEqual(flat.billingRows.length, 1);
  const raw = flat.billingRows[0];
  assert.strictEqual(raw['Tổng chi phí'], '26117752');
  assert.strictEqual(raw['NB nhận lại'], '0');
  assert.ok(raw['Research key']);
  assert.deepStrictEqual(billing.billingTotalsFromRawRow(raw), billing.billingTotalsFromPayload(payload()));
  assert.strictEqual(hchanhFetchOutputToRows({ billing: { _fetch_status: 'error' } }, src, 'r').billingRows.length, 0);
});

test('Chi phí là phần tùy chọn: mặc định không lấy, đề cương cần thì lấy', () => {
  assert.deepStrictEqual(collection.PART_KEYS, ['xn', 'cdha', 'profile', 'discharge', 'surgery', 'order_history']);
  assert.ok(collection.ALL_PART_KEYS.includes('billing'));
  assert.ok(!collection.collectionPartsForStudy(null).includes('billing'));
  assert.ok(!collection.collectionPartsForStudy({}).includes('billing'));
  assert.ok(collection.collectionPartsForStudy({ data_requirements: { parts: ['billing'] } }).includes('billing'));
  const withCostVar = { variable_selection: { selected_variables: [{ id: 'analysis_ready.cost_total', table: 'analysis_ready', name: 'cost_total' }] } };
  assert.ok(collection.requirementsFromStudy(withCostVar).parts.includes('billing'));
  assert.ok(collection.collectionPartsForStudy(withCostVar).includes('billing'));
  assert.deepStrictEqual(collection.resolveCollectionParts({ requested: ['billing', 'bogus'] }), ['billing']);
  assert.ok(collection.resolveCollectionParts({ refreshParts: ['billing'] }).includes('billing'));
  assert.ok(!collection.resolveCollectionParts({}).includes('billing'));
  const groups = collection.groupTasksByFetcher([{ key: 'k', parts: ['profile', 'billing'] }]);
  assert.deepStrictEqual([...groups.hchanh.keys()], ['billing,profile']);
});

test('Sổ thu thập ghi trạng thái Chi phí nhưng lượt đủ 6 phần vẫn là đủ', () => {
  const src = { 'Research key': 'k1', 'Mã BN': '601', 'Mã NC': 'NC1', 'T/G vào': '08:00 01/03/2026' };
  const at = '2026-03-06T00:00:00Z';
  const okFile = rows => ({ fetch_status: 'ok', rows, at });
  const ledger = collection.buildLedger({
    sourceRows: [src],
    xnProgress: {},
    hchanhProgress: { k1: { ma_bn: '601', file_status: { profile: okFile(1), discharge: okFile(1), surgery: okFile(0), billing: okFile(1) } } },
  });
  const enc = ledger.encounters.k1;
  assert.strictEqual(enc.parts.billing.status, 'ok');
  const plan = collection.planCollection(ledger, { parts: collection.PART_KEYS });
  assert.ok(plan.tasks.every(t => !t.parts.includes('billing')), 'mặc định không giao phần Chi phí');
  const planCost = collection.planCollection(ledger, { parts: ['billing'] });
  assert.strictEqual(planCost.tasks.length, 0, 'đã có Chi phí thì không lấy lại');
});

test('Chuẩn hóa: cost_* gắn đúng đợt, không cộng đôi dòng chuyển khoa, bảng kê lệch → để trống', () => {
  const runDir = newRunDir();
  writeCsv(path.join(runDir, 'du_lieu_ban_dau.csv'), ['T/G vào', 'Mã BN', 'Họ tên', 'Ngày ra viện'], [
    { 'T/G vào': '08:00 01/03/2026', 'Mã BN': '701', 'Họ tên': 'BN GIA LAP D', 'Ngày ra viện': '05/03/2026' },
    { 'T/G vào': '08:00 01/05/2026', 'Mã BN': '701', 'Họ tên': 'BN GIA LAP D', 'Ngày ra viện': '04/05/2026' },
    { 'T/G vào': '08:00 01/06/2026', 'Mã BN': '702', 'Họ tên': 'BN GIA LAP E', 'Ngày ra viện': '03/06/2026' },
  ]);
  const raw = (code, from, to, totals, key) => ({
    'Mã BN': code, 'Ngày vào viện': from, 'Ngày ra viện': to, 'Research key': key, 'Nguồn': 'hchanh_auto_billing',
    ...billing.billingRawFields(totals),
  });
  const a = billing.billingTotalsFromPayload(payload());
  const b = billing.billingTotalsFromPayload({ _fetch_status: 'ok', rows: ROWS.slice(0, 1), tong_hop: { ...SUMMARY, tong_chi_phi: 900000 } });
  const c1 = billing.billingTotalsFromPayload({ _fetch_status: 'ok', rows: ROWS.slice(0, 2) });
  const c2 = billing.billingTotalsFromPayload({ _fetch_status: 'ok', rows: ROWS.slice(0, 3), tong_hop: { tong_chi_phi: 1 } });
  const rows = [
    raw('701', '08:00 01/03/2026', '05/03/2026', a, 'kA1'),
    raw('701', '08:00 01/03/2026', '05/03/2026', a, 'kA2'), // dòng chuyển khoa: cùng bảng kê
    raw('701', '08:00 01/05/2026', '04/05/2026', b, 'kB'),
    raw('702', '08:00 01/06/2026', '03/06/2026', c1, 'kC1'),
    raw('702', '08:00 01/06/2026', '03/06/2026', c2, 'kC2'),
  ];
  writeCsv(path.join(runDir, 'hchanh_billing.csv'), Object.keys(rows[0]), rows);
  const out = R.normalizeRunOutputs(runDir, { sourceRunId: 'r', force: true });
  const table = readCsvTable(path.join(runDir, 'analysis_ready.csv'), 100);
  for (const col of billing.TREATMENT_COST_COLUMNS) assert.ok(table.columns.includes(col), col);
  assert.ok(NORMALIZED_COLUMNS.analysis_ready.includes('cost_total'));
  const ready = table.rows;
  const byAdm = Object.fromEntries(ready.map(r => [`${r.patient_code}|${String(r.admission_date).slice(0, 10)}`, r]));
  const first = byAdm['701|2026-03-01'];
  const second = byAdm['701|2026-05-01'];
  const conflict = byAdm['702|2026-06-01'];
  assert.ok(first && second && conflict, JSON.stringify(Object.keys(byAdm)));
  assert.strictEqual(first.cost_total, '26117752', 'không cộng đôi 2 dòng chuyển khoa');
  assert.strictEqual(first.cost_itemized_total, '951234');
  assert.strictEqual(first.cost_advance, '27000000');
  assert.strictEqual(first.cost_patient_refund_due, '0');
  assert.strictEqual(second.cost_total, '900000', 'đợt 2 không lấy số của đợt 1');
  assert.strictEqual(second.cost_item_lines, '1');
  assert.strictEqual(conflict.cost_total, '', 'bảng kê khác nhau → không tự chọn');
  assert.strictEqual(conflict.cost_itemized_total, '');
  assert.strictEqual(out.treatment_cost_conflicts, 1);
  assert.strictEqual(out.treatment_cost_encounters, 2);
});

console.log(`\n${passed} kịch bản pass.`);
