import { safeText, toNumber } from '../utils/text.js';

export function parseVTYTDeclarations(root = document) {
  const container = root.querySelector('#divDanhSachYLenh');
  if (!container) return [];

  const blocks = Array.from(container.querySelectorAll('.ibox.float-e-margins'));
  return blocks.map((block) => {
    const headerText = safeText(block.querySelector('thead th')?.innerText || '');
    const thoiGian = headerText.match(/Thời gian:\s*(.*?)\s*\|/)?.[1]?.trim() || '';
    const nguoiKeKhai = headerText.match(/Người kê khai:\s*(.*?)\s*\|/)?.[1]?.trim() || '';
    const trangThai = headerText.match(/Trạng thái:\s*(.*?)\s*\|/)?.[1]?.trim() || '';
    const thoiGianYLenh = headerText.match(/Y lệnh ngày\s*(.*?)(?:\s|$)/)?.[1]?.trim() || '';
    const tables = block.querySelectorAll('table');
    const detailTable = tables[tables.length - 1];
    const rows = Array.from(detailTable?.querySelectorAll('tbody tr') || []);

    const items = rows.map((row) => {
      const cells = Array.from(row.querySelectorAll('td')).map((td) => safeText(td.innerText));
      return {
        stt: cells[0] || '',
        loai_ke: cells[1] || '',
        so_phieu: cells[2] || '',
        ma_thuoc_vtyt: cells[3] || '',
        ten_thuoc_vtyt: cells[4] || '',
        don_vi: cells[5] || '',
        so_luong: toNumber(cells[6]),
        doi_tuong: cells[7] || '',
      };
    });

    return { thoi_gian_ke_khai: thoiGian, nguoi_ke_khai: nguoiKeKhai, trang_thai: trangThai, thoi_gian_y_lenh: thoiGianYLenh, items };
  });
}
