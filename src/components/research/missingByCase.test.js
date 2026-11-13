// Danh sách ca thiếu dữ liệu xuất ra CSV: chỉ Mã NC, số biến thiếu, tên biến thiếu, cờ cần xem lại.
import { describe, it, expect } from 'vitest';
import { rowsToCsvText } from './missingByCase.js';

describe('rowsToCsvText', () => {
  it('mỗi ca một dòng, tên biến nối bằng "; " và được đặt trong nháy', () => {
    const csv = rowsToCsvText([
      { research_code: 'NC2', missing_count: 2, missing: ['Giới tính', 'Tuổi'], needs_review: true },
      { research_code: 'NC3', missing_count: 1, missing: ['Tuổi'], needs_review: false },
    ]);
    expect(csv.split('\r\n')).toEqual([
      'ma_nc,so_bien_thieu,bien_thieu,can_xem_lai',
      'NC2,2,"Giới tính; Tuổi",1',
      'NC3,1,Tuổi,0',
      '',
    ]);
  });
  it('thoát dấu nháy kép trong tên biến', () => {
    expect(rowsToCsvText([{ research_code: 'A', missing_count: 1, missing: ['Đau "nhiều"'] }])).toContain('"Đau ""nhiều"""');
  });
});
