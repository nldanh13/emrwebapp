#!/usr/bin/env node
'use strict';

// relatedRows dùng chỉ mục (mã đợt / Mã NC / Mã BN) phải cho ĐÚNG kết quả và thứ tự như cách
// quét toàn bảng cũ, với mọi kiểu dòng: có/không mã đợt, có/không Mã NC, sai Mã BN, ngoài
// khoảng ngày. Kèm kiểm tra tốc độ: 3.000 lượt × 30 dòng XN phải xong trong vài giây.
// Chạy: node scripts/research_related_rows_index_test.js

const assert = require('assert');
const vs = require('../server/research/variable_selection');

let passed = 0;
function test(name, fn) {
  try { fn(); passed += 1; console.log(`  ok - ${name}`); } catch (err) { console.error(`  FAIL - ${name}`); console.error(err); process.exitCode = 1; }
}

// Bản cũ (quét toàn bảng), giữ nguyên để đối chiếu.
function eventTime(row) { return vs.getCell(row, ['lab_datetime', 'order_datetime', 'lab_date', 'order_date', 'date']); }
function timeInsideEncounter(value, admission, discharge) {
  const t = vs.coerceComparable(value).time; const a = vs.coerceComparable(admission).time; const d = vs.coerceComparable(discharge).time;
  if (!Number.isFinite(t) || !Number.isFinite(a)) return false;
  const end = Number.isFinite(d) ? d : a + 60 * 86400000;
  return t >= a - 86400000 && t <= end + 86400000;
}
function relatedRowsOld(list, identity) {
  const pc = String(identity.patient_code || '').trim(); const rc = String(identity.research_code || '').trim(); const eid = String(identity.encounter_id || '').trim();
  return list.filter(row => {
    const rowEid = vs.getCell(row, ['encounter_id', 'visit_id']); const rowRc = vs.researchCode(row); const rowPc = vs.patientCode(row);
    if (eid && rowEid) return rowEid === eid;
    if (rowEid) return false;
    if (pc) {
      if (rowPc !== pc) return false;
      const ev = eventTime(row); return Boolean(ev && timeInsideEncounter(ev, identity.admission_date, identity.discharge_date));
    }
    if (rc && rowRc === rc) {
      const candidates = list.filter(item => vs.researchCode(item) === rc);
      const patientCodes = new Set(candidates.map(vs.patientCode).filter(Boolean));
      if (patientCodes.size > 1) return false;
      const ev = eventTime(row); return Boolean(ev && timeInsideEncounter(ev, identity.admission_date, identity.discharge_date));
    }
    return false;
  }).filter(row => {
    const status = String(row?.encounter_match_status || '').trim();
    if (status && status !== 'matched') return false;
    return !Object.prototype.hasOwnProperty.call(row || {}, 'is_within_encounter') || String(row.is_within_encounter || '').trim() === '1';
  });
}

test('Mã BN và khoảng ngày được ưu tiên; Mã NC trùng không kéo dữ liệu từ người bệnh khác', () => {
  const rows = [
    { patient_code: 'BN1', research_code: 'NC-SHARED', encounter_id: 'e1', lab_datetime: '2026-03-03', test_name_norm: 'wbc' },
    { patient_code: 'BN2', research_code: 'NC-SHARED', encounter_id: '', lab_datetime: '2026-03-03', test_name_norm: 'hb' },
    { patient_code: 'BN1', research_code: 'NC-OLD', encounter_id: '', lab_datetime: '2025-01-03', test_name_norm: 'crp' },
    { patient_code: 'BN1', research_code: '', encounter_id: '', lab_datetime: '2026-03-04', test_name_norm: 'plt' },
  ];
  const identity = { patient_code: 'BN1', research_code: 'NC-SHARED', encounter_id: 'e1', admission_date: '2026-03-01', discharge_date: '2026-03-10' };
  assert.deepStrictEqual(vs.relatedRows(rows, identity), [rows[0], rows[3]]);
  const noEncounter = { ...identity, encounter_id: '' };
  assert.deepStrictEqual(vs.relatedRows(rows, noEncounter), [rows[3]], 'dùng Mã BN và khoảng ngày, bỏ Mã NC ngoài đợt');
});
 
let seed = 42;
const rand = n => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
const pick = arr => arr[rand(arr.length)];

test('kết quả và thứ tự giống hệt bản quét toàn bảng (2.000 tình huống ngẫu nhiên)', () => {
  const rows = [];
  for (let i = 0; i < 3000; i += 1) {
    rows.push({
      encounter_id: pick(['', '', 'e1', 'e2', 'e3', 'e4']),
      research_code: pick(['', '', 'NC1', 'NC2', 'NC3']),
      patient_code: pick(['', 'BN1', 'BN2', 'BN3']),
      lab_datetime: pick(['', '2026-03-01 07:00', '2026-03-05 07:00', '2026-04-20 07:00', '2025-12-01 07:00']),
    });
  }
  for (let k = 0; k < 2000; k += 1) {
    const identity = {
      encounter_id: pick(['', 'e1', 'e2', 'e9']), research_code: pick(['', 'NC1', 'NC2', 'NC9']), patient_code: pick(['', 'BN1', 'BN2']),
      admission_date: pick(['2026-03-01', '', '01/03/2026']), discharge_date: pick(['2026-03-10', '']),
    };
    assert.deepStrictEqual(vs.relatedRows(rows, identity), relatedRowsOld(rows, identity), JSON.stringify(identity));
  }
});

test('tốc độ: 3.000 lượt × 30 dòng XN, 3 biến XN, 1 điều kiện — dưới 5 giây', () => {
  const analysis = []; const labs = []; const meds = [];
  for (let i = 0; i < 3000; i += 1) {
    analysis.push({ research_code: `NC${i}`, encounter_id: `e${i}`, patient_code: `BN${i}`, admission_date: '2026-03-01', discharge_date: '2026-03-08' });
    for (let k = 0; k < 30; k += 1) labs.push({ encounter_id: `e${i}`, research_code: `NC${i}`, patient_code: `BN${i}`, lab_datetime: `2026-03-0${1 + (k % 7)} 07:00`, test_name_norm: ['wbc', 'hb', 'crp'][k % 3], result_num: String(k) });
    meds.push({ encounter_id: `e${i}`, research_code: `NC${i}`, patient_code: `BN${i}`, order_datetime: '2026-03-03 09:00', drug_name_norm: i % 2 ? 'zoledronic acid' : 'paracetamol' });
  }
  const selection = {
    anchor: { kind: 'drug', drug: 'zoledronic' },
    selected_variables: ['wbc', 'hb', 'crp'].map(t => ({ id: `lab:${t}`, table: 'lab_results', name: `lab:${t}`, virtual_kind: 'lab_test', source_filter: { test_name_norm: t }, aggregation: 'closest_before_anchor' })),
    conditions: [{ variable_id: 'drug:z', table: 'medication_orders', name: 'drug:zoledronic', virtual_kind: 'drug_item', operator: 'not_empty' }],
  };
  const tables = { lab_results: labs, medication_orders: meds };
  const started = Date.now();
  const cohort = vs.filterCohortRowsByVariableSelection(analysis, selection, tables);
  const ds = vs.buildSelectedAnalysisDataset(cohort.rows, selection, tables);
  const ms = Date.now() - started;
  assert.strictEqual(ds.rows.length, 1500);
  assert.ok(ms < 5000, `mất ${ms} ms`);
  console.log(`    (3.000 lượt, 90.000 dòng XN: ${ms} ms)`);
});

console.log(`${passed} test(s) passed`);
