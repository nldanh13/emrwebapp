'use strict';

// Tự điền phiếu nhập tay từ dữ liệu đã có (lấy từ kho/EMR) của từng Mã NC.
// Trường của phiếu có khóa `auto` (vd. 'lab_vitd', 'dm') thì app điền sẵn giá trị gợi ý kèm nguồn;
// người nhập xem lại và sửa được. Giá trị đã nhập tay luôn được ưu tiên.
// Mốc (thời điểm truyền) của mỗi mẫu: mốc nhập tay → mốc tự động (analysis_selected) → y lệnh sớm nhất
// của thuốc/hoạt chất trong tiêu chuẩn chọn vào.

const fs = require('fs');
const path = require('path');
const { readCsvTable, getCell } = require('./table_io');
const { researchCode, virtualVariableMatches } = require('./variable_selection');
const { augmentMedicationRowsForResearch } = require('./medication_ingredient_catalog');

const DAY = 86400000;

const plain = value => String(value ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/đ/g, 'd').replace(/Đ/g, 'D').toLowerCase();

function parseTime(value) {
  const s = String(value || '').trim();
  if (!s) return NaN;
  let m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?/.exec(s);
  if (m) return new Date(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0)).getTime();
  m = /(?:(\d{1,2}):(\d{2})\s+)?(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(\d{1,2}):(\d{2}))?/.exec(s);
  if (m) return new Date(+m[5], +m[4] - 1, +m[3], +(m[1] || m[6] || 0), +(m[2] || m[7] || 0)).getTime();
  return NaN;
}
const hasClock = value => /\d{1,2}:\d{2}/.test(String(value || ''));
const startOfDay = t => { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); };
const isoDay = t => { const d = new Date(t); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const fmtDay = t => { const d = new Date(t); return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`; };

// Xét nghiệm theo tên (bỏ dấu, chữ thường). Phần trăm (%Lym, %Mono) tách với số tuyệt đối.
const LAB_RULES = {
  lab_vitd: { label: 'Vitamin D', test: n => /25\s*-?\s*\(?\s*oh\s*\)?|vitamin\s*d|vit\.?\s*d\b/.test(n) },
  lab_ca_ion: { label: 'Canxi ion hóa', test: n => /(canxi|calci|calcium|\bca\b)\s*(\+\+|2\+|ion)|ion\s*hoa|\bica\b/.test(n) },
  lab_egfr: { label: 'eGFR', test: n => /egfr|\bgfr\b|mlct|muc loc cau than/.test(n) },
  lab_wbc: { label: 'WBC', test: n => /\bwbc\b|so luong bach cau|^bach cau\b/.test(n) && !/%|ty le|neu|lym|mono|eos|baso/.test(n) },
  lab_lym: { label: '%Lym', test: n => /(lym|lymph)/.test(n) && (/%|ty le/.test(n)) && !/#/.test(n) },
  lab_mono: { label: '%Mono', test: n => /mono/.test(n) && (/%|ty le/.test(n)) && !/#/.test(n) },
};

const ANALGESIC = /paracetamol|acetaminophen|perfalgan|efferalgan|panadol|hapacol|partamol|ibuprofen|diclofenac|meloxicam|celecoxib|etoricoxib|naproxen|ketorolac|piroxicam|aceclofenac|ketoprofen|nimesulid|prednisolon|prednison|methylprednisolon|medrol|solu.?medrol|dexamethason|hydrocortison|betamethason|depersolon/;
const STATIN = /statin|lipitor|crestor|zocor|atorva|rosuva|simva|prava|lova|fluva|pitava/;

const ICD = {
  dm: { label: 'Đái tháo đường', re: /^E1[0-4]/ },
  gastro: { label: 'Bệnh dạ dày – tá tràng', re: /^K2[5-9]/ },
  autoimmune: { label: 'Bệnh tự miễn (Lupus/RA)', re: /^(M32|M05|M06)/ },
  fracture: { label: 'Gãy xương', re: /^(M80|M84|S[1-9]2)/ },
};
const OSTEO_SEVERE = 'Loãng xương nặng (có gãy xương)';
const OSTEO_PRIMARY = 'Loãng xương sau mãn kinh/nguyên phát';

const AUTO_KEYS = new Set([
  'birth_year', 'sex', 'department', 'osteo_dx', 'fracture', 'analgesic_3d', 'analgesic_3d_names', 'statin',
  'dm', 'gastro', 'autoimmune', 'infusion_session', 'lab_vitd_date', ...Object.keys(LAB_RULES),
]);

function readRunTable(runDir, name) {
  const file = path.join(runDir, `${name}.csv`);
  return fs.existsSync(file) ? (readCsvTable(file, Number.MAX_SAFE_INTEGER).rows || []) : [];
}

function groupByCode(rows) {
  const map = new Map();
  for (const row of rows) {
    const code = researchCode(row);
    if (!code) continue;
    if (!map.has(code)) map.set(code, []);
    map.get(code).push(row);
  }
  return map;
}

const eventTimeOf = row => parseTime(getCell(row, ['lab_datetime', 'order_datetime', 'lab_date', 'order_date', 'note_datetime', 'note_date']));

// Thuốc/hoạt chất trong tiêu chuẩn chọn vào (để suy mốc khi nghiên cứu không đặt mốc).
function inclusionDrugConditions(selection) {
  return (selection?.conditions || []).filter(c => !c.exclude && ['active_ingredient', 'drug_item'].includes(String(c.virtual_kind || '')));
}

function loadRunContext(runDir, selection) {
  if (!runDir || !fs.existsSync(runDir)) return null;
  const notes = readRunTable(runDir, 'clinical_notes');
  const meds = augmentMedicationRowsForResearch(readRunTable(runDir, 'medication_orders'), notes);
  const anchors = {};
  for (const row of readRunTable(runDir, 'analysis_selected')) {
    const code = researchCode(row);
    if (code && row.anchor_datetime && !anchors[code]) anchors[code] = row.anchor_datetime;
  }
  return {
    analysis: groupByCode(readRunTable(runDir, 'analysis_ready')),
    encounters: groupByCode(readRunTable(runDir, 'encounters')),
    diagnoses: groupByCode(readRunTable(runDir, 'diagnoses')),
    labs: groupByCode(readRunTable(runDir, 'lab_results')),
    meds: groupByCode(meds),
    anchors,
    drugConditions: inclusionDrugConditions(selection),
  };
}

function anchorFor(code, ctx, manual = '') {
  if (manual) return { time: parseTime(manual), raw: manual, source: 'mốc nhập tay', clock: true };
  if (ctx.anchors[code]) return { time: parseTime(ctx.anchors[code]), raw: ctx.anchors[code], source: 'mốc tự động', clock: hasClock(ctx.anchors[code]) };
  let best = null;
  for (const row of ctx.meds.get(code) || []) {
    if (!ctx.drugConditions.some(c => virtualVariableMatches(row, c))) continue;
    const raw = getCell(row, ['order_datetime', 'order_date']);
    const t = parseTime(raw);
    if (Number.isFinite(t) && (!best || t < best.time)) best = { time: t, raw, source: 'y lệnh thuốc sớm nhất', clock: hasClock(raw) };
  }
  return best || { time: NaN, raw: '', source: '', clock: false };
}

function computeOne(key, code, ctx, anchor) {
  const first = (ctx.analysis.get(code) || [])[0] || {};
  const enc = (ctx.encounters.get(code) || [])[0] || {};
  const dx = ctx.diagnoses.get(code) || [];
  const meds = ctx.meds.get(code) || [];
  const icds = dx.map(r => String(getCell(r, ['icd_code']) || '').toUpperCase().replace(/\s+/g, '')).filter(Boolean);
  const icdHit = re => icds.filter(c => re.test(c));
  const hasA = Number.isFinite(anchor.time);

  if (key === 'birth_year') {
    const v = getCell(first, ['birth_year']) || String(getCell(first, ['birth_date']) || '').slice(0, 4);
    return /^\d{4}$/.test(v) ? { value: v, source: 'hồ sơ EMR' } : null;
  }
  if (key === 'sex') {
    const s = plain(getCell(first, ['sex']) || getCell(enc, ['sex']));
    const v = /^n(u|ữ)|female|^f$/.test(s) ? 'Nữ' : /^nam|male|^m$/.test(s) ? 'Nam' : '';
    return v ? { value: v, source: 'hồ sơ EMR' } : null;
  }
  if (key === 'department') {
    const v = getCell(enc, ['department']) || getCell(first, ['department']);
    return v ? { value: v, source: 'đợt điều trị EMR' } : null;
  }
  if (key in ICD) {
    if (!dx.length) return null;
    const hits = icdHit(ICD[key].re);
    return { value: hits.length ? '1' : '0', source: hits.length ? `ICD ${hits.join(', ')}` : 'không có mã ICD tương ứng' };
  }
  if (key === 'osteo_dx') {
    const severe = icdHit(/^M80/).concat(icdHit(/^M8[12]/).length ? icdHit(ICD.fracture.re) : []);
    const primary = icdHit(/^M8[12]/);
    if (severe.length) return { value: OSTEO_SEVERE, source: `ICD ${[...new Set([...severe, ...primary])].join(', ')}` };
    if (primary.length) return { value: OSTEO_PRIMARY, source: `ICD ${primary.join(', ')}` };
    return null;
  }
  if (key === 'statin') {
    if (!meds.length) return null;
    const hits = [...new Set(meds.filter(r => STATIN.test(plain([getCell(r, ['drug_name_raw']), getCell(r, ['active_ingredient'])].join(' ')))).map(r => getCell(r, ['drug_name_raw'])))];
    return { value: hits.length ? '1' : '0', source: hits.length ? `y lệnh: ${hits.slice(0, 3).join('; ')}` : 'không có y lệnh statin trong đợt' };
  }
  if (key === 'analgesic_3d' || key === 'analgesic_3d_names') {
    if (!hasA || !meds.length) return null;
    // "Trong vòng 3 ngày trước khi truyền": ngày -3 đến -1 so với ngày truyền (không tính thuốc dự phòng cùng ngày).
    const day0 = startOfDay(anchor.time);
    const hits = meds.filter(r => {
      const t = eventTimeOf(r);
      return Number.isFinite(t) && t >= day0 - 3 * DAY && t < day0
        && ANALGESIC.test(plain([getCell(r, ['drug_name_raw']), getCell(r, ['active_ingredient'])].join(' ')));
    });
    const names = [...new Set(hits.map(r => getCell(r, ['drug_name_raw'])).filter(Boolean))];
    if (key === 'analgesic_3d_names') return names.length ? { value: names.slice(0, 6).join('; '), source: 'y lệnh 3 ngày trước truyền' } : null;
    return { value: names.length ? '1' : '0', source: names.length ? `y lệnh ${fmtDay(day0 - 3 * DAY)}–${fmtDay(day0 - DAY)}` : 'không có y lệnh NSAID/corticoid/paracetamol 3 ngày trước truyền' };
  }
  if (key === 'infusion_session') {
    if (!hasA || !anchor.clock) return null;
    const h = new Date(anchor.time).getHours();
    return { value: h < 12 ? 'Sáng (trước 12h)' : 'Chiều (sau 12h)', source: `${anchor.source} ${String(anchor.raw).slice(0, 16)}` };
  }
  if (key in LAB_RULES || key === 'lab_vitd_date') {
    if (!hasA) return null;
    const rule = LAB_RULES[key === 'lab_vitd_date' ? 'lab_vitd' : key];
    // XN trong vòng 14 ngày trước truyền (tính cả ngày truyền tới thời điểm mốc), lấy kết quả gần mốc nhất.
    const from = startOfDay(anchor.time) - 14 * DAY;
    const to = anchor.clock ? anchor.time : startOfDay(anchor.time) + DAY - 1;
    let best = null;
    for (const r of ctx.labs.get(code) || []) {
      const name = plain([getCell(r, ['test_name_raw']), getCell(r, ['test_name_norm']), getCell(r, ['unit'])].join(' '));
      if (!rule.test(name)) continue;
      const t = eventTimeOf(r);
      if (!Number.isFinite(t) || t < from || t > to) continue;
      const v = getCell(r, ['result_num']) || getCell(r, ['result_raw']);
      if (!v) continue;
      if (!best || t > best.t) best = { t, v, raw: getCell(r, ['test_name_raw']) };
    }
    if (!best) return null;
    if (key === 'lab_vitd_date') return { value: isoDay(best.t), source: `${best.raw} ngày ${fmtDay(best.t)}` };
    return { value: String(best.v).replace(',', '.'), source: `${best.raw} ngày ${fmtDay(best.t)}` };
  }
  return null;
}

// { [Mã NC]: { anchor: {...}, values: { [fieldId]: { value, source } } } } cho các trường có `auto`.
function computeAutoValues({ runDir, form, entries = {}, codes = [], selection = null }) {
  const autoFields = (form?.fields || []).filter(f => !f.timepoint && f.auto && AUTO_KEYS.has(f.auto));
  const ctx = autoFields.length ? loadRunContext(runDir, selection) : null;
  const out = {};
  if (!ctx) return out;
  for (const code of codes) {
    const anchor = anchorFor(code, ctx, entries[code]?.anchor_at || '');
    const values = {};
    for (const field of autoFields) {
      let v = null;
      try { v = computeOne(field.auto, code, ctx, anchor); } catch { v = null; }
      if (!v || v.value === '' || v.value == null) continue;
      if (field.type === 'choice' && !(field.options || []).includes(v.value)) continue;
      if (field.type === 'number' && !Number.isFinite(Number(v.value))) continue;
      values[field.id] = v;
    }
    out[code] = { anchor: Number.isFinite(anchor.time) ? { at: anchor.raw, source: anchor.source } : null, values };
  }
  return out;
}

module.exports = { AUTO_KEYS, computeAutoValues, LAB_RULES, parseTime };
