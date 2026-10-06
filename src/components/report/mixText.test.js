// Chữ "pha …" trên Báo cáo ca trực: không in mã thô NACL_0.9, không lặp dung môi đã có trong tên,
// lấy quy tắc pha của Danh mục thuốc khi y lệnh không ghi dung môi.
import { describe, it, expect } from 'vitest';
import { mixTextOf } from './reportMedicationCollect.js';

describe('mixTextOf', () => {
  it('mã dung môi worker → tên đọc được', () => {
    expect(mixTextOf({ dung_moi: 'NACL_0.9' }, 'Merovia 1g')).toBe('Natri clorid 0.9%');
  });
  it('tên thuốc đã ghi "+ Natri clorid 0.9%" → không lặp', () => {
    expect(mixTextOf({ dung_moi: 'NACL_0.9' }, 'VANCOMYCIN 1G + Natri clorid 0.9%')).toBe('');
  });
  it('không có dung môi → dùng quy tắc pha của danh mục', () => {
    expect(mixTextOf({ quy_tac_pha: 'Pha Glucose 5% 250 ml (theo danh mục)' }, 'Amiodaron'))
      .toBe('Glucose 5% 250 ml (theo danh mục)');
  });
  it('quy tắc "Không pha thêm" không in thành "pha Không pha"', () => {
    expect(mixTextOf({ quy_tac_pha: 'Không pha thêm (theo danh mục)' }, 'X')).toBe('');
  });
});
