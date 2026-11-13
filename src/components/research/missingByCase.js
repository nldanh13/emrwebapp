// CSV danh sách ca thiếu dữ liệu: chỉ Mã NC, số biến thiếu, tên biến thiếu và cờ cần xem lại.
function csvCell(value) {
  const s = String(value ?? '');
  return /[",\r\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function rowsToCsvText(cases = []) {
  const lines = [['ma_nc', 'so_bien_thieu', 'bien_thieu', 'can_xem_lai'].join(',')];
  for (const c of cases) {
    lines.push([c.research_code, c.missing_count, (c.missing || []).join('; '), c.needs_review ? 1 : 0].map(csvCell).join(','));
  }
  return `${lines.join('\r\n')}\r\n`;
}

// CSV danh sách giá trị cần kiểm lại: Mã NC, cột, biến, giá trị, lý do (không có Mã BN/họ tên).
export function valueIssuesToCsvText(issues = []) {
  const lines = [['ma_nc', 'cot', 'bien', 'gia_tri', 'ly_do'].join(',')];
  for (const i of issues) lines.push([i.research_code, i.column, i.label, i.value, i.reason].map(csvCell).join(','));
  return `${lines.join('\r\n')}\r\n`;
}
