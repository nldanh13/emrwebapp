#!/usr/bin/env node
'use strict';

// "Dùng hoạt chất: X" trong Tạo nghiên cứu: lấy từ Danh mục thuốc, gộp mọi tên thương mại.
// Chạy: node scripts/research_active_ingredient_condition_test.js

const assert = require('assert');
const vs = require('../server/research/variable_selection');
const { buildVirtualVariablesForTable } = require('../server/research/variable_catalog');
const { augmentMedicationRowsForResearch, ingredientEvidence } = require('../server/research/medication_ingredient_catalog');

let passed = 0;
function test(name, fn) {
  try { fn(); passed += 1; console.log(`  ok - ${name}`); } catch (err) { console.error(`  FAIL - ${name}`); console.error(err); process.exitCode = 1; }
}

const medications = [
  { canonical: 'ACLASTA 5MG/100ML', aliases: ['ACLASTA', 'ZOLEDRONIC ACID 5MG'], active_ingredients: ['Acid Zoledronic'] },
  { canonical: 'ZOMETA 4MG', aliases: ['ZOMETA'], active_ingredient: 'Acid Zoledronic' },
  { canonical: 'FOSAMAX PLUS', aliases: [], active_ingredients: ['Alendronat', 'Cholecalciferol'] },
  { canonical: 'THERMODOL', aliases: ['PARACETAMOL 1G'] },
];
const orders = [
  { encounter_id: 'e1', drug_name_raw: 'Aclasta 5mg/100ml truyền TM', drug_name_norm: 'aclasta' },
  { encounter_id: 'e2', drug_name_raw: 'Zometa 4mg', drug_name_norm: 'zometa' },
  { encounter_id: 'e3', drug_name_raw: 'Fosamax plus 70mg', drug_name_norm: 'fosamax plus' },
  { encounter_id: 'e4', drug_name_raw: 'Thermodol', drug_name_norm: 'thermodol' },
];
const notes = [{ encounter_id: 'e5', order_text: 'Truyền ACLASTA 5MG/100ML chiều nay' }];
const encounters = ['e1', 'e2', 'e3', 'e4', 'e5', 'e6'].map(id => ({ encounter_id: id, research_code: `NC_${id}` }));
const augmented = augmentMedicationRowsForResearch(orders, notes, medications);
const tableDef = { key: 'medication_orders', label: 'Thuốc/y lệnh' };

test('danh mục biến có "Dùng hoạt chất: …" cho mọi hoạt chất đã khai báo, đếm theo mọi tên thương mại', () => {
  const vars = buildVirtualVariablesForTable(tableDef, orders, { ingredientRows: augmented, medications });
  const ing = vars.filter(v => v.virtual_kind === 'active_ingredient');
  assert.deepStrictEqual(ing.map(v => v.label), ['Dùng hoạt chất: Acid Zoledronic', 'Dùng hoạt chất: Alendronat', 'Dùng hoạt chất: Cholecalciferol']);
  const zol = ing[0];
  assert.strictEqual(zol.name, 'ingredient:Acid Zoledronic');
  assert.strictEqual(zol.nonempty, 3); // Aclasta + Zometa + Y lệnh khác
  assert.strictEqual(zol.encounters, 3);
  assert.strictEqual(zol.operators[0], 'not_empty'); // bấm là dùng được, không phải nhập giá trị
  assert.ok(zol.trade_names.includes('ZOMETA 4MG'));
  assert.match(zol.source_note, /Danh mục thuốc/);
  assert.strictEqual(zol.source_filter, undefined);
});

test('hoạt chất khai báo nhưng chưa có trong dữ liệu vẫn hiện, số lượt 0', () => {
  const vars = buildVirtualVariablesForTable(tableDef, [], { ingredientRows: [], medications });
  const zol = vars.find(v => v.name === 'ingredient:Acid Zoledronic');
  assert.ok(zol);
  assert.strictEqual(zol.nonempty, 0);
});

test('điều kiện chọn vào khớp mọi tên thương mại và "Y lệnh khác"; loại trừ đúng', () => {
  const cond = { id: 'c1', variable_id: 'x', table: 'medication_orders', name: 'ingredient:Acid Zoledronic', virtual_kind: 'active_ingredient', operator: 'not_empty' };
  const sel = vs.sanitizeVariableSelection({ conditions: [cond] });
  assert.strictEqual(sel.conditions[0].virtual_kind, 'active_ingredient');
  const inc = vs.filterCohortRowsByVariableSelection(encounters, sel, { medication_orders: augmented }).rows;
  assert.deepStrictEqual(inc.map(r => r.encounter_id), ['e1', 'e2', 'e5']);
  const exc = vs.filterCohortRowsByVariableSelection(encounters, vs.sanitizeVariableSelection({ conditions: [{ ...cond, exclude: true }] }), { medication_orders: augmented }).rows;
  assert.deepStrictEqual(exc.map(r => r.encounter_id), ['e3', 'e4', 'e6']);
});

test('khớp đúng tên hoạt chất, không khớp một phần tên (Acid ≠ Acid Zoledronic)', () => {
  const rows = [{ encounter_id: 'e1', active_ingredient: 'Acid Zoledronic; Calci' }, { encounter_id: 'e2', active_ingredient: 'Acid Folic' }];
  const m = (name) => rows.filter(r => vs.virtualVariableMatches(r, { name, virtual_kind: 'active_ingredient' })).map(r => r.encounter_id);
  assert.deepStrictEqual(m('ingredient:Calci'), ['e1']);
  assert.deepStrictEqual(m('ingredient:Acid'), []);
  assert.deepStrictEqual(m('ingredient:acid zoledronic'), ['e1']);
});

test('dò tên vẫn theo ranh giới từ như trước (ingredientEvidence)', () => {
  assert.deepStrictEqual(ingredientEvidence('Truyền Zometa 4mg', ['Acid Zoledronic'], medications).map(h => h.active_ingredient), ['Acid Zoledronic']);
  assert.deepStrictEqual(ingredientEvidence('Zometab', ['Acid Zoledronic'], medications), []);
});

console.log(`research_active_ingredient_condition_test: ${passed} passed`);
