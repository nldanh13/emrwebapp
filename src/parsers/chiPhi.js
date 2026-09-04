import { safeText } from '../utils/text.js';

function extractTooltipId(row) {
  const attr = row.getAttribute('ondblclick') || '';
  const match = attr.match(/'([^']+)'/);
  return match ? match[1] : '';
}

function detectRowType(row) {
  const attr = row.getAttribute('ondblclick') || '';
  if (attr.includes('showRowTooltipVatTu')) return 'thuoc_vat_tu';
  if (attr.includes('showRowTooltipDichVu')) return 'dich_vu';
  return '';
}

export function parseChiPhiTable(root = document) {
  const table = root.querySelector('#dataTableYeuCau');
  if (!table) return [];

  const rows = Array.from(table.querySelectorAll('tbody tr'));
  const result = [];
  let currentPaymentObject = '';
  let currentCostGroup = '';
  let currentDepartment = '';

  for (const row of rows) {
    const cells = Array.from(row.querySelectorAll('td'));
    if (!cells.length) continue;
    const text = safeText(row.innerText);

    if (cells.length === 1 && /Đối tượng/i.test(text)) {
      currentPaymentObject = text;
      continue;
    }
    if (cells.length === 1 && row.querySelector('b')) {
      currentCostGroup = safeText(row.querySelector('b').innerText);
      continue;
    }
    const dept = row.querySelector('strong');
    if (dept) {
      currentDepartment = safeText(dept.innerText);
      continue;
    }

    if (cells.length >= 17) {
      const val = (i) => safeText(cells[i]?.innerText || '');
      result.push({
        doi_tuong_chi_phi: currentPaymentObject,
        nhom_chi_phi: currentCostGroup,
        khoa_phong: currentDepartment,
        stt: val(0), ten_chi_phi: val(1), doi_tuong: val(2), muc_huong: val(3), don_vi: val(4), so_luong: val(5),
        don_gia_bv: val(6), don_gia_bh: val(7), tlttdv: val(8), thanh_tien_bv: val(9), tltt: val(10),
        thanh_tien_bh: val(11), quy_bhyt: val(12), bn_cct: val(13), khac: val(14), bn_tu_tra: val(15), phu_thu: val(16),
        row_id: extractTooltipId(row),
        row_type: detectRowType(row),
      });
    }
  }

  return result;
}
