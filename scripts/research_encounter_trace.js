#!/usr/bin/env node
'use strict';

// Lần theo nguồn của từng đợt điều trị của MỘT người bệnh: đợt lấy ngày vào/ra, khoa và chẩn đoán từ
// dòng nào (danh sách nguồn, hồ sơ hành chánh, ra viện). Dùng khi một đợt mang chẩn đoán lạ (vd. đợt
// mổ nhiễm trùng lại mang chẩn đoán loãng xương của đợt khác).
// CHỈ ĐỌC, không ghi file. KHÔNG in họ tên, Mã NC, URL; Mã BN chỉ dùng để lọc, không in ra.
//
// Chạy:
//   node scripts/research_encounter_trace.js <Mã BN>              (đợt mới nhất của kho gốc)
//   node scripts/research_encounter_trace.js <Mã BN> --run=<id>   (một đợt cụ thể)

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { RESEARCH_STORE_DIR } = require('../server/constants');
const { readCsvTable } = require('../server/research/table_io');

const argv = process.argv.slice(2);
const code = (argv.find(a => !a.startsWith('--')) || '').trim();
const runArg = (argv.find(a => a.startsWith('--run=')) || '').slice(6);
if (!code) {
  console.error('Cần Mã BN. Ví dụ: node scripts/research_encounter_trace.js 26001305');
  process.exit(1);
}

const runsDir = path.join(RESEARCH_STORE_DIR, 'du_lieu_goc', 'runs');
function pickRun() {
  if (runArg) return runArg;
  if (!fs.existsSync(runsDir)) return '';
  return fs.readdirSync(runsDir, { withFileTypes: true })
    .filter(d => d.isDirectory() && fs.existsSync(path.join(runsDir, d.name, 'encounters.csv')))
    .map(d => d.name).sort().pop() || '';
}
const run = pickRun();
if (!run) { console.error('Không thấy đợt chuẩn hóa nào trong kho gốc.'); process.exit(1); }
const dir = path.join(runsDir, run);

const text = v => String(v ?? '').trim();
const pick = (row, keys) => { for (const k of keys) { const v = text(row[k]); if (v) return v; } return ''; };
const short = (v, n = 60) => { const s = text(v).replace(/\s+/g, ' '); return s.length > n ? `${s.slice(0, n)}…` : s; };
const tag = v => (text(v) ? crypto.createHash('sha256').update(text(v)).digest('hex').slice(0, 6) : '—');
const isCode = row => pick(row, ['Mã BN', 'patient_code']) === code;

function rowsOf(file) {
  const t = readCsvTable(path.join(dir, file), Number.MAX_SAFE_INTEGER);
  return t.exists === false ? [] : (t.rows || []).filter(isCode);
}

console.log(`Đợt chuẩn hóa: ${run}`);
console.log('\n== Các đợt sau chuẩn hóa (encounters.csv) ==');
const encs = rowsOf('encounters.csv');
encs.forEach((e, i) => {
  console.log(`  [${i + 1}] id=${tag(e.encounter_id)} vào=${text(e.admission_date)} ra=${text(e.discharge_date)} khoa=${short(e.department, 30)}`);
  console.log(`      chẩn đoán=${short(e.diagnosis_raw)} | vào=${short(e.admission_diagnosis, 40)} | ra=${short(e.discharge_diagnosis, 40)}`);
  console.log(`      nguồn=${short(e.source_status || e.__source_status || e.source || '', 40)}`);
});

const SOURCES = ['research_source.csv', 'du_lieu_ban_dau.csv', 'du_lieu_goc.csv', 'hchanh_profile.csv', 'hchanh_discharge.csv'];
for (const file of SOURCES) {
  const rows = rowsOf(file);
  if (!rows.length) continue;
  console.log(`\n== ${file} (${rows.length} dòng) ==`);
  rows.forEach((r, i) => {
    console.log(`  [${i + 1}] key=${tag(pick(r, ['Research key']))} nguồn=${short(pick(r, ['Nguồn input', 'Nguồn']), 20)} T/G vào=${pick(r, ['T/G vào'])} vào viện=${pick(r, ['Ngày vào viện'])} ra=${pick(r, ['Ngày ra viện'])} khoa=${short(pick(r, ['Khoa']), 25)}`);
    console.log(`      chẩn đoán=${short(pick(r, ['Chẩn đoán']))} | vào=${short(pick(r, ['Chẩn đoán vào viện']), 40)} | ra=${short(pick(r, ['Chẩn đoán ra viện']), 40)}`);
  });
}
console.log('\nKết quả không có họ tên, Mã NC hay URL; có thể dán để kiểm tra.');
