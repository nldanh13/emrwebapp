#!/usr/bin/env node
'use strict';

// Gợi ý đề tài từ dữ liệu kho: tìm nhóm đủ lớn (ICD, phẫu thuật, thuốc), dựng đề tài kèm biến
// và điều kiện có thật trong danh mục; nhóm quá nhỏ không được gợi ý; gợi ý chạy được qua bước
// thống kê (summarizeSelectionForRun) như người dùng bấm "Dùng gợi ý này".
// Chạy: node scripts/research_study_suggestions_test.js

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.EMR_RUNTIME_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'research_study_suggestions_test_'));
process.env.EMR_STUDY_SUGGESTION_MIN_N = '10';
const { buildStudySuggestions } = require('../server/research/study_suggestions');
const { buildVariableCatalog } = require('../server/research/variable_catalog');
const { summarizeSelectionForRun } = require('../server/research/selection_runtime');
const { writeCsv } = require('../server/research/table_io');

let passed = 0;
function test(name, fn) {
  try { fn(); passed += 1; console.log(`  ok - ${name}`); } catch (err) { console.error(`  FAIL - ${name}`); console.error(err); process.exitCode = 1; }
}

const runDir = path.join(process.env.EMR_RUNTIME_ROOT, 'run');
fs.mkdirSync(runDir, { recursive: true });
fs.writeFileSync(path.join(runDir, 'manifest.json'), '{}');
const analysis = []; const dx = []; const labs = []; const surg = []; const meds = [];
for (let i = 0; i < 40; i += 1) {
  const enc = `e${i}`; const code = `NC${i}`;
  const osteo = i < 24; // 24 lượt loãng xương (M81), 16 lượt gãy xương đùi (S72) có mổ
  analysis.push({ research_code: code, encounter_id: enc, patient_key: `P${i % 35}`, age: String(50 + (i % 30)), sex: i % 2 ? 'Nam' : 'Nữ',
    admission_date: '2026-03-01', discharge_date: '2026-03-06', hospital_stay_days: String(3 + (i % 6)), diagnosis_raw: osteo ? 'Loãng xương' : 'Gãy cổ xương đùi',
    comorbidity_text: '', time_to_surgery_hours: osteo ? '' : '20', surgery_method: osteo ? '' : 'Thay khớp háng', anesthesia_method: osteo ? '' : 'Tê tủy sống' });
  dx.push({ encounter_id: enc, research_code: code, icd_code: osteo ? 'M81.0' : 'S72.0', diagnosis_text: osteo ? 'Loãng xương sau mãn kinh' : 'Gãy cổ xương đùi' });
  labs.push({ encounter_id: enc, research_code: code, lab_datetime: '2026-03-02 07:00', test_name_raw: 'Canxi ion', test_name_norm: 'canxi ion', result_num: '1.1', unit: 'mmol/L' });
  labs.push({ encounter_id: enc, research_code: code, lab_datetime: '2026-03-04 07:00', test_name_raw: 'Canxi ion', test_name_norm: 'canxi ion', result_num: '1.0', unit: 'mmol/L' });
  // WBC chỉ đo trước khi truyền: không so sánh trước–sau được.
  labs.push({ encounter_id: enc, research_code: code, lab_datetime: '2026-03-02 08:00', test_name_raw: 'WBC', test_name_norm: 'wbc', result_num: '7', unit: 'G/L' });
  if (osteo) meds.push({ encounter_id: enc, research_code: code, order_datetime: '2026-03-03 09:00', drug_name_raw: 'Zoledronic acid 5mg', drug_name_norm: 'zoledronic acid', active_ingredient: 'Zoledronic acid' });
  else surg.push({ encounter_id: enc, research_code: code, surgery_date: '2026-03-02', surgery_method: 'Thay khớp háng', surgery_name: 'Thay khớp háng' });
}
writeCsv(path.join(runDir, 'analysis_ready.csv'), Object.keys(analysis[0]), analysis);
writeCsv(path.join(runDir, 'diagnoses.csv'), Object.keys(dx[0]), dx);
writeCsv(path.join(runDir, 'lab_results.csv'), Object.keys(labs[0]), labs);
writeCsv(path.join(runDir, 'surgery_results.csv'), Object.keys(surg[0]), surg);
writeCsv(path.join(runDir, 'medication_orders.csv'), Object.keys(meds[0]), meds);

const result = buildStudySuggestions(runDir);
const ids = new Set(buildVariableCatalog(runDir).groups.flatMap(g => g.variables.map(v => v.id)));

test('gợi ý nhóm theo ICD, phẫu thuật và thuốc; đủ 3 kiểu thiết kế', () => {
  const labels = result.suggestions.map(s => `${s.design}:${s.cohort_label}`);
  assert.ok(labels.some(l => l.startsWith('describe:') && l.includes('(M81)')), labels.join(' | '));
  assert.ok(labels.some(l => l.startsWith('risk:')), 'có đề tài yếu tố liên quan (nhóm có mổ)');
  assert.ok(labels.some(l => l.startsWith('before_after:') && /zoledronic/i.test(l)), 'có đề tài trước–sau dùng thuốc');
  const m81 = result.suggestions.find(s => s.cohort_label.includes('(M81)'));
  assert.strictEqual(m81.stats.encounters, 24);
  assert.strictEqual(m81.stats.with_labs, 100);
  assert.deepStrictEqual(m81.conditions, [{ variable_id: 'diagnoses.icd_code', operator: 'starts_with', value: 'M81' }]);
});

test('mọi biến và điều kiện đều có thật trong danh mục biến', () => {
  for (const s of result.suggestions) {
    for (const v of s.variables) assert.ok(ids.has(v.id), `${s.title}: thiếu biến ${v.id}`);
    for (const c of s.conditions) assert.ok(ids.has(c.variable_id), `${s.title}: thiếu điều kiện ${c.variable_id}`);
  }
});

test('nhóm nhỏ hơn ngưỡng không được gợi ý', () => {
  assert.ok(result.suggestions.every(s => s.stats.encounters >= 10));
});

test('đề tài trước–sau: mốc thuốc, xét nghiệm gần trước/sau mốc; chạy thống kê ra đúng mẫu', () => {
  const s = result.suggestions.find(x => x.design === 'before_after');
  assert.deepStrictEqual(s.anchor, { kind: 'drug', drug: s.cohort_label });
  assert.ok(s.variables.some(v => v.aggregation === 'closest_before_anchor' && v.window_from_days === -14));
  assert.ok(!s.variables.some(v => /wbc/i.test(v.survey_label)), 'WBC chỉ có trước mốc nên không gợi ý so sánh trước–sau');
  const catalog = new Map(buildVariableCatalog(runDir).groups.flatMap(g => g.variables.map(v => [v.id, v])));
  const selection = {
    anchor: s.anchor,
    selected_variables: s.variables.map(v => ({ ...catalog.get(v.id), ...v, label: v.survey_label })),
    conditions: s.conditions.map(c => ({ ...c, ...catalog.get(c.variable_id), id: 'c1' })),
  };
  const { summary } = summarizeSelectionForRun(runDir, selection);
  assert.strictEqual(summary.total, 24, 'đúng 24 lượt dùng Zoledronic');
  const before = summary.variables.find(v => /trước dùng thuốc/.test(v.survey_label));
  const after = summary.variables.find(v => /sau dùng thuốc/.test(v.survey_label));
  assert.strictEqual(before.stats.mean, 1.1);
  assert.strictEqual(after.stats.mean, 1);
  // Vai trò: hai lần đo của xét nghiệm đầu tiên là kết cục chính; cỡ mẫu tính theo thiết kế cặp.
  const primary = s.variables.filter(v => v.role === 'primary_outcome');
  assert.strictEqual(primary.length, 2);
  assert.deepStrictEqual(primary.map(v => v.aggregation).sort(), ['closest_after_anchor', 'closest_before_anchor']);
  assert.strictEqual(s.sample_size_design, 'paired_means');
  assert.strictEqual(summary.variables.filter(v => v.role === 'primary_outcome').length, 2);
});

console.log(`${passed} test(s) passed`);
