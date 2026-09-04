#!/usr/bin/env node
'use strict';

/**
 * Quet toan bo project de tim file/thu muc khong can thiet va don dep an toan.
 *
 * Mac dinh chi DRY-RUN: khong xoa gi, chi tao cleanup_report.preview.json.
 * Khi --apply: chuyen file vao .cleanup_backup/<timestamp>/ de co the khoi phuc.
 * Chi xoa vinh vien khi them --permanent.
 *
 * Lenh hay dung:
 *   node scripts/clean_unused.js
 *   node scripts/clean_unused.js --apply
 *   node scripts/clean_unused.js --private-data --apply
 *   node scripts/clean_unused.js --unused-code
 *   node scripts/clean_unused.js --unused-code --confirm-unused-code --apply
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const argv = process.argv.slice(2);
const args = new Set(argv);

const HELP = args.has('--help') || args.has('-h');
const APPLY = args.has('--apply');
const PERMANENT = args.has('--permanent');
const VERBOSE = args.has('--verbose');
const JSON_ONLY = args.has('--json');
const INCLUDE_PRIVATE_DATA = args.has('--private-data') || args.has('--runtime-data');
const INCLUDE_DIST_ALL = args.has('--dist');
const INCLUDE_RELEASE_ARCHIVES = args.has('--release-archives') || args.has('--release');
const INCLUDE_UNUSED_CODE = args.has('--unused-code');
const CONFIRM_UNUSED_CODE = args.has('--confirm-unused-code');
const INCLUDE_EMPTY_DIRS = !args.has('--no-empty-dirs');

const SKIP_DIRS = new Set(['.git', 'node_modules', '.venv', '.cleanup_backup']);
const TEXT_EXTS = new Set(['.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.json', '.py', '.css', '.html', '.md']);
const JS_EXTS = ['.js', '.jsx', '.mjs', '.cjs', '.json'];
const PY_EXTS = ['.py'];

const candidates = new Map();

function usage() {
  console.log(`Dọn file không cần thiết cho EMR Dashboard\n\n` +
`Mặc định là dry-run, chỉ xem trước.\n\n` +
`Lệnh thường dùng:\n` +
`  npm run clean:unused\n` +
`  npm run clean:unused:apply\n` +
`  node scripts/clean_unused.js --private-data --apply\n` +
`  node scripts/clean_unused.js --unused-code\n` +
`  node scripts/clean_unused.js --unused-code --confirm-unused-code --apply\n\n` +
`Tùy chọn:\n` +
`  --apply                 Thực hiện dọn. Không có flag này thì chỉ xem trước.\n` +
`  --permanent             Xóa vĩnh viễn thay vì chuyển vào .cleanup_backup.\n` +
`  --private-data          Dọn runtime/data thật: .runtime, data, research_store, care_baseline_store, reports.\n` +
`  --dist                  Xóa toàn bộ dist; mặc định chỉ dọn asset build cũ không còn được dùng.\n` +
`  --release-archives      Dọn file zip/thư mục release cũ.\n` +
`  --unused-code           Quét code có khả năng không còn được import. Chỉ báo cáo nếu chưa có --confirm-unused-code.\n` +
`  --confirm-unused-code   Cho phép dọn cả nhóm potential-unused-code khi dùng --apply.\n` +
`  --no-empty-dirs         Không dọn thư mục rỗng.\n` +
`  --verbose               In đầy đủ danh sách.\n` +
`  --json                  Chỉ in JSON summary.\n`);
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

function stat(absPath) {
  try { return fs.statSync(absPath); } catch (_) { return null; }
}

function isDirectory(absPath) {
  const st = stat(absPath);
  return Boolean(st && st.isDirectory());
}

function isFile(absPath) {
  const st = stat(absPath);
  return Boolean(st && st.isFile());
}

function fileSize(absPath) {
  const st = stat(absPath);
  return st ? st.size : 0;
}

function mkdirp(absPath) {
  fs.mkdirSync(absPath, { recursive: true });
}

function timestamp() {
  const d = new Date();
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

const backupRoot = path.join(ROOT, '.cleanup_backup', timestamp());

function addCandidate(absPath, group, reason, options = {}) {
  const full = path.resolve(absPath);
  if (!insideRoot(full) || full === ROOT || !exists(full)) return;
  const relative = rel(full);
  if (!relative || relative === '.') return;
  if (relative.startsWith('.cleanup_backup/')) return;
  if (relative === 'cleanup_report.preview.json' || relative === 'cleanup_report.json') return;

  const current = candidates.get(relative);
  const item = {
    absPath: full,
    relative,
    group,
    reason,
    type: isDirectory(full) ? 'dir' : 'file',
    size: isDirectory(full) ? 0 : fileSize(full),
    safe: options.safe !== false,
    applyAllowed: options.applyAllowed !== false,
  };

  if (!current) {
    candidates.set(relative, item);
    return;
  }

  // Neu cung path bi bat o nhieu nhom, uu tien nhom kem an toan hon.
  if (current.safe && !item.safe) candidates.set(relative, item);
}

function walk(dir, onEntry) {
  if (!exists(dir) || !isDirectory(dir)) return;
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      onEntry(full, entry);
      walk(full, onEntry);
    } else if (entry.isFile()) {
      onEntry(full, entry);
    }
  }
}

function readText(absPath) {
  try { return fs.readFileSync(absPath, 'utf8'); } catch (_) { return ''; }
}

function addStaticGenerated() {
  const generatedDirs = [
    '.pytest_cache', '.ruff_cache', '.mypy_cache', '.cache', 'coverage',
    'debug', 'debug_bundle', 'logs',
  ];
  for (const dirname of generatedDirs) {
    addCandidate(path.join(ROOT, dirname), 'generated', 'Cache/log/debug sinh ra khi chạy app/test, không phải source chính.');
  }

  // release/_data_shape_bundle là thư mục tạm khi đóng gói, không cần giữ.
  addCandidate(path.join(ROOT, 'release', '_data_shape_bundle'), 'generated', 'Thư mục tạm sinh ra khi tạo data_shape_bundle.');

  walk(ROOT, (full, entry) => {
    const name = entry.name;
    const relative = rel(full);

    if (entry.isDirectory()) {
      if (name === '__pycache__') addCandidate(full, 'python-cache', 'Python __pycache__.');
      if (name === '.vite' || name === '.parcel-cache') addCandidate(full, 'frontend-cache', 'Cache build frontend.');
      return;
    }

    if (/\.py[co]$/i.test(name) || /\.pyd$/i.test(name)) addCandidate(full, 'python-cache', 'File bytecode/cache Python.');
    if (/^\.coverage(?:\..*)?$/.test(name)) addCandidate(full, 'test-cache', 'Coverage cache.');
    if (/\.log$/i.test(name)) addCandidate(full, 'log', 'File log sinh ra khi chạy app.');
    if (/\.(tmp|temp|swp)$/i.test(name)) addCandidate(full, 'temp', 'File tạm.');
    if (/\.(bak|orig|rej)$/i.test(name) || /\.bak\./i.test(name)) addCandidate(full, 'backup-temp', 'File backup/tạm.');
    if (name === '.DS_Store' || name === 'Thumbs.db') addCandidate(full, 'os-cache', 'File hệ điều hành sinh ra tự động.');
  });
}

function addPrivateRuntimeData() {
  if (!INCLUDE_PRIVATE_DATA) return;
  const privateDirs = [
    '.runtime', 'data', 'reports', 'research_store', 'care_baseline_store',
  ];
  for (const dirname of privateDirs) {
    addCandidate(path.join(ROOT, dirname), 'private-runtime-data', 'Dữ liệu runtime/dữ liệu bệnh nhân hoặc kết quả chạy thật; chỉ dọn khi đã sao lưu hoặc muốn đóng gói sạch.', { safe: false });
  }

  const privateFiles = [
    '.env', 'config/config.json', 'config/care_baseline.json',
    'data_raw.json', 'data_sorted.json', 'KetQua_YLenh.json', 'DuLieu_PhanLoai.json',
    'clinic_targets.xlsx', 'task_progress.json', 'care_done.json', 'infusions_done.json',
  ];
  for (const filename of privateFiles) {
    addCandidate(path.join(ROOT, filename), 'private-runtime-data', 'File cấu hình/dữ liệu thật không nên giữ khi chia sẻ project.', { safe: false });
  }

  walk(ROOT, (full, entry) => {
    if (!entry.isFile()) return;
    const name = entry.name;
    const relative = rel(full);
    if (/^research\/.*\.csv$/i.test(relative)) addCandidate(full, 'private-runtime-data', 'CSV nghiên cứu có thể chứa dữ liệu thật.', { safe: false });
    if (/^data_phan_loai_chuan_.*\.json$/i.test(name)) addCandidate(full, 'private-runtime-data', 'Dữ liệu phân loại runtime.', { safe: false });
    if (/^_tmp_(?:in|out)_.*\.json$/i.test(name)) addCandidate(full, 'private-runtime-data', 'File input/output tạm runtime.', { safe: false });
    if (/^input_targets(?:_care)?_.*\.json$/i.test(name)) addCandidate(full, 'private-runtime-data', 'Target nhập liệu runtime.', { safe: false });
    if (/^clinic_(?:request|preview|procedures)_.*\.json$/i.test(name)) addCandidate(full, 'private-runtime-data', 'File clinic runtime.', { safe: false });
    if (/^(?:input_care|input_infusions)_result\.json$/i.test(name)) addCandidate(full, 'private-runtime-data', 'Kết quả nhập liệu runtime.', { safe: false });
  });
}

function addReleaseArchives() {
  if (!INCLUDE_RELEASE_ARCHIVES) return;
  const releaseDir = path.join(ROOT, 'release');
  addCandidate(releaseDir, 'release-archive', 'Thư mục zip bàn giao cũ; có thể tạo lại bằng npm run package:clean.');
  walk(ROOT, (full, entry) => {
    if (!entry.isFile()) return;
    const relative = rel(full);
    if (/^release\/.*\.zip$/i.test(relative) || /emr_dashboard.*\.zip$/i.test(entry.name)) {
      addCandidate(full, 'release-archive', 'File zip bàn giao cũ; có thể tạo lại khi cần.');
    }
  });
}

function addDistCleanup() {
  const distDir = path.join(ROOT, 'dist');
  if (!exists(distDir)) return;

  if (INCLUDE_DIST_ALL) {
    addCandidate(distDir, 'build-output', 'Thư mục build frontend; có thể tạo lại bằng npm run build.');
    return;
  }

  const indexPath = path.join(distDir, 'index.html');
  const assetsDir = path.join(distDir, 'assets');
  if (!exists(indexPath) || !exists(assetsDir) || !isDirectory(assetsDir)) return;
  const html = readText(indexPath);
  for (const entry of fs.readdirSync(assetsDir, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const full = path.join(assetsDir, entry.name);
    if (!html.includes(entry.name)) {
      addCandidate(full, 'build-stale', 'Asset build cũ không còn được dist/index.html tham chiếu.');
    }
  }
}

function candidateExtensionsForImport(base, exts) {
  const out = [];
  const ext = path.extname(base);
  if (ext) out.push(base);
  else {
    for (const e of exts) out.push(base + e);
    for (const e of exts) out.push(path.join(base, 'index' + e));
  }
  return out;
}

function resolveRelativeImport(fromFile, spec, exts) {
  if (!spec.startsWith('.')) return null;
  const base = path.resolve(path.dirname(fromFile), spec);
  for (const candidate of candidateExtensionsForImport(base, exts)) {
    if (exists(candidate) && isFile(candidate)) return candidate;
  }
  return null;
}

function extractJsImports(text) {
  const specs = [];
  const patterns = [
    /import\s+(?:[^'";]+?\s+from\s+)?['"]([^'"]+)['"]/g,
    /export\s+[^'";]+?\s+from\s+['"]([^'"]+)['"]/g,
    /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /import\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  ];
  for (const rx of patterns) {
    let m;
    while ((m = rx.exec(text))) specs.push(m[1]);
  }
  return specs;
}

function extractPyImports(text, filePath) {
  const specs = [];
  const dir = path.dirname(filePath);
  const rxImport = /^\s*import\s+([a-zA-Z_][\w.]*)(?:\s+as\s+\w+)?/gm;
  const rxFrom = /^\s*from\s+([.]?[\w.]+)\s+import\s+(.+)$/gm;
  let m;

  while ((m = rxImport.exec(text))) {
    const mod = m[1];
    specs.push({ type: 'module', name: mod });
  }

  while ((m = rxFrom.exec(text))) {
    const mod = m[1];
    const names = m[2].split(',').map(s => s.trim().split(/\s+as\s+/)[0]).filter(Boolean);
    if (mod.startsWith('.')) {
      const dots = mod.match(/^\.+/)[0].length;
      const rest = mod.slice(dots);
      let baseDir = dir;
      for (let i = 1; i < dots; i++) baseDir = path.dirname(baseDir);
      if (rest) specs.push({ type: 'path', base: path.join(baseDir, ...rest.split('.')) });
      for (const name of names) specs.push({ type: 'path', base: path.join(baseDir, ...(rest ? rest.split('.') : []), name) });
    } else {
      specs.push({ type: 'module', name: mod });
    }
  }
  return specs;
}

function collectFilesUnder(dirs, exts) {
  const out = [];
  for (const dirname of dirs) {
    const root = path.join(ROOT, dirname);
    if (isFile(root)) {
      if (exts.includes(path.extname(root))) out.push(root);
      continue;
    }
    walk(root, (full, entry) => {
      if (!entry.isFile()) return;
      if (exts.includes(path.extname(full))) out.push(full);
    });
  }
  return Array.from(new Set(out.map(p => path.resolve(p))));
}

function markReachableJs(roots, allFiles) {
  const allSet = new Set(allFiles.map(p => path.resolve(p)));
  const seen = new Set();
  const stack = roots.filter(Boolean).map(p => path.resolve(p)).filter(p => allSet.has(p));

  while (stack.length) {
    const file = stack.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    for (const spec of extractJsImports(readText(file))) {
      const resolved = resolveRelativeImport(file, spec, JS_EXTS);
      if (resolved && allSet.has(path.resolve(resolved)) && !seen.has(path.resolve(resolved))) stack.push(path.resolve(resolved));
    }
  }
  return seen;
}

function markReachablePy(roots, allFiles) {
  const allSet = new Set(allFiles.map(p => path.resolve(p)));
  const byStem = new Map();
  const byModule = new Map();
  for (const file of allFiles) {
    const resolved = path.resolve(file);
    const stem = path.basename(file, '.py');
    if (!byStem.has(stem)) byStem.set(stem, []);
    byStem.get(stem).push(resolved);

    const relative = rel(resolved);
    if (relative.startsWith('worker/')) {
      const noExt = relative.slice('worker/'.length).replace(/\.py$/, '').replace(/\//g, '.');
      byModule.set(noExt, resolved);
      if (noExt.endsWith('.__init__')) {
        byModule.set(noExt.slice(0, -'.__init__'.length), resolved);
      }
    }
  }

  const seen = new Set();
  const stack = roots.filter(Boolean).map(p => path.resolve(p)).filter(p => allSet.has(p));
  while (stack.length) {
    const file = stack.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    for (const spec of extractPyImports(readText(file), file)) {
      const targets = [];
      if (spec.type === 'path') {
        for (const candidate of candidateExtensionsForImport(spec.base, PY_EXTS)) {
          if (allSet.has(path.resolve(candidate))) targets.push(path.resolve(candidate));
        }
      } else if (spec.type === 'module') {
        if (byModule.has(spec.name)) targets.push(byModule.get(spec.name));
        const lastName = spec.name.split('.').pop();
        for (const target of byStem.get(lastName) || []) targets.push(target);
      }
      for (const target of targets) if (!seen.has(target)) stack.push(target);
    }
  }
  return seen;
}

function packageScriptFileNames() {
  const pkgPath = path.join(ROOT, 'package.json');
  if (!exists(pkgPath)) return new Set();
  let pkg = {};
  try { pkg = JSON.parse(readText(pkgPath)); } catch (_) { return new Set(); }
  const text = Object.values(pkg.scripts || {}).join('\n');
  const result = new Set();
  const rx = /(?:node|tsx|vite-node)\s+([^\s;&|]+)/g;
  let m;
  while ((m = rx.exec(text))) {
    const p = m[1].replace(/^['"]|['"]$/g, '');
    if (p.startsWith('scripts/') || p === 'server.js' || p.startsWith('server/')) result.add(path.resolve(ROOT, p));
  }
  return result;
}

function addPotentialUnusedCode() {
  if (!INCLUDE_UNUSED_CODE) return;

  const jsFiles = collectFilesUnder(['server.js', 'vite.config.js', 'src', 'server', 'scripts'], JS_EXTS.filter(e => e !== '.json'));
  const roots = new Set([
    path.join(ROOT, 'server.js'),
    path.join(ROOT, 'vite.config.js'),
    path.join(ROOT, 'src/main.jsx'),
    path.join(ROOT, 'src/index.js'),
    path.join(ROOT, 'src/App.jsx'),
    ...packageScriptFileNames(),
  ].map(p => path.resolve(p)));

  // Tat ca scripts/*.js la entrypoint tiem nang; khong tu xoa script chi vi khong import.
  for (const file of jsFiles) {
    const r = rel(file);
    if (/^scripts\/[^/]+\.(js|mjs|cjs)$/.test(r)) roots.add(path.resolve(file));
  }

  const reachableJs = markReachableJs(Array.from(roots), jsFiles);
  for (const file of jsFiles) {
    const r = rel(file);
    if (r.startsWith('scripts/')) continue;
    if (r.startsWith('server/routes/')) continue; // Express route co the dang duoc require dong hoac dang cho import bang registry.
    if (reachableJs.has(path.resolve(file))) continue;
    addCandidate(file, 'potential-unused-code', 'File JS/JSX không nằm trong import graph từ entrypoint chính; cần xem lại trước khi xóa.', {
      safe: false,
      applyAllowed: CONFIRM_UNUSED_CODE,
    });
  }

  const pyFiles = collectFilesUnder(['worker'], PY_EXTS);
  // Worker top-level thuong duoc server spawn truc tiep theo ten file, nen coi la entrypoint.
  const pyRoots = pyFiles.filter(file => {
    const r = rel(file);
    return /^worker\/[^/]+\.py$/.test(r);
  });
  const reachablePy = markReachablePy(pyRoots, pyFiles);
  for (const file of pyFiles) {
    const r = rel(file);
    if (/^worker\/[^/]+\.py$/.test(r)) continue;
    if (path.basename(file) === '__init__.py') continue;
    if (reachablePy.has(path.resolve(file))) continue;
    addCandidate(file, 'potential-unused-code', 'File Python không được import từ các worker entrypoint; cần xem lại trước khi xóa.', {
      safe: false,
      applyAllowed: CONFIRM_UNUSED_CODE,
    });
  }
}

function addEmptyDirs() {
  if (!INCLUDE_EMPTY_DIRS) return;
  const dirs = [];
  walk(ROOT, (full, entry) => {
    if (entry.isDirectory()) dirs.push(full);
  });
  dirs.sort((a, b) => b.length - a.length);
  for (const dir of dirs) {
    if (!exists(dir) || !isDirectory(dir)) continue;
    const relative = rel(dir);
    if (relative.startsWith('.cleanup_backup/')) continue;
    if (SKIP_DIRS.has(path.basename(dir))) continue;
    let entries = [];
    try { entries = fs.readdirSync(dir); } catch (_) { continue; }
    if (entries.length === 0) addCandidate(dir, 'empty-dir', 'Thư mục rỗng.');
  }
}

function parentCovered(item, selectedRels) {
  const parts = item.relative.split('/');
  for (let i = 1; i < parts.length; i++) {
    const parent = parts.slice(0, i).join('/');
    if (selectedRels.has(parent)) return true;
  }
  return false;
}

function selectedItems() {
  const all = Array.from(candidates.values())
    .filter(item => !(APPLY && !item.applyAllowed))
    .sort((a, b) => a.relative.localeCompare(b.relative, 'vi'));

  const rels = new Set(all.map(i => i.relative));
  return all.filter(item => !parentCovered(item, rels));
}

function moveToBackup(item) {
  const dest = path.join(backupRoot, item.relative);
  if (!insideRoot(dest)) throw new Error(`Đường dẫn backup không an toàn: ${dest}`);
  mkdirp(path.dirname(dest));
  fs.renameSync(item.absPath, dest);
}

function removePermanent(item) {
  fs.rmSync(item.absPath, { recursive: true, force: true });
}

function applyCleanup(items) {
  if (!APPLY) return;
  if (!PERMANENT) mkdirp(backupRoot);
  for (const item of items) {
    if (!exists(item.absPath)) continue;
    if (PERMANENT) removePermanent(item);
    else moveToBackup(item);
  }
}

function writeReport(items, skippedUnsafe) {
  const report = {
    createdAt: new Date().toISOString(),
    root: ROOT,
    mode: APPLY ? (PERMANENT ? 'permanent-delete' : 'move-to-backup') : 'dry-run',
    backupDir: APPLY && !PERMANENT ? rel(backupRoot) : null,
    options: {
      privateData: INCLUDE_PRIVATE_DATA,
      dist: INCLUDE_DIST_ALL,
      releaseArchives: INCLUDE_RELEASE_ARCHIVES,
      unusedCode: INCLUDE_UNUSED_CODE,
      confirmUnusedCode: CONFIRM_UNUSED_CODE,
      emptyDirs: INCLUDE_EMPTY_DIRS,
    },
    total: items.length,
    skippedUnsafe: skippedUnsafe.map(({ relative, group, reason, type }) => ({ path: relative, group, reason, type })),
    items: items.map(({ relative, group, reason, type, size, safe, applyAllowed }) => ({ path: relative, group, reason, type, size, safe, applyAllowed })),
  };

  const reportPath = APPLY && !PERMANENT
    ? path.join(backupRoot, 'cleanup_report.json')
    : path.join(ROOT, 'cleanup_report.preview.json');
  mkdirp(path.dirname(reportPath));
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf8');
  return { report, reportPath };
}

function formatBytes(n) {
  if (!Number.isFinite(n) || n <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = n;
  let idx = 0;
  while (value >= 1024 && idx < units.length - 1) {
    value /= 1024;
    idx += 1;
  }
  return `${value.toFixed(idx === 0 ? 0 : 1)} ${units[idx]}`;
}

function printSummary(items, skippedUnsafe, reportPath) {
  const groupCount = new Map();
  const groupSize = new Map();
  for (const item of items) {
    groupCount.set(item.group, (groupCount.get(item.group) || 0) + 1);
    groupSize.set(item.group, (groupSize.get(item.group) || 0) + item.size);
  }

  if (JSON_ONLY) {
    console.log(JSON.stringify({ total: items.length, groups: Object.fromEntries(groupCount), report: rel(reportPath) }, null, 2));
    return;
  }

  console.log(`[clean-unused] Root: ${ROOT}`);
  console.log(`[clean-unused] Mode: ${APPLY ? (PERMANENT ? 'XÓA VĨNH VIỄN' : 'CHUYỂN VÀO BACKUP') : 'DRY-RUN / CHỈ XEM TRƯỚC'}`);
  if (APPLY && !PERMANENT) console.log(`[clean-unused] Backup: ${rel(backupRoot)}`);
  console.log(`[clean-unused] Tìm thấy ${items.length} mục có thể dọn.`);

  for (const [group, count] of Array.from(groupCount.entries()).sort()) {
    console.log(`  - ${group}: ${count} (${formatBytes(groupSize.get(group) || 0)})`);
  }

  if (skippedUnsafe.length) {
    console.log(`[clean-unused] Bỏ qua ${skippedUnsafe.length} mục chưa được xác nhận để dọn khi --apply.`);
  }

  const limit = VERBOSE ? items.length : Math.min(items.length, 160);
  for (const item of items.slice(0, limit)) {
    const mark = item.safe ? '' : ' / CẦN XEM LẠI';
    console.log(`- [${item.group}${mark}] ${item.relative} :: ${item.reason}`);
  }
  if (items.length > limit) console.log(`... còn ${items.length - limit} mục khác. Dùng --verbose để xem hết.`);

  console.log(`[clean-unused] Report: ${rel(reportPath)}`);
  if (!APPLY) {
    console.log('\nChưa xóa gì. Nếu danh sách đúng, chạy lại với --apply.');
  } else if (!PERMANENT) {
    console.log('\nĐã chuyển các mục vào .cleanup_backup. Có thể khôi phục bằng cách copy từ backup về lại vị trí cũ.');
  } else {
    console.log('\nĐã xóa vĩnh viễn các mục đã liệt kê.');
  }

  if (INCLUDE_UNUSED_CODE && !CONFIRM_UNUSED_CODE) {
    console.log('\nGhi chú: nhóm potential-unused-code chỉ được báo cáo. Muốn dọn nhóm này cần thêm --confirm-unused-code.');
  }
}

addStaticGenerated();
addPrivateRuntimeData();
addReleaseArchives();
addDistCleanup();
addPotentialUnusedCode();
addEmptyDirs();

const allSelected = selectedItems();
const skippedUnsafe = Array.from(candidates.values())
  .filter(item => APPLY && !item.applyAllowed)
  .sort((a, b) => a.relative.localeCompare(b.relative, 'vi'));

const { reportPath } = writeReport(allSelected, skippedUnsafe);
applyCleanup(allSelected);
printSummary(allSelected, skippedUnsafe, reportPath);
