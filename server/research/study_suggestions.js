'use strict';

// Gợi ý đề tài từ chính dữ liệu đang có trong kho, cho người mới bắt đầu chưa biết nghiên cứu
// gì / chọn biến gì. Không dùng AI bên ngoài: dữ liệu người bệnh không rời máy chủ.
//   1. Tìm nhóm người bệnh đủ lớn: theo chẩn đoán (ICD 3 ký tự, không có ICD thì theo chẩn
//      đoán chữ), theo phẫu thuật/thủ thuật, theo thuốc.
//   2. Đo dữ liệu có sẵn của nhóm: % lượt có xét nghiệm/CĐHA/phẫu thuật/thuốc, xét nghiệm
//      nào phổ biến trong nhóm.
//   3. Dựng đề tài theo mẫu thiết kế (mô tả; yếu tố liên quan đến ngày nằm viện; thay đổi xét
//      nghiệm trước–sau dùng thuốc), kèm sẵn biến, điều kiện chọn mẫu, mốc thời gian.
// Đây là gợi ý theo dữ liệu, không thay đánh giá khoa học của nghiên cứu viên.

const fs = require('fs');
const path = require('path');
const { getCell, readCsvTable } = require('./table_io');
const { normalizeToken } = require('./encounter_context');
const { normalizeLabName } = require('./value_normalizers');
const { buildVariableCatalog, VARIABLE_CATALOG_MAX_ROWS } = require('./variable_catalog');
const { coerceComparable } = require('./variable_selection');

const MIN_ENCOUNTERS = Math.max(5, Number(process.env.EMR_STUDY_SUGGESTION_MIN_N || 20));
const MAX_SUGGESTIONS = 15;
const cache = new Map();

const encounterKey = row => String(getCell(row, ['encounter_id']) || getCell(row, ['research_code', 'Mã NC']) || '').trim();
const pct = (n, d) => (d ? Math.round((n / d) * 100) : 0);

function readRows(runDir, file) {
  const p = path.join(runDir, file);
  if (!fs.existsSync(p)) return { rows: [], limited: false };
  const t = readCsvTable(p, VARIABLE_CATALOG_MAX_ROWS);
  return { rows: t.rows || [], limited: Boolean(t.limited) };
}

// Gom tập lượt điều trị theo khóa (ICD, phẫu thuật, thuốc...).
function groupEncounters(rows, keyFn) {
  const groups = new Map();
  for (const row of rows) {
    const enc = encounterKey(row);
    if (!enc) continue;
    for (const raw of [].concat(keyFn(row) || [])) {
      const key = String(raw?.key || '').trim();
      if (!key) continue;
      const g = groups.get(key) || { key, label: raw.label, labels: new Map(), encounters: new Set() };
      g.encounters.add(enc);
      if (raw.label) g.labels.set(raw.label, (g.labels.get(raw.label) || 0) + 1);
      groups.set(key, g);
    }
  }
  for (const g of groups.values()) g.label = [...g.labels.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || g.label || g.key;
  return [...groups.values()];
}

function buildIndex(runDir) {
  const analysis = readRows(runDir, 'analysis_ready.csv');
  const diagnoses = readRows(runDir, 'diagnoses.csv');
  const labs = readRows(runDir, 'lab_results.csv');
  const imaging = readRows(runDir, 'imaging_results.csv');
  const surgery = readRows(runDir, 'surgery_results.csv');
  const meds = readRows(runDir, 'medication_orders.csv');
  const sets = { labs: new Set(), imaging: new Set(), surgery: new Set(), meds: new Set() };
  const labsByEncounter = new Map();
  const labTimes = new Map(); // encounter → norm → [thời điểm] (cho đề tài trước–sau)
  for (const row of labs.rows) {
    const enc = encounterKey(row);
    if (!enc) continue;
    sets.labs.add(enc);
    const norm = getCell(row, ['test_name_norm']) || normalizeLabName(getCell(row, ['test_name_raw']));
    if (!norm) continue;
    if (!labsByEncounter.has(enc)) labsByEncounter.set(enc, new Set());
    labsByEncounter.get(enc).add(norm);
    const t = coerceComparable(getCell(row, ['lab_datetime', 'lab_date'])).time;
    if (Number.isFinite(t)) {
      if (!labTimes.has(enc)) labTimes.set(enc, new Map());
      const m = labTimes.get(enc);
      if (!m.has(norm)) m.set(norm, []);
      m.get(norm).push(t);
    }
  }
  for (const row of imaging.rows) { const e = encounterKey(row); if (e) sets.imaging.add(e); }
  for (const row of surgery.rows) { const e = encounterKey(row); if (e) sets.surgery.add(e); }
  for (const row of meds.rows) { const e = encounterKey(row); if (e) sets.meds.add(e); }
  const patientOf = new Map(analysis.rows.map(r => [encounterKey(r), String(getCell(r, ['patient_key', 'patient_code']) || '')]));
  return {
    analysis, diagnoses, surgery, meds, sets, labsByEncounter, labTimes, patientOf,
    limited: [analysis, diagnoses, labs, imaging, surgery, meds].some(t => t.limited),
  };
}

function cohortStats(index, encounters) {
  const n = encounters.size;
  const count = set => [...encounters].filter(e => set.has(e)).length;
  const labCounts = new Map();
  for (const e of encounters) for (const lab of index.labsByEncounter.get(e) || []) labCounts.set(lab, (labCounts.get(lab) || 0) + 1);
  return {
    encounters: n,
    patients: new Set([...encounters].map(e => index.patientOf.get(e)).filter(Boolean)).size || n,
    with_labs: pct(count(index.sets.labs), n),
    with_imaging: pct(count(index.sets.imaging), n),
    with_surgery: pct(count(index.sets.surgery), n),
    with_meds: pct(count(index.sets.meds), n),
    // Xét nghiệm có ở ≥ 40% lượt của nhóm, nhiều nhất trước.
    common_labs: [...labCounts.entries()].filter(([, c]) => c / n >= 0.4).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([norm, c]) => ({ norm, pct: pct(c, n) })),
  };
}

// Xét nghiệm có giá trị CẢ trong 14 ngày trước VÀ trong ngày 1–14 sau lần đầu dùng thuốc,
// ở ≥ 40% lượt của nhóm. Chỉ những xét nghiệm này mới so sánh trước–sau được.
function labsAroundDrug(index, encounters, drugNeedle) {
  const DAY = 86400000;
  const anchorOf = new Map();
  for (const r of index.meds.rows) {
    const enc = encounterKey(r);
    if (!encounters.has(enc)) continue;
    const hay = normalizeToken([getCell(r, ['active_ingredient']), getCell(r, ['drug_name_norm']), getCell(r, ['drug_name_raw'])].join(' '));
    if (!hay.includes(drugNeedle)) continue;
    const t = coerceComparable(getCell(r, ['order_datetime', 'order_date'])).time;
    if (Number.isFinite(t) && (!anchorOf.has(enc) || t < anchorOf.get(enc))) anchorOf.set(enc, t);
  }
  const counts = new Map();
  for (const [enc, anchor] of anchorOf) {
    for (const [norm, times] of index.labTimes.get(enc) || []) {
      const before = times.some(t => t <= anchor && t >= anchor - 14 * DAY);
      const after = times.some(t => t > anchor && t <= anchor + 15 * DAY);
      if (before && after) counts.set(norm, (counts.get(norm) || 0) + 1);
    }
  }
  const n = encounters.size || 1;
  return [...counts.entries()].filter(([, c]) => c / n >= 0.4).sort((a, b) => b[1] - a[1]).map(([norm, c]) => ({ norm, pct: pct(c, n) }));
}

function catalogIndex(catalog) {
  const byId = new Map();
  const labByNorm = new Map();
  for (const group of catalog.groups || []) {
    for (const v of group.variables || []) {
      byId.set(v.id, v);
      const norm = v.source_filter?.test_name_norm;
      if (v.table === 'lab_results' && norm && (!labByNorm.has(norm) || v.nonempty > labByNorm.get(norm).nonempty)) labByNorm.set(norm, v);
    }
  }
  return { byId, labByNorm };
}

const CORE = [
  ['analysis_ready.age', 'Tuổi'], ['analysis_ready.sex', 'Giới'], ['analysis_ready.admission_date', 'Ngày vào viện'],
  ['analysis_ready.discharge_date', 'Ngày ra viện'], ['analysis_ready.hospital_stay_days', 'Số ngày nằm viện'],
  ['analysis_ready.diagnosis_raw', 'Chẩn đoán'], ['analysis_ready.comorbidity_text', 'Bệnh kèm'],
];

function buildStudySuggestions(runDir) {
  const manifest = path.join(runDir, 'manifest.json');
  const stamp = fs.existsSync(manifest) ? fs.statSync(manifest).mtimeMs : 0;
  const cached = cache.get(runDir);
  if (cached && cached.stamp === stamp) return cached.value;

  const catalog = buildVariableCatalog(runDir);
  const cat = catalogIndex(catalog);
  const index = buildIndex(runDir);
  const total = index.analysis.rows.length;
  const has = id => cat.byId.has(id);
  const v = (id, extra = {}) => (has(id) ? { id, ...extra } : null);
  const core = () => CORE.map(([id, label]) => v(id, { survey_label: label })).filter(Boolean);
  const labVars = (stats, extra) => stats.common_labs.map(l => cat.labByNorm.get(l.norm)).filter(Boolean).slice(0, 6)
    .map(lab => ({ id: lab.id, survey_label: String(lab.label || '').replace(/\s*\(.*\)\s*$/, ''), ...extra }));

  // ── Nhóm người bệnh ứng viên ──
  const cohorts = [];
  const hasIcd = index.diagnoses.rows.some(r => getCell(r, ['icd_code']));
  if (hasIcd && has('diagnoses.icd_code')) {
    for (const g of groupEncounters(index.diagnoses.rows, row => {
      const code = String(getCell(row, ['icd_code']) || '').trim().toUpperCase().slice(0, 3);
      return /^[A-Z]\d{2}$/.test(code) ? { key: code, label: String(getCell(row, ['diagnosis_text']) || code).slice(0, 80) } : null;
    })) {
      cohorts.push({ kind: 'diagnosis', key: `dx:${g.key}`, label: `${g.label} (${g.key})`, encounters: g.encounters,
        condition: { variable_id: 'diagnoses.icd_code', operator: 'starts_with', value: g.key } });
    }
  } else if (has('analysis_ready.diagnosis_raw')) {
    // Không có ICD: gom theo chẩn đoán chữ (phần đầu, trước dấu ; hoặc ,).
    for (const g of groupEncounters(index.analysis.rows, row => {
      const text = String(getCell(row, ['diagnosis_raw']) || '').split(/[;,(]/)[0].trim();
      return text.length >= 4 ? { key: normalizeToken(text), label: text.slice(0, 80) } : null;
    })) {
      cohorts.push({ kind: 'diagnosis', key: `dxt:${g.key}`, label: g.label, encounters: g.encounters,
        condition: { variable_id: 'analysis_ready.diagnosis_raw', operator: 'contains', value: g.label } });
    }
  }
  for (const vv of cat.byId.values()) {
    if (vv.virtual_kind !== 'procedure_item' && vv.virtual_kind !== 'drug_item') continue;
    const rows = vv.virtual_kind === 'procedure_item' ? index.surgery.rows : index.meds.rows;
    const needle = normalizeToken(String(vv.name || '').split(':').slice(1).join(':'));
    if (!needle) continue;
    const enc = new Set(rows.filter(r => {
      const hay = normalizeToken(vv.virtual_kind === 'procedure_item'
        ? [getCell(r, ['surgery_method']), getCell(r, ['surgery_name'])].join(' ')
        : [getCell(r, ['active_ingredient']), getCell(r, ['drug_name_norm']), getCell(r, ['drug_name_raw'])].join(' '));
      return hay.includes(needle);
    }).map(encounterKey).filter(Boolean));
    const label = String(vv.name).split(':').slice(1).join(':');
    cohorts.push({ kind: vv.virtual_kind === 'procedure_item' ? 'procedure' : 'drug', key: vv.id, label, encounters: enc, drug: label,
      condition: { variable_id: vv.id, operator: 'not_empty', value: '' } });
  }

  // ── Đề tài theo mẫu thiết kế ──
  const suggestions = [];
  for (const c of cohorts) {
    if (c.encounters.size < MIN_ENCOUNTERS) continue;
    const stats = cohortStats(index, c.encounters);
    const reasons = [`${stats.encounters} lượt điều trị (${stats.patients} người bệnh) trong kho`];
    if (stats.common_labs.length) reasons.push(`${stats.common_labs.length} xét nghiệm có ở ≥ 40% lượt`);
    const base = { cohort_kind: c.kind, cohort_label: c.label, stats, conditions: [c.condition] };
    const subject = c.kind === 'procedure' ? `người bệnh được ${c.label}` : c.kind === 'drug' ? `người bệnh dùng ${c.label}` : `người bệnh ${c.label}`;

    if (c.kind !== 'drug') {
      suggestions.push({ ...base, design: 'describe', design_label: 'Mô tả',
        title: `Đặc điểm lâm sàng, cận lâm sàng và kết quả điều trị ${subject}`,
        outcome: 'Số ngày nằm viện, tình trạng ra viện',
        variables: [...core(), ...labVars(stats, { aggregation: 'first' }),
          ...(stats.with_surgery >= 30 ? [v('analysis_ready.surgery_method', { survey_label: 'Phương pháp phẫu thuật' })] : [])].filter(Boolean),
        reasons, score: stats.encounters * (1 + stats.with_labs / 100) });
    }
    if (stats.with_surgery >= 50 && has('analysis_ready.time_to_surgery_hours')) {
      suggestions.push({ ...base, design: 'risk', design_label: 'Yếu tố liên quan',
        title: `Các yếu tố liên quan đến thời gian nằm viện ở ${subject}${c.kind === 'procedure' ? '' : ' có phẫu thuật'}`,
        outcome: 'Số ngày nằm viện',
        variables: [...core(), v('analysis_ready.time_to_surgery_hours', { survey_label: 'Số giờ chờ mổ' }),
          v('analysis_ready.anesthesia_method', { survey_label: 'Phương pháp vô cảm' }),
          ...labVars(stats, { aggregation: 'closest_before_surgery' }).map(x => ({ ...x, survey_label: `${x.survey_label} trước mổ` }))].filter(Boolean),
        reasons: [...reasons, `${stats.with_surgery}% lượt có phẫu thuật`], score: stats.encounters * (stats.with_surgery / 100) * 0.9 });
    }
    const pairedLabs = c.kind === 'drug' ? labsAroundDrug(index, c.encounters, normalizeToken(c.label)) : [];
    if (c.kind === 'drug' && pairedLabs.length) {
      const labs = labVars({ common_labs: pairedLabs }, {}).slice(0, 4);
      suggestions.push({ ...base, design: 'before_after', design_label: 'Trước – sau',
        title: `Thay đổi ${labs.map(l => l.survey_label).slice(0, 2).join(', ')} trước và sau dùng ${c.label}`,
        outcome: 'Chênh lệch xét nghiệm sau – trước dùng thuốc',
        anchor: { kind: 'drug', drug: c.label },
        variables: [...core().slice(0, 5),
          ...labs.map(l => ({ ...l, aggregation: 'closest_before_anchor', window_from_days: -14, window_to_days: 0, survey_label: `${l.survey_label} trước dùng thuốc` })),
          ...labs.map(l => ({ ...l, aggregation: 'closest_after_anchor', window_from_days: 1, window_to_days: 14, survey_label: `${l.survey_label} sau dùng thuốc` }))],
        reasons: [...reasons, `${pairedLabs.length} xét nghiệm có cả trước và sau dùng thuốc ở ≥ 40% lượt`], score: stats.encounters * (stats.with_labs / 100) * 0.8 });
    }
  }

  // Vai trò biến và cách tính cỡ mẫu gợi ý theo thiết kế, để người mới biết biến nào là biến chính.
  for (const sg of suggestions) {
    const role = (x) => {
      if (sg.design === 'before_after') {
        // Kết cục chính là chênh lệch sau – trước của xét nghiệm đầu tiên: cả hai lần đo đều là biến chính.
        if (x.aggregation && x.id === sg.variables.find(y => y.aggregation === 'closest_before_anchor')?.id) return 'primary_outcome';
        return x.aggregation ? 'secondary_outcome' : 'descriptive';
      }
      if (x.id === 'analysis_ready.hospital_stay_days') return 'primary_outcome';
      if (sg.design === 'risk') {
        if (['analysis_ready.time_to_surgery_hours', 'analysis_ready.anesthesia_method'].includes(x.id)) return 'exposure';
        if (['analysis_ready.age', 'analysis_ready.sex', 'analysis_ready.comorbidity_text'].includes(x.id) || x.aggregation) return 'covariate';
      }
      return 'descriptive';
    };
    sg.variables = sg.variables.map(x => ({ ...x, role: role(x) }));
    sg.sample_size_design = sg.design === 'before_after' ? 'paired_means' : sg.design === 'risk' ? 'correlation' : 'mean_one';
  }

  // Một nhóm tối đa 2 đề tài; ưu tiên nhóm lớn và đủ dữ liệu.
  const perCohort = new Map();
  const picked = suggestions.sort((a, b) => b.score - a.score).filter(s => {
    const k = s.cohort_label;
    perCohort.set(k, (perCohort.get(k) || 0) + 1);
    return perCohort.get(k) <= 2;
  }).slice(0, MAX_SUGGESTIONS).map((s, i) => {
    const { score, ...rest } = s;
    // Mỗi biến chỉ xuất hiện một lần theo cách lấy + cửa sổ.
    const seen = new Set();
    rest.variables = rest.variables.filter(x => { const k = `${x.id}|${x.aggregation || ''}|${x.window_from_days ?? ''}`; if (seen.has(k)) return false; seen.add(k); return true; });
    return { id: `s${i + 1}`, ...rest };
  });

  const value = { run_id: path.basename(runDir), total_encounters: total, min_encounters: MIN_ENCOUNTERS, sampled: index.limited, suggestions: picked };
  cache.set(runDir, { stamp, value });
  return value;
}

module.exports = { buildStudySuggestions };
