#!/usr/bin/env node
'use strict';

/**
 * Quản lý bí mật (mật khẩu/token) — xem docs/SECRETS.md.
 *
 *   npm run secrets:check            Bí mật nào đã cấu hình, lấy từ đâu, cảnh báo
 *                                    mật khẩu yếu / còn ở vị trí cũ / quyền file.
 *   npm run secrets:migrate          Xem trước việc gom bí mật từ config/config.json,
 *                                    .env, config/users.json, config/nurse_emr_accounts.json
 *                                    về thư mục secrets/ (không đổi gì).
 *   npm run secrets:migrate:apply    Thực hiện (có backup vào secrets/backup/).
 *   node scripts/secrets_tool.js scan-repo
 *                                    Quét file đang được git theo dõi, báo lỗi nếu có
 *                                    mật khẩu/token thật bị commit (chạy trong CI).
 *
 * Không bao giờ in giá trị bí mật ra màn hình.
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const store = require('../server/services/secret_store');

const ROOT = store.ROOT_DIR;
const EXAMPLE_PATH = path.join(ROOT, 'config', 'secrets.example.json');
const ENV_PATH = path.join(ROOT, '.env');
const IS_POSIX = process.platform !== 'win32';

const WEAK_PASSWORDS = new Set(['123', '1234', '12345', '123456', '1234567', '12345678', '123456789', 'password', 'admin', 'abc123', '111111', '000000', 'emr', 'matkhau']);

const SOURCE_LABEL = {
  [store.SOURCE.ENV]: 'biến môi trường',
  [store.SOURCE.ENV_FILE]: 'file *_FILE',
  [store.SOURCE.SECRETS_FILE]: 'secrets/secrets.json',
  [store.SOURCE.LEGACY_CONFIG]: 'config/config.json (VỊ TRÍ CŨ)',
  [store.SOURCE.NONE]: '— chưa cấu hình —',
};

function rel(p) {
  return path.relative(ROOT, p).split(path.sep).join('/') || '.';
}

function isWeakPassword(value) {
  const v = String(value || '');
  if (!v) return false;
  return v.length < 6 || WEAK_PASSWORDS.has(v.toLowerCase()) || /^(.)\1*$/.test(v);
}

function readJsonArray(filePath) {
  try {
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return Array.isArray(data) ? data : Object.entries(data || {}).map(([id, v]) => ({ id, ...(v || {}) }));
  } catch {
    return [];
  }
}

// ── scan-repo ────────────────────────────────────────────────────────────────

const SECRET_KEY_RE = /(^|_)(pass|passwd|password|mat_khau|matkhau|token|secret|api_key|apikey|salt)$/i;
const PLACEHOLDER_RE = /^(replace-with|your[-_]|<|\$\{|x{3,}|\*{3,}|example|changeme)/i;
const CODE_ASSIGN_RE = /^\s*[A-Z][A-Z0-9_]*(PASSWORD|PASSWD|SECRET|API_KEY|TOKEN)\s*=\s*(["'])([^"']+)\2/;

function gitTrackedFiles() {
  const res = spawnSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8' });
  if (res.status !== 0) return null;
  return res.stdout.split('\0').filter(Boolean);
}

function scanJsonValue(value, keyPath, findings, file) {
  if (Array.isArray(value)) {
    value.forEach((v, i) => scanJsonValue(v, `${keyPath}[${i}]`, findings, file));
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [k, v] of Object.entries(value)) {
    const here = keyPath ? `${keyPath}.${k}` : k;
    if (typeof v === 'string' && SECRET_KEY_RE.test(k) && v.trim() && !PLACEHOLDER_RE.test(v.trim())) {
      findings.push({ file, where: here });
    } else {
      scanJsonValue(v, here, findings, file);
    }
  }
}

function scanRepo() {
  const files = gitTrackedFiles();
  if (!files) return { ok: true, skipped: 'Không phải git repo — bỏ qua quét.', findings: [], trackedSecretFiles: [] };
  const findings = [];
  const secretDirRel = rel(store.secretsDir());
  const alwaysSecret = new Set([
    'config/config.json', 'config/users.json', 'config/nurse_emr_accounts.json', 'config/care_baseline.json', '.env',
  ]);
  const trackedSecretFiles = files.filter(f => alwaysSecret.has(f) || f === secretDirRel || f.startsWith(`${secretDirRel}/`));

  for (const file of files) {
    if (file === 'package-lock.json' || file.includes('node_modules/')) continue;
    const abs = path.join(ROOT, file);
    if (file.endsWith('.json')) {
      let data;
      try { data = JSON.parse(fs.readFileSync(abs, 'utf8')); } catch { continue; }
      scanJsonValue(data, '', findings, file);
    } else if (/\.(py|js|mjs|cjs|jsx)$/.test(file)) {
      let lines;
      try { lines = fs.readFileSync(abs, 'utf8').split(/\r?\n/); } catch { continue; }
      lines.forEach((line, i) => {
        const m = CODE_ASSIGN_RE.exec(line);
        if (m && !PLACEHOLDER_RE.test(m[3])) findings.push({ file, where: `dòng ${i + 1}` });
      });
    }
  }
  return { ok: findings.length === 0 && trackedSecretFiles.length === 0, findings, trackedSecretFiles };
}

function printScan(result) {
  if (result.skipped) { console.log(`  ${result.skipped}`); return; }
  for (const f of result.trackedSecretFiles) console.log(`  ✗ File bí mật đang bị git theo dõi: ${f}  (git rm --cached "${f}")`);
  for (const f of result.findings) console.log(`  ✗ Có vẻ là mật khẩu/token thật trong file commit: ${f.file} → ${f.where}`);
  if (result.ok) console.log('  ✓ Không thấy mật khẩu/token thật trong các file được commit.');
}

// ── check ────────────────────────────────────────────────────────────────────

function checkPermissions(target, warnings) {
  if (!IS_POSIX || !fs.existsSync(target)) return;
  const mode = fs.statSync(target).mode & 0o777;
  if (mode & 0o077) warnings.push(`${rel(target)} đang cho người khác đọc (quyền ${mode.toString(8)}). Sửa: chmod ${fs.statSync(target).isDirectory() ? '700' : '600'} "${rel(target)}"`);
}

function check() {
  const warnings = [];
  const errors = [];
  const manifest = store.loadManifest();
  const secretsData = store.readJsonObject(store.secretsFilePath());
  const legacyConfig = store.readJsonObject(store.LEGACY_CONFIG_PATH);

  console.log(`Thư mục bí mật: ${rel(store.secretsDir())}${fs.existsSync(store.secretsDir()) ? '' : '  (chưa tạo — chạy npm run secrets:migrate:apply)'}\n`);
  console.log('Bí mật:');
  for (const spec of manifest.secrets) {
    const { value, source } = store.resolveSecret(spec.key, { secretsData, legacyConfig });
    const mark = !value ? (spec.required ? '✗' : '·') : (source === store.SOURCE.LEGACY_CONFIG ? '!' : '✓');
    console.log(`  ${mark} ${spec.key.padEnd(26)} ${SOURCE_LABEL[source]}`);
    if (!value && spec.required) warnings.push(`Chưa cấu hình ${spec.key} (${spec.label}).`);
    if (source === store.SOURCE.LEGACY_CONFIG) warnings.push(`${spec.key} còn nằm trong config/config.json — chạy npm run secrets:migrate:apply.`);
    if (value && spec.kind === 'password' && isWeakPassword(value)) warnings.push(`${spec.key}: mật khẩu quá yếu — nên đổi trên EMR rồi cập nhật lại.`);
    if (value && spec.min_length && value.length < spec.min_length) warnings.push(`${spec.key}: nên dài tối thiểu ${spec.min_length} ký tự.`);
  }

  console.log('\nFile danh sách tài khoản:');
  for (const spec of manifest.files) {
    const info = store.resolveSecretFile(spec.name);
    const exists = fs.existsSync(info.path);
    const where = info.mode === 'legacy' ? `${rel(info.path)} (VỊ TRÍ CŨ)` : rel(info.path);
    console.log(`  ${exists ? (info.mode === 'legacy' ? '!' : '✓') : '·'} ${spec.name.padEnd(26)} ${exists ? where : '— chưa có —'}`);
    if (info.mode === 'legacy') warnings.push(`${spec.name} còn ở ${rel(info.path)} — chạy npm run secrets:migrate:apply.`);
    if (exists) {
      checkPermissions(info.path, warnings);
      const weak = readJsonArray(info.path)
        .filter(row => row && isWeakPassword(row.emr_password))
        .map(row => String(row.name || row.id || '?'));
      if (weak.length) warnings.push(`${spec.name}: ${weak.length} tài khoản EMR có mật khẩu quá yếu (${weak.join(', ')}).`);
    }
  }
  checkPermissions(store.secretsDir(), warnings);
  checkPermissions(store.secretsFilePath(), warnings);

  console.log('\nQuét file commit:');
  const scan = scanRepo();
  printScan(scan);
  if (!scan.ok) errors.push('Có bí mật bị commit vào git — xem danh sách trên.');

  if (warnings.length) {
    console.log('\nCảnh báo:');
    for (const w of warnings) console.log(`  ! ${w}`);
  }
  if (errors.length) {
    console.log('\nLỗi:');
    for (const e of errors) console.log(`  ✗ ${e}`);
    process.exitCode = 1;
  } else if (!warnings.length) {
    console.log('\nTất cả ổn.');
  }
}

// ── migrate ──────────────────────────────────────────────────────────────────

function parseEnvFile(textContent) {
  return textContent.split(/\r?\n/).map(line => {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m || /^\s*#/.test(line)) return { line };
    let value = m[2].trim();
    if (/^(["']).*\1$/.test(value)) value = value.slice(1, -1);
    return { line, name: m[1], value };
  });
}

function writeJsonSecure(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  if (IS_POSIX) fs.chmodSync(filePath, 0o600);
}

function migrate({ apply, configPath = store.LEGACY_CONFIG_PATH, envPath = ENV_PATH, legacyRoot = ROOT } = {}) {
  const manifest = store.loadManifest();
  const dir = store.secretsDir();
  const secretsPath = store.secretsFilePath();
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupDir = path.join(dir, 'backup', stamp);
  const actions = [];
  const conflicts = [];

  let secretsData = store.readJsonObject(secretsPath);
  const secretsExisted = fs.existsSync(secretsPath);
  if (!secretsExisted) {
    secretsData = store.readJsonObject(EXAMPLE_PATH);
    delete secretsData._note;
    actions.push(`Tạo ${rel(secretsPath)} từ config/secrets.example.json`);
  }
  let secretsChanged = !secretsExisted;

  // Đưa 1 giá trị vào secrets.json; trả true nếu vị trí cũ có thể xóa an toàn.
  function take(spec, value, fromLabel) {
    const current = String(store.getPath(secretsData, spec.path) ?? '').trim();
    if (!current) {
      store.setPath(secretsData, spec.path, value);
      secretsChanged = true;
      actions.push(`${spec.key}: ${fromLabel} → ${rel(secretsPath)} (${spec.path})`);
      return true;
    }
    if (current === value) {
      actions.push(`${spec.key}: đã có trong secrets.json, xóa bản trùng ở ${fromLabel}`);
      return true;
    }
    conflicts.push(`${spec.key}: ${fromLabel} khác giá trị trong secrets.json — giữ cả hai, tự kiểm tra rồi xóa bản cũ.`);
    return false;
  }

  // 1. config/config.json
  const config = store.readJsonObject(configPath);
  const configClears = [];
  for (const spec of manifest.secrets) {
    const key = spec.legacy_config_key;
    const value = key ? String(config[key] ?? '').trim() : '';
    if (value && take(spec, value, `config/config.json:${key}`)) configClears.push(key);
  }

  // 2. .env
  let envEntries = null;
  const envMoved = new Set();
  if (fs.existsSync(envPath)) {
    envEntries = parseEnvFile(fs.readFileSync(envPath, 'utf8'));
    const byEnv = new Map(manifest.secrets.map(s => [s.env, s]));
    for (const entry of envEntries) {
      const spec = entry.name && byEnv.get(entry.name);
      if (spec && entry.value && take(spec, entry.value, `.env:${entry.name}`)) envMoved.add(entry.name);
    }
  }

  // 3. users.json, nurse_emr_accounts.json
  const fileMoves = [];
  for (const spec of manifest.files) {
    if (!spec.legacy) continue;
    const from = path.join(legacyRoot, spec.legacy);
    const to = path.join(dir, spec.name);
    if (!fs.existsSync(from)) continue;
    if (fs.existsSync(to)) {
      conflicts.push(`${spec.name}: có ở cả ${spec.legacy} và ${rel(to)} — app đang dùng ${rel(to)}, tự kiểm tra rồi xóa bản cũ.`);
      continue;
    }
    fileMoves.push({ from, to });
    actions.push(`Chuyển ${spec.legacy} → ${rel(to)}`);
  }

  console.log(apply ? 'Gom bí mật về secrets/:' : 'XEM TRƯỚC — chưa thay đổi gì (thêm --apply để thực hiện):');
  if (!actions.length && !conflicts.length) console.log('  Không có gì cần chuyển.');
  for (const a of actions) console.log(`  → ${a}`);
  for (const c of conflicts) console.log(`  ! ${c}`);
  if (!apply) return;

  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (IS_POSIX) fs.chmodSync(dir, 0o700);

  if (secretsChanged) writeJsonSecure(secretsPath, secretsData);

  // Bản sao vẫn chứa mật khẩu → chỉ chủ máy đọc được.
  function backup(from, name) {
    fs.mkdirSync(backupDir, { recursive: true, mode: 0o700 });
    const to = path.join(backupDir, name);
    fs.copyFileSync(from, to);
    if (IS_POSIX) fs.chmodSync(to, 0o600);
  }

  if (configClears.length) {
    backup(configPath, 'config.json');
    for (const key of configClears) config[key] = '';
    fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  }

  if (envMoved.size) {
    backup(envPath, '.env');
    const out = envEntries.map(e => (envMoved.has(e.name) ? `# ${e.name}= (đã chuyển sang secrets/secrets.json)` : e.line));
    fs.writeFileSync(envPath, out.join('\n'), 'utf8');
  }

  for (const { from, to } of fileMoves) {
    fs.renameSync(from, to);
    if (IS_POSIX) fs.chmodSync(to, 0o600);
  }

  if (fs.existsSync(backupDir)) console.log(`\nBản sao file cũ (vẫn chứa mật khẩu) ở ${rel(backupDir)} — xóa khi đã chạy ổn.`);
  console.log('Xong. Khởi động lại server để áp dụng, rồi chạy npm run secrets:check.');
}

// ── main ─────────────────────────────────────────────────────────────────────

function main(argv) {
  const [command = 'check', ...rest] = argv;
  if (command === 'check') return check();
  if (command === 'migrate') return migrate({ apply: rest.includes('--apply') });
  if (command === 'scan-repo') {
    const result = scanRepo();
    printScan(result);
    if (!result.ok) process.exitCode = 1;
    return undefined;
  }
  console.error(`Lệnh không hợp lệ: ${command}. Dùng: check | migrate [--apply] | scan-repo`);
  process.exitCode = 2;
  return undefined;
}

if (require.main === module) main(process.argv.slice(2));

module.exports = { scanRepo, isWeakPassword, parseEnvFile, migrate, check };
