// Báo cáo "Y lệnh khác": màn xem và bản in dùng chung danh sách dòng.
import { describe, it, expect } from 'vitest';
import { collectOtherOrderRows, buildOtherOrderPrintHtml } from './otherOrderReport.js';

const DATE = '07/11/2026';
const patients = [
  { ma_bn: '2', ho_ten: 'Trần B', room: 'P10', day_map: { [DATE]: { y_lenh_khac_goc: [
    { gio_y_lenh: '14:30', bac_si: 'BS B', noi_dung: 'Chụp X-quang <kiểm tra>' },
    { gio_y_lenh: '08:00', bac_si: 'BS A', noi_dung: 'Nhịn ăn\nchuẩn bị mổ' },
  ] } } },
  { ma_bn: '1', ho_ten: 'Lê A', room: 'P2', day_map: { [DATE]: { y_lenh_khac_goc: [{ gio_y_lenh: '09:00', bac_si: 'BS C', noi_dung: 'Mời hội chẩn' }] } } },
  { ma_bn: '3', ho_ten: 'Không có', room: 'P1', day_map: { [DATE]: {} } },
];

describe('Y lệnh khác', () => {
  it('chỉ lấy ô Y lệnh khác, xếp theo phòng rồi giờ phiếu', () => {
    const rows = collectOtherOrderRows(patients, DATE);
    expect(rows.map(r => [r.room, r.patientName, r.time, r.text])).toEqual([
      ['P2', 'Lê A', '09:00', 'Mời hội chẩn'],
      ['P10', 'Trần B', '08:00', 'Nhịn ăn\nchuẩn bị mổ'],
      ['P10', 'Trần B', '14:30', 'Chụp X-quang <kiểm tra>'],
    ]);
  });

  it('bản in có đúng các dòng đang xem, không lẫn thuốc', () => {
    const rows = collectOtherOrderRows(patients, DATE);
    const html = buildOtherOrderPrintHtml(rows, DATE);
    expect(html).toContain('Y LỆNH KHÁC NGÀY 07/11/2026');
    expect((html.match(/<tr>/g) || []).length).toBe(rows.length + 1);
    expect(html).toContain('Chụp X-quang &lt;kiểm tra&gt;');
    expect(html).not.toContain('<kiểm tra>');
  });
});
