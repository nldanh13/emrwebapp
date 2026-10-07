#!/usr/bin/env node
'use strict';

// Kiểm tra ngẫu nhiên: chọn một đợt, lấy mục cần kiểm (mốc đợt, mẫu từng loại dữ liệu, dòng không gắn
// sát đợt), lưu Đúng/Sai ngay, cộng dồn tỉ lệ đạt; ca đã kiểm không bị chọn lại.
// Chạy: node scripts/research_audit_sample_test.js

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
process.env.EMR_RUNTIME_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'audit_sample_'));
const R = require('../server/routes/research')._test;
const audit = require('../server/research/audit_sample');

let passed = 0;
function test(name, fn) {
  try { fn(); passed += 1; console.log(`  ok - ${name}`); } catch (err) { console.error(`  FAIL - ${name}`); console.error(err); process.exitCode = 1; }
}
function writeCsv(file, cols, rows) {
  const esc = v => (/[",\n]/.test(String(v ?? '')) ? `"${String(v).replace(/"/g, '""')}"` : String(v ?? ''));
  fs.writeFileSync(file, `﻿${[cols.join(','), ...rows.map(r => cols.map(c => esc(r[c])).join(','))].join('\n')}\n`);
}
function seeded(seed) { let s = seed; return () => { s = (s * 16807) % 2147483647; return (s - 1) / 2147483646; }; }

const runDir = path.join(process.env.EMR_RUNTIME_ROOT, 'run1');
fs.mkdirSync(runDir, { recursive: true });
writeCsv(path.join(runDir, 'du_lieu_ban_dau.csv'), ['T/G vào', 'Mã BN', 'Họ tên', 'Ngày ra viện'], [
  { 'T/G vào': '08:00 01/03/2026', 'Mã BN': '801', 'Họ tên': 'BN GIA LAP A', 'Ngày ra viện': '10/03/2026' },
  { 'T/G vào': '08:00 01/04/2026', 'Mã BN': '802', 'Họ tên': 'BN GIA LAP B', 'Ngày ra viện': '05/04/2026' },
]);
const labs = [];
for (let d = 1; d <= 9; d += 1) labs.push({ 'Mã BN': '801', 'TG chỉ định': `07:00 0${d}/03/2026`, 'Chỉ số': `XN${d}`, 'Kết quả': String(d), 'Đơn vị': 'G/L' });
labs.push({ 'Mã BN': '801', 'TG chỉ định': '07:00 14/03/2026', 'Chỉ số': 'SAU_RA_VIEN', 'Kết quả': '1', 'Đơn vị': 'G/L' });
for (let d = 1; d <= 4; d += 1) labs.push({ 'Mã BN': '802', 'TG chỉ định': `07:00 0${d}/04/2026`, 'Chỉ số': `B${d}`, 'Kết quả': String(d), 'Đơn vị': 'G/L' });
writeCsv(path.join(runDir, 'lich_su_xn.csv'), ['Mã BN', 'TG chỉ định', 'Chỉ số', 'Kết quả', 'Đơn vị'], labs);
R.normalizeRunOutputs(runDir, { sourceRunId: 'r', force: true });

let first;
test('chọn một đợt: có mốc đợt, tối đa 5 XN của đợt, dòng không gắn sát đợt', () => {
  first = audit.createAudit(runDir, { random: seeded(7), runId: 'run1' });
  assert.strictEqual(first.patient_code, '801', 'hạt giống cố định chọn đợt đầu tiên');
  const groups = first.items.map(i => i.group);
  assert.deepStrictEqual(groups.slice(0, 3), ['encounter', 'encounter', 'encounter']);
  const labItems = first.items.filter(i => i.group === 'labs');
  assert.ok(labItems.length >= 1 && labItems.length <= 5);
  assert.ok(first.items.every(i => i.verdict === ''));
  assert.ok(first.items.some(i => i.group === 'unassigned' && /SAU_RA_VIEN/.test(i.label)), 'XN sau ra viện của cùng người bệnh được đưa vào để kiểm "không thuộc đợt"');
});

test('ca đã kiểm không bị chọn lại khi còn ca khác', () => {
  const second = audit.createAudit(runDir, { random: seeded(7), runId: 'run1' });
  assert.notStrictEqual(second.encounter_id, first.encounter_id);
});

test('lưu Đúng/Sai ngay từng mục; tổng hợp tỉ lệ đạt và danh sách mục sai', () => {
  const labItem = first.items.find(i => i.group === 'labs');
  audit.saveVerdict(runDir, first.id, 'enc_admission', { verdict: 'dung' });
  audit.saveVerdict(runDir, first.id, 'enc_discharge', { verdict: 'sai', note: 'EMR ra viện 11/03' });
  audit.saveVerdict(runDir, first.id, labItem.id, { verdict: 'dung' });
  const reloaded = audit.getAudit(runDir, first.id);
  assert.strictEqual(reloaded.items.find(i => i.id === 'enc_discharge').note, 'EMR ra viện 11/03');
  const s = audit.summarize(runDir);
  const enc = s.groups.find(g => g.group === 'encounter');
  assert.deepStrictEqual([enc.dung, enc.sai], [1, 1]);
  assert.strictEqual(enc.accuracy, 0.5);
  assert.strictEqual(s.overall.checked, 3);
  assert.strictEqual(s.failures.length, 1);
  assert.strictEqual(s.failures[0].note, 'EMR ra viện 11/03');
  assert.strictEqual(s.audit_count, 2);
});

test('kết quả sai kiểu bị từ chối bằng thông báo tiếng Việt', () => {
  assert.throws(() => audit.saveVerdict(runDir, first.id, 'enc_admission', { verdict: 'ok' }), /Đúng, Sai hoặc Không chắc/);
  assert.throws(() => audit.getAudit(runDir, 'khong_co'), /Không tìm thấy lượt kiểm tra/);
});

test('khoảng tin cậy Wilson hợp lý', () => {
  const ci = audit.wilson(19, 20);
  assert.ok(ci.low > 0.7 && ci.low < 0.8 && ci.high > 0.98);
  assert.strictEqual(audit.wilson(0, 0), null);
});

console.log(`research_audit_sample_test: ${passed} passed`);
