#!/usr/bin/env node
'use strict';

// Chẩn đoán vì sao "Thu thập tự động" đếm số lượt khác với "Giám sát dữ liệu".
// CHỈ ĐỌC, không ghi file nào. CHỈ IN SỐ ĐẾM — không in mã BN, họ tên, Mã NC, ngày
// hay nội dung dòng — để có thể dán kết quả ra ngoài an toàn.
//
// Chạy:
//   node scripts/research_collection_diagnose.js              (run mới nhất của kho gốc)
//   node scripts/research_collection_diagnose.js --run=<id>   (một run cụ thể)

const fs = require('fs');
const path = require('path');
const { RESEARCH_STORE_DIR } = require('../server/constants');
const collection = require('../server/research/collection');
const { readCsvTable } = require('../server/routes/research')._test;

const args = Object.fromEntries(
  process.argv.slice(2)
    .map(a => a.match(/^--([^=]+)(?:=(.*))?$/))
    .filter(Boolean)
    .map(m => [m[1], m[2] === undefined ? true : m[2]])
);

const runsDir = path.join(RESEARCH_STORE_DIR, 'du_lieu_goc', 'runs');

function pickRun() {
  if (args.run) return String(args.run);
  if (!fs.existsSync(runsDir)) return '';
  const dirs = fs.readdirSync(runsDir, { withFileTypes: true })
    .filter(d => d.isDirectory() && fs.existsSync(path.join(runsDir, d.name, 'research_source.csv')))
    .map(d => d.name)
    .sort();
  return dirs[dirs.length - 1] || '';
}

function rowsOf(runDir, file) {
  const t = readCsvTable(path.join(runDir, file), Number.MAX_SAFE_INTEGER);
  return t.exists ? (t.rows || []) : null;
}

function get(row, names) {
  for (const n of names) {
    const v = String(row?.[n] ?? '').trim();
    if (v) return v;
  }
  return '';
}

function mtime(runDir, file) {
  try { return fs.statSync(path.join(runDir, file)).mtime.toISOString().slice(0, 16).replace('T', ' '); } catch (_) { return '-'; }
}

const runId = pickRun();
if (!runId) {
  console.log('Không tìm thấy run nào có research_source.csv trong kho gốc.');
  process.exit(1);
}
const runDir = path.join(runsDir, runId);
console.log(`Run: ${runId}`);

console.log('\n[Số dòng từng file] (thời điểm sửa gần nhất)');
for (const f of ['du_lieu_ban_dau.csv', 'research_source.csv', 'encounters.csv', 'extract_status.csv']) {
  const r = rowsOf(runDir, f);
  console.log(`  ${f.padEnd(22)} ${r === null ? 'không có' : String(r.length).padStart(6)}   ${mtime(runDir, f)}`);
}

const source = rowsOf(runDir, 'research_source.csv') || [];
const encounters = rowsOf(runDir, 'encounters.csv') || [];
const has = names => source.filter(r => get(r, names)).length;
console.log('\n[research_source.csv — mỗi dòng là một Research key]');
console.log(`  số người bệnh (Mã BN khác nhau): ${new Set(source.map(r => get(r, ['Mã BN']))).size}`);
console.log(`  có Mã nội trú:   ${has(['Mã nội trú', 'noitruid', 'emr_noitru_id'])}`);
console.log(`  có Mã điều trị:  ${has(['Mã điều trị', 'emr_treatment_id'])}`);
console.log(`  có Mã vào viện:  ${has(['Mã vào viện', 'emr_admission_id'])}`);
console.log(`  có T/G vào / Ngày vào viện: ${has(['T/G vào', 'Ngày vào viện'])}`);
console.log(`  có Ngày ra viện: ${has(['Ngày ra viện', 'T/G ra'])}`);
const perPatient = new Map();
for (const r of source) { const c = get(r, ['Mã BN']); perPatient.set(c, (perPatient.get(c) || 0) + 1); }
const multi = [...perPatient.values()].filter(n => n > 1);
console.log(`  người bệnh có >1 dòng: ${multi.length} (tổng ${multi.reduce((a, b) => a + b, 0)} dòng)`);

const encCodes = new Set(encounters.map(r => get(r, ['patient_code'])).filter(Boolean));
const unresolved = encounters.filter(r => get(r, ['encounter_id']).startsWith('enc_unresolved_')).length;
console.log('\n[encounters.csv — kết quả chuẩn hóa lần gần nhất]');
console.log(`  lượt: ${encounters.length} | chưa xác định lượt: ${unresolved} | có Mã nội trú: ${encounters.filter(r => get(r, ['emr_noitru_id'])).length} | có ngày ra viện: ${encounters.filter(r => get(r, ['discharge_date'])).length}`);
console.log(`  người bệnh của research_source CHƯA có trong encounters.csv: ${[...perPatient.keys()].filter(c => c && !encCodes.has(c)).length}`);

const units = collection.buildCollectionUnits({ sourceRows: source, encounterRows: encounters });
const matched = units.filter(u => u.encounter_id);
const alone = units.filter(u => !u.encounter_id);
const aloneNoEnc = alone.filter(u => !encCodes.has(u.patient_code)).length;
console.log('\n[Đơn vị thu thập = lượt]');
console.log(`  tổng: ${units.length}`);
console.log(`  ghép được về encounters.csv: ${matched.length} (gom ${matched.reduce((a, u) => a + u.members.length, 0)} dòng)`);
console.log(`  đứng riêng: ${alone.length}`);
console.log(`    - người bệnh chưa có trong encounters.csv: ${aloneNoEnc}`);
console.log(`    - người bệnh có trong encounters.csv nhưng không khớp chắc: ${alone.length - aloneNoEnc}`);
