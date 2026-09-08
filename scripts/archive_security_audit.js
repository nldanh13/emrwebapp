#!/usr/bin/env node
'use strict';

/**
 * Di chuyển (không xoá) các file security_audit_YYYYMM.jsonl đã cũ từ
 * .runtime/audit/ sang một thư mục lưu trữ khác, để giảm dung lượng trên ổ
 * đang chạy production mà không phá chuỗi hash chống sửa (mỗi file tháng có
 * chuỗi hash riêng — xem server/services/security_audit.js — nên archive
 * theo từng file tháng vẫn giữ nguyên khả năng verify).
 *
 * Mặc định chỉ DRY-RUN: liệt kê các file sẽ di chuyển, không đụng gì.
 *
 * Lệnh:
 *   node scripts/archive_security_audit.js
 *   node scripts/archive_security_audit.js --older-than-months=6 --apply
 *   node scripts/archive_security_audit.js --dest=/duong/dan/luu-tru --apply
 *   EMR_RUNTIME_ROOT=/duong/dan/khac node scripts/archive_security_audit.js
 */

const fs = require('fs');
const path = require('path');

const args = Object.fromEntries(
  process.argv.slice(2)
    .map(a => a.match(/^--([^=]+)(?:=(.*))?$/))
    .filter(Boolean)
    .map(m => [m[1], m[2] === undefined ? true : m[2]])
);

const APPLY = Boolean(args.apply);
const OLDER_THAN_MONTHS = Number(args['older-than-months'] || 6);

const ROOT_DIR = path.resolve(__dirname, '..');
const RUNTIME_ROOT = path.resolve(process.env.EMR_RUNTIME_ROOT || path.join(ROOT_DIR, '.runtime'));
const AUDIT_DIR = path.join(RUNTIME_ROOT, 'audit');
const DEST_DIR = path.resolve(args.dest || path.join(RUNTIME_ROOT, 'audit_archive'));

function humanSize(bytes) {
  if (!Number.isFinite(bytes)) return '?';
  const units = ['B', 'KB', 'MB', 'GB'];
  let n = bytes;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i += 1; }
  return `${n.toFixed(n >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
}

function monthKeyFromFilename(name) {
  const m = name.match(/^security_audit_(\d{6})\.jsonl$/);
  return m ? m[1] : null;
}

function monthKeyCutoff(monthsAgo) {
  const now = new Date();
  now.setUTCMonth(now.getUTCMonth() - monthsAgo);
  return `${now.getUTCFullYear()}${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
}

if (!fs.existsSync(AUDIT_DIR)) {
  console.log(`(Không thấy thư mục audit: ${AUDIT_DIR})`);
  process.exit(0);
}

const cutoff = monthKeyCutoff(OLDER_THAN_MONTHS);
const entries = fs.readdirSync(AUDIT_DIR, { withFileTypes: true })
  .filter(e => e.isFile())
  .map(e => e.name)
  .filter(name => {
    const key = monthKeyFromFilename(name);
    return key && key < cutoff;
  })
  .sort();

if (!entries.length) {
  console.log(`Không có file security_audit_*.jsonl nào cũ hơn ${OLDER_THAN_MONTHS} tháng (mốc: ${cutoff}).`);
  process.exit(0);
}

console.log(`Nguồn : ${AUDIT_DIR}`);
console.log(`Đích  : ${DEST_DIR}`);
console.log(`Mốc   : cũ hơn ${OLDER_THAN_MONTHS} tháng (< ${cutoff})`);
console.log(APPLY ? '\nSẽ DI CHUYỂN các file sau:' : '\nDRY-RUN — sẽ di chuyển các file sau nếu chạy thêm --apply:');

let total = 0;
for (const name of entries) {
  const size = fs.statSync(path.join(AUDIT_DIR, name)).size;
  total += size;
  console.log(`  - ${name} (${humanSize(size)})`);
}
console.log(`\nTổng: ${entries.length} file, ~${humanSize(total)}`);

if (!APPLY) {
  console.log('\n(Chưa di chuyển gì — thêm --apply để thực hiện.)');
  process.exit(0);
}

fs.mkdirSync(DEST_DIR, { recursive: true });
let moved = 0;
for (const name of entries) {
  const src = path.join(AUDIT_DIR, name);
  const dst = path.join(DEST_DIR, name);
  if (fs.existsSync(dst)) {
    console.warn(`  BỎ QUA (đã tồn tại ở đích): ${name}`);
    continue;
  }
  fs.renameSync(src, dst);
  moved += 1;
  console.log(`  OK -> ${dst}`);
}
console.log(`\nĐã di chuyển ${moved}/${entries.length} file.`);
