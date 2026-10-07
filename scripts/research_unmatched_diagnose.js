#!/usr/bin/env node
'use strict';

// Chẩn đoán vì sao dữ liệu của kho "không ghép được vào lượt điều trị" (Ngoài thời gian điều trị,
// Mơ hồ) và vì sao có "Mã NC gắn với nhiều Mã BN".
// CHỈ ĐỌC, không ghi file nào. CHỈ IN SỐ ĐẾM — không in Mã BN, họ tên, Mã NC hay ngày — để dán
// kết quả ra ngoài an toàn.
//
// Chạy:
//   node scripts/research_unmatched_diagnose.js              (đợt mới nhất của kho gốc)
//   node scripts/research_unmatched_diagnose.js --run=<id>   (một đợt cụ thể)

const fs = require('fs');
const path = require('path');
const { RESEARCH_STORE_DIR } = require('../server/constants');
const { readCsvTable } = require('../server/research/table_io');
const { parseAnyDate } = require('../server/research/encounter_context');

const args = Object.fromEntries(process.argv.slice(2)
  .map(a => a.match(/^--([^=]+)(?:=(.*))?$/)).filter(Boolean)
  .map(m => [m[1], m[2] === undefined ? true : m[2]]));

const runsDir = path.join(RESEARCH_STORE_DIR, 'du_lieu_goc', 'runs');
const DAY = 86400000;

const TABLES = {
  'Xét nghiệm': { file: 'lab_results.csv', time: ['lab_datetime', 'lab_date'] },
  'CĐHA': { file: 'imaging_results.csv', time: ['ordered_at', 'order_date'] },
  'Phẫu thuật': { file: 'surgery_results.csv', time: ['surgery_datetime', 'surgery_date'] },
  'Y lệnh thuốc': { file: 'medication_orders.csv', time: ['order_datetime', 'order_date'] },
  'Diễn biến & y lệnh gốc': { file: 'clinical_notes.csv', time: ['note_datetime', 'note_date'] },
};

const CODE_SOURCES = ['research_source.csv', 'du_lieu_goc.csv', 'du_lieu_ban_dau.csv', 'hchanh_profile.csv', 'hchanh_discharge.csv', 'hchanh_surgery.csv', 'hchanh_order_history.csv'];

function text(v) { return String(v ?? '').trim(); }
function pick(row, keys) { for (const k of keys) { const v = text(row[k]); if (v) return v; } return ''; }
function rows(dir, file) {
  const t = readCsvTable(path.join(dir, file), Number.MAX_SAFE_INTEGER);
  return t.exists === false ? null : (t.rows || []);
}
function pickRun() {
  if (args.run) return String(args.run);
  if (!fs.existsSync(runsDir)) return '';
  return fs.readdirSync(runsDir, { withFileTypes: true })
    .filter(d => d.isDirectory() && fs.existsSync(path.join(runsDir, d.name, 'encounters.csv')))
    .map(d => d.name).sort().pop() || '';
}
function bump(obj, key, n = 1) { obj[key] = (obj[key] || 0) + n; }
function gapBucket(days) {
  if (days <= 1) return '≤ 1 ngày';
  if (days <= 3) return '2–3 ngày';
  if (days <= 7) return '4–7 ngày';
  if (days <= 30) return '8–30 ngày';
  if (days <= 180) return '1–6 tháng';
  return '> 6 tháng';
}
function print(title, obj) {
  const entries = Object.entries(obj).sort((a, b) => b[1] - a[1]);
  console.log(`  ${title}:`);
  if (!entries.length) { console.log('    (không có)'); return; }
  for (const [k, v] of entries) console.log(`    ${k}: ${v}`);
}

const runId = pickRun();
if (!runId) { console.log('Không tìm thấy đợt nào của kho gốc có encounters.csv.'); process.exit(0); }
const dir = path.join(runsDir, runId);
console.log(`Đợt kho: ${runId}`);

const encounters = rows(dir, 'encounters.csv') || [];
const stays = new Map(); // Mã BN -> [{ start, end }]
let openStays = 0;
let dateOnlyAdmission = 0;
for (const e of encounters) {
  const pc = text(e.patient_code);
  const start = parseAnyDate(e.admission_date);
  if (!pc || !start) continue;
  const endRaw = parseAnyDate(e.discharge_date);
  if (!endRaw) openStays += 1;
  if (!/\d{1,2}:\d{2}/.test(text(e.admission_date))) dateOnlyAdmission += 1;
  const end = endRaw ? new Date(endRaw.getTime() + (/\d{1,2}:\d{2}/.test(text(e.discharge_date)) ? 0 : DAY - 1)) : new Date(8.64e15);
  if (!stays.has(pc)) stays.set(pc, []);
  stays.get(pc).push({ start: start.getTime(), end: end.getTime() });
}
console.log(`\nLượt điều trị: ${encounters.length} · người bệnh: ${stays.size} · chưa có ngày ra: ${openStays} · ngày vào chỉ có ngày (không giờ): ${dateOnlyAdmission}`);

console.log('\n== Dòng không ghép được, theo bảng ==');
for (const [label, spec] of Object.entries(TABLES)) {
  const list = rows(dir, spec.file);
  if (!list || !list.length) continue;
  const status = {}; const reason = {}; const outside = {}; const ambiguous = {}; const period = {};
  for (const r of list) {
    const st = text(r.encounter_match_status) || '(trống)';
    bump(status, st);
    if (st === 'matched') {
      const m = text(r.encounter_match_method);
      bump(period, m === 'pre_admission' ? 'trước nhập viện (≤ 3 ngày)' : m === 'emergency_before_ward' ? 'Cấp cứu, trước vào khoa (≤ 24 giờ)' : 'trong đợt');
    }
    if (st === 'matched') continue;
    const why = text(r.encounter_match_reason) || '(không ghi lý do)';
    bump(reason, why);
    const at = parseAnyDate(pick(r, spec.time));
    const pc = text(r.patient_code);
    const own = stays.get(pc) || [];
    if (why.includes('outside_time')) {
      if (!at) { bump(outside, 'không có thời gian'); continue; }
      if (!own.length) { bump(outside, 'người bệnh không có lượt nào trong kho'); continue; }
      const t = at.getTime();
      const first = Math.min(...own.map(s => s.start));
      const last = Math.max(...own.map(s => s.end));
      if (t < first) bump(outside, `trước lượt đầu tiên ${gapBucket((first - t) / DAY)}`);
      else if (t > last) bump(outside, `sau lượt cuối cùng ${gapBucket((t - last) / DAY)}`);
      else {
        const gap = Math.min(...own.map(s => (t < s.start ? s.start - t : t > s.end ? t - s.end : 0)));
        bump(outside, `giữa hai lượt, cách lượt gần nhất ${gapBucket(gap / DAY)}`);
      }
    } else if (why.includes('ambiguous')) {
      if (!at) { bump(ambiguous, 'không có thời gian'); continue; }
      const t = at.getTime();
      bump(ambiguous, `rơi vào ${own.filter(s => t >= s.start && t <= s.end).length} lượt chồng nhau`);
    }
  }
  console.log(`\n${label} (${spec.file}): ${list.length} dòng`);
  print('trạng thái', status);
  print('đã ghép, theo giai đoạn', period);
  print('lý do chưa ghép', reason);
  print('"ngoài thời gian": lệch bao xa so với lượt của chính người bệnh', outside);
  print('"mơ hồ"', ambiguous);
}

console.log('\n== Mã NC gắn với nhiều Mã BN (bảng encounters) ==');
const byCode = new Map();
for (const e of encounters) {
  const rc = text(e.research_code); const pc = text(e.patient_code);
  if (!rc || !pc) continue;
  if (!byCode.has(rc)) byCode.set(rc, new Set());
  byCode.get(rc).add(pc);
}
const bad = [...byCode.entries()].filter(([, s]) => s.size > 1);
console.log(`Số Mã NC bị trùng: ${bad.length}`);
bad.slice(0, 10).forEach(([rc, patients], i) => {
  console.log(`  Mã NC trùng #${i + 1}: ${patients.size} Mã BN · ${encounters.filter(e => text(e.research_code) === rc).length} lượt`);
  for (const file of CODE_SOURCES) {
    const list = rows(dir, file);
    if (!list) continue;
    const pcs = new Set(list.filter(r => pick(r, ['Mã NC', 'Ma NC', 'research_code']) === rc).map(r => pick(r, ['Mã BN', 'patient_code'])).filter(Boolean));
    if (pcs.size) console.log(`    ${file}: mã này có ở ${pcs.size} Mã BN`);
  }
});

// ── Kiểm tra giả thuyết (chỉ đếm) ───────────────────────────────────────────
const mask = v => text(v).replace(/\d/g, 'd').slice(0, 24) || '(trống)';
function insideOwn(pc, ms) { return (stays.get(pc) || []).some(s => ms >= s.start && ms <= s.end); }

console.log('\n== Phẫu thuật: định dạng ngày thô và thử đảo ngày/tháng ==');
const surgeryRaw = rows(dir, 'hchanh_surgery.csv') || [];
const masks = {}; const sources = {};
let swapFits = 0; let asIsFits = 0; let checked = 0;
for (const r of surgeryRaw) {
  const raw = pick(r, ['Ngày phẫu thuật', 'Ngay phau thuat', 'Thời gian']);
  bump(masks, mask(raw));
  bump(sources, pick(r, ['Nguồn', 'source']) || '(không ghi)');
  const m = raw.match(/(\d{1,2})[/-](\d{1,2})[/-](\d{4})/);
  const pc = pick(r, ['Mã BN', 'patient_code']);
  if (!m || !pc) continue;
  checked += 1;
  const asIs = parseAnyDate(`${m[1]}/${m[2]}/${m[3]}`);
  const swapped = Number(m[2]) <= 12 && Number(m[1]) <= 12 ? parseAnyDate(`${m[2]}/${m[1]}/${m[3]}`) : null;
  if (asIs && insideOwn(pc, asIs.getTime() + 12 * 3600000)) asIsFits += 1;
  else if (swapped && insideOwn(pc, swapped.getTime() + 12 * 3600000)) swapFits += 1;
}
print('định dạng (d = chữ số)', masks);
print('nguồn dòng', sources);
console.log(`  có ngày: ${checked} · đọc ngày/tháng rơi vào đợt: ${asIsFits} · chỉ khi đảo tháng/ngày mới rơi vào đợt: ${swapFits}`);

console.log('\n== Y lệnh: so với khoảng vào–ra ghi trên chính dòng y lệnh ==');
const orderRaw = rows(dir, 'hchanh_order_history.csv') || [];
const orderCheck = {};
for (const r of orderRaw) {
  const at = parseAnyDate(pick(r, ['TG y lệnh', 'Thời gian', 'Ngày']));
  const pc = pick(r, ['Mã BN', 'patient_code']);
  if (!at || !pc) continue;
  const t = at.getTime();
  if (insideOwn(pc, t)) { bump(orderCheck, 'trong một đợt của kho'); continue; }
  const from = parseAnyDate(pick(r, ['Ngày vào viện']));
  const toRaw = pick(r, ['Ngày ra viện']);
  const to = parseAnyDate(toRaw);
  const toMs = to ? to.getTime() + (/\d{1,2}:\d{2}/.test(toRaw) ? 0 : DAY - 1) : null;
  if (from && toMs != null && t >= from.getTime() - DAY && t <= toMs) bump(orderCheck, 'ngoài đợt của kho nhưng trong khoảng vào–ra ghi trên dòng (đợt của kho bị ngắn)');
  else if (from && toMs == null && t >= from.getTime()) bump(orderCheck, 'ngoài đợt của kho, dòng không ghi ngày ra');
  else bump(orderCheck, 'ngoài cả khoảng ghi trên dòng');
}
print('dòng y lệnh thô', orderCheck);
