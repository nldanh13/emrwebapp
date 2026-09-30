#!/usr/bin/env node
'use strict';

/**
 * Xuất "data shape bundle": schema + thống kê + mẫu đã ẩn danh.
 * Mục tiêu: giúp chia sẻ cấu trúc dữ liệu mà không đóng gói dữ liệu bệnh nhân/tài khoản thật.
 *
 * Chạy riêng:
 *   npm run package:data-shape
 *   node scripts/data_shape/export_data_shape.js --source-root=. --out=release/data_shape_bundle
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { StringDecoder } = require('string_decoder');

const DEFAULT_DATA_ROOTS = [
  'data',
  '.runtime/data',
  '.runtime/sessions',
  'research_store',
  'care_baseline_store',
  'reports',
];

const SUPPORTED_EXT = new Set(['.json', '.jsonl', '.csv']);
const DEFAULT_MAX_FILES_PER_GROUP = 8;
const DEFAULT_MAX_TOTAL_FILES = 300;
const DEFAULT_MAX_FILE_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAX_ROWS_PER_FILE = 120;
const DEFAULT_MAX_SAMPLE_ARRAY = 3;
const DEFAULT_MAX_DEPTH = 8;
const DEFAULT_CSV_CHUNK_BYTES = 64 * 1024;
const DEFAULT_MAX_DISTINCT_VALUES = 10000;

const EXCLUDE_DIR_NAMES = new Set([
  '.git',
  'node_modules',
  'dist',
  'release',
  '__pycache__',
  '.pytest_cache',
  '.mypy_cache',
  '.ruff_cache',
  'coverage',
]);

const EXCLUDE_PATH_PARTS = new Set([
  'auth',
  'logs',
  'debug',
  'debug_bundle',
]);

const SECRET_FILE_RE = /(?:^|[_.-])(cookie|cookies|token|secret|password|credential|credentials|auth|session)(?:[_.-]|$)/i;
const RAW_FILE_RE = /(?:raw_html|raw_response|raw_input|screenshot|browser_restart|resource_log|case_trace)/i;
const SECRET_REL_PATHS = new Set([
  '.env',
  'config/config.json',
  'config/care_baseline.json',
]);

const KEY_FIELD_RE = /^(id|.*_id|ma_bn|mabn|patient_id|encounter_key|patient_day_key|ticket_id|study_id|run_id|session_id|order_id|key)$/i;
const SENSITIVE_KEY_RE = /(password|passwd|pwd|token|cookie|secret|authorization|auth|credential|username|user_name|account|tai_khoan|mat_khau|session)/i;
const NAME_KEY_RE = /(^|_)(ho_ten|hoten|ten_bn|ten_benh_nhan|patient_name|full_name|name|ten)($|_)/i;
const PATIENT_ID_KEY_RE = /(ma_bn|mabn|patient_id|ma_benh_nhan|ma_y_te|mayte|so_benh_an|medical_record)/i;
const PHONE_KEY_RE = /(phone|mobile|dien_thoai|sdt|so_dien_thoai)/i;
const ADDRESS_KEY_RE = /(address|dia_chi|thon|xa|huyen|tinh)/i;
const ROOM_KEY_RE = /(room|phong|giuong|bed)/i;
const DATE_KEY_RE = /(date|time|ngay|gio|created|updated|timestamp|started|ended|tu_ngay|den_ngay)/i;
const TEXT_KEY_RE = /(chan_doan|diagnosis|note|ghi_chu|noi_dung|content|mo_ta|description|ly_do|reason|ket_luan|result|dien_bien|y_lenh|order_text)/i;
const MONEY_KEY_RE = /(tong_tien|amount|price|cost|fee|money|thanh_tien|don_gia|tien)/i;
const STATUS_KEY_RE = /(status|state|trang_thai|severity|level)/i;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DATE_VALUE_RE = /^\d{4}[-/]\d{1,2}[-/]\d{1,2}|^\d{1,2}[-/]\d{1,2}[-/]\d{4}|^\d{4}-\d{2}-\d{2}T/i;
const PHONE_VALUE_RE = /(?:\+?84|0)\d{8,10}/;
const LONG_DIGIT_RE = /^\d{6,}$/;

function parseArgs(argv = process.argv.slice(2)) {
  const out = {};
  for (const arg of argv) {
    if (arg.startsWith('--source-root=')) out.sourceRoot = arg.slice('--source-root='.length);
    else if (arg.startsWith('--out=')) out.outDir = arg.slice('--out='.length);
    else if (arg.startsWith('--max-files=')) out.maxTotalFiles = Number(arg.slice('--max-files='.length));
    else if (arg === '--dry-run') out.dryRun = true;
  }
  return out;
}

function toPosix(p) {
  return p.split(path.sep).join('/');
}

function relPath(root, absPath) {
  return toPosix(path.relative(root, absPath));
}

function safeWriteJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', 'utf8');
}

function safeWriteText(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, value, 'utf8');
}

function csvCell(value) {
  const text = String(value ?? '');
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function safeWriteCsv(file, rows) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const text = rows.map(row => row.map(csvCell).join(',')).join('\r\n') + '\r\n';
  fs.writeFileSync(file, text, 'utf8');
}

function clampString(s, max = 160) {
  const text = String(s ?? '');
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function safeName(name) {
  return String(name || 'data')
    .replace(/[^a-zA-Z0-9._/-]+/g, '_')
    .replace(/[/{}/]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 140) || 'data';
}

function normalizeGroupKey(rel) {
  let p = toPosix(rel);
  p = p.replace(/\.runtime\/sessions\/[^/]+/g, '.runtime/sessions/{session_id}');
  p = p.replace(/\/runs\/\d{8}_\d{6}(?=\/|$)/g, '/runs/{run_id}');
  p = p.replace(/\/runs\/\d{8,14}(?=\/|$)/g, '/runs/{run_id}');
  p = p.replace(/\/runs\/[a-f0-9]{8,}(?=\/|$)/gi, '/runs/{run_id}');
  p = p.replace(/\/patients\/[^/]+(?=\/|$)/g, '/patients/{patient_id}');
  p = p.replace(/\/hchanh\/patients\/[^/]+(?=\/|$)/g, '/hchanh/patients/{patient_id}');
  p = p.replace(/\b\d{8}_\d{6}\b/g, '{timestamp}');
  p = p.replace(/\d{13}/g, '{timestamp_ms}');
  p = p.replace(/\d{6,}/g, '{id}');
  p = p.replace(/[a-f0-9]{16,}/gi, '{hash}');
  p = p.replace(/[a-z0-9]{8,}-[a-z0-9-]{6,}/gi, '{id}');
  return p;
}

function shouldExcludeFile(sourceRoot, absFile) {
  const rel = relPath(sourceRoot, absFile);
  const parts = rel.split('/').filter(Boolean);
  const base = path.basename(absFile);
  const ext = path.extname(base).toLowerCase();

  if (SECRET_REL_PATHS.has(rel) || base === 'config.json') return 'secret_rel_path';
  if (!SUPPORTED_EXT.has(ext)) return 'unsupported_ext';
  if (parts.some(part => EXCLUDE_DIR_NAMES.has(part))) return 'excluded_dir';
  if (parts.some(part => EXCLUDE_PATH_PARTS.has(part))) return 'sensitive_dir';
  if (SECRET_FILE_RE.test(base) || RAW_FILE_RE.test(base)) return 'sensitive_file_name';
  // CSV lớn được đọc tuần tự ở bước phân tích, không nạp toàn bộ vào RAM.
  if (fs.statSync(absFile).size > DEFAULT_MAX_FILE_BYTES && ext !== '.csv') return 'too_large';
  return '';
}

function walkDataFiles(sourceRoot, dataRoots = DEFAULT_DATA_ROOTS) {
  const files = [];
  const excluded = [];

  function walk(absDir) {
    if (!fs.existsSync(absDir)) return;
    for (const entry of fs.readdirSync(absDir, { withFileTypes: true })) {
      const full = path.join(absDir, entry.name);
      if (entry.isDirectory()) {
        if (EXCLUDE_DIR_NAMES.has(entry.name) || EXCLUDE_PATH_PARTS.has(entry.name)) {
          excluded.push({ path: relPath(sourceRoot, full), reason: EXCLUDE_PATH_PARTS.has(entry.name) ? 'sensitive_dir' : 'excluded_dir' });
          continue;
        }
        walk(full);
      } else if (entry.isFile()) {
        const reason = shouldExcludeFile(sourceRoot, full);
        if (reason) excluded.push({ path: relPath(sourceRoot, full), reason });
        else files.push(full);
      }
    }
  }

  for (const root of dataRoots) walk(path.join(sourceRoot, root));
  return { files, excluded };
}

function valueType(value) {
  if (value === null || value === undefined) return 'null';
  if (Array.isArray(value)) return 'array';
  const t = typeof value;
  if (t === 'number') return Number.isFinite(value) ? 'number' : 'number_nonfinite';
  if (t === 'boolean') return 'boolean';
  if (t === 'string') return 'string';
  if (t === 'object') return 'object';
  return t;
}

function createFieldStat(pathName) {
  return {
    path: pathName,
    types: {},
    count: 0,
    null_count: 0,
    string_min_len: null,
    string_max_len: null,
    number_min: null,
    number_max: null,
    array_min_len: null,
    array_max_len: null,
    object_observed: false,
    empty_count: 0,
    non_empty_count: 0,
    _distinct_hashes: new Set(),
    _distinct_count_capped: false,
    _formats: new Set(),
  };
}

function isEmptyValue(value) {
  if (value === null || value === undefined) return true;
  if (typeof value === 'string') return value.trim() === '';
  if (Array.isArray(value)) return value.length === 0;
  return false;
}

function valueFormat(value) {
  if (value === null || value === undefined || (typeof value === 'string' && value.trim() === '')) return 'empty';
  if (typeof value === 'boolean') return 'boolean';
  if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'decimal';
  if (Array.isArray(value)) return 'array';
  if (value && typeof value === 'object') return 'object';
  const text = String(value).trim();
  if (/^-?\d+$/.test(text)) return 'integer_text';
  if (/^-?\d+(?:[.,]\d+)$/.test(text)) return 'decimal_text';
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return 'date_yyyy_mm_dd';
  if (/^\d{1,2}[/-]\d{1,2}[/-]\d{4}$/.test(text)) return 'date_dd_mm_yyyy';
  if (/^\d{4}-\d{2}-\d{2}T/.test(text)) return 'datetime_iso';
  if (/^[\[{].*[\]}]$/s.test(text)) return 'json_text';
  return 'text';
}

function trackDistinct(stat, value) {
  if (isEmptyValue(value) || stat._distinct_count_capped) return;
  if (stat._distinct_hashes.size >= DEFAULT_MAX_DISTINCT_VALUES) {
    stat._distinct_count_capped = true;
    return;
  }
  let normalized;
  if (typeof value === 'string') normalized = value;
  else if (typeof value === 'number' || typeof value === 'boolean') normalized = String(value);
  else return;
  stat._distinct_hashes.add(crypto.createHash('sha256').update(normalized).digest('hex'));
}

function updateFieldStat(stat, value) {
  const type = valueType(value);
  stat.types[type] = (stat.types[type] || 0) + 1;
  stat.count += 1;
  if (isEmptyValue(value)) stat.empty_count += 1;
  else stat.non_empty_count += 1;
  stat._formats.add(valueFormat(value));
  trackDistinct(stat, value);
  if (type === 'null') {
    stat.null_count += 1;
  } else if (type === 'string') {
    const len = value.length;
    stat.string_min_len = stat.string_min_len === null ? len : Math.min(stat.string_min_len, len);
    stat.string_max_len = stat.string_max_len === null ? len : Math.max(stat.string_max_len, len);
  } else if (type === 'number') {
    stat.number_min = stat.number_min === null ? value : Math.min(stat.number_min, value);
    stat.number_max = stat.number_max === null ? value : Math.max(stat.number_max, value);
  } else if (type === 'array') {
    const len = value.length;
    stat.array_min_len = stat.array_min_len === null ? len : Math.min(stat.array_min_len, len);
    stat.array_max_len = stat.array_max_len === null ? len : Math.max(stat.array_max_len, len);
  } else if (type === 'object') {
    stat.object_observed = true;
  }
}

function addStat(stats, pathName, value) {
  if (!stats[pathName]) stats[pathName] = createFieldStat(pathName);
  updateFieldStat(stats[pathName], value);
}

function collectStats(value, stats, prefix = '$', depth = 0) {
  addStat(stats, prefix, value);
  if (depth >= DEFAULT_MAX_DEPTH) return;
  if (Array.isArray(value)) {
    for (const item of value.slice(0, DEFAULT_MAX_ROWS_PER_FILE)) collectStats(item, stats, `${prefix}[]`, depth + 1);
  } else if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      collectStats(child, stats, `${prefix}.${key}`, depth + 1);
    }
  }
}

function mergeSchemas(target, source) {
  if (!source) return target;
  if (!target) return JSON.parse(JSON.stringify(source));
  const types = new Set([...(target.type || []), ...(source.type || [])]);
  target.type = Array.from(types).sort();
  target.observed_count = (target.observed_count || 0) + (source.observed_count || 0);

  if (source.properties) {
    target.properties = target.properties || {};
    for (const [key, child] of Object.entries(source.properties)) {
      target.properties[key] = mergeSchemas(target.properties[key], child);
    }
  }
  if (source.items) target.items = mergeSchemas(target.items, source.items);
  return target;
}

function inferSchema(value, depth = 0) {
  const type = valueType(value);
  const schema = { type: [type], observed_count: 1 };
  if (depth >= DEFAULT_MAX_DEPTH) return schema;
  if (type === 'object') {
    schema.properties = {};
    for (const [key, child] of Object.entries(value)) schema.properties[key] = inferSchema(child, depth + 1);
  } else if (type === 'array') {
    let itemSchema = null;
    for (const item of value.slice(0, DEFAULT_MAX_ROWS_PER_FILE)) itemSchema = mergeSchemas(itemSchema, inferSchema(item, depth + 1));
    schema.items = itemSchema || { type: ['unknown'], observed_count: 0 };
  }
  return schema;
}

function parseCsvLine(line) {
  const out = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"';
        i += 1;
      } else if (ch === '"') {
        quoted = false;
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === ',') {
      out.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}

function parseCsvRows(text, maxRows = DEFAULT_MAX_ROWS_PER_FILE) {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/).filter(line => line.trim() !== '');
  if (!lines.length) return [];
  const header = parseCsvLine(lines[0]).map(h => h.trim() || 'column');
  const rows = [];
  for (const line of lines.slice(1, maxRows + 1)) {
    const values = parseCsvLine(line);
    const row = {};
    header.forEach((h, idx) => { row[h] = values[idx] ?? ''; });
    rows.push(row);
  }
  return rows;
}

/**
 * Đọc CSV theo từng khối nhỏ. Bộ nhớ chỉ giữ một dòng đang phân tích và tối đa
 * DEFAULT_MAX_ROWS_PER_FILE dòng mẫu; toàn bộ giá trị thật không được ghi ra bundle.
 */
function scanCsvFile(absFile) {
  const stats = {};
  let schema = null;
  const sampleRows = [];
  let header = null;
  let totalRows = 0;
  let row = [];
  let field = '';
  let quoted = false;
  let pendingQuote = false;
  let firstCharacter = true;

  function finishField() {
    row.push(field);
    field = '';
  }

  function finishRow() {
    finishField();
    if (row.length === 1 && row[0].trim() === '') {
      row = [];
      return;
    }
    if (!header) {
      header = row.map((name, idx) => name.trim() || `column_${idx + 1}`);
      row = [];
      return;
    }
    const record = {};
    header.forEach((name, idx) => { record[name] = row[idx] ?? ''; });
    totalRows += 1;
    if (sampleRows.length < DEFAULT_MAX_ROWS_PER_FILE) {
      sampleRows.push(record);
      schema = mergeSchemas(schema, inferSchema(record));
    }
    addStat(stats, '$[]', record);
    for (const [key, value] of Object.entries(record)) addStat(stats, `$[].${key}`, value);
    row = [];
  }

  function feed(text) {
    for (let i = 0; i < text.length; i += 1) {
      let ch = text[i];
      if (firstCharacter) {
        firstCharacter = false;
        if (ch === '\uFEFF') continue;
      }
      if (pendingQuote) {
        pendingQuote = false;
        if (ch === '"') {
          field += '"';
          continue;
        }
        quoted = false;
      }
      if (quoted) {
        if (ch === '"') {
          if (i + 1 < text.length) {
            if (text[i + 1] === '"') {
              field += '"';
              i += 1;
            } else {
              quoted = false;
            }
          } else {
            pendingQuote = true;
          }
        } else {
          field += ch;
        }
      } else if (ch === '"' && field === '') {
        quoted = true;
      } else if (ch === ',') {
        finishField();
      } else if (ch === '\n') {
        finishRow();
      } else if (ch !== '\r') {
        field += ch;
      }
    }
  }

  const fd = fs.openSync(absFile, 'r');
  const decoder = new StringDecoder('utf8');
  const buffer = Buffer.allocUnsafe(DEFAULT_CSV_CHUNK_BYTES);
  try {
    let bytesRead;
    do {
      bytesRead = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (bytesRead) feed(decoder.write(buffer.subarray(0, bytesRead)));
    } while (bytesRead);
    feed(decoder.end());
    if (pendingQuote) {
      pendingQuote = false;
      quoted = false;
    }
    if (field !== '' || row.length) finishRow();
  } finally {
    fs.closeSync(fd);
  }

  return {
    data: sampleRows,
    schema: {
      type: ['array'],
      observed_count: 1,
      items: schema || { type: ['object'], observed_count: 0, properties: {} },
    },
    stats,
    recordsObserved: totalRows,
    fullScan: true,
  };
}

function parseFile(absFile) {
  const ext = path.extname(absFile).toLowerCase();
  const text = fs.readFileSync(absFile, 'utf8');
  if (ext === '.json') return JSON.parse(text);
  if (ext === '.jsonl') {
    const rows = [];
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        rows.push(JSON.parse(line));
      } catch (_) {
        rows.push({ line_type: 'unparseable_jsonl_line', text_length: line.length });
      }
      if (rows.length >= DEFAULT_MAX_ROWS_PER_FILE) break;
    }
    return rows;
  }
  if (ext === '.csv') return parseCsvRows(text);
  return null;
}


function sanitizeDynamicKey(key) {
  const text = String(key ?? '');
  if (/^\d{6,}::/.test(text)) return 'PATIENT_DAY_KEY';
  if (/^\d{6,}$/.test(text)) return 'PATIENT_ID_KEY';
  if (/\d{6,}/.test(text)) return text.replace(/\d{13}/g, 'TIMESTAMP_MS').replace(/\d{6,}/g, 'ID_VALUE');
  if (/^[a-f0-9]{16,}$/i.test(text)) return 'HASH_KEY';
  return text;
}

function sanitizeStructureKeys(value, depth = 0) {
  if (depth >= DEFAULT_MAX_DEPTH) return value;
  if (Array.isArray(value)) return value.slice(0, DEFAULT_MAX_ROWS_PER_FILE).map(item => sanitizeStructureKeys(item, depth + 1));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, child] of Object.entries(value)) {
      const safeKey = sanitizeDynamicKey(key);
      if (Object.prototype.hasOwnProperty.call(out, safeKey)) {
        // Gộp các khóa động cùng dạng, chỉ cần cấu trúc đại diện.
        continue;
      }
      out[safeKey] = sanitizeStructureKeys(child, depth + 1);
    }
    return out;
  }
  return value;
}

function redactPrimitive(key, value, report) {
  const keyText = String(key || '');
  const type = valueType(value);
  if (value === null || value === undefined) return null;
  if (SENSITIVE_KEY_RE.test(keyText)) {
    report.redacted.secret += 1;
    return 'REMOVED';
  }
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (MONEY_KEY_RE.test(keyText)) return 123456;
    if (DATE_KEY_RE.test(keyText)) return 20260101;
    return value === 0 ? 0 : 1;
  }
  const s = String(value);
  if (PATIENT_ID_KEY_RE.test(keyText) || LONG_DIGIT_RE.test(s)) {
    report.redacted.patient_id += 1;
    return 'PATIENT_000001';
  }
  if (NAME_KEY_RE.test(keyText)) {
    report.redacted.name += 1;
    return 'PERSON_NAME';
  }
  if (PHONE_KEY_RE.test(keyText) || PHONE_VALUE_RE.test(s)) {
    report.redacted.phone += 1;
    return 'PHONE_VALUE';
  }
  if (ADDRESS_KEY_RE.test(keyText)) {
    report.redacted.address += 1;
    return 'ADDRESS_VALUE';
  }
  if (EMAIL_RE.test(s)) {
    report.redacted.email += 1;
    return 'email@example.local';
  }
  if (DATE_KEY_RE.test(keyText) || DATE_VALUE_RE.test(s)) {
    report.redacted.date += 1;
    return '2026-01-01T00:00:00.000Z';
  }
  if (ROOM_KEY_RE.test(keyText)) {
    report.redacted.room += 1;
    return 'ROOM_001';
  }
  if (STATUS_KEY_RE.test(keyText)) return 'STATUS_VALUE';
  if (TEXT_KEY_RE.test(keyText)) {
    report.redacted.text += 1;
    return 'TEXT_VALUE';
  }
  if (type === 'string') {
    report.redacted.string += 1;
    return s.length > 60 ? 'LONG_TEXT_VALUE' : 'STRING_VALUE';
  }
  return value;
}

function redactValue(key, value, report, depth = 0) {
  if (depth >= DEFAULT_MAX_DEPTH) return '[MAX_DEPTH]';
  if (Array.isArray(value)) {
    return value.slice(0, DEFAULT_MAX_SAMPLE_ARRAY).map(item => redactValue(key, item, report, depth + 1));
  }
  if (value && typeof value === 'object') {
    const out = {};
    for (const [childKey, child] of Object.entries(value)) out[childKey] = redactValue(childKey, child, report, depth + 1);
    return out;
  }
  return redactPrimitive(key, value, report);
}

function summarizeStats(stats, recordsObserved) {
  return Object.fromEntries(Object.entries(stats)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, stat]) => {
      const { _distinct_hashes, _distinct_count_capped, _formats, ...out } = stat;
      out.distinct_count = _distinct_hashes.size;
      out.distinct_count_capped = _distinct_count_capped;
      out.example_format = Array.from(_formats).sort().join('|');
      out.presence_ratio = recordsObserved ? Number((stat.count / recordsObserved).toFixed(4)) : null;
      return [key, out];
    }));
}

function makeCoverageRows(groupProfiles) {
  const rows = [[
    'table_name',
    'field_name',
    'total_rows',
    'non_empty_rows',
    'empty_rows',
    'coverage_pct',
    'distinct_count',
    'distinct_count_capped',
    'example_format',
    'full_scan',
  ]];
  for (const group of groupProfiles) {
    for (const [fieldPath, stat] of Object.entries(group.fields || {})) {
      if (!/^\$\[\]\.[^.]+$/.test(fieldPath)) continue;
      const total = group.records_observed || 0;
      const nonEmpty = Math.min(Number(stat.non_empty_count || 0), total);
      const empty = Math.max(total - nonEmpty, 0);
      const coverage = total ? Number(((nonEmpty / total) * 100).toFixed(2)) : 0;
      rows.push([
        group.group_key,
        fieldPath.slice(4),
        total,
        nonEmpty,
        empty,
        coverage,
        stat.distinct_count || 0,
        stat.distinct_count_capped ? 'true' : 'false',
        stat.example_format || '',
        group.full_scan ? 'true' : 'false',
      ]);
    }
  }
  return rows;
}

function discoverRelationships(groupProfiles) {
  const fields = [];
  for (const group of groupProfiles) {
    for (const field of Object.keys(group.fields || {})) {
      const last = field.split('.').pop().replace(/\[\]$/, '');
      if (KEY_FIELD_RE.test(last)) fields.push({ group: group.group_key, field, role: last });
    }
  }
  const byRole = {};
  for (const item of fields) {
    byRole[item.role] = byRole[item.role] || [];
    byRole[item.role].push({ group: item.group, field: item.field });
  }
  return { discovered_key_fields: fields, possible_relationships: byRole };
}

function makeReadme(manifest) {
  return `# Data Shape Bundle\n\nBundle này chỉ chứa cấu trúc dữ liệu đã ẩn danh, dùng để phân tích/refactor model mà không gửi dữ liệu thật.\n\n## Nội dung\n\n- \`manifest.json\`: thống kê tổng quan và danh sách nhóm file đã phân tích.\n- \`coverage_summary.csv\`: số dòng có dữ liệu, số dòng trống và tỷ lệ đầy đủ từng cột.\n- \`schemas/\`: schema suy luận từ JSON/CSV/JSONL.\n- \`stats/\`: thống kê field, kiểu dữ liệu, null/blank count, min/max và số giá trị khác nhau.\n- \`samples/\`: mẫu đã ẩn danh, chỉ giữ hình dạng dữ liệu.\n- \`relationships.json\`: các field khóa có thể liên kết dữ liệu giữa module/tab.\n- \`redaction_report.json\`: báo cáo loại trừ và số lượng giá trị đã ẩn danh.\n\n## Cách đọc coverage_summary.csv\n\n- \`coverage_pct\`: tỷ lệ dòng có giá trị khác rỗng.\n- \`full_scan=true\`: toàn bộ CSV đã được đọc tuần tự, kể cả file lớn.\n- \`distinct_count_capped=true\`: số giá trị khác nhau đã chạm ngưỡng an toàn ${DEFAULT_MAX_DISTINCT_VALUES}; đây là cận dưới.\n- \`example_format\`: chỉ mô tả định dạng, không chứa giá trị thật.\n\n## Cam kết giới hạn\n\n- Không đưa nguyên thư mục \`.runtime\`, \`research_store\`, \`care_baseline_store\`, \`logs\`, \`config/config.json\`.\n- Không giữ họ tên, mã bệnh nhân, token, cookie, password, tài khoản thật trong sample.\n- CSV lớn chỉ được đọc tuần tự để lấy schema/thống kê; không được chép nguyên vào bundle.\n- JSON/JSONL quá lớn, log, raw HTML, cookie/token/auth/debug vẫn bị loại trừ.\n\n## Thống kê nhanh\n\n- Generated at: ${manifest.generated_at}\n- Source roots scanned: ${manifest.source_roots_scanned.join(', ') || 'none'}\n- Files scanned: ${manifest.files_scanned}\n- File groups: ${manifest.groups.length}\n`;
}

function buildDataShapeBundle(options = {}) {
  const sourceRoot = path.resolve(options.sourceRoot || process.env.DATA_SHAPE_SOURCE_ROOT || path.resolve(__dirname, '../..'));
  const outDir = path.resolve(options.outDir || process.env.DATA_SHAPE_OUT_DIR || path.join(sourceRoot, 'release', 'data_shape_bundle'));
  const maxTotalFiles = Number(options.maxTotalFiles || DEFAULT_MAX_TOTAL_FILES);
  const maxFilesPerGroup = Number(options.maxFilesPerGroup || DEFAULT_MAX_FILES_PER_GROUP);

  const redactionReport = {
    source_root_name: path.basename(sourceRoot),
    generated_at: new Date().toISOString(),
    excluded_files: [],
    parse_errors: [],
    redacted: {
      secret: 0,
      patient_id: 0,
      name: 0,
      phone: 0,
      address: 0,
      email: 0,
      date: 0,
      room: 0,
      text: 0,
      string: 0,
    },
  };

  if (fs.existsSync(outDir)) fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });

  const { files, excluded } = walkDataFiles(sourceRoot);
  redactionReport.excluded_files = excluded.slice(0, 1000).map(item => ({ ...item, path: normalizeGroupKey(item.path) }));

  const groups = new Map();
  for (const file of files) {
    const rel = relPath(sourceRoot, file);
    const groupKey = normalizeGroupKey(rel);
    if (!groups.has(groupKey)) groups.set(groupKey, []);
    groups.get(groupKey).push(file);
  }

  const groupProfiles = [];
  let filesScanned = 0;
  const sortedGroups = Array.from(groups.entries()).sort(([a], [b]) => a.localeCompare(b));

  for (const [groupKey, groupFiles] of sortedGroups) {
    if (filesScanned >= maxTotalFiles) break;
    let schema = null;
    const stats = {};
    let sample = undefined;
    let recordsObserved = 0;
    let scannedInGroup = 0;
    const examples = [];
    let fullScan = groupFiles.length <= maxFilesPerGroup;

    for (const file of groupFiles.slice(0, maxFilesPerGroup)) {
      if (filesScanned >= maxTotalFiles) break;
      const rel = relPath(sourceRoot, file);
      try {
        const ext = path.extname(file).toLowerCase();
        let safeData;
        if (ext === '.csv') {
          const scan = scanCsvFile(file);
          safeData = sanitizeStructureKeys(scan.data);
          schema = mergeSchemas(schema, scan.schema);
          for (const [fieldPath, fieldStat] of Object.entries(scan.stats)) {
            if (!stats[fieldPath]) stats[fieldPath] = createFieldStat(fieldPath);
            const target = stats[fieldPath];
            for (const [type, count] of Object.entries(fieldStat.types)) target.types[type] = (target.types[type] || 0) + count;
            target.count += fieldStat.count;
            target.null_count += fieldStat.null_count;
            target.empty_count += fieldStat.empty_count;
            target.non_empty_count += fieldStat.non_empty_count;
            target.string_min_len = target.string_min_len === null ? fieldStat.string_min_len : (fieldStat.string_min_len === null ? target.string_min_len : Math.min(target.string_min_len, fieldStat.string_min_len));
            target.string_max_len = target.string_max_len === null ? fieldStat.string_max_len : (fieldStat.string_max_len === null ? target.string_max_len : Math.max(target.string_max_len, fieldStat.string_max_len));
            target.number_min = target.number_min === null ? fieldStat.number_min : (fieldStat.number_min === null ? target.number_min : Math.min(target.number_min, fieldStat.number_min));
            target.number_max = target.number_max === null ? fieldStat.number_max : (fieldStat.number_max === null ? target.number_max : Math.max(target.number_max, fieldStat.number_max));
            target.array_min_len = target.array_min_len === null ? fieldStat.array_min_len : (fieldStat.array_min_len === null ? target.array_min_len : Math.min(target.array_min_len, fieldStat.array_min_len));
            target.array_max_len = target.array_max_len === null ? fieldStat.array_max_len : (fieldStat.array_max_len === null ? target.array_max_len : Math.max(target.array_max_len, fieldStat.array_max_len));
            target.object_observed = target.object_observed || fieldStat.object_observed;
            for (const hash of fieldStat._distinct_hashes) {
              if (target._distinct_hashes.size >= DEFAULT_MAX_DISTINCT_VALUES) {
                target._distinct_count_capped = true;
                break;
              }
              target._distinct_hashes.add(hash);
            }
            target._distinct_count_capped = target._distinct_count_capped || fieldStat._distinct_count_capped;
            for (const format of fieldStat._formats) target._formats.add(format);
          }
          recordsObserved += scan.recordsObserved;
        } else {
          const data = parseFile(file);
          safeData = sanitizeStructureKeys(data);
          schema = mergeSchemas(schema, inferSchema(safeData));
          collectStats(safeData, stats);
          if (Array.isArray(safeData)) recordsObserved += Math.max(safeData.length, 1);
          else recordsObserved += 1;
          fullScan = false;
        }
        if (sample === undefined) sample = redactValue(path.basename(file), safeData, redactionReport);
        scannedInGroup += 1;
        filesScanned += 1;
        examples.push(normalizeGroupKey(rel));
      } catch (err) {
        redactionReport.parse_errors.push({ path: normalizeGroupKey(rel), error: clampString(err.message, 200) });
      }
    }

    if (scannedInGroup < groupFiles.length) fullScan = false;

    if (!scannedInGroup) continue;
    const id = safeName(groupKey.replace(/\.[a-z0-9]+$/i, ''));
    const schemaFile = `schemas/${id}.schema.json`;
    const statFile = `stats/${id}.profile.json`;
    const sampleFile = `samples/${id}.sample.json`;
    const profile = {
      group_key: groupKey,
      normalized_examples: Array.from(new Set(examples)).slice(0, 5),
      files_in_group: groupFiles.length,
      files_scanned: scannedInGroup,
      records_observed: recordsObserved,
      full_scan: fullScan,
      fields: summarizeStats(stats, recordsObserved),
    };

    safeWriteJson(path.join(outDir, schemaFile), {
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      title: groupKey,
      description: 'Schema suy luận tự động từ dữ liệu đã phân tích. Không chứa dữ liệu thật.',
      inferred_schema: schema || { type: ['unknown'], observed_count: 0 },
    });
    safeWriteJson(path.join(outDir, statFile), profile);
    safeWriteJson(path.join(outDir, sampleFile), sample === undefined ? null : sample);

    groupProfiles.push({
      group_key: groupKey,
      files_in_group: groupFiles.length,
      files_scanned: scannedInGroup,
      records_observed: recordsObserved,
      full_scan: fullScan,
      schema_file: schemaFile,
      stats_file: statFile,
      sample_file: sampleFile,
      fields: profile.fields,
    });
  }

  const existingRoots = DEFAULT_DATA_ROOTS.filter(root => fs.existsSync(path.join(sourceRoot, root)));
  const manifest = {
    bundle_type: 'emr_dashboard_data_shape',
    bundle_version: 2,
    generated_at: new Date().toISOString(),
    source_root_name: path.basename(sourceRoot),
    source_roots_scanned: existingRoots,
    files_discovered: files.length,
    files_scanned: filesScanned,
    files_excluded: excluded.length,
    groups: groupProfiles.map(({ fields, ...item }) => item),
    safety: {
      raw_data_included: false,
      samples_redacted: true,
      secrets_excluded: true,
      max_files_per_group: maxFilesPerGroup,
      max_total_files: maxTotalFiles,
      max_file_bytes: DEFAULT_MAX_FILE_BYTES,
      large_csv_streamed: true,
      max_distinct_values: DEFAULT_MAX_DISTINCT_VALUES,
    },
  };

  safeWriteJson(path.join(outDir, 'manifest.json'), manifest);
  safeWriteCsv(path.join(outDir, 'coverage_summary.csv'), makeCoverageRows(groupProfiles));
  safeWriteJson(path.join(outDir, 'relationships.json'), discoverRelationships(groupProfiles));
  safeWriteJson(path.join(outDir, 'redaction_report.json'), redactionReport);
  safeWriteText(path.join(outDir, 'README.md'), makeReadme(manifest));

  return { outDir, manifest, redactionReport };
}

if (require.main === module) {
  const args = parseArgs();
  const result = buildDataShapeBundle(args);
  console.log(`[data-shape] Đã tạo: ${result.outDir}`);
  console.log(`[data-shape] File đã phân tích: ${result.manifest.files_scanned}`);
  console.log(`[data-shape] Nhóm dữ liệu: ${result.manifest.groups.length}`);
}

module.exports = {
  buildDataShapeBundle,
  normalizeGroupKey,
  redactValue,
  sanitizeStructureKeys,
};
