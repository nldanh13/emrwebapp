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

// Gom theo ngày: số dòng, thời điểm đầu/cuối (không in nội dung lâm sàng).
function spanOf(rows, timeCols) {
  const times = rows.map(r => timeCols.map(c => text(r[c])).find(Boolean) || '').filter(Boolean);
  const iso = times.map(t => {
    const m = t.match(/(\d{1,2})[/-](\d{1,2})[/-](\d{4})/);
    return m ? `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}` : t.slice(0, 10);
  }).sort();
  const days = new Map();
  for (const d of iso) days.set(d, (days.get(d) || 0) + 1);
  return { n: rows.length, first: iso[0] || '·', last: iso[iso.length - 1] || '·', days: [...days.entries()].map(([d, n]) => `${d.slice(5)}:${n}`).join(' ') };
}
function showSpan(file, timeCols, groupCol = '') {
  const all = rowsOf(file);
  if (!all) { console.log(`\n${file}: (không có file)`); return; }
  const rows = ofPatient(all);
  const sp = spanOf(rows, timeCols);
  console.log(`\n${file}: ${sp.n} dòng${sp.n ? ` · ${sp.first} … ${sp.last}` : ''}`);
  if (sp.n) console.log(`  theo ngày: ${sp.days}`);
  if (groupCol && rows.length) {
    const g = new Map();
    for (const r of rows) g.set(text(r[groupCol]) || '·', (g.get(text(r[groupCol]) || '·') || 0) + 1);
    console.log(`  theo ${groupCol}: ${[...g.entries()].map(([k, n]) => `${k}=${n}`).join(', ')}`);
  }
}
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
// Dữ liệu thô XN/CĐHA/y lệnh theo ngày, kết quả chuẩn hóa và trạng thái thu thập — để biết thiếu do
// chưa lấy, lấy lỗi, hay lấy được mà không ghép vào đợt.
showSpan('lich_su_xn.csv', ['TG chỉ định', 'Ngày chỉ định']);
showSpan('lich_su_cdha.csv', ['TG chỉ định', 'Ngày chỉ định']);
showSpan('hchanh_order_history.csv', ['TG y lệnh', 'Ngày']);
showSpan('lab_results.csv', ['lab_datetime', 'lab_date'], 'encounter_match_status');
showSpan('imaging_results.csv', ['ordered_at', 'order_date'], 'encounter_match_status');
showSpan('medication_orders.csv', ['order_datetime', 'order_date'], 'encounter_match_status');
show('extract_status.csv', ['encounter_id', 'popup_status', 'xn_status', 'cdha_status', 'profile_status', 'discharge_status', 'surgery_status', 'order_history_status', 'overall_status', 'missing_required', 'last_error']);
{
  const progress = (file) => {
    try { return JSON.parse(fs.readFileSync(path.join(dir, file), 'utf-8')); } catch (_) { return null; }
  };
  for (const file of ['hchanh_auto_progress.json', 'order_history_auto_progress.json']) {
    const p = progress(file);
    if (!p) { console.log(`\n${file}: (không có file)`); continue; }
    const mine = Object.entries(p).filter(([, v]) => text(v?.ma_bn) === code);
    console.log(`\n${file}: ${mine.length} lượt`);
    for (const [k, v] of mine) {
      const fsx = Object.entries(v.file_status || {}).map(([f, st]) => `${f}=${text(st?.status || st)}`).join(', ');
      console.log(`  key=${k.slice(0, 10)} | status=${text(v.status)} | finished=${text(v.finished_at) || '·'} | ${fsx}${v.error ? ` | lỗi=${text(v.error).split('\n')[0].slice(0, 120)}` : ''}`);
    }
  }
}
