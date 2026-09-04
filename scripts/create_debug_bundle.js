#!/usr/bin/env node
/*
  Tạo gói debug để gửi kèm source code khi cần kiểm tra lỗi.
  Mặc định script sẽ:
  - Gom log gần đây, nhưng cố gắng ẩn thông tin nhạy cảm theo key phổ biến.
  - Tạo summary cho data/runtime thay vì đóng gói toàn bộ dữ liệu bệnh nhân.
  - Gom source code cần thiết để đối chiếu UI ↔ API ↔ worker.

  Cách chạy:
    npm run debug:bundle
    npm run debug:bundle -- --no-source
    npm run debug:bundle -- --raw-logs
    npm run debug:bundle -- --include-data-samples
*/

const fs = require('fs');
const path = require('path');
const os = require('os');
const cp = require('child_process');

const ROOT = process.cwd();
const args = new Set(process.argv.slice(2));

const options = {
  includeSource: !args.has('--no-source'),
  includeLogs: !args.has('--no-logs'),
  includeDataSamples: args.has('--include-data-samples'),
  rawLogs: args.has('--raw-logs'),
  rawData: args.has('--raw-data'),
};

const now = new Date();
const stamp = formatStamp(now);
const outRoot = path.join(ROOT, 'debug_bundle');
const bundleDir = path.join(outRoot, `debug_${stamp}`);
const zipPath = path.join(outRoot, `debug_${stamp}.zip`);

const MAX_TEXT_BYTES = 2 * 1024 * 1024;
const MAX_LOG_FILES = 80;
const MAX_SOURCE_FILE_BYTES = 1.5 * 1024 * 1024;
const MAX_JSON_RECORD_SAMPLES = 5;

const IGNORE_DIRS = new Set([
  'node_modules', '.git', '.venv', 'venv', 'env', '__pycache__', '.pytest_cache',
  'dist', 'release', 'debug_bundle', '.runtime', 'logs', 'reports',
]);

const SOURCE_DIRS = ['server', 'src', 'worker', 'scripts', 'tests', 'config'];
const SOURCE_ROOT_FILES = [
  'package.json', 'package-lock.json', 'vite.config.js', 'server.js',
  'requirements.txt', 'index.html', '.gitignore',
];

const DATA_DIRS = ['data', 'debug', '.runtime'];
const LOG_DIRS = ['logs', '.runtime'];

main();

function main() {
  safeRm(bundleDir);
  ensureDir(bundleDir);
  ensureDir(outRoot);

  const manifest = {
    created_at: now.toISOString(),
    app_root: ROOT,
    options,
    environment: collectEnvironment(),
    package: readJsonIfExists(path.join(ROOT, 'package.json')),
    files: [],
    warnings: [],
    next_steps: [
      'Gửi file zip debug này kèm file code khi báo lỗi.',
      'Điền thêm notes/MO_TA_LOI.md nếu lỗi cần mô tả thao tác.',
      'Không gửi dữ liệu bệnh nhân thật nếu chưa được phép chia sẻ.',
    ],
  };

  writeText(path.join(bundleDir, 'README_GUI_GOI_DEBUG.md'), buildReadme(stamp));
  writeText(path.join(bundleDir, 'notes', 'MO_TA_LOI.md'), buildBugTemplate());

  if (options.includeSource) {
    copySource(manifest);
  }

  if (options.includeLogs) {
    copyLogs(manifest);
  } else {
    manifest.warnings.push('Đã bỏ qua log vì có --no-logs.');
  }

  collectDataSummaries(manifest);
  collectRuntimeIndex(manifest);

  writeJson(path.join(bundleDir, 'manifest.json'), manifest);

  const zipped = tryCreateZip(bundleDir, zipPath);
  const relBundle = path.relative(ROOT, bundleDir);
  const relZip = path.relative(ROOT, zipPath);

  console.log('');
  console.log('Đã tạo gói debug:');
  console.log(`- Thư mục: ${relBundle}`);
  if (zipped) console.log(`- Zip: ${relZip}`);
  else console.log('- Không nén zip được trên máy này; hãy nén thủ công thư mục ở trên.');
  console.log('');
  console.log('Khi gửi lỗi, gửi kèm file zip/thư mục này và mô tả thao tác gây lỗi.');
}

function copySource(manifest) {
  const targetRoot = path.join(bundleDir, 'source');
  ensureDir(targetRoot);

  for (const file of SOURCE_ROOT_FILES) {
    const src = path.join(ROOT, file);
    if (fs.existsSync(src) && fs.statSync(src).isFile()) {
      copyMaybeText(src, path.join(targetRoot, file), manifest, { redact: false });
    }
  }

  for (const dir of SOURCE_DIRS) {
    const srcDir = path.join(ROOT, dir);
    if (!fs.existsSync(srcDir) || !fs.statSync(srcDir).isDirectory()) continue;
    walk(srcDir, (src) => {
      const rel = path.relative(ROOT, src);
      if (shouldSkipSource(rel, src)) return;
      copyMaybeText(src, path.join(targetRoot, rel), manifest, { redact: false });
    });
  }
}

function copyLogs(manifest) {
  const candidates = [];
  for (const dir of LOG_DIRS) {
    const srcDir = path.join(ROOT, dir);
    if (!fs.existsSync(srcDir)) continue;
    walk(srcDir, (file) => {
      if (!fs.statSync(file).isFile()) return;
      const lower = file.toLowerCase();
      if (!/(\.log|\.jsonl|\.txt|\.ndjson|\.err|\.out)$/.test(lower)) return;
      candidates.push({ file, mtime: fs.statSync(file).mtimeMs, size: fs.statSync(file).size });
    });
  }

  candidates.sort((a, b) => b.mtime - a.mtime);
  const selected = candidates.slice(0, MAX_LOG_FILES);
  const targetRoot = path.join(bundleDir, options.rawLogs ? 'logs_raw' : 'logs_redacted');
  ensureDir(targetRoot);

  for (const item of selected) {
    const rel = path.relative(ROOT, item.file);
    const dest = path.join(targetRoot, rel);
    copyMaybeText(item.file, dest, manifest, { redact: !options.rawLogs, maxBytes: MAX_TEXT_BYTES });
  }

  if (candidates.length > selected.length) {
    manifest.warnings.push(`Có ${candidates.length} file log, chỉ lấy ${selected.length} file mới nhất.`);
  }
  if (options.rawLogs) {
    manifest.warnings.push('Bạn đã dùng --raw-logs: log có thể chứa thông tin bệnh nhân/tài khoản. Kiểm tra trước khi gửi.');
  }
}

function collectDataSummaries(manifest) {
  const outDir = path.join(bundleDir, 'data_summary');
  ensureDir(outDir);
  const summaries = [];

  for (const dir of DATA_DIRS) {
    const srcDir = path.join(ROOT, dir);
    if (!fs.existsSync(srcDir)) continue;
    walk(srcDir, (file) => {
      if (!fs.statSync(file).isFile()) return;
      if (!/\.(json|jsonl)$/i.test(file)) return;
      const rel = path.relative(ROOT, file);
      const summary = summarizeDataFile(file, rel);
      summaries.push(summary);

      if (options.rawData) {
        const dest = path.join(outDir, 'raw_data', rel);
        copyMaybeText(file, dest, manifest, { redact: false, maxBytes: MAX_TEXT_BYTES });
      } else if (options.includeDataSamples && summary.redacted_sample !== undefined) {
        const safeName = rel.replace(/[\\/]/g, '__') + '.sample.redacted.json';
        writeJson(path.join(outDir, 'samples', safeName), summary.redacted_sample);
      }
    });
  }

  writeJson(path.join(outDir, 'data_files_summary.json'), summaries);
  manifest.files.push({ type: 'data_summary', path: path.relative(ROOT, path.join(outDir, 'data_files_summary.json')), count: summaries.length });

  if (options.rawData) {
    manifest.warnings.push('Bạn đã dùng --raw-data: có thể chứa dữ liệu bệnh nhân thật. Kiểm tra kỹ trước khi gửi.');
  }
}

function collectRuntimeIndex(manifest) {
  const runtimeDirs = ['.runtime', 'data', 'logs', 'debug'];
  const index = [];
  for (const dir of runtimeDirs) {
    const base = path.join(ROOT, dir);
    if (!fs.existsSync(base)) continue;
    walk(base, (file) => {
      if (!fs.statSync(file).isFile()) return;
      const stat = fs.statSync(file);
      index.push({
        path: path.relative(ROOT, file),
        size_bytes: stat.size,
        modified_at: stat.mtime.toISOString(),
      });
    });
  }
  index.sort((a, b) => b.modified_at.localeCompare(a.modified_at));
  writeJson(path.join(bundleDir, 'runtime_file_index.json'), index);
  manifest.files.push({ type: 'runtime_index', path: 'runtime_file_index.json', count: index.length });
}

function summarizeDataFile(file, rel) {
  const stat = fs.statSync(file);
  const summary = {
    path: rel,
    size_bytes: stat.size,
    modified_at: stat.mtime.toISOString(),
    kind: path.extname(file).toLowerCase(),
  };

  if (stat.size > MAX_TEXT_BYTES) {
    summary.note = `File lớn hơn ${MAX_TEXT_BYTES} bytes, chỉ ghi metadata.`;
    return summary;
  }

  try {
    const text = fs.readFileSync(file, 'utf8');
    if (file.toLowerCase().endsWith('.jsonl')) {
      const lines = text.split(/\r?\n/).filter(Boolean);
      summary.records = lines.length;
      summary.first_line_keys = safeJsonKeys(lines[0]);
      if (options.includeDataSamples) {
        summary.redacted_sample = lines.slice(0, MAX_JSON_RECORD_SAMPLES).map((line) => {
          try { return redactObject(JSON.parse(line)); } catch { return redactText(line); }
        });
      }
      return summary;
    }

    const data = JSON.parse(text);
    if (Array.isArray(data)) {
      summary.shape = 'array';
      summary.records = data.length;
      summary.first_item_keys = data[0] && typeof data[0] === 'object' ? Object.keys(data[0]).slice(0, 80) : [];
      if (options.includeDataSamples) summary.redacted_sample = data.slice(0, MAX_JSON_RECORD_SAMPLES).map(redactObject);
    } else if (data && typeof data === 'object') {
      summary.shape = 'object';
      summary.top_level_keys = Object.keys(data).slice(0, 100);
      for (const [key, value] of Object.entries(data).slice(0, 40)) {
        if (Array.isArray(value)) summary[`count.${key}`] = value.length;
        else if (value && typeof value === 'object') summary[`keys.${key}`] = Object.keys(value).slice(0, 40);
      }
      if (options.includeDataSamples) summary.redacted_sample = redactObject(data, 3);
    } else {
      summary.shape = typeof data;
    }
  } catch (err) {
    summary.error = `Không đọc được JSON: ${err.message}`;
  }

  return summary;
}

function safeJsonKeys(line) {
  try {
    const obj = JSON.parse(line);
    return obj && typeof obj === 'object' ? Object.keys(obj).slice(0, 80) : [];
  } catch {
    return [];
  }
}

function shouldSkipSource(rel, src) {
  const parts = rel.split(/[\\/]/);
  if (parts.some((p) => IGNORE_DIRS.has(p))) return true;
  const base = path.basename(src);
  if (base === 'config.json' || base === '.env') return true;
  if (/\.(png|jpg|jpeg|gif|webp|ico|pdf|docx|xlsx|pptx|zip|7z|rar|exe|dll|pyd)$/i.test(src)) return true;
  if (fs.statSync(src).size > MAX_SOURCE_FILE_BYTES) return true;
  return false;
}

function copyMaybeText(src, dest, manifest, opts = {}) {
  const stat = fs.statSync(src);
  const maxBytes = opts.maxBytes || MAX_SOURCE_FILE_BYTES;
  ensureDir(path.dirname(dest));

  if (stat.size > maxBytes) {
    writeText(dest + '.skipped.txt', `Bỏ qua file lớn: ${path.relative(ROOT, src)}\nSize: ${stat.size} bytes\n`);
    manifest.files.push({ type: 'skipped_large_file', source: path.relative(ROOT, src), size_bytes: stat.size });
    return;
  }

  if (opts.redact) {
    let text = fs.readFileSync(src, 'utf8');
    text = redactText(text);
    fs.writeFileSync(dest, text, 'utf8');
  } else {
    fs.copyFileSync(src, dest);
  }

  manifest.files.push({ type: 'file', path: path.relative(ROOT, dest), source: path.relative(ROOT, src), size_bytes: stat.size });
}

function redactText(text) {
  let out = text;

  // Ẩn email, số điện thoại dài, token/cookie/key phổ biến.
  out = out.replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[EMAIL_REDACTED]');
  out = out.replace(/\b(?:\+?84|0)(?:\d[\s.-]?){8,10}\b/g, '[PHONE_REDACTED]');
  out = out.replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, '$1[TOKEN_REDACTED]');

  const keyPattern = /(password|passwd|pass|token|secret|cookie|authorization|credential|api[_-]?key|session|email|user(name)?|ho[_\s-]?ten|ten[_\s-]?bn|patient[_\s-]?name|ma[_\s-]?bn|mabn|so[_\s-]?benh[_\s-]?an|so[_\s-]?vao[_\s-]?vien|cccd|cmnd|dien[_\s-]?thoai|phone|dia[_\s-]?chi|address)/i;

  out = out.split(/\r?\n/).map((line) => {
    if (!keyPattern.test(line)) return line;
    return line
      .replace(/(:\s*)"[^"]*"/g, '$1"[REDACTED]"')
      .replace(/(=\s*)[^,;\s]+/g, '$1[REDACTED]')
      .replace(/(:\s*)[^,;{}\]]+/g, '$1[REDACTED]');
  }).join(os.EOL);

  return out;
}

function redactObject(value, depth = 5) {
  if (depth <= 0) return '[DEPTH_LIMIT]';
  if (Array.isArray(value)) return value.slice(0, MAX_JSON_RECORD_SAMPLES).map((v) => redactObject(v, depth - 1));
  if (!value || typeof value !== 'object') return value;

  const out = {};
  for (const [key, val] of Object.entries(value)) {
    if (isSensitiveKey(key)) {
      out[key] = '[REDACTED]';
    } else if (Array.isArray(val)) {
      out[key] = val.slice(0, MAX_JSON_RECORD_SAMPLES).map((v) => redactObject(v, depth - 1));
    } else if (val && typeof val === 'object') {
      out[key] = redactObject(val, depth - 1);
    } else {
      out[key] = val;
    }
  }
  return out;
}

function isSensitiveKey(key) {
  return /(password|passwd|pass|token|secret|cookie|authorization|credential|api[_-]?key|session|email|user(name)?|ho[_\s-]?ten|ten[_\s-]?bn|tenbenhnhan|patient[_\s-]?name|name|ma[_\s-]?bn|mabn|so[_\s-]?benh[_\s-]?an|so[_\s-]?vao[_\s-]?vien|id[_\s-]?benh[_\s-]?an|cccd|cmnd|dien[_\s-]?thoai|phone|dia[_\s-]?chi|address)/i.test(key);
}

function collectEnvironment() {
  return {
    platform: process.platform,
    arch: process.arch,
    node: safeExec('node -v'),
    npm: safeExec('npm -v'),
    python: safeExec('python --version') || safeExec('py --version') || safeExec('python3 --version'),
    cwd: ROOT,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  };
}

function safeExec(cmd) {
  try {
    return cp.execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 }).trim();
  } catch {
    return '';
  }
}

function readJsonIfExists(file) {
  try {
    if (!fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    return { error: err.message };
  }
}

function walk(dir, fn) {
  if (!fs.existsSync(dir)) return;
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (IGNORE_DIRS.has(entry.name) && !p.includes(`${path.sep}.runtime`)) continue;
      walk(p, fn);
    } else if (entry.isFile()) {
      fn(p);
    }
  }
}

function tryCreateZip(sourceDir, destZip) {
  try {
    if (process.platform === 'win32') {
      const ps = `Compress-Archive -Path '${sourceDir.replace(/'/g, "''")}\\*' -DestinationPath '${destZip.replace(/'/g, "''")}' -Force`;
      cp.execSync(`powershell -NoProfile -ExecutionPolicy Bypass -Command "${ps}"`, { stdio: 'ignore', timeout: 120000 });
      return fs.existsSync(destZip);
    }
    cp.execSync(`cd "${path.dirname(sourceDir)}" && zip -rq "${destZip}" "${path.basename(sourceDir)}"`, { stdio: 'ignore', timeout: 120000 });
    return fs.existsSync(destZip);
  } catch {
    return false;
  }
}

function buildReadme(stamp) {
  return `# Gói debug ${stamp}\n\nGửi file zip/thư mục này kèm source code khi cần kiểm tra lỗi.\n\n## Bên trong gồm gì\n\n- \`manifest.json\`: phiên bản app, môi trường chạy, danh sách file được gom.\n- \`notes/MO_TA_LOI.md\`: mẫu mô tả lỗi, nên điền trước khi gửi.\n- \`logs_redacted/\`: log gần đây đã cố gắng ẩn thông tin nhạy cảm theo key phổ biến.\n- \`data_summary/\`: thống kê file dữ liệu, số dòng, key có trong JSON; mặc định không gửi raw data.\n- \`runtime_file_index.json\`: danh sách file runtime/log/data đang có.\n- \`source/\`: source liên quan nếu không chạy với \`--no-source\`.\n\n## Lưu ý an toàn\n\nScript có cơ chế ẩn thông tin theo các key phổ biến, nhưng không thể đảm bảo 100%. Trước khi gửi ra ngoài, hãy kiểm tra nhanh các file log nếu có dữ liệu bệnh nhân thật.\n\n## Lệnh thường dùng\n\n\`\`\`bash\nnpm run debug:bundle\n\`\`\`\n\nNếu log đang có thông tin nhạy cảm và chỉ muốn gửi source + thống kê dữ liệu:\n\n\`\`\`bash\nnpm run debug:bundle -- --no-logs\n\`\`\`\n\nNếu cần kèm mẫu dữ liệu đã ẩn tên/mã BN:\n\n\`\`\`bash\nnpm run debug:bundle -- --include-data-samples\n\`\`\`\n`;
}

function buildBugTemplate() {
  return `# Mô tả lỗi\n\n## 1. Lỗi xảy ra ở màn hình/tab nào?\nVí dụ: Điều dưỡng bệnh phòng / Hành chánh / Xếp phòng / Lấy dữ liệu.\n\n## 2. Tôi đã bấm gì?\nGhi theo thứ tự thao tác:\n1. ...\n2. ...\n3. ...\n\n## 3. Tôi kỳ vọng app làm gì?\n...\n\n## 4. Thực tế app làm gì?\n...\n\n## 5. Thời gian dữ liệu đang chọn\nTừ: ...\nĐến: ...\n\n## 6. Có thông báo lỗi trên màn hình không?\n...\n\n## 7. Có ảnh chụp màn hình không?\nCó/Không. Nếu có, gửi kèm ảnh.\n\n## 8. Ghi chú thêm\n...\n`;
}

function formatStamp(d) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function writeText(file, text) {
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, text, 'utf8');
}

function writeJson(file, obj) {
  writeText(file, JSON.stringify(obj, null, 2));
}

function safeRm(p) {
  if (fs.existsSync(p)) fs.rmSync(p, { recursive: true, force: true });
}
