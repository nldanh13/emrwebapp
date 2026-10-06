// Chữ "pha …" trên Báo cáo ca trực: không in mã thô NACL_0.9, không lặp dung môi đã có trong tên,
// lấy quy tắc pha của Danh mục thuốc khi y lệnh không ghi dung môi.
import { describe, it, expect } from 'vitest';
import { mixTextOf } from './reportMedicationCollect.js';

describe('mixTextOf', () => {
  it('mã dung môi worker → tên đọc được', () => {
    expect(mixTextOf({ dung_moi: 'NACL_0.9' }, 'Merovia 1g')).toBe('Natri clorid 0.9%');
  });
  it('tên thuốc đã ghi "+ Natri clorid 0.9%" → không lặp, chỉ ghi thể tích', () => {
    expect(mixTextOf({ dung_moi: 'NACL_0.9' }, 'VANCOMYCIN 1G + Natri clorid 0.9%')).toBe('');
    expect(mixTextOf({ dung_moi: 'NACL_0.9', the_tich: 200, nguon_pha: 'y_lenh' }, 'VANCOMYCIN 1G + Natri clorid 0.9%')).toBe('200 ml');
  });
  it('thể tích không từ y lệnh → nói rõ nguồn', () => {
    expect(mixTextOf({ dung_moi: 'NACL_0.9', the_tich: 100, nguon_pha: 'danh_muc' }, 'Merovia 1g')).toBe('Natri clorid 0.9% 100 ml (theo danh mục)');
    expect(mixTextOf({ dung_moi: 'NACL_0.9', tui_dich_truyen_ml: 100, nguon_pha: 'mac_dinh' }, 'X')).toBe('Natri clorid 0.9% 100 ml (mặc định, hỏi lại y lệnh)');
  });
  it('không có dung môi → dùng quy tắc pha của danh mục', () => {
    expect(mixTextOf({ quy_tac_pha: 'Pha Glucose 5% 250 ml (theo danh mục)' }, 'Amiodaron'))
      .toBe('Glucose 5% 250 ml (theo danh mục)');
  });
  it('quy tắc "Không pha thêm" không in thành "pha Không pha"', () => {
    expect(mixTextOf({ quy_tac_pha: 'Không pha thêm (theo danh mục)' }, 'X')).toBe('');
  });
});

import { collectDrugRows } from './reportMedicationCollect.js';

describe('cần xác nhận cách pha', () => {
  it('dòng thuốc worker đánh dấu → báo cáo có confirmMix kèm lý do', () => {
    const DATE = '06/10/2026';
    const rows = collectDrugRows([{ ma_bn: '1', ho_ten: 'A', so_phong: 'P1', ngay_lam: DATE, thuoc: { dich_truyen: [
      { ten_thuoc: 'VANCOMYCIN', ten_hien_thi: 'VANCOMYCIN + Natri clorid 0.9%', gio_dung: '8 giờ', duong_dung: 'TTM', dung_moi: 'NACL_0.9',
        the_tich: 100, nguon_pha: 'danh_muc', can_xac_nhan_pha: true, ly_do_xac_nhan_pha: 'Y lệnh không ghi rõ liều mỗi lần.' },
      { ten_thuoc: 'MEROVIA 1G', gio_dung: '8 giờ', duong_dung: 'TTM', dung_moi: 'NACL_0.9', the_tich: 100, nguon_pha: 'y_lenh' },
    ] } }], DATE);
    const vanco = rows.find(r => /VANCOMYCIN/i.test(r.drugName));
    const mero = rows.find(r => /MEROVIA/i.test(r.drugName));
    expect(vanco.confirmMix).toBe('Y lệnh không ghi rõ liều mỗi lần.');
    expect(mero.confirmMix).toBe('');
  });
});
