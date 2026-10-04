import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../..');
const require = createRequire(import.meta.url);
const ingredientCatalog = require(path.join(repoRoot, 'server/research/medication_ingredient_catalog.js'));

function source(rel) {
  return fs.readFileSync(path.join(repoRoot, rel), 'utf8');
}

const catalog = [
  { canonical: 'TRADE-A', aliases: ['TRADE A 5MG'], active_ingredients: ['Ingredient X'] },
  { canonical: 'TRADE-B', aliases: ['TRADE B'], active_ingredients: ['Ingredient X'] },
  { canonical: 'TRADE-C', aliases: ['TRADE C'], active_ingredients: ['Ingredient Y'] },
];

describe('medication catalog active ingredients', () => {
  it('lets the user maintain active ingredients separately from product/trade names', () => {
    const ui = source('src/components/MedicationCatalogManager.jsx');
    expect(ui).toContain('active_ingredients');
    expect(ui).toContain('Hoạt chất');
    expect(ui).toContain('Tên khác / tên thương mại');
  });

  it('persists active ingredients and exposes a generic resolver for research', () => {
    const route = source('server/routes/medication_catalog.js');
    expect(route).toContain('body.active_ingredients');
    expect(route).toContain('/medication-catalog/resolve-active-ingredients');
    expect(route).toContain('resolveIngredientTargets');
  });

  it('resolves one ingredient to every configured trade name and supports multiple ingredients', () => {
    const one = ingredientCatalog.resolveIngredientTargets(['Ingredient X'], catalog);
    expect(one.medication_names).toEqual(expect.arrayContaining(['TRADE-A', 'TRADE A 5MG', 'TRADE-B', 'TRADE B']));
    expect(one.targets[0].catalog_matches).toBe(2);

    const many = ingredientCatalog.resolveIngredientTargets(['Ingredient X', 'Ingredient Y'], catalog);
    expect(many.targets).toHaveLength(2);
    expect(many.medication_names).toContain('TRADE-C');
  });

  it('adds catalog-derived ingredient evidence from medication orders and other orders without changing source rows', () => {
    const medicationRows = [{ encounter_id: 'e1', patient_code: 'p1', drug_name_raw: 'TRADE A 5MG' }];
    const noteRows = [{ encounter_id: 'e2', patient_code: 'p2', note_datetime: '2026-01-01 08:00', order_text: 'Truyền TRADE B theo y lệnh' }];
    const rows = ingredientCatalog.augmentMedicationRowsForResearch(medicationRows, noteRows, catalog);

    const medHit = rows.find(r => r.encounter_id === 'e1' && r.active_ingredient === 'Ingredient X');
    const otherOrderHit = rows.find(r => r.encounter_id === 'e2' && r.active_ingredient === 'Ingredient X');
    expect(medHit?.active_ingredient_source).toBe('medication_catalog');
    expect(otherOrderHit?.source).toBe('clinical_notes_order_text');
    expect(medicationRows[0].active_ingredient).toBeUndefined();
  });

  it('does not make active ingredient names aliases for medication inference', () => {
    const helper = source('server/research/medication_ingredient_catalog.js');
    expect(helper).toContain('activeIngredientsOf');
    expect(helper).toContain('namesOf');
    expect(helper).not.toContain('Zoledronic');
  });
});
