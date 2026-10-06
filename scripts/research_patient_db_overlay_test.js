#!/usr/bin/env node
'use strict';

// Kiểm thử đợt 5 Kho người bệnh: khi chuẩn hoá, phần hành chánh của nghiên cứu lấy từ kho chung —
// ca chưa có thì lấy từ kho, ca đang dùng dữ liệu tạm thời thì thay bằng dữ liệu gốc, còn lại giữ nguyên;
// CSV thô của lần quét không bị sửa; kho có bản quét mới thì chữ ký đầu vào đổi (phải chuẩn hoá lại).
// Chạy: node scripts/research_patient_db_overlay_test.js  (cần Node.js >= 22.13)

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const RUNTIME_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'research_kho_overlay_test_'));
process.env.EMR_RUNTIME_ROOT = RUNTIME_ROOT;

const patientDb = require('../server/services/patient_db');
if (!patientDb.available()) {
  console.log(`research_patient_db_overlay_test: bỏ qua — ${patientDb.unavailableReason()}`);
  process.exit(process.env.REQUIRE_PATIENT_DB === '1' ? 1 : 0);
}
const R = require('../server/routes/research')._test;

let passed = 0;
function test(name, fn) {
  try { fn(); passed += 1; console.log(`  ok - ${name}`); } catch (err) { console.error(`  FAIL - ${name}`); console.error(err); process.exitCode = 1; }
}

const dis = (dx, src, now) => patientDb.recordInpatient(src.bn, {
  discharge: { _fetch_status: 'ok', ngay_ra: '28/09/2026', raw_time: '09:00 28/09/2026', tong_so_ngay_dt: '9', chan_doan_chinh: dx, xu_tri: 'Ra viện' },
}, { from: '2026-09-20', to: '2026-09-28', source: src.source, now });

console.log('research_patient_db_overlay_test');
dis('Gốc A1', { bn: 'A1', source: 'kho_nghien_cuu' }, '2026-09-29T00:00:00Z');
dis('Tạm thời A2', { bn: 'A2', source: 'hanh_chanh' }, '2026-09-29T00:00:00Z');
dis('Gốc A3', { bn: 'A3', source: 'kho_nghien_cuu' }, '2026-09-30T00:00:00Z');
dis('Gốc A4', { bn: 'A4', source: 'kho_nghien_cuu' }, '2026-09-30T00:00:00Z');

const row = (bn, nc) => ({ 'Mã BN': bn, 'Họ tên': `BN ${bn}`, 'Mã NC': nc, 'Ngày vào viện': '21/09/2026', 'Ngày ra viện': '28/09/2026' });
const sourceRows = [row('A1', 'NC1'), row('A2', 'NC2'), row('A3', 'NC3'), row('A4', 'NC4'), row('A5', 'NC5')];
const key = r => R.researchHchanhMeta(r, 'r1').source_key;
const runDischarge = (r, dx) => ({ 'Mã BN': r['Mã BN'], 'Research key': key(r), 'Chẩn đoán': dx, 'Nguồn input': 'hchanh_discharge' });

test('Thiếu thì lấy từ kho (ghi rõ gốc / tạm thời); tạm thời trong lần quét được thay bằng gốc; còn lại giữ nguyên', () => {
  const runDir = fs.mkdtempSync(path.join(RUNTIME_ROOT, 'run_'));
  // A3: lần quét dùng dữ liệu tạm thời (progress ghi provisional_files) → kho đã có gốc → thay.
  // A4: lần quét tự lấy từ EMR (gốc) → giữ nguyên dù kho khác chữ.
  fs.writeFileSync(path.join(runDir, 'hchanh_auto_progress.json'), JSON.stringify({ [key(sourceRows[2])]: { status: 'done', provisional_files: ['discharge'] } }));
  const tables = {
    profile: [], surgery: [], order_history: [],
    discharge: [runDischarge(sourceRows[2], 'Tạm thời cũ A3'), runDischarge(sourceRows[3], 'Lần quét A4')],
  };
  const { tables: out, report } = R.overlayHchanhFromPatientDb(runDir, sourceRows, 'r1', tables);
  const dx = Object.fromEntries(out.discharge.map(r => [r['Mã BN'], `${r['Chẩn đoán']}|${r['Nguồn kho'] || ''}`]));
  assert.deepStrictEqual(dx, {
    A1: 'Gốc A1|kho_nguoi_benh:goc',
    A2: 'Tạm thời A2|kho_nguoi_benh:tam_thoi',
    A3: 'Gốc A3|kho_nguoi_benh:goc',
    A4: 'Lần quét A4|',
  });
  assert.strictEqual(out.discharge.filter(r => r['Mã BN'] === 'A3').length, 1, 'không để trùng bản cũ');
  assert.strictEqual(report.cases_in_kho, 4);
  assert.strictEqual(report.filled.discharge, 2);
  assert.strictEqual(report.replaced_by_goc.discharge, 1);
  assert.deepStrictEqual(report.provisional.map(p => `${p.research_code}:${p.file}`), ['NC2:discharge']);
  assert.strictEqual(tables.discharge.length, 2, 'bảng đầu vào không bị sửa');
});

test('Chuẩn hoá: dùng dữ liệu từ kho, không sửa CSV thô, ghi báo cáo; kho có bản quét mới thì chữ ký đầu vào đổi', () => {
  const runDir = path.join(RUNTIME_ROOT, 'fixture', 'archive_like', 'runs', 'r1');
  fs.mkdirSync(runDir, { recursive: true });
  const cols = ['T/G vào', 'Mã BN', 'Mã nội trú', 'Họ tên', 'Tuổi', 'GT', 'Trạng thái', 'Khoa chuyển đến', 'Xử trí'];
  fs.writeFileSync(path.join(runDir, 'du_lieu_ban_dau.csv'), `﻿${cols.join(',')}\n21/09/2026 08:00,A1,NT1,BN A1,60,Nam,Hoàn tất,,Ra viện\n`);
  const sigBefore = R.normalizeInputSignature(runDir);
  R.normalizeRunOutputs(runDir, { sourceRunId: 'r1' });
  assert.ok(!fs.existsSync(path.join(runDir, 'hchanh_discharge.csv')), 'không tạo / sửa CSV thô của lần quét');
  const report = JSON.parse(fs.readFileSync(path.join(runDir, 'kho_nguoi_benh_overlay.json'), 'utf-8'));
  assert.strictEqual(report.filled.discharge, 1);
  const manifest = JSON.parse(fs.readFileSync(path.join(runDir, 'manifest.json'), 'utf-8'));
  assert.strictEqual(manifest.normalized_outputs.hchanh_discharge, 1);
  assert.strictEqual(manifest.normalized_outputs.kho_nguoi_benh.filled, 1);
  const enc = R.readCsvTable(path.join(runDir, 'encounters.csv'), 100).rows;
  assert.ok(enc.length >= 1);

  const sigAfter = R.normalizeInputSignature(runDir);
  dis('Gốc A1 cập nhật', { bn: 'A1', source: 'kho_nghien_cuu' }, '2026-10-01T00:00:00Z');
  assert.notStrictEqual(R.normalizeInputSignature(runDir), sigAfter, 'kho đổi → phải chuẩn hoá lại');
  assert.ok(sigBefore);
});

test('XN / CĐHA: bổ sung từng kết quả còn thiếu từ kho, không bỏ cả ca chỉ vì run đã có một dòng', () => {
  // Kết quả của A2 đã có trong kho từ lần quét khác (vd kho gốc).
  patientDb.recordResults([{ 'Mã NC': 'GOC1', 'Mã BN': 'A2', 'TG chỉ định': '08:00 22/09/2026', 'Chỉ số': 'HGB', 'Kết quả': '101', 'Đơn vị': 'g/L' },
    { 'Mã BN': 'A2', 'TG chỉ định': '08:00 01/09/2026', 'Chỉ số': 'HGB', 'Kết quả': '140' }], { kind: 'xn' });
  patientDb.recordResults([{ 'Mã BN': 'A2', 'TG chỉ định': '09:00 23/09/2026', 'Tên dịch vụ': 'Chụp CT sọ não', 'Kết luận': 'Bình thường' }], { kind: 'cdha' });
  // A3 có CRP trong run nhưng kho còn HGB cùng đợt: phải bổ sung HGB, không nhân đôi CRP.
  patientDb.recordResults([
    { 'Mã BN': 'A3', 'TG chỉ định': '08:00 22/09/2026', 'Chỉ số': 'CRP', 'Kết quả': '12' },
    { 'Mã BN': 'A3', 'TG chỉ định': '09:00 22/09/2026', 'Chỉ số': 'HGB', 'Kết quả': '115', 'Đơn vị': 'g/L' },
  ], { kind: 'xn' });
  const labRaw = [{ 'Mã NC': 'NC3', 'Mã BN': 'A3', 'TG chỉ định': '08:00 22/09/2026', 'Chỉ số': 'CRP', 'Kết quả': '12' }];
  const { labRaw: xn, imagingRaw: cd, report } = R.overlayResultsFromPatientDb(RUNTIME_ROOT, sourceRows, 'r1', labRaw, []);
  assert.strictEqual(report.ingested.xn, 1, 'kết quả của lần quét được ghi vào kho');
  const a2 = xn.filter(r => r['Mã BN'] === 'A2');
  assert.deepStrictEqual(a2.map(r => `${r['Mã NC']}|${r['Kết quả']}|${r['Nguồn kho']}`), ['NC2|101|kho_nguoi_benh:goc'], 'chỉ trong khoảng ngày của ca, mang Mã NC của nghiên cứu này');
  const a3 = xn.filter(r => r['Mã BN'] === 'A3');
  assert.deepStrictEqual(a3.map(r => `${r['Chỉ số']}|${r['Kết quả']}`).sort(), ['CRP|12', 'HGB|115'], 'giữ dòng run và bổ sung đúng dòng còn thiếu');
  assert.strictEqual(a3.filter(r => r['Chỉ số'] === 'CRP').length, 1, 'kết quả đã có không bị nhân đôi');
  assert.deepStrictEqual(cd.map(r => r['Tên dịch vụ']), ['Chụp CT sọ não']);
  assert.deepStrictEqual(report.filled_cases, { xn: 2, cdha: 1 });
  assert.strictEqual(labRaw.length, 1, 'bảng đầu vào không bị sửa');
});

test('Góp XN / CĐHA của mọi lần quét nghiên cứu đã có vào kho (không trùng khi chạy lại)', () => {
  const runDir = path.join(RUNTIME_ROOT, 'research', 'research_store', 'nc_demo', 'runs', 'r7');
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(path.join(runDir, 'lich_su_xn.csv'), '﻿Mã NC,Mã BN,TG chỉ định,Chỉ số,Kết quả\nNC7,A7,08:00 02/09/2026,HGB,120\nNC7,A7,08:00 03/09/2026,HGB,118\n');
  fs.writeFileSync(path.join(runDir, 'lich_su_cdha.csv'), '﻿Mã NC,Mã BN,TG chỉ định,Tên dịch vụ,Kết luận\nNC7,A7,09:00 02/09/2026,Chụp X quang ngực,Bình thường\n');
  assert.deepStrictEqual(R.ingestAllResearchResultsToPatientDb(), { runs: 1, xn: 2, cdha: 1 });
  assert.deepStrictEqual(R.ingestAllResearchResultsToPatientDb(), { runs: 1, xn: 0, cdha: 0 });
});

patientDb.close();
fs.rmSync(RUNTIME_ROOT, { recursive: true, force: true });
console.log(`\n${passed} kịch bản pass.`);
if (process.exitCode) process.exit(1);
