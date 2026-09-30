'use strict';

// Đọc CSV theo từng khối byte thay vì nạp cả file thành một chuỗi.
//
// Bản cũ (readFileSync + ghép từng ký tự) giữ cùng lúc: chuỗi cả file (UTF-16, gấp đôi
// dung lượng file tiếng Việt), mảng mảng ô của mọi dòng, rồi mảng object. Với
// lich_su_xn.csv/lab_results.csv cỡ 200 MB, Node vượt heap 2 GB và chết. Ở đây:
//  - đọc từng khối 4 MB, tách ô trên byte (dấu , " \n đều là ASCII nên an toàn với UTF-8);
//  - giải mã mỗi ô thành chuỗi riêng, không giữ tham chiếu tới khối đọc;
//  - dùng chung một bản cho giá trị ngắn lặp lại (đơn vị, tên XN, ngày, mã đợt...);
//  - khi đã đủ maxRows thì chỉ đếm dòng tiếp, không tạo object.
// Kết quả giống parseCsv cũ: { columns, rows, count, limited }.

const fs = require('fs');

const CHUNK_BYTES = 4 * 1024 * 1024;
const INTERN_MAX_LENGTH = 48;
const INTERN_MAX_ENTRIES = 200000;
const QUOTE = 0x22;
const COMMA = 0x2c;
const LF = 0x0a;

function unquoteCell(raw) {
  // Cùng quy tắc với parseCsv cũ: " mở/đóng vùng trích dẫn, "" trong vùng trích dẫn là ".
  let out = '';
  let inQuotes = false;
  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i];
    if (inQuotes) {
      if (ch === '"' && raw[i + 1] === '"') { out += '"'; i += 1; }
      else if (ch === '"') inQuotes = false;
      else out += ch;
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch !== '\r') {
      out += ch;
    }
  }
  return out;
}

// Bản cũ ghi CSV nội bộ qua bộ chặn công thức Excel, chèn ' trước giá trị bắt đầu bằng
// = + - @ (vd. -3.5 thành '-3.5). Đọc lại thì bỏ dấu ' đó để số âm và kết quả "+"/"-"
// đúng như gốc. File tải về vẫn được chặn công thức khi xuất (rowsToCsv).
const LEGACY_FORMULA_GUARD_RE = /^'(?=\s*[=+\-@])/;
function repairFormulaGuard(value) {
  return value.charCodeAt(0) === 0x27 ? value.replace(LEGACY_FORMULA_GUARD_RE, '') : value;
}

// options.onRow(obj): nhận từng dòng thay vì gom vào mảng rows (rows trả về rỗng), để
// xử lý bảng lớn (xuất file) mà RAM không tăng theo số dòng.
function readCsvFileRows(filePath, maxRows, options = {}) {
  const onRow = typeof options.onRow === 'function' ? options.onRow : null;
  const onHeader = typeof options.onHeader === 'function' ? options.onHeader : null;
  let delivered = 0;
  const limit = Number.isFinite(Number(maxRows)) ? Math.max(0, Number(maxRows)) : Number.MAX_SAFE_INTEGER;
  const intern = new Map();
  const internValue = value => {
    if (!value || value.length > INTERN_MAX_LENGTH) return value;
    const hit = intern.get(value);
    if (hit !== undefined) return hit;
    if (intern.size < INTERN_MAX_ENTRIES) intern.set(value, value);
    return value;
  };

  let columns = null;
  const rows = [];
  let count = 0;
  let collecting = limit > 0;

  const fd = fs.openSync(filePath, 'r');
  try {
    let carry = Buffer.alloc(0);
    let eof = false;
    while (!eof) {
      const chunk = Buffer.allocUnsafe(CHUNK_BYTES);
      const bytesRead = fs.readSync(fd, chunk, 0, CHUNK_BYTES, null);
      eof = bytesRead === 0;
      const buf = carry.length ? Buffer.concat([carry, chunk.subarray(0, bytesRead)]) : chunk.subarray(0, bytesRead);
      // Mỗi khối quét lại từ đầu dòng còn dở ở khối trước (carry).
      let rowStart = 0;
      let cellStart = 0;
      let quotedCell = false;
      let inQuotes = false;
      let visible = false; // dòng có byte khác khoảng trắng/dấu nháy (chỉ dùng khi đếm)
      let cells = [];

      const endCell = (end) => {
        if (collecting || !columns) {
          const text = buf.toString('utf8', cellStart, end);
          cells.push(quotedCell ? unquoteCell(text) : text.replace(/\r/g, ''));
        }
        cellStart = end + 1;
        quotedCell = false;
      };
      const endRow = () => {
        if (!columns) {
          columns = cells.map((value, idx) => {
            const v = (idx === 0 ? value.replace(/^\ufeff/, '') : value).trim();
            return v || `Cột ${idx + 1}`;
          });
          if (onHeader) onHeader(columns);
        } else if (collecting) {
          const values = cells.map(v => repairFormulaGuard(v.trim()));
          if (values.some(Boolean)) {
            count += 1;
            const obj = {};
            if (onRow) {
              for (let i = 0; i < columns.length; i += 1) obj[columns[i]] = values[i] ?? '';
              onRow(obj);
              delivered += 1;
              if (delivered >= limit) collecting = false;
            } else {
              for (let i = 0; i < columns.length; i += 1) obj[columns[i]] = internValue(values[i] ?? '');
              rows.push(obj);
              if (rows.length >= limit) collecting = false;
            }
          }
        } else if (visible) {
          count += 1;
        }
        cells = [];
        visible = false;
      };

      for (let i = 0; i < buf.length; i += 1) {
        const b = buf[i];
        if (b === QUOTE) {
          inQuotes = !inQuotes;
          quotedCell = true;
          continue;
        }
        if (inQuotes) {
          if (b > 0x20) visible = true;
          continue;
        }
        if (b === COMMA) {
          endCell(i);
        } else if (b === LF) {
          endCell(i);
          endRow();
          rowStart = i + 1;
        } else if (b > 0x20) {
          visible = true;
        }
      }
      if (eof) {
        // Dòng cuối không có \n.
        if (rowStart < buf.length) {
          endCell(buf.length);
          endRow();
        }
      } else {
        // Chép phần dòng dở sang khối sau (bản sao nhỏ, không giữ khối 4 MB).
        carry = Buffer.from(buf.subarray(rowStart));
      }
    }
  } finally {
    fs.closeSync(fd);
  }

  if (!columns) return { columns: [], rows: [], count: 0, limited: false };
  return { columns, rows, count, limited: count > (onRow ? delivered : rows.length) };
}

module.exports = { readCsvFileRows, repairFormulaGuard };
