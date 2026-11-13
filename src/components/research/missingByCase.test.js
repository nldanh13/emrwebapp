// Danh sách ca thiếu dữ liệu xuất ra CSV: chỉ Mã NC, số biến thiếu, tên biến thiếu, cờ cần xem lại.
import { describe, it, expect } from 'vitest';
import { rowsToCsvText, valueIssuesToCsvText } from './missingByCase.js';

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

describe('valueIssuesToCsvText', () => {
  it('Mã NC, cột, biến, giá trị, lý do; ô có dấu ; được đặt trong nháy', () => {
    const csv = valueIssuesToCsvText([{ research_code: 'NC900', column: 'hb', label: 'Hb', value: '120; 98', reason: 'Nhiều giá trị trong một ô' }]);
    expect(csv.split('\r\n')).toEqual(['ma_nc,cot,bien,gia_tri,ly_do', 'NC900,hb,Hb,"120; 98",Nhiều giá trị trong một ô', '']);
  });
});
