#!/usr/bin/env node
'use strict';

/**
 * Tạo file zip bàn giao sạch bằng Node.js thuần, không cần thư viện ngoài.
 * Chạy: npm run package:clean
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const { buildDataShapeBundle } = require('./data_shape/export_data_shape');

const ROOT = path.resolve(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'release');
const RELEASE_BASENAME = 'emr_dashboard_clean';

// ── Thư mục luôn bị loại trừ (dữ liệu runtime, cache, build) ─────────────────
const EXCLUDE_DIRS = new Set([
  '.git', '.runtime', '.venv', '.cleanup_backup', '.vscode', '.idea', 'node_modules', 'dist', 'logs', 'release', 'data', 'debug', 'debug_bundle', 'reports', 'in', 'secrets',
  '__pycache__', '.pytest_cache', '.mypy_cache', '.ruff_cache', 'coverage', 'research_store', 'care_baseline_store', 'data_shape_bundle',
]);

// ── File cụ thể bị loại trừ (thông tin nhạy cảm) ─────────────────────────────
const EXCLUDE_FILES = new Set([
  'config/config.json',    // chứa URL/username/password EMR — không được đưa vào bản release
  'config/care_baseline.json', // chứa nhiều tài khoản lấy lường cơ bản — không được đưa vào bản release
  'config/users.json',     // chứa tài khoản người dùng thật và hash/mật khẩu cấu hình
  '.env',                  // chứa EMR_APP_TOKEN và cấu hình môi trường thật
  'package-lock.json.bak',
  'package.modular.bak.json',
  'cleanup_report.preview.json',
  'cleanup_report.json',
  '.coverage',
]);

// ── Pattern tên file bị loại trừ ─────────────────────────────────────────────
const EXCLUDE_PATTERNS = [
  // Compiled / cache Python
  '*.pyc', '*.pyo', '*.pyd',
  // File backup / log / PDF tạm
  '*.bak', '*.bak.json', '*.log', '*.pdf', '*.zip', '*.patch', '*.diff', '*.secret', '*.pem', '*.key',
  'research/**/*.csv', 'config/hchanh/imports/*.csv', 'config/hchanh/imports/*.xls', 'config/hchanh/imports/*.xlsx', 'config/hchanh/imports/*.json',
  // Dữ liệu bệnh nhân runtime (không được đưa vào bản release)
  'data_raw.json', 'data_sorted.json', 'KetQua_YLenh.json', 'DuLieu_PhanLoai.json',
  'data_phan_loai_chuan_*.json', '_tmp_in_*.json', '_tmp_out_*.json',
  'input_targets_*.json', 'input_targets_care_*.json',
  'clinic_request_*.json', 'clinic_preview_*.json', 'clinic_targets.xlsx', 'clinic_procedures_*.json',
  'input_care_result.json', 'input_infusions_result.json',
  'care_done.json', 'infusions_done.json', 'task_progress.json',
  // File JSX nằm ngoài src/ là file bị copy nhầm — loại trừ để tránh đóng gói bản cũ
  'server/**/*.jsx',
];

function toPosix(p) {
  return p.split(path.sep).join('/');
}

function relPosix(absPath) {
  return toPosix(path.relative(ROOT, absPath));
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

function releaseStamp(date = new Date()) {
  return [
    date.getFullYear(),
    pad2(date.getMonth() + 1),
    pad2(date.getDate()),
    '_',
    pad2(date.getHours()),
    pad2(date.getMinutes()),
    pad2(date.getSeconds()),
  ].join('');
}

function randomSuffix(length = 6) {
  // Dung ky tu ngan, de doc, tranh nham lan khi gui file nhieu lan.
  return crypto.randomBytes(Math.ceil(length / 2)).toString('hex').slice(0, length);
}


function assertSafeReleaseDir() {
  const resolvedOut = path.resolve(OUT_DIR);
  const resolvedRoot = path.resolve(ROOT);

  if (resolvedOut === resolvedRoot) {
    throw new Error('OUT_DIR không được trùng với thư mục gốc dự án. Dừng để tránh xóa nhầm.');
  }

  if (!resolvedOut.startsWith(resolvedRoot + path.sep)) {
    throw new Error('OUT_DIR phải nằm bên trong thư mục dự án. Dừng để tránh xóa nhầm.');
  }
}

function cleanReleaseDirectory() {
  assertSafeReleaseDir();
  fs.mkdirSync(OUT_DIR, { recursive: true });

  for (const entry of fs.readdirSync(OUT_DIR)) {
    const fullPath = path.join(OUT_DIR, entry);
    fs.rmSync(fullPath, { recursive: true, force: true });
  }
}

function nextReleaseZipPath() {
  // Vi du: release/emr_dashboard_clean_20260501_132530_a1b2c3.zip
  const base = `${RELEASE_BASENAME}_${releaseStamp()}_${randomSuffix()}`;
  let candidate = path.join(OUT_DIR, `${base}.zip`);
  let index = 2;

  // Hau nhu khong xay ra vi da co timestamp + random, nhung van phong truong hop trung.
  while (fs.existsSync(candidate)) {
    candidate = path.join(OUT_DIR, `${base}_${index}.zip`);
    index += 1;
  }
  return candidate;
}

function wildcardToRegExp(pattern) {
  // Hỗ trợ ** (match nhiều segment đường dẫn) và * (match trong 1 segment)
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')  // escape ký tự regex đặc biệt
    .replace(/\*\*/g, '\x00DSTAR\x00')      // tạm giữ ** trước
    .replace(/\*/g, '[^/]*')               // * không match /
    .replace(/\x00DSTAR\x00/g, '.*')       // ** match bất kỳ path
    .replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`);
}

const EXCLUDE_REGEX = EXCLUDE_PATTERNS.map(wildcardToRegExp);

function shouldExclude(absPath, isDir = false) {
  const rel = relPosix(absPath);
  const parts = rel.split('/').filter(Boolean);
  if (parts.some((part, idx) => idx < parts.length - 1 && EXCLUDE_DIRS.has(part))) return true;
  if (isDir && EXCLUDE_DIRS.has(path.basename(absPath))) return true;
  if (EXCLUDE_FILES.has(rel)) return true;
  const name = path.basename(absPath);
  // Kiểm tra theo tên file VÀ theo đường dẫn tương đối (để hỗ trợ pattern như server/**/*.jsx)
  return EXCLUDE_REGEX.some((rx) => rx.test(name) || rx.test(rel));
}

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!shouldExclude(full, true)) walk(full, out);
    } else if (entry.isFile()) {
      if (!shouldExclude(full, false)) out.push(full);
    }
  }
  return out;
}

// CRC32 table
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function dosDateTime(date = new Date()) {
  const year = Math.max(1980, date.getFullYear());
  const dosTime = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
  const dosDate = ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { dosTime, dosDate };
}

function u16(n) { const b = Buffer.alloc(2); b.writeUInt16LE(n & 0xffff, 0); return b; }
function u32(n) { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0, 0); return b; }

function zipEntryName(entry) {
  return typeof entry === 'string' ? relPosix(entry) : toPosix(entry.zipPath);
}

function zipEntryPath(entry) {
  return typeof entry === 'string' ? entry : entry.absPath;
}

function walkZipEntries(dir, zipRoot, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    const rel = toPosix(path.relative(dir, full));
    if (entry.isDirectory()) {
      walkZipEntries(full, `${zipRoot}/${entry.name}`, out);
    } else if (entry.isFile()) {
      out.push({ absPath: full, zipPath: `${zipRoot}/${rel}` });
    }
  }
  return out;
}

function makeZip(files, outPath) {
  const chunks = [];
  const central = [];
  let offset = 0;
  const { dosTime, dosDate } = dosDateTime();

  for (const file of files) {
    const name = zipEntryName(file);
    const nameBuf = Buffer.from(name, 'utf8');
    const data = fs.readFileSync(zipEntryPath(file));
    const compressed = zlib.deflateRawSync(data, { level: 9 });
    const crc = crc32(data);

    const localHeader = Buffer.concat([
      u32(0x04034b50), // local file header signature
      u16(20),         // version needed
      u16(0x0800),     // UTF-8 file name
      u16(8),          // deflate
      u16(dosTime), u16(dosDate),
      u32(crc), u32(compressed.length), u32(data.length),
      u16(nameBuf.length), u16(0),
      nameBuf,
    ]);

    chunks.push(localHeader, compressed);

    const centralHeader = Buffer.concat([
      u32(0x02014b50), // central directory signature
      u16(20), u16(20),
      u16(0x0800),
      u16(8),
      u16(dosTime), u16(dosDate),
      u32(crc), u32(compressed.length), u32(data.length),
      u16(nameBuf.length), u16(0), u16(0),
      u16(0), u16(0),
      u32(0),
      u32(offset),
      nameBuf,
    ]);
    central.push(centralHeader);
    offset += localHeader.length + compressed.length;
  }

  const centralStart = offset;
  const centralBuf = Buffer.concat(central);
  const centralSize = centralBuf.length;
  const eocd = Buffer.concat([
    u32(0x06054b50),
    u16(0), u16(0),
    u16(files.length), u16(files.length),
    u32(centralSize), u32(centralStart),
    u16(0),
  ]);

  fs.writeFileSync(outPath, Buffer.concat([...chunks, centralBuf, eocd]));
}

function main() {
  cleanReleaseDirectory();
  const outZip = nextReleaseZipPath();

  // Mặc định KHÔNG đưa data-shape vào gói phát hành. Dù đã được làm mờ,
  // metadata/schema sinh từ dữ liệu runtime vẫn có thể tiết lộ cấu trúc nghiệp vụ.
  // Chỉ bật khi người vận hành chủ động yêu cầu để phục vụ chẩn đoán nội bộ.
  let dataShapeEntries = [];
  let dataShape = null;
  if (String(process.env.INCLUDE_DATA_SHAPE_BUNDLE || '').trim() === '1') {
    const dataShapeDir = path.join(OUT_DIR, '_data_shape_bundle');
    const dataShapeSourceRoot = process.env.DATA_SHAPE_SOURCE_ROOT || ROOT;
    dataShape = buildDataShapeBundle({ sourceRoot: dataShapeSourceRoot, outDir: dataShapeDir });
    dataShapeEntries = walkZipEntries(dataShapeDir, 'data_shape_bundle');
  }

  const sourceFiles = walk(ROOT).sort((a, b) => relPosix(a).localeCompare(relPosix(b)));
  const files = [...sourceFiles, ...dataShapeEntries].sort((a, b) => zipEntryName(a).localeCompare(zipEntryName(b)));
  makeZip(files, outZip);

  console.log(`Đã dọn sạch thư mục release và tạo: ${outZip}`);
  console.log(`Số file source: ${sourceFiles.length}`);
  if (dataShape) {
    console.log(`Data shape bundle: ${dataShape.manifest.files_scanned} file / ${dataShape.manifest.groups.length} nhóm`);
  } else {
    console.log('Data shape bundle: không kèm theo (mặc định an toàn)');
  }
  console.log(`Tổng file trong zip: ${files.length}`);
}

main();
