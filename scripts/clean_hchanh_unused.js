#!/usr/bin/env node
'use strict';

/**
 * Dọn file dư/thừa cho project EMR Dashboard, ưu tiên module Hành chánh.
 *
 * Mặc định chỉ chạy DRY-RUN: không xóa gì, chỉ liệt kê.
 * Khi dùng --apply, script sẽ CHUYỂN file vào .cleanup_backup/<timestamp>/,
 * không xóa vĩnh viễn. Muốn xóa vĩnh viễn phải thêm --permanent.
 *
 * Chạy an toàn:
 *   node scripts/clean_hchanh_unused.js
 *   node scripts/clean_hchanh_unused.js --apply
 *
 * Dọn thêm dữ liệu Hành chánh cũ:
 *   node scripts/clean_hchanh_unused.js --hchanh-data
 *   node scripts/clean_hchanh_unused.js --hchanh-data --apply
 *
 * Dọn thêm code Hành chánh đã bỏ UI/không còn được import:
 *   node scripts/clean_hchanh_unused.js --unused-code
 *   node scripts/clean_hchanh_unused.js --unused-code --apply
 *
 * Dọn runtime nhạy cảm/cookie/session để đóng gói sạch:
 *   node scripts/clean_hchanh_unused.js --runtime --apply
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const args = new Set(process.argv.slice(2));

const APPLY = args.has('--apply');
const PERMANENT = args.has('--permanent');
const INCLUDE_RUNTIME = args.has('--runtime');
const INCLUDE_HCHANH_DATA = args.has('--hchanh-data');
const INCLUDE_UNUSED_CODE = args.has('--unused-code');
const INCLUDE_DIST_ALL = args.has('--dist');
const VERBOSE = args.has('--verbose');
const HELP = args.has('--help') || args.has('-h');

const SKIP_DIRS = new Set(['.git', 'node_modules', '.venv', '.cleanup_backup']);
const TEXT_EXTS = new Set(['.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.json', '.py']);

function usage() {
  console.log(`Dọn file dư/thừa cho EMR Dashboard / Hành chánh\n\n` +
`Mặc định: dry-run, chỉ liệt kê.\n\n` +
`Lệnh thường dùng:\n` +
`  node scripts/clean_hchanh_unused.js\n` +
`  node scripts/clean_hchanh_unused.js --apply\n` +
`  node scripts/clean_hchanh_unused.js --hchanh-data --apply\n` +
`  node scripts/clean_hchanh_unused.js --unused-code --apply\n` +
`  node scripts/clean_hchanh_unused.js --runtime --apply\n\n` +
`Tùy chọn:\n` +
`  --apply         Thực hiện dọn. Không có flag này thì chỉ xem trước.\n` +
`  --permanent     Xóa vĩnh viễn thay vì chuyển vào .cleanup_backup.\n` +
`  --hchanh-data   Dọn dữ liệu Hành chánh cũ: cls.json, documents.json, file legacy nếu đã có file chuẩn.\n` +
`  --unused-code   Dọn file code Hành chánh không còn được import.\n` +
`  --runtime       Dọn toàn bộ .runtime, data, research_store; có thể mất cookie/session/dữ liệu BN.\n` +
`  --dist          Dọn toàn bộ dist thay vì chỉ xóa asset build cũ không còn được index.html dùng.\n` +
`  --verbose       In chi tiết hơn.\n`);
}

if (HELP) {
  usage();
  process.exit(0);
}

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

function exists(absPath) {
  try { return fs.existsSync(absPath); } catch (_) { return false; }
}

function isDirectory(absPath) {
  try { return fs.statSync(absPath).isDirectory(); } catch (_) { return false; }
}

function mkdirp(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function timestamp() {
  const d = new Date();
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth()+1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

const backupRoot = path.join(ROOT, '.cleanup_backup', timestamp());
const candidates = new Map();

function addCandidate(absPath, group, reason) {
  const full = path.resolve(absPath);
  if (!insideRoot(full) || full === ROOT || !exists(full)) return;
  const relative = rel(full);
  if (!relative || relative === '.') return;
  if (relative.startsWith('.cleanup_backup/')) return;
  if (candidates.has(relative)) return;
  candidates.set(relative, { absPath: full, relative, group, reason, type: isDirectory(full) ? 'dir' : 'file' });
}

function walk(dir, onEntry) {
  if (!exists(dir) || !isDirectory(dir)) return;
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    const relative = rel(full);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      onEntry(full, entry);
      walk(full, onEntry);
    } else if (entry.isFile()) {
      onEntry(full, entry);
    }
  }
}

function addStaticGenerated() {
  const dirs = [
    '.pytest_cache', '.ruff_cache', '.mypy_cache', 'coverage', 'debug', 'debug_bundle',
    'logs', 'release', 'reports',
  ];
  for (const d of dirs) addCandidate(path.join(ROOT, d), 'generated', 'Thư mục sinh ra khi chạy/test/debug, không phải source chính.');

  walk(ROOT, (full, entry) => {
    const name = entry.name;
    const relative = rel(full);

    if (entry.isDirectory()) {
      if (name === '__pycache__') addCandidate(full, 'python-cache', 'Python __pycache__.');
      if (relative === '.runtime/logs') addCandidate(full, 'runtime-log', 'Log runtime, không chứa source.');
      if (/^\.runtime\/sessions\/[^/]+\/data\/logs$/.test(relative)) addCandidate(full, 'runtime-log', 'Log của phiên chạy cũ.');
      if (/^\.runtime\/sessions\/[^/]+\/debug$/.test(relative)) addCandidate(full, 'runtime-debug', 'HTML/ảnh debug của phiên chạy cũ.');
      return;
    }

    if (/\.py[co]$/i.test(name) || /\.pyd$/i.test(name)) addCandidate(full, 'python-cache', 'File bytecode/cache Python.');
    if (/\.bak(?:\.json)?$/i.test(name) || /\.tmp$/i.test(name)) addCandidate(full, 'backup-temp', 'File backup/tạm.');
    if (/^\.coverage(?:\..*)?$/.test(name)) addCandidate(full, 'test-cache', 'Coverage cache.');
    if (/^activity_\d+\.(log|jsonl)$/i.test(name) && relative.startsWith('.runtime/logs/')) addCandidate(full, 'runtime-log', 'Activity log cũ.');
  });
}

function addDistCleanup() {
  const distDir = path.join(ROOT, 'dist');
  if (!exists(distDir)) return;
  if (INCLUDE_DIST_ALL) {
    addCandidate(distDir, 'build', 'Xóa toàn bộ dist; npm start/npm run build có thể tạo lại.');
    return;
  }
  const indexPath = path.join(distDir, 'index.html');
  const assetsDir = path.join(distDir, 'assets');
  if (!exists(indexPath) || !exists(assetsDir) || !isDirectory(assetsDir)) return;
  let html = '';
  try { html = fs.readFileSync(indexPath, 'utf8'); } catch (_) { return; }
  for (const entry of fs.readdirSync(assetsDir, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const full = path.join(assetsDir, entry.name);
    if (!html.includes(entry.name)) addCandidate(full, 'build-stale', 'Asset build cũ không còn được dist/index.html tham chiếu.');
  }
}

function addRuntimeDangerous() {
  if (!INCLUDE_RUNTIME) return;
  for (const p of ['.runtime', 'data', 'research_store']) {
    addCandidate(path.join(ROOT, p), 'runtime-private', 'Dọn runtime/session/dữ liệu chạy thật. Có thể cần đăng nhập/lấy dữ liệu lại.');
  }
}

function addHchanhLegacyData() {
  if (!INCLUDE_HCHANH_DATA) return;

  const mapping = [
    ['profile.json', 'thong_tin_nen.json'],
    ['discharge.json', 'ra_vien.json'],
    ['billing.json', 'bang_ke.json'],
    ['bed_days.json', 'ngay_giuong.json'],
    ['surgery.json', 'phau_thuat.json'],
    ['order_history.json', 'lich_su_y_lenh.json'],
  ];

  walk(path.join(ROOT, '.runtime'), (full, entry) => {
    if (!entry.isFile()) return;
    const name = entry.name;
    const relative = rel(full);

    if (/\/hchanh\/patients\/[^/]+\/(cls|documents)\.json$/i.test(relative)) {
      addCandidate(full, 'hchanh-obsolete-data', 'Hành chánh hiện đã bỏ CLS/documents khỏi luồng ra viện.');
      return;
    }

    if (/\/hchanh\/(fetch_input|fetch_output)_[^/]+\.json$/i.test(relative)) {
      addCandidate(full, 'hchanh-temp', 'File input/output tạm của worker Hành chánh.');
      return;
    }

    if (!/\/hchanh\/patients\/[^/]+\/[^/]+\.json$/i.test(relative)) return;
    for (const [oldName, newName] of mapping) {
      if (name !== oldName) continue;
      const newPath = path.join(path.dirname(full), newName);
      if (exists(newPath)) {
        addCandidate(full, 'hchanh-legacy-duplicate', `File legacy ${oldName} đã có bản chuẩn ${newName}.`);
      }
    }
  });
}

function shouldScanTextFile(full) {
  const ext = path.extname(full).toLowerCase();
  if (!TEXT_EXTS.has(ext)) return false;
  const relative = rel(full);
  return !relative.startsWith('dist/') && !relative.startsWith('.runtime/') && !relative.startsWith('release/') && !relative.startsWith('logs/');
}

function fileContainsAny(full, needles) {
  try {
    const text = fs.readFileSync(full, 'utf8');
    return needles.some(n => text.includes(n));
  } catch (_) {
    return false;
  }
}

function hasExternalReference(targetAbs, needles) {
  let found = false;
  walk(ROOT, (full, entry) => {
    if (found || !entry.isFile()) return;
    if (path.resolve(full) === path.resolve(targetAbs)) return;
    if (rel(full) === 'scripts/clean_hchanh_unused.js') return;
    if (!shouldScanTextFile(full)) return;
    if (fileContainsAny(full, needles)) found = true;
  });
  return found;
}

function addUnusedCode() {
  if (!INCLUDE_UNUSED_CODE) return;

  const hchanhLogic = path.join(ROOT, 'server/services/hchanh/logic.js');
  if (exists(hchanhLogic)) {
    const referenced = hasExternalReference(hchanhLogic, [
      "services/hchanh/logic",
      "buildHchanhLogic",
      "bedHintForSurgeryClass",
    ]);
    if (!referenced) {
      addCandidate(hchanhLogic, 'unused-code', 'File logic Hành chánh cũ không còn được import sau khi bỏ tab Logic.');
    }
  }
}

function moveToBackup(item) {
  const dest = path.join(backupRoot, item.relative);
  if (!insideRoot(dest)) throw new Error(`Đường dẫn backup không an toàn: ${dest}`);
  mkdirp(path.dirname(dest));
  fs.renameSync(item.absPath, dest);
}

function deletePermanent(item) {
  fs.rmSync(item.absPath, { recursive: true, force: true });
}

function applyCandidates(items) {
  if (!APPLY) return;
  if (!PERMANENT) mkdirp(backupRoot);
  for (const item of items) {
    if (!exists(item.absPath)) continue;
    if (PERMANENT) deletePermanent(item);
    else moveToBackup(item);
  }
}

function makeReport(items) {
  const report = {
    createdAt: new Date().toISOString(),
    root: ROOT,
    mode: APPLY ? (PERMANENT ? 'permanent-delete' : 'move-to-backup') : 'dry-run',
    backupDir: APPLY && !PERMANENT ? rel(backupRoot) : null,
    options: {
      hchanhData: INCLUDE_HCHANH_DATA,
      unusedCode: INCLUDE_UNUSED_CODE,
      runtime: INCLUDE_RUNTIME,
      dist: INCLUDE_DIST_ALL,
    },
    total: items.length,
    items: items.map(({ relative, group, reason, type }) => ({ path: relative, group, reason, type })),
  };

  const outPath = path.join(ROOT, APPLY && !PERMANENT ? backupRoot : ROOT, APPLY && !PERMANENT ? 'cleanup_report.json' : 'cleanup_report.preview.json');
  try {
    if (APPLY && !PERMANENT) mkdirp(backupRoot);
    fs.writeFileSync(outPath, JSON.stringify(report, null, 2), 'utf8');
    return outPath;
  } catch (_) {
    return null;
  }
}

addStaticGenerated();
addDistCleanup();
addRuntimeDangerous();
addHchanhLegacyData();
addUnusedCode();

const items = Array.from(candidates.values()).sort((a, b) => a.relative.localeCompare(b.relative, 'vi'));

console.log(`[clean-hchanh] Root: ${ROOT}`);
console.log(`[clean-hchanh] Mode: ${APPLY ? (PERMANENT ? 'XÓA VĨNH VIỄN' : 'CHUYỂN VÀO BACKUP') : 'DRY-RUN / CHỈ XEM TRƯỚC'}`);
if (APPLY && !PERMANENT) console.log(`[clean-hchanh] Backup: ${rel(backupRoot)}`);
console.log(`[clean-hchanh] Tìm thấy ${items.length} mục có thể dọn.`);

const groupCount = new Map();
for (const item of items) groupCount.set(item.group, (groupCount.get(item.group) || 0) + 1);
for (const [group, count] of Array.from(groupCount.entries()).sort()) console.log(`  - ${group}: ${count}`);

const limit = VERBOSE ? items.length : Math.min(items.length, 120);
for (const item of items.slice(0, limit)) {
  console.log(`- [${item.group}] ${item.relative} :: ${item.reason}`);
}
if (items.length > limit) console.log(`... còn ${items.length - limit} mục khác. Dùng --verbose để xem hết.`);

applyCandidates(items);
const reportPath = makeReport(items);
if (reportPath) console.log(`[clean-hchanh] Report: ${rel(reportPath)}`);

if (!APPLY) {
  console.log('\nChưa xóa gì. Nếu danh sách đúng, chạy lại với --apply.');
} else if (!PERMANENT) {
  console.log('\nĐã chuyển các mục vào .cleanup_backup. Nếu cần khôi phục, copy từ thư mục backup về lại vị trí cũ.');
} else {
  console.log('\nĐã xóa vĩnh viễn các mục đã liệt kê.');
}
