#!/usr/bin/env node
'use strict';

// Thuốc của đợt lấy từ bảng kê chi phí (dữ liệu giả lập, không có BN thật).
// Lịch sử y lệnh EMR thường chỉ ghi "Dự trù thuốc" / "Thực hiện y lệnh thuốc đã có"; tên thuốc nằm
// trong bảng kê. Kiểm:
//  1. Dòng thô hchanh_billing.csv mang danh sách thuốc (chỉ các dòng loại "Thuốc..."), bước ghi và
//     bước chuẩn hóa dùng chung một hàm.
//  2. Chuẩn hóa: medication_orders có dòng thuốc của đúng đợt, order_action=billed, không có ngày giờ;
//     dòng chuyển khoa dùng lại cùng bảng kê không nhân đôi; cùng thuốc ở 2 khoa được cộng số lượng.
//  3. Đối chiếu lấy lại (không mở bảng kê) không báo các dòng này là "kho thừa".
// Chạy: node scripts/research_billing_drugs_test.js

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const RUNTIME_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'research_billing_drugs_test_'));
process.env.EMR_RUNTIME_ROOT = RUNTIME_ROOT;

const research = require('../server/routes/research');
const R = research._test;
const billing = require('../server/research/billing_summary');
const { hchanhFetchOutputToRows } = require('../server/research/research_source');
const { readCsvTable } = require('../server/research/table_io');
const { compareCase } = require('../server/research/live_audit_compare');

let passed = 0;
function test(name, fn) {
  try { fn(); passed += 1; console.log(`  ok - ${name}`); } catch (err) { console.error(`  FAIL - ${name}`); console.error(err); process.exitCode = 1; }
}
function writeCsv(file, cols, rows) {
  const esc = v => (/[",\n]/.test(String(v ?? '')) ? `"${String(v).replace(/"/g, '""')}"` : String(v ?? ''));
  fs.writeFileSync(file, `﻿${[cols.join(','), ...rows.map(r => cols.map(c => esc(r[c])).join(','))].join('\n')}\n`, 'utf-8');
}

const BILL = {
  _fetch_status: 'ok',
  tong_hop: { tong_chi_phi: 1000 },
  rows: [
    { loai_yc: 'Thuốc, hóa chất', khoa: 'Khoa Giả A', name: 'Thuốc giả X 500mg', dvt: 'Viên', sl: 6, doi_tuong: 'Bảo hiểm', thanh_tien: 600, payment_group: 'bhyt' },
    { loai_yc: 'Thuốc, hóa chất', khoa: 'Khoa Giả B', name: 'Thuốc giả X 500mg', dvt: 'Viên', sl: 4, doi_tuong: 'Bảo hiểm', thanh_tien: 400, payment_group: 'bhyt' },
    { loai_yc: 'Thuốc, hóa chất', khoa: 'Khoa Giả A', name: 'Dịch truyền giả Y', dvt: 'Chai', sl: 2, doi_tuong: 'Viện phí', thanh_tien: 0, payment_group: 'self_pay' },
    { loai_yc: 'Vật tư y tế tiêu hao', khoa: 'Khoa Giả A', name: 'Bông giả', dvt: 'Gói', sl: 3, doi_tuong: 'Bảo hiểm', thanh_tien: 0, payment_group: 'bhyt' },
    { loai_yc: 'Xét nghiệm', khoa: 'Khoa Giả A', name: 'Xét nghiệm giả', dvt: 'Lần', sl: 1, doi_tuong: 'Bảo hiểm', thanh_tien: 0, payment_group: 'bhyt' },
  ],
};

test('Dòng thô bảng kê mang danh sách thuốc, chỉ dòng loại Thuốc', () => {
  const lines = billing.billingDrugLines(BILL);
  assert.deepStrictEqual(lines.map(l => l.name), ['Thuốc giả X 500mg', 'Thuốc giả X 500mg', 'Dịch truyền giả Y']);
  const flat = hchanhFetchOutputToRows({ billing: BILL }, { 'Mã BN': '990001', 'Research key': 'k1' }, 'r');
  assert.strictEqual(flat.billingRows.length, 1);
  assert.deepStrictEqual(billing.billingDrugLinesFromRawRow(flat.billingRows[0]), lines);
  assert.strictEqual(billing.billingDrugLinesFromRawRow({}).length, 0);
  assert.strictEqual(billing.billingDrugLinesFromRawRow({ [billing.BILLING_DRUGS_COLUMN]: 'không phải JSON' }).length, 0);
});

test('Chuẩn hóa: thuốc bảng kê vào đúng đợt, không nhân đôi, cộng số lượng cùng thuốc', () => {
  const runDir = path.join(RUNTIME_ROOT, 'fixture', 'r1');
  fs.mkdirSync(runDir, { recursive: true });
  writeCsv(path.join(runDir, 'du_lieu_ban_dau.csv'), ['T/G vào', 'Mã BN', 'Họ tên', 'Ngày ra viện'], [
    { 'T/G vào': '08:00 01/03/2026', 'Mã BN': '990001', 'Họ tên': 'BN GIA LAP F', 'Ngày ra viện': '05/03/2026' },
    { 'T/G vào': '08:00 01/05/2026', 'Mã BN': '990001', 'Họ tên': 'BN GIA LAP F', 'Ngày ra viện': '04/05/2026' },
  ]);
  const raw = (from, to, key) => ({
    ...hchanhFetchOutputToRows({ billing: BILL }, { 'Mã BN': '990001', 'Research key': key }, 'r').billingRows[0],
    'Mã BN': '990001', 'Ngày vào viện': from, 'Ngày ra viện': to, 'Research key': key,
  });
  const rows = [raw('08:00 01/03/2026', '05/03/2026', 'kA1'), raw('08:00 01/03/2026', '05/03/2026', 'kA2')];
  writeCsv(path.join(runDir, 'hchanh_billing.csv'), Object.keys(rows[0]), rows);
  R.normalizeRunOutputs(runDir, { sourceRunId: 'r', force: true });
  const meds = readCsvTable(path.join(runDir, 'medication_orders.csv'), 1000).rows.filter(r => r.order_action === 'billed');
  const enc = readCsvTable(path.join(runDir, 'encounters.csv'), 100).rows;
  const march = enc.find(e => String(e.admission_date).startsWith('2026-03-01'));
  assert.ok(march, 'có đợt tháng 3');
  assert.strictEqual(meds.length, 2, JSON.stringify(meds.map(m => m.raw_line)));
  for (const m of meds) {
    assert.strictEqual(m.encounter_id, march.encounter_id, 'gắn đúng đợt tháng 3, không sang đợt tháng 5');
    assert.strictEqual(m.order_datetime, '', 'bảng kê không có giờ dùng: để trống');
    assert.strictEqual(m.source, 'hchanh_billing');
  }
  const x = meds.find(m => m.drug_name_raw === 'Thuốc giả X 500mg');
  assert.ok(x.raw_line.includes('tổng 10 Viên cả đợt (Bảo hiểm)'), x.raw_line);
  assert.ok(!meds.some(m => /Bông giả|Xét nghiệm giả/.test(m.drug_name_raw)), 'vật tư/xét nghiệm không phải thuốc');
});

test('Đối chiếu lấy lại không tính thuốc bảng kê là kho thừa', () => {
  const billed = { order_action: 'billed', source: 'hchanh_billing', drug_name_raw: 'Thuốc giả X', order_datetime: '' };
  const res = compareCase({ medications: [billed] }, { medications: [] });
  const med = res.kinds.find(k => k.archive_only !== undefined && k.kind === 'medications') || res.kinds[3];
  assert.strictEqual(med.archive_only, 0);
});

console.log(`\n${passed} kịch bản pass.`);
