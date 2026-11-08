#!/usr/bin/env node
'use strict';

// Chẩn đoán cấu trúc thư mục dữ liệu runtime (RUNTIME_ROOT) mà KHÔNG in nội
// dung file và KHÔNG in tên các thư mục con dạng định danh bệnh nhân (mã BN,
// case_key...) — chỉ đếm số lượng, để có thể dán kết quả ra ngoài an toàn.
//
// Chạy:
//   node scripts/inspect_runtime_data.js
//   node scripts/inspect_runtime_data.js --depth=5 --fanout=15
//   EMR_RUNTIME_ROOT=/duong/dan/khac node scripts/inspect_runtime_data.js

const fs = require('fs');
const path = require('path');

const args = Object.fromEntries(
  process.argv.slice(2)
    .map(a => a.match(/^--([^=]+)(?:=(.*))?$/))
    .filter(Boolean)
    .map(m => [m[1], m[2] === undefined ? true : m[2]])
);

const MAX_DEPTH = Number(args.depth || 6);
// Từ ngưỡng này trở lên, coi thư mục là "fan-out" (mỗi entry là 1 bản ghi
// lặp lại cùng dạng, ví dụ mỗi mã BN 1 thư mục) -> chỉ đếm, không liệt kê tên,
// không đệ quy vào bên trong từng entry.
const FANOUT_THRESHOLD = Number(args.fanout || 12);

const ROOT_DIR = path.resolve(__dirname, '..');
const RUNTIME_ROOT = path.resolve(process.env.EMR_RUNTIME_ROOT || path.join(ROOT_DIR, '.runtime'));

function humanSize(bytes) {
  if (!Number.isFinite(bytes)) return '?';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let n = bytes;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i += 1; }
  return `${n.toFixed(n >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
}

// Liệu tên các entry trong 1 thư mục có "cùng dạng" không (mã số, hoặc mã
// dạng case_key ma_bn::xxx, hoặc uuid/hash) — dấu hiệu đây là thư mục
// "mỗi bản ghi 1 folder", nên ẩn tên thật đi dù số lượng chưa vượt ngưỡng.
function looksLikeIdentifierPattern(names) {
  if (!names.length) return false;
  const idLike = names.filter(n => /^\d{4,}/.test(n) || /::/.test(n) || /^[0-9a-f]{8,}$/i.test(n)).length;
  return idLike / names.length >= 0.6;
}

function safeReaddir(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    return null;
  }
}

function safeStatSize(p) {
  try {
    return fs.statSync(p).size;
  } catch (_) {
    return 0;
  }
}

// Tính tổng dung lượng đệ quy nhưng có giới hạn số file quét để không treo
// trên các kho cực lớn — quá giới hạn thì báo "≥" thay vì số chính xác.
function dirSizeApprox(dir, limitFiles = 20000) {
  let total = 0;
  let count = 0;
  let truncated = false;
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop();
    const entries = safeReaddir(cur);
    if (!entries) continue;
    for (const e of entries) {
      if (count > limitFiles) { truncated = true; break; }
      const full = path.join(cur, e.name);
      if (e.isDirectory()) stack.push(full);
      else if (e.isFile()) { total += safeStatSize(full); count += 1; }
    }
    if (truncated) break;
  }
  return { total, count, truncated };
}

const lines = [];
function emit(depth, text) {
  lines.push(`${'  '.repeat(depth)}${text}`);
}

// Tên file/thư mục có thể chứa mã BN (dãy ≥ 6 chữ số) hoặc họ tên có dấu
// (ví dụ IN_RA_VIEN_<mã BN>_<HỌ_TÊN>.pdf, KetQua_YLenh_one_<mã BN>.json).
// Những tên này không được in: gộp theo phần đầu trước chữ số đầu tiên.
// Trả về null nếu tên an toàn để in nguyên văn.
function sensitiveGroupKey(name) {
  const hasLongDigits = /\d{6,}/.test(name);
  const hasNonAscii = /[^\x00-\x7F]/.test(name);
  if (!hasLongDigits && !hasNonAscii) return null;
  const ext = path.extname(name);
  if (hasNonAscii && !/^[\x00-\x7F]*\d/.test(name)) return `[tên có dấu]${ext}`;
  const prefix = name.slice(0, name.search(/\d/));
  if (/[^\x00-\x7F]/.test(prefix)) return `[tên có dấu]${ext}`;
  return `${prefix}…${ext}`;
}

function dirLabel(full) {
  const info = dirSizeApprox(full);
  return `~${humanSize(info.total)}${info.truncated ? ' (ước lượng)' : ''}, ${info.count} file`;
}

function emitGroups(depth, groups, icon) {
  for (const [key, g] of [...groups.entries()].sort()) {
    emit(depth, `${icon} [${g.count} ${icon === '📁' ? 'thư mục' : 'file'} ${key} — đã ẩn tên] tổng ~${humanSize(g.size)}${g.files ? `, ${g.files} file bên trong` : ''}`);
  }
}

function walk(dir, depth) {
  const entries = safeReaddir(dir);
  if (!entries) { emit(depth, '(không đọc được thư mục)'); return; }

  const dirs = entries.filter(e => e.isDirectory()).map(e => e.name).sort();
  const files = entries.filter(e => e.isFile()).map(e => e.name).sort();

  const treatAsFanout = dirs.length >= FANOUT_THRESHOLD || looksLikeIdentifierPattern(dirs);

  if (treatAsFanout && dirs.length) {
    const sizeInfo = { total: 0, count: 0, truncated: false };
    for (const name of dirs) {
      const info = dirSizeApprox(path.join(dir, name));
      sizeInfo.total += info.total; sizeInfo.count += info.count; sizeInfo.truncated ||= info.truncated;
    }
    emit(depth, `📁 [${dirs.length} thư mục con — dạng bản ghi lặp lại, đã ẩn tên] tổng ~${humanSize(sizeInfo.total)}${sizeInfo.truncated ? ' (ước lượng, đã cắt bớt khi quét)' : ''}, ${sizeInfo.count} file bên trong`);
  } else {
    const hiddenDirs = new Map();
    for (const name of dirs) {
      const full = path.join(dir, name);
      const key = sensitiveGroupKey(name);
      if (key) {
        const info = dirSizeApprox(full);
        const g = hiddenDirs.get(key) || { count: 0, size: 0, files: 0 };
        g.count += 1; g.size += info.total; g.files += info.count;
        hiddenDirs.set(key, g);
        continue;
      }
      emit(depth, `📁 ${name}/ (${dirLabel(full)})`);
      if (depth + 1 < MAX_DEPTH) walk(full, depth + 1);
      else emit(depth + 1, '… (đã đạt giới hạn độ sâu, dùng --depth để xem thêm)');
    }
    emitGroups(depth, hiddenDirs, '📁');
  }

  const hiddenFiles = new Map();
  for (const name of files) {
    const size = safeStatSize(path.join(dir, name));
    const key = sensitiveGroupKey(name);
    if (key) {
      const g = hiddenFiles.get(key) || { count: 0, size: 0 };
      g.count += 1; g.size += size;
      hiddenFiles.set(key, g);
      continue;
    }
    emit(depth, `📄 ${name} (${humanSize(size)})`);
  }
  emitGroups(depth, hiddenFiles, '📄');
}

console.log(`RUNTIME_ROOT: ${RUNTIME_ROOT}`);
if (!fs.existsSync(RUNTIME_ROOT)) {
  console.log('(chưa tồn tại — app chưa chạy lần nào hoặc EMR_RUNTIME_ROOT trỏ sai chỗ)');
  process.exit(0);
}
const topSize = dirSizeApprox(RUNTIME_ROOT);
console.log(`Tổng dung lượng: ~${humanSize(topSize.total)}${topSize.truncated ? ' (ước lượng, kho rất lớn)' : ''} — ${topSize.count} file\n`);

walk(RUNTIME_ROOT, 0);
console.log(lines.join('\n'));

console.log('\n--- Gợi ý ---');
console.log('- Thư mục có nhiều bản ghi lặp lại (mã BN, case_key, run_id...) được gộp lại thành 1 dòng đếm, không in tên thật.');
console.log('- Tên file/thư mục có dãy từ 6 chữ số trở lên hoặc có chữ có dấu (mã BN, họ tên) được gộp theo phần đầu, không in tên thật.');
console.log('- Output không in nội dung file. Họ tên viết không dấu và không kèm số vẫn có thể lọt qua: đọc lại trước khi gửi ra ngoài.');
console.log('- Tăng --depth=N nếu muốn xem sâu hơn ở các thư mục không phải dạng bản ghi lặp lại.');
