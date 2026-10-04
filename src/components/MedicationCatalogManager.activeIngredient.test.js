import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../..');

function source(rel) {
  return fs.readFileSync(path.join(repoRoot, rel), 'utf8');
}

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

  it('keeps ingredient mapping generic and supports multiple targets', () => {
    const helper = source('server/research/medication_ingredient_catalog.js');
    expect(helper).toContain('resolveIngredientTargets');
    expect(helper).toContain('activeIngredientsOf');
    expect(helper).toContain('ingredientEvidence');
    expect(helper).not.toContain('Zoledronic');
  });
});
