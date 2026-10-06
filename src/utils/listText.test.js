// Lỗi thật 06/10/2026: tên khác "NATRI CLORID 0,9%" bị lưu thành "NATRI CLORID 0" và "9%".
import { describe, it, expect } from 'vitest';
import { parseList } from './listText.js';

describe('tách danh sách tên', () => {
  it('giữ dấu phẩy thập phân', () => {
    expect(parseList('NATRI CLORID 0,9%, SODIUM CHLORIDE 0,9%')).toEqual(['NATRI CLORID 0,9%', 'SODIUM CHLORIDE 0,9%']);
    expect(parseList('VIBATAZOL 1G/0,5G;TAZOPELIN 4,5G\nAclasta')).toEqual(['VIBATAZOL 1G/0,5G', 'TAZOPELIN 4,5G', 'Aclasta']);
  });
  it('vẫn tách ở dấu phẩy thường', () => {
    expect(parseList('CLASTIZOL, Aclasta,Zoruxa')).toEqual(['CLASTIZOL', 'Aclasta', 'Zoruxa']);
  });
});
