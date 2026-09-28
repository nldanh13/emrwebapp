import { describe, expect, it } from 'vitest';
import { buildPrintableRoomGroups, paginateRoomGroups } from './bedBoardPrint.js';

describe('in danh sách xếp phòng', () => {
  it('chỉ giữ dữ liệu xếp phòng cần thiết và không đưa giá giường vào bản in', () => {
    const groups = buildPrintableRoomGroups([{
      'Mã BN': '26000001',
      'Họ tên': 'NGUYỄN VĂN A',
      Vi_Tri: 'P01',
      GhiChuGiaPhong: '500.000đ',
      NgayChuyenPhong: '29/09/2026',
      DangKyPhong: '2',
    }]);
    expect(groups).toHaveLength(1);
    expect(groups[0].displayRoom).toBe('P1');
    expect(groups[0]).not.toHaveProperty('price');
    expect(groups[0].patients[0]).not.toHaveProperty('priceNote');
    expect(groups[0].patients[0].transferDate).toBe('29/09/2026');
  });

  it('chia các phòng thành ba cột trên mỗi trang', () => {
    const groups = buildPrintableRoomGroups(Array.from({ length: 4 }, (_, index) => ({
      'Mã BN': `26${index}`,
      'Họ tên': `Người bệnh ${index + 1}`,
      Vi_Tri: `P0${index + 1}`,
    })));
    const pages = paginateRoomGroups(groups, { columnsPerPage: 3, columnCapacityUnits: 3 });
    expect(pages[0]).toHaveLength(3);
    expect(pages.flat(2).filter(Boolean).length).toBeGreaterThan(0);
  });
});
