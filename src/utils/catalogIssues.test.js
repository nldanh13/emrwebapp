// Ảnh chụp Danh mục thuốc thật 06/10/2026: lọc "chưa có quy tắc" liệt kê cả chai truyền sẵn; Vinphacine
// 2 ml xếp dịch truyền; NATRI CLORID 0,9% và SODIUM CHLORIDE 0,9% là một.
import { describe, it, expect } from 'vitest';
import { catalogIssues, filterCatalog, isReadyToInfuse } from './catalogIssues.js';

const ITEMS = [
  { canonical: 'THERMODOL', category: 'dich_truyen', default_volume_ml: 100 },
  { canonical: 'MEROVIA 1G', category: 'thuoc_tiem' },
  { canonical: 'BACQURE 500MG + Natri clorid 0.9%', category: 'dich_truyen', default_volume_ml: 100 },
  { canonical: 'VINPHACINE 500mg/2ml', category: 'dich_truyen', default_volume_ml: 2 },
  { canonical: 'NATRI CLORID 0,9%', category: 'dich_truyen', default_volume_ml: 500 },
  { canonical: 'SODIUM CHLORIDE 0,9%', category: 'dich_truyen', default_volume_ml: 500 },
  { canonical: 'CLASTIZOL', category: 'dich_truyen', default_volume_ml: 100, active_ingredients: ['Acid Zoledronic'], dilution: { solvent: 'KHONG_PHA' } },
];
const hasRule = i => Boolean(i.dilution);

describe('bộ lọc Danh mục thuốc', () => {
  it('"chưa có quy tắc" bỏ chai/túi truyền pha sẵn', () => {
    expect(isReadyToInfuse(ITEMS[0])).toBe(true);
    expect(filterCatalog(ITEMS, 'no_rule', { hasRule }).map(i => i.canonical))
      .toEqual(['MEROVIA 1G', 'BACQURE 500MG + Natri clorid 0.9%', 'VINPHACINE 500mg/2ml']);
  });
  it('thiếu hoạt chất', () => {
    expect(filterCatalog(ITEMS, 'no_ingredient').some(i => i.canonical === 'CLASTIZOL')).toBe(false);
  });
  it('có thể sai: mục cũ + dung môi, dịch truyền < 50 ml, trùng NaCl/Sodium chloride', () => {
    expect(catalogIssues(ITEMS[2], ITEMS)[0]).toMatch(/Xem và dọn/);
    expect(catalogIssues(ITEMS[3], ITEMS)[0]).toMatch(/thể tích 2 ml — có phải thuốc tiêm/);
    expect(catalogIssues(ITEMS[4], ITEMS)[0]).toMatch(/Trùng với "SODIUM CHLORIDE 0,9%"/);
    expect(catalogIssues(ITEMS[0], ITEMS)).toEqual([]);
    expect(filterCatalog(ITEMS, 'issues').length).toBe(4);
  });
});
