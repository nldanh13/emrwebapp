// server/utils/file.js — Tiện ích thao tác file

'use strict';

const fs   = require('fs');
const path = require('path');

/** Tạo thư mục nếu chưa tồn tại (đệ quy). */
function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true });
}

/** Đọc JSON an toàn — trả về fallback nếu file không tồn tại hoặc parse lỗi. */
function readJsonSafe(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, 'utf-8') || 'null') ?? fallback;
  } catch (err) {
    console.error('!!! LỖI đọc JSON:', filePath, err);
    return fallback;
  }
}



class CriticalJsonError extends Error {
  constructor(message, { filePath = '', quarantinePath = '', cause = null } = {}) {
    super(message);
    this.name = 'CriticalJsonError';
    this.code = 'CRITICAL_JSON_CORRUPT';
    this.filePath = filePath;
    this.quarantinePath = quarantinePath;
    this.cause = cause;
  }
}

function corruptStamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

/**
 * Đọc JSON nghiệp vụ quan trọng. File thiếu được phép dùng fallback, nhưng file
 * tồn tại mà hỏng sẽ bị cách ly và tác vụ phải dừng thay vì coi như dữ liệu rỗng.
 */
function readJsonCritical(filePath, fallbackIfMissing = null, { quarantine = true } = {}) {
  if (!fs.existsSync(filePath)) return fallbackIfMissing;
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(raw || 'null') ?? fallbackIfMissing;
  } catch (cause) {
    let quarantinePath = '';
    if (quarantine) {
      quarantinePath = `${filePath}.corrupt-${corruptStamp()}`;
      try { fs.renameSync(filePath, quarantinePath); } catch (_) { quarantinePath = ''; }
    }
    throw new CriticalJsonError(
      `File dữ liệu quan trọng bị hỏng: ${path.basename(filePath)}. Hệ thống đã dừng tác vụ để tránh nhập lặp/sai dữ liệu.`,
      { filePath, quarantinePath, cause },
    );
  }
}

/** Ghi file an toàn: ghi ra .tmp rồi rename để tránh JSON hỏng nếu process bị kill giữa chừng. */
function writeFileAtomic(filePath, content, encoding = 'utf-8') {
  ensureDir(path.dirname(filePath));
  const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  try {
    fs.writeFileSync(tmpPath, content, encoding);
    fs.renameSync(tmpPath, filePath);
  } catch (err) {
    try { if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath); } catch (_) {}
    throw err;
  }
}

/** Ghi JSON an toàn với định dạng dễ đọc. */
function writeJsonAtomic(filePath, value) {
  writeFileAtomic(filePath, JSON.stringify(value, null, 2), 'utf-8');
}

/** Xoá file không ném lỗi nếu không tồn tại. */
function safeUnlink(filePath) {
  try {
    if (filePath && fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch (_) {}
}

/** Trả về path đầu tiên trong danh sách tồn tại, hoặc null. */
function firstExistingPath(candidates) {
  for (const p of candidates) {
    if (p && fs.existsSync(p)) return p;
  }
  return null;
}

/** Timestamp dạng YYYYMMdd_HHmmss dùng cho tên file. */
function nowFileStamp() {
  const d   = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

/** Escape tên file: chỉ giữ ký tự an toàn, tối đa 80 ký tự. */
function safeFilePart(s) {
  return String(s || '').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80);
}

// Đọc file văn bản theo từng dòng bằng các khúc nhỏ, không đọc cả file thành một chuỗi
// (Node giới hạn một chuỗi khoảng 512 MB). Dòng cuối không có "\n" vẫn được trả về.
// Trả về số dòng không rỗng; file không tồn tại → 0.
function forEachLineSync(filePath, onLine, chunkBytes = 1024 * 1024) {
  let fd;
  try { fd = fs.openSync(filePath, 'r'); } catch (_) { return 0; }
  let count = 0;
  try {
    const buf = Buffer.alloc(chunkBytes);
    let pending = [];
    const emit = parts => {
      const line = Buffer.concat(parts).toString('utf-8').replace(/\r$/, '');
      if (!line.trim()) return;
      count += 1;
      if (onLine) onLine(line);
    };
    for (;;) {
      const n = fs.readSync(fd, buf, 0, chunkBytes, null);
      if (n <= 0) break;
      let start = 0;
      for (let i = buf.indexOf(10, 0); i !== -1 && i < n; i = buf.indexOf(10, i + 1)) {
        pending.push(Buffer.from(buf.subarray(start, i)));
        emit(pending);
        pending = [];
        start = i + 1;
      }
      if (start < n) pending.push(Buffer.from(buf.subarray(start, n)));
    }
    if (pending.length) emit(pending);
  } finally {
    fs.closeSync(fd);
  }
  return count;
}

module.exports = { ensureDir, readJsonSafe, readJsonCritical, CriticalJsonError, writeFileAtomic, writeJsonAtomic, safeUnlink, firstExistingPath, nowFileStamp, safeFilePart, forEachLineSync };
