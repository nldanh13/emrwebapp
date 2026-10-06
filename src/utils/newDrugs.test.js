import { describe, it, expect } from 'vitest';
import { newDrugSummary, prefillFromNewDrug } from './newDrugs.js';

describe('thuốc mới chưa có trong danh mục', () => {
  const d = { key: 'AMIPAREN 10', name: 'AMIPAREN 10%', variants: ['AMIPAREN 10%', 'Amiparen 10% 200ml'], count: 12,
    category: 'dich_truyen', route: 'TTM', form: 'Chai', ingredient: 'Acid amin', volume_ml: 200, last_seen: '2026-10-05' };
  it('điền sẵn form thêm thuốc', () => {
    expect(prefillFromNewDrug(d)).toEqual({ canonical: 'AMIPAREN 10%', aliases: 'Amiparen 10% 200ml', active_ingredients: 'Acid amin',
      category: 'dich_truyen', default_route: 'TTM', default_volume_ml: '200' });
  });
  it('tóm tắt một dòng', () => {
    expect(newDrugSummary(d)).toBe('12 lần · TTM · Chai · hoạt chất: Acid amin · 200 ml · gặp gần nhất 05/10/2026');
  });
});
