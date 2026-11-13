'use strict';

// Cú pháp SPSS (.sps) đi kèm file CSV "Biến đã chọn": đọc CSV với đúng kiểu từng cột, gắn nhãn
// biến (tiếng Việt) và nhãn giá trị (0/1). Không chứa dữ liệu người bệnh, chỉ tên cột và nhãn.
//
// Kiểu cột lấy từ chính dữ liệu sẽ xuất (không chỉ từ cấu hình biến): một biến "Số" nhưng cách lấy
// là "Liệt kê giá trị" có ô dạng "5; 6", đọc thành số sẽ mất dữ liệu im lặng. Cột chỉ là số khi mọi
// ô có giá trị đều là số viết bằng dấu chấm thập phân; còn lại đọc thành chuỗi.

const SPSS_RESERVED = new Set(['ALL', 'AND', 'BY', 'EQ', 'GE', 'GT', 'LE', 'LT', 'NE', 'NOT', 'OR', 'TO', 'WITH']);
const NUMBER_RE = /^-?\d+(\.\d+)?$/;
const MAX_NAME_BYTES = 64;
const MAX_LABEL_CHARS = 240;
const MAX_STRING_BYTES = 32767;

function asciiSlug(value) {
  return String(value || '')
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/đ/g, 'd').replace(/Đ/g, 'D')
    .replace(/[^A-Za-z0-9_]+/g, '_')
    .replace(/_+/g, '_').replace(/^_+|_+$/g, '');
}

// Tên biến SPSS hợp lệ: bắt đầu bằng chữ, chỉ chữ/số/_, tối đa 64 byte, không trùng (không phân
// biệt hoa thường), không phải từ khóa dành riêng.
function spssVariableNames(columns) {
  const used = new Set();
  return (columns || []).map((col, i) => {
    let base = asciiSlug(col) || `v${i + 1}`;
    if (!/^[A-Za-z]/.test(base)) base = `v_${base}`;
    if (SPSS_RESERVED.has(base.toUpperCase())) base = `${base}_`;
    base = base.slice(0, MAX_NAME_BYTES);
    let name = base;
    let n = 2;
    while (used.has(name.toUpperCase())) {
      const suffix = `_${n++}`;
      name = `${base.slice(0, MAX_NAME_BYTES - suffix.length)}${suffix}`;
    }
    used.add(name.toUpperCase());
    return name;
  });
}

function byteLength(value) {
  return Buffer.byteLength(String(value ?? ''), 'utf8');
}

// Định dạng đọc cho từng cột theo dữ liệu thật: F<w>.<d> cho cột số, A<w> cho cột chuỗi.
function columnFormat(values) {
  const filled = (values || []).map(v => String(v ?? '').trim()).filter(Boolean);
  if (filled.length && filled.every(v => NUMBER_RE.test(v))) {
    const decimals = Math.min(6, Math.max(0, ...filled.map(v => (v.split('.')[1] || '').length)));
    const width = Math.min(40, Math.max(8, ...filled.map(v => v.length + 1)));
    return { kind: 'number', format: `F${Math.max(width, decimals + 3)}.${decimals}` };
  }
  const width = Math.min(MAX_STRING_BYTES, Math.max(1, ...filled.map(byteLength)));
  return { kind: 'string', format: `A${width}` };
}

function quote(value) {
  return `'${String(value ?? '').replace(/[\r\n\t]+/g, ' ').replace(/'/g, "''").trim()}'`;
}

function shortLabel(value) {
  const s = String(value ?? '').replace(/\s+/g, ' ').trim();
  return s.length > MAX_LABEL_CHARS ? `${s.slice(0, MAX_LABEL_CHARS - 1)}…` : s;
}

// Nhãn giá trị từ cột "Mã hóa" của từ điển biến, dạng "1 = Có, 0 = Không". Chỉ dùng cho cột số.
function parseValueLabels(text) {
  const out = [];
  for (const part of String(text || '').split(/[,;]/)) {
    const m = /^\s*(-?\d+(?:\.\d+)?)\s*=\s*(.+?)\s*$/.exec(part);
    if (m) out.push([m[1], m[2]]);
  }
  return out;
}

/**
 * columns: tên cột đúng như header của file CSV sẽ xuất (sau khi ẩn định danh nếu có).
 * rows: các dòng của file đó (để suy ra kiểu cột).
 * codebook: các dòng của Từ điển biến (cot, nhan, don_vi, ma_hoa, ...).
 */
function buildSpssSyntax({ columns = [], rows = [], codebook = [], csvFilename = 'du_lieu.csv', studyName = '' } = {}) {
  const book = new Map((codebook || []).map(r => [String(r.cot || ''), r]));
  const names = spssVariableNames(columns);
  const specs = columns.map((col, i) => ({
    col,
    name: names[i],
    ...columnFormat(rows.map(r => r?.[col])),
    entry: book.get(col) || null,
  }));

  const lines = [];
  lines.push('* Encoding: UTF-8.');
  lines.push(`* Cú pháp SPSS đọc file ${csvFilename}${studyName ? ` (nghiên cứu: ${shortLabel(studyName).replace(/\*/g, '')})` : ''}.`);
  lines.push('* Cách dùng: mở file này trong SPSS, sửa dòng FILE HANDLE thành đường dẫn đầy đủ của file CSV, rồi chọn Run > All.');
  lines.push('* Cột ngày được đọc dạng chuỗi để không mất giá trị; đổi kiểu sau nếu cần.');
  lines.push('* File CSV và file cú pháp phải xuất cùng lúc, cùng chế độ ẩn định danh, để thứ tự cột khớp nhau.');
  lines.push('');
  lines.push('SET UNICODE=ON.');
  lines.push(`FILE HANDLE duLieu /NAME=${quote(csvFilename)}.`);
  lines.push('GET DATA /TYPE=TXT /FILE=duLieu /ENCODING=\'UTF8\'');
  lines.push('  /ARRANGEMENT=DELIMITED /DELIMITERS="," /QUALIFIER=\'"\' /FIRSTCASE=2');
  lines.push('  /VARIABLES=');
  for (const s of specs) lines.push(`  ${s.name} ${s.format}`);
  lines.push('.');
  lines.push('DATASET NAME NghienCuu WINDOW=FRONT.');
  lines.push('');

  lines.push('VARIABLE LABELS');
  specs.forEach((s, i) => {
    const label = s.entry?.nhan || s.col;
    const unit = s.entry?.don_vi ? ` (${s.entry.don_vi})` : '';
    const text = label.includes(unit.trim()) ? label : `${label}${unit}`;
    lines.push(`  ${s.name} ${quote(shortLabel(text))}${i === specs.length - 1 ? '.' : ''}`);
  });
  lines.push('');

  const valueLabels = specs
    .filter(s => s.kind === 'number')
    .map(s => ({ s, labels: parseValueLabels(s.entry?.ma_hoa) }))
    .filter(x => x.labels.length);
  if (valueLabels.length) {
    lines.push('VALUE LABELS');
    valueLabels.forEach(({ s, labels }, i) => {
      const prefix = i === 0 ? '  ' : '  /';
      lines.push(`${prefix}${s.name} ${labels.map(([v, l]) => `${v} ${quote(shortLabel(l))}`).join(' ')}`);
    });
    lines.push('.');
    lines.push('');
  }

  const renamed = specs.filter(s => s.name !== s.col);
  if (renamed.length) {
    lines.push('* Tên cột đã đổi cho hợp lệ trong SPSS (tên trong SPSS = tên cột trong CSV):');
    for (const s of renamed) lines.push(`*   ${s.name} = ${String(s.col).replace(/[\r\n]+/g, ' ')}.`);
    lines.push('');
  }
  lines.push('EXECUTE.');
  return `${lines.join('\r\n')}\r\n`;
}

module.exports = { buildSpssSyntax, spssVariableNames, columnFormat, parseValueLabels };
