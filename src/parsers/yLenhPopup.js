import { safeText, toNumber } from '../utils/text.js';

export function parseYLenhThuocVTYTFromPopup(root = document) {
  const tbody = root.querySelector('#tbodydivDS');
  if (!tbody) return [];

  const rows = Array.from(tbody.querySelectorAll('tr'));
  const result = [];
  let currentOrder = null;

  for (const row of rows) {
    const checkbox = row.querySelector('.chkYlenh');
    if (checkbox) {
      const text = safeText(row.innerText);
      currentOrder = {
        y_lenh_id: checkbox.value || '',
        thoi_gian_y_lenh: text.replace(/^Y\s*lệnh\s*-?/i, '').trim(),
        checked: checkbox.checked,
        items: [],
      };
      result.push(currentOrder);
      continue;
    }

    const cells = Array.from(row.querySelectorAll('td')).map((td) => safeText(td.innerText));
    if (!currentOrder || cells.length < 6) continue;

    const ma = cells[0] || '';
    const ten = cells[1] || '';
    if (!ma && !ten) continue;

    currentOrder.items.push({
      ma_thuoc_vtyt: ma,
      ten_thuoc_vtyt: ten,
      ham_luong: cells[2] || '',
      don_vi: cells[3] || '',
      so_luong: toNumber(cells[4]),
      duong_dung: cells[5] || '',
      is_vtyt: /^VTYT/i.test(ma),
      is_active: toNumber(cells[4]) > 0,
      raw: cells.join(' | '),
    });
  }

  return result;
}

export function parseAddedVTYTRows(root = document) {
  const table = root.querySelector('#divVanDeCS table, #divVanDeCS');
  if (!table) return [];

  return Array.from(table.querySelectorAll('tbody tr, tr'))
    .map((row) => Array.from(row.querySelectorAll('td')).map((td) => safeText(td.innerText)))
    .filter((cells) => cells.some(Boolean))
    .map((cells) => ({
      ma_thuoc_vtyt: cells.find((x) => /^VTYT\./i.test(x)) || '',
      ten_thuoc_vtyt: cells[2] || cells[1] || cells.join(' '),
      so_luong: toNumber(cells.find((x) => /^\d+(\.\d+)?$/.test(x)) || 0),
      raw_cells: cells,
    }));
}

export function parseSelect2VTYTResults(root = document) {
  const options = Array.from(root.querySelectorAll('#select2-txtHang-results .select2-results__option'));
  return options
    .map((option) => {
      const cells = Array.from(option.querySelectorAll('td')).map((td) => safeText(td.innerText));
      if (cells.length < 2) return null;
      return {
        code: cells[0],
        name: cells[1],
        stock: toNumber(cells[2]),
        note: cells[3] || '',
        element: option,
      };
    })
    .filter(Boolean);
}
