#!/usr/bin/env node
'use strict';

// Truy vết một người bệnh trong kho gốc: in các mốc ngày của MỌI file nguồn (danh sách, hồ sơ, ra viện,
// phẫu thuật, y lệnh) và kết quả chuẩn hóa (đợt, phẫu thuật), để biết ngày vào/ra, ngày mổ đến từ đâu.
// CHỈ ĐỌC. Chỉ in Mã BN đã nhập và các cột ngày/nguồn — không in họ tên, chẩn đoán hay nội dung lâm sàng.
//
// Chạy: node scripts/research_case_trace.js <Mã BN> [--run=<id>]

const fs = require('fs');
const path = require('path');
const { RESEARCH_STORE_DIR } = require('../server/constants');
const { readCsvTable } = require('../server/research/table_io');

const args = process.argv.slice(2);
const code = (args.find(a => !a.startsWith('--')) || '').trim();
const runArg = (args.find(a => a.startsWith('--run=')) || '').slice(6);
if (!code) { console.log('Cách dùng: node scripts/research_case_trace.js <Mã BN> [--run=<id>]'); process.exit(1); }

const runsDir = path.join(RESEARCH_STORE_DIR, 'du_lieu_goc', 'runs');
const runId = runArg || (fs.existsSync(runsDir) ? fs.readdirSync(runsDir).filter(d => fs.existsSync(path.join(runsDir, d, 'encounters.csv'))).sort().pop() : '');
if (!runId) { console.log('Không tìm thấy đợt kho gốc.'); process.exit(0); }
const dir = path.join(runsDir, runId);
console.log(`Đợt kho: ${runId} · Mã BN ${code}`);

const text = v => String(v ?? '').trim();
const rowsOf = file => {
  const t = readCsvTable(path.join(dir, file), Number.MAX_SAFE_INTEGER);
  return t.exists === false ? null : (t.rows || []);
};
const ofPatient = (rows, keys = ['Mã BN', 'patient_code']) => (rows || []).filter(r => keys.some(k => text(r[k]) === code));

function show(file, cols, extra = null) {
  const rows = rowsOf(file);
  if (!rows) { console.log(`\n${file}: (không có file)`); return; }
  const mine = ofPatient(rows);
  console.log(`\n${file}: ${mine.length} dòng`);
  mine.slice(0, 60).forEach((r, i) => {
    const parts = cols.map(c => `${c}=${text(r[c]) || '·'}`);
    if (extra) parts.push(extra(r));
    console.log(`  [${i + 1}] ${parts.join(' | ')}`);
  });
  if (mine.length > 60) console.log(`  … còn ${mine.length - 60} dòng`);
}

function rawJsonDates(r) {
  const raw = text(r['Raw JSON']);
  if (!raw) return '';
  try {
    const obj = JSON.parse(raw);
    const d = obj.detail || {};
    const pick = ['thoi_gian', 'bat_dau', 'ket_thuc', 'ngay_thuc_hien', 'ngay_tao'];
    const vals = [...pick.map(k => (obj[k] ? `${k}:${obj[k]}` : '')), ...pick.map(k => (d[k] ? `detail.${k}:${d[k]}` : ''))].filter(Boolean);
    return `raw[${vals.join(', ')}]`;
  } catch (_) { return 'raw[không đọc được]'; }
}

const KEY = r => text(r['Research key']).slice(0, 10);
show('du_lieu_ban_dau.csv', ['T/G vào', 'T/G ra', 'Ngày ra viện', 'Khoa', 'Trạng thái']);
show('research_source.csv', ['T/G vào', 'Ngày vào viện', 'Ngày ra viện', 'fetch_from_date', 'fetch_to_date', 'source_scan_to_date'], r => `key=${KEY(r)}`);
show('hchanh_profile.csv', ['Ngày vào viện', 'Ngày ra viện', 'Thời gian điều trị', 'Nguồn input'], r => `key=${KEY(r)}`);
show('hchanh_discharge.csv', ['Ngày vào viện', 'Ngày ra viện', 'Thời gian điều trị', 'Nguồn input'], r => `key=${KEY(r)}`);
show('hchanh_surgery.csv', ['Ngày vào viện', 'Ngày ra viện', 'Ngày phẫu thuật', 'Thời gian', 'bat_dau', 'Nguồn'], r => `key=${KEY(r)} ${rawJsonDates(r)}`);
show('lich_su_phau_thuat.csv', ['Ngày phẫu thuật', 'Thời gian', 'bat_dau', 'surgery_datetime', 'surgery_date']);
show('phau_thuat.csv', ['Ngày phẫu thuật', 'Thời gian', 'bat_dau', 'surgery_datetime', 'surgery_date']);
// Y lệnh: gom theo khoảng vào–ra ghi trên dòng (nhiều dòng giống nhau).
{
  const rows = ofPatient(rowsOf('hchanh_order_history.csv') || []);
  const windows = new Map();
  for (const r of rows) {
    const k = `vào=${text(r['Ngày vào viện']) || '·'} | ra=${text(r['Ngày ra viện']) || '·'}`;
    const w = windows.get(k) || { n: 0, first: '', last: '' };
    const t = text(r['TG y lệnh']);
    w.n += 1;
    if (t && (!w.first || t < w.first)) w.first = t;
    if (t && (!w.last || t > w.last)) w.last = t;
    windows.set(k, w);
  }
  console.log(`\nhchanh_order_history.csv: ${rows.length} dòng, theo khoảng ghi trên dòng:`);
  for (const [k, w] of windows) console.log(`  ${k} · ${w.n} dòng (TG y lệnh ${w.first || '·'} … ${w.last || '·'})`);
}
show('encounters.csv', ['encounter_id', 'admission_date', 'discharge_date', 'treatment_duration', 'source_status']);
show('surgery_results.csv', ['surgery_datetime', 'encounter_id', 'encounter_match_status', 'encounter_match_method', 'encounter_match_reason', 'is_within_encounter'], r => `tên=${text(r.surgery_name).slice(0, 40)}`);
