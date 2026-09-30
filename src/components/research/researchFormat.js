// Tiện ích định dạng/đọc giá trị dùng trong màn hình Kho nghiên cứu.
function sampleText(values, max = 4) {
  const arr = Array.isArray(values) ? values : [];
  const raw = arr.slice(0, max).map(x => String(x?.value ?? x ?? '').trim()).filter(Boolean).join(' · ');
  if (!raw) return 'Chưa có giá trị mẫu';
  return raw.length > 180 ? `${raw.slice(0, 180)}…` : raw;
}

// ── helpers ──────────────────────────────────────────────────────────────────
function text(v) { return String(v ?? '').trim(); }

function lower(v) { return text(v).toLowerCase(); }

function pick(row, keys, fb = '') {
  for (const k of keys) if (text(row?.[k])) return text(row[k]);
  return fb;
}

function csvEscape(v) {
  const s = String(v ?? '');
  return /[",\n\r;]/.test(s) ? `"${s.replace(/"/g,'""')}"` : s;
}

function downloadCsv(filename, columns, rows) {
  const csv = `\ufeff${columns.map(csvEscape).join(',')}\n${rows.map(r => columns.map(c => csvEscape(r?.[c] ?? '')).join(',')).join('\n')}`;
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
}

function saveBlob(filename, blob) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
}

function parseDate(v) {
  const s = text(v);
  let m = s.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (m) return new Date(+m[3], +m[2]-1, +m[1]);
  m = s.match(/(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return new Date(+m[1], +m[2]-1, +m[3]);
  return null;
}

function parseDateTime(v) {
  const s = text(v);
  let m = s.match(/(\d{1,2}):(\d{2})\s+(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (m) return new Date(+m[5], +m[4]-1, +m[3], +m[1], +m[2]);
  m = s.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2})/);
  if (m) return new Date(+m[3], +m[2]-1, +m[1], +m[4], +m[5]);
  m = s.match(/(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T]+(\d{1,2}):(\d{2}))?/);
  if (m) return new Date(+m[1], +m[2]-1, +m[3], +(m[4] || 0), +(m[5] || 0));
  return parseDate(s);
}

function sortRowsForDisplay(tableKey, inputRows) {
  if (!['initial_list', 'deep_source', 'patients', 'cohort'].includes(String(tableKey || ''))) return inputRows;
  if (!Array.isArray(inputRows) || inputRows.length < 2) return inputRows || [];
  const dateKeys = ['T/G vào','TG vào','Tg vào','Thời gian vào','Thoi gian vao','Ngày vào viện','Ngay vao vien','Ngày nhập viện','Ngay nhap vien','admission_time','admission_datetime','admission_date'];
  return [...inputRows].sort((a, b) => {
    const da = parseDateTime(pick(a, dateKeys));
    const db = parseDateTime(pick(b, dateKeys));
    const ta = da ? da.getTime() : -Infinity;
    const tb = db ? db.getTime() : -Infinity;
    if (tb !== ta) return tb - ta;
    return pick(b, ['Mã BN','Ma BN','MABN','patient_code']).localeCompare(pick(a, ['Mã BN','Ma BN','MABN','patient_code']));
  });
}

function rowInDateRange(row, columns, from, to) {
  if (!from && !to) return true;
  const dateCols = columns.filter(c => /ngày|ngay|tg |thời gian|thoi gian|date|time/i.test(c));
  for (const c of (dateCols.length ? dateCols : columns)) {
    const d = parseDate(row?.[c]);
    if (!d) continue;
    if (from && d < from) continue;
    if (to && d > to) continue;
    return true;
  }
  return false;
}

function compactNumber(v) {
  const n = Number(v || 0);
  return Number.isFinite(n) ? n.toLocaleString('vi-VN') : String(v || 0);
}

export {
  sampleText,
  text,
  lower,
  pick,
  csvEscape,
  downloadCsv,
  saveBlob,
  parseDate,
  parseDateTime,
  sortRowsForDisplay,
  rowInDateRange,
  compactNumber,
};
