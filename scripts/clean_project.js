#!/usr/bin/env node
'use strict';

/**
 * Dọn các file sinh ra khi chạy app/test/build.
 *
 * Mặc định giữ config/config.json để không làm hỏng môi trường chạy thật.
 * Dùng --release khi muốn dọn để chia sẻ source ra ngoài: sẽ xóa thêm .env và config/config.json.
 *
 * Chạy:
 *   npm run clean:project
 *   npm run clean:project -- --release
 *   npm run clean:project -- --dry-run
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const args = new Set(process.argv.slice(2));
const DRY_RUN = args.has('--dry-run');
const RELEASE_MODE = args.has('--release');

const GENERATED_DIRS = [
  '.cleanup_backup',
  '.pytest_cache',
  '.runtime',
  '.ruff_cache',
  'coverage',
  'data',
  'debug',
  'debug_bundle',
  'dist',
  'logs',
  'release',
  'reports',
  'research_store',
  'care_baseline_store',
];

const GENERATED_FILE_PATTERNS = [
  /^cleanup_report(?:\.preview)?\.json$/,
  /^\.coverage(?:\..*)?$/,
  /^.*\.log$/i,
  /^.*\.py[co]$/i,
  /^.*\.pyd$/i,
  /^.*\.pdf$/i,
  /^data_raw\.json$/,
  /^data_sorted\.json$/,
  /^KetQua_YLenh\.json$/,
  /^DuLieu_PhanLoai\.json$/,
  /^data_phan_loai_chuan_.*\.json$/,
  /^_tmp_(?:in|out)_.*\.json$/,
  /^input_targets(?:_care)?_.*\.json$/,
  /^clinic_(?:request|preview|procedures)_.*\.json$/,
  /^clinic_targets\.xlsx$/,
  /^(?:input_care|input_infusions)_result\.json$/,
  /^(?:care|infusions)_done\.json$/,
  /^task_progress\.json$/,
];

const RELEASE_ONLY_FILES = ['.env', 'config/config.json', 'config/care_baseline.json'];
const RELEASE_ONLY_PATTERNS = [/^research\/.*\.csv$/i];
const REMOVED = [];

function toPosix(p) {
  return p.split(path.sep).join('/');
}

function rel(absPath) {
  return toPosix(path.relative(ROOT, absPath));
}

function insideRoot(absPath) {
  const resolved = path.resolve(absPath);
  return resolved === ROOT || resolved.startsWith(ROOT + path.sep);
}

function removePath(absPath) {
  if (!insideRoot(absPath) || absPath === ROOT) {
    throw new Error(`Từ chối xóa ngoài thư mục project: ${absPath}`);
  }
  if (!fs.existsSync(absPath)) return;
  REMOVED.push(rel(absPath));
  if (!DRY_RUN) fs.rmSync(absPath, { recursive: true, force: true });
}

function shouldRemoveFile(file) {
  const relative = rel(file);
  const name = path.basename(file);
  if (RELEASE_MODE && RELEASE_ONLY_FILES.includes(relative)) return true;
  if (GENERATED_FILE_PATTERNS.some(rx => rx.test(name))) return true;
  if (RELEASE_MODE && RELEASE_ONLY_PATTERNS.some(rx => rx.test(relative))) return true;
  return false;
}

function walk(dir) {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue;
      if (entry.name === '__pycache__') {
        removePath(full);
      } else {
        walk(full);
      }
    } else if (entry.isFile() && shouldRemoveFile(full)) {
      removePath(full);
    }
  }
}

function removeEmptyDirs(dir) {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory() && entry.name !== '.git' && entry.name !== 'node_modules') removeEmptyDirs(full);
  }
  if (dir !== ROOT && fs.existsSync(dir) && fs.readdirSync(dir).length === 0) removePath(dir);
}

for (const dirname of GENERATED_DIRS) {
  removePath(path.join(ROOT, dirname));
}
walk(ROOT);
removeEmptyDirs(ROOT);

const mode = RELEASE_MODE ? 'release' : 'local';
console.log(`[clean] Mode: ${mode}${DRY_RUN ? ' / dry-run' : ''}`);
console.log(`[clean] Đã ${DRY_RUN ? 'tìm thấy' : 'xóa'} ${REMOVED.length} mục.`);
for (const item of REMOVED.slice(0, 80)) console.log(`- ${item}`);
if (REMOVED.length > 80) console.log(`... và ${REMOVED.length - 80} mục khác`);
