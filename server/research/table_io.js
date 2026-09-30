'use strict';

// Đọc/ghi CSV của Kho nghiên cứu: bảng có cache, đếm dòng, ghi hợp cột, lấy giá trị ô.

const { MAX_TABLE_ROWS, normalizedKey } = require('./store_paths');
const { writeFileAtomic } = require('../utils/file');
const { rowsToCsvRaw } = require('../utils/csv');
const fs = require('fs');
const path = require('path');
const { readCsvFileRows } = require('./csv_reader');
const { strictLocalDate } = require('./date_utils');

function parseCsv(text, { maxRows = MAX_TABLE_ROWS } = {}) {
  const source = String(text || '').replace(/^\ufeff/, '');
  const rows = [];
  let row = [];
  let cell = '';
  let inQuotes = false;

  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i];
    const next = source[i + 1];
    if (inQuotes) {
      if (ch === '"' && next === '"') {
        cell += '"';
        i += 1;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        cell += ch;
      }
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      row.push(cell);
      cell = '';
    } else if (ch === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
      if (rows.length > maxRows + 1) break;
    } else if (ch === '\r') {
      // bỏ qua, xử lý ở \n
    } else {
      cell += ch;
    }
  }
  if (cell || row.length) {
    row.push(cell);
    rows.push(row);
  }

  while (rows.length && rows[rows.length - 1].every(v => String(v || '').trim() === '')) rows.pop();
  if (!rows.length) return { columns: [], rows: [], count: 0, limited: false };
  const columns = rows[0].map((v, idx) => String(v || `Cột ${idx + 1}`).trim() || `Cột ${idx + 1}`);
  const body = rows.slice(1, maxRows + 1).filter(r => r.some(v => String(v || '').trim() !== ''));
  const objects = body.map(values => {
    const obj = {};
    columns.forEach((col, i) => { obj[col] = String(values[i] ?? '').trim(); });
    return obj;
  });
  return { columns, rows: objects, count: Math.max(0, rows.length - 1), limited: rows.length - 1 > maxRows };
}

function writeCsv(filePath, columns, rows) {
  writeFileAtomic(filePath, `\ufeff${rowsToCsvRaw(columns, rows)}`, 'utf-8');
}

const CSV_TABLE_CACHE = new Map();

// Cache object CSV lớn tốn RAM gấp nhiều lần kích thước file (chuỗi + object cho
// từng ô). Chỉ cache các bảng nhỏ thường dùng; bảng lớn/toàn bộ dữ liệu phải được
// giải phóng sau request để server không chạm giới hạn heap 2 GB.
const CSV_CACHE_MAX_ENTRIES = 16;

const CSV_CACHE_MAX_FILE_BYTES = Math.max(64 * 1024, Number(process.env.EMR_CSV_CACHE_MAX_FILE_BYTES || 1024 * 1024));

function _csvCacheKey(filePath, maxRows) {
  try {
    const stat = fs.statSync(filePath);
    return `${path.resolve(filePath)}|${stat.size}|${Math.floor(stat.mtimeMs)}|${maxRows}`;
  } catch (_) {
    return '';
  }
}

function _trimCsvCache() {
  if (CSV_TABLE_CACHE.size <= CSV_CACHE_MAX_ENTRIES) return;
  const extra = CSV_TABLE_CACHE.size - CSV_CACHE_MAX_ENTRIES;
  for (const key of [...CSV_TABLE_CACHE.keys()].slice(0, extra)) CSV_TABLE_CACHE.delete(key);
}

function readCsvTable(filePath, maxRows = MAX_TABLE_ROWS) {
  if (!fs.existsSync(filePath)) return { columns: [], rows: [], count: 0, limited: false, exists: false };
  let fileSize = 0;
  try { fileSize = fs.statSync(filePath).size; } catch (_) { /* đọc bên dưới sẽ báo lỗi thật */ }
  const cacheEligible = fileSize > 0 && fileSize <= CSV_CACHE_MAX_FILE_BYTES && Number(maxRows) <= MAX_TABLE_ROWS;
  const cacheKey = cacheEligible ? _csvCacheKey(filePath, maxRows) : '';
  if (cacheKey && CSV_TABLE_CACHE.has(cacheKey)) return CSV_TABLE_CACHE.get(cacheKey);

  // Đọc theo khối: không nạp cả file thành một chuỗi (file XN/CĐHA có thể vài trăm MB).
  const result = { ...readCsvFileRows(filePath, maxRows), exists: true };
  if (cacheKey) {
    // Xóa cache cũ của cùng file khi file đã thay đổi.
    const prefix = `${path.resolve(filePath)}|`;
    for (const key of CSV_TABLE_CACHE.keys()) {
      if (key !== cacheKey && key.startsWith(prefix)) CSV_TABLE_CACHE.delete(key);
    }
    CSV_TABLE_CACHE.set(cacheKey, result);
    _trimCsvCache();
  }
  return result;
}

function safeDownloadName(value, fallback = 'research_export') {
  const cleaned = String(value || fallback).normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9_.-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 120);
  return cleaned || fallback;
}

// ── Lấy giá trị ô theo danh sách tên cột ──────────────────────────────────────
function cell(row, keys, fallback = '') {
  for (const key of keys) {
    const v = row?.[key];
    if (v != null && String(v).trim() !== '') return String(v).trim();
  }
  return fallback;
}

function readRunTableRowsWhere(runDir, filename, predicate) {
  const filePath = path.join(runDir, filename);
  if (!fs.existsSync(filePath)) return [];
  const rows = [];
  readCsvFileRows(filePath, Number.MAX_SAFE_INTEGER, { onRow: row => { if (predicate(row)) rows.push(row); } });
  return rows;
}

function safeReadRunTable(runDir, filename) {
  return readCsvTable(path.join(runDir, filename), Number.MAX_SAFE_INTEGER).rows || [];
}

// Chỉ đếm dòng (không tạo object) và nhớ kết quả theo kích thước + mtime: dashboard
// gọi hàm này cho mọi bảng ở mỗi lần làm mới, kể cả file XN/CĐHA vài trăm MB.
const CSV_ROW_COUNT_CACHE = new Map();

const CSV_ROW_COUNT_CACHE_MAX = 512;

function countCsvRows(filePath) {
  try {
    const stat = fs.statSync(filePath);
    const resolved = path.resolve(filePath);
    const stamp = `${stat.size}|${Math.floor(stat.mtimeMs)}`;
    const cached = CSV_ROW_COUNT_CACHE.get(resolved);
    if (cached && cached.stamp === stamp) return cached.count;
    const count = Number(readCsvFileRows(filePath, 0).count || 0);
    CSV_ROW_COUNT_CACHE.delete(resolved);
    CSV_ROW_COUNT_CACHE.set(resolved, { stamp, count });
    if (CSV_ROW_COUNT_CACHE.size > CSV_ROW_COUNT_CACHE_MAX) {
      CSV_ROW_COUNT_CACHE.delete(CSV_ROW_COUNT_CACHE.keys().next().value);
    }
    return count;
  } catch (_) {
    return 0;
  }
}

function getCell(row, names) {
  if (!row) return '';
  const byKey = new Map(Object.keys(row).map(key => [normalizedKey(key), row[key]]));
  for (const name of names) {
    const v = byKey.get(normalizedKey(name));
    if (String(v || '').trim()) return String(v || '').trim();
  }
  return '';
}

function patientCode(row) {
  return getCell(row, [
    'Mã BN', 'Ma BN', 'MABN', 'Mã bệnh nhân', 'Ma benh nhan',
    'patient_code', 'patientCode', 'code', 'ma_bn', 'maBN', 'Mã YT', 'Ma YT',
  ]);
}

function parseDateCell(value) {
  const s = String(value || '').trim();
  if (!s) return null;
  let m = s.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (m) return strictLocalDate(Number(m[3]), Number(m[2]), Number(m[1]));
  m = s.match(/(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return strictLocalDate(Number(m[1]), Number(m[2]), Number(m[3]));
  return null;
}

function parseDateTimeCell(value) {
  const s = String(value || '').trim();
  if (!s) return null;

  // Các bảng EMR thường ghi: "08:38 02/06/2026".
  let m = s.match(/(\d{1,2}):(\d{2})\s+(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (m) return strictLocalDate(Number(m[5]), Number(m[4]), Number(m[3]), Number(m[1]), Number(m[2]));

  // Một số file có thể ghi: "02/06/2026 08:38".
  m = s.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2})/);
  if (m) return strictLocalDate(Number(m[3]), Number(m[2]), Number(m[1]), Number(m[4]), Number(m[5]));

  // ISO/local: "2026-06-02 08:38" hoặc "2026-06-02T08:38".
  m = s.match(/(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T]+(\d{1,2}):(\d{2}))?/);
  if (m) return strictLocalDate(Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4] || 0), Number(m[5] || 0));

  return parseDateCell(s);
}

function unionColumnsForRows(rows, preferred = []) {
  const seen = new Set();
  const out = [];
  for (const col of preferred || []) {
    if (!seen.has(col)) { seen.add(col); out.push(col); }
  }
  for (const row of rows || []) {
    for (const col of Object.keys(row || {})) {
      if (!seen.has(col)) { seen.add(col); out.push(col); }
    }
  }
  return out;
}

function writeCsvUnion(filePath, rows, preferred = []) {
  const cols = unionColumnsForRows(rows, preferred);
  if (!cols.length) {
    writeFileAtomic(filePath, '\ufeff\n', 'utf-8');
    return;
  }
  writeCsv(filePath, cols, rows || []);
}

module.exports = {
  parseCsv,
  writeCsv,
  CSV_TABLE_CACHE,
  CSV_CACHE_MAX_ENTRIES,
  CSV_CACHE_MAX_FILE_BYTES,
  _csvCacheKey,
  _trimCsvCache,
  readCsvTable,
  safeDownloadName,
  cell,
  readRunTableRowsWhere,
  safeReadRunTable,
  CSV_ROW_COUNT_CACHE,
  CSV_ROW_COUNT_CACHE_MAX,
  countCsvRows,
  getCell,
  patientCode,
  parseDateCell,
  parseDateTimeCell,
  unionColumnsForRows,
  writeCsvUnion,
};
