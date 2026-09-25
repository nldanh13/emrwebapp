// server/services/secret_store.js — Nơi DUY NHẤT server đọc mật khẩu/token/khóa.
//
// Mọi bí mật của hệ thống gom về thư mục secrets/ (đã .gitignore, bị loại khỏi
// gói release):
//   secrets/secrets.json            — mật khẩu EMR, token app, salt, API key...
//   secrets/users.json              — tài khoản đăng nhập app
//   secrets/nurse_emr_accounts.json — tài khoản EMR theo tên điều dưỡng
//
// Danh mục khóa nằm ở config/secrets_manifest.json, dùng chung với
// worker/shared/secret_store.py — thêm bí mật mới thì khai ở đó, không đọc
// process.env trực tiếp rải rác trong code.
//
// Thứ tự ưu tiên cho mỗi bí mật (cao → thấp):
//   1. Biến môi trường, ví dụ EMR_APP_TOKEN
//   2. File chứa giá trị, ví dụ EMR_APP_TOKEN_FILE=/run/secrets/app_token
//   3. secrets/secrets.json
//   4. (Chỉ các khóa cũ) config/config.json — vẫn đọc được để không gãy máy
//      đang chạy, `npm run secrets:check` sẽ cảnh báo để chuyển sang secrets/.
//
// Module này KHÔNG require constants.js (constants.js require module này).

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT_DIR = path.resolve(__dirname, '..', '..');
const MANIFEST_PATH = path.join(ROOT_DIR, 'config', 'secrets_manifest.json');
const LEGACY_CONFIG_PATH = path.join(ROOT_DIR, 'config', 'config.json');

const SOURCE = Object.freeze({
  ENV: 'env',
  ENV_FILE: 'env_file',
  SECRETS_FILE: 'secrets_file',
  LEGACY_CONFIG: 'legacy_config',
  NONE: '',
});

let manifestCache = null;
function loadManifest() {
  if (manifestCache) return manifestCache;
  const raw = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
  const secrets = Array.isArray(raw.secrets) ? raw.secrets : [];
  const files = Array.isArray(raw.files) ? raw.files : [];
  manifestCache = Object.freeze({
    secrets: Object.freeze(secrets.map(s => Object.freeze({ ...s }))),
    files: Object.freeze(files.map(f => Object.freeze({ ...f }))),
    byKey: new Map(secrets.map(s => [s.key, s])),
    fileByName: new Map(files.map(f => [f.name, f])),
  });
  return manifestCache;
}

function resolveFromRoot(p) {
  return path.isAbsolute(p) ? p : path.join(ROOT_DIR, p);
}

// Đọc lại env mỗi lần gọi để test đổi EMR_SECRETS_DIR giữa chừng vẫn có tác dụng.
function secretsDir() {
  const configured = String(process.env.EMR_SECRETS_DIR || '').trim();
  return configured ? resolveFromRoot(configured) : path.join(ROOT_DIR, 'secrets');
}

function secretsFilePath() {
  return path.join(secretsDir(), 'secrets.json');
}

const warnedFiles = new Set();
function readJsonObject(filePath) {
  let text;
  try { text = fs.readFileSync(filePath, 'utf8'); } catch { return {}; }
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch (err) {
    if (!warnedFiles.has(filePath)) {
      warnedFiles.add(filePath);
      console.error(`[secret_store] ${filePath} không phải JSON hợp lệ — bỏ qua: ${err.message}`);
    }
    return {};
  }
}

function getPath(obj, dotted) {
  let cur = obj;
  for (const part of String(dotted || '').split('.')) {
    if (!cur || typeof cur !== 'object') return undefined;
    cur = cur[part];
  }
  return cur;
}

function setPath(obj, dotted, value) {
  const parts = String(dotted || '').split('.');
  let cur = obj;
  for (const part of parts.slice(0, -1)) {
    if (!cur[part] || typeof cur[part] !== 'object' || Array.isArray(cur[part])) cur[part] = {};
    cur = cur[part];
  }
  cur[parts[parts.length - 1]] = value;
}

function text(value) {
  return value === undefined || value === null ? '' : String(value).trim();
}

function readEnvFile(envName) {
  const filePath = text(process.env[`${envName}_FILE`]);
  if (!filePath) return '';
  try {
    return fs.readFileSync(resolveFromRoot(filePath), 'utf8').trim();
  } catch (err) {
    console.error(`[secret_store] Không đọc được ${envName}_FILE: ${err.message}`);
    return '';
  }
}

/**
 * Tìm giá trị một bí mật. Trả về { value, source } — `source` cho biết giá trị
 * lấy từ đâu (để kiểm tra/diagnostics), KHÔNG bao giờ log `value`.
 * @param {string} key khóa trong config/secrets_manifest.json
 * @param {{secretsData?: object, legacyConfig?: object}} [opts] dữ liệu đã đọc sẵn (dùng khi duyệt nhiều khóa)
 */
function resolveSecret(key, opts = {}) {
  const spec = loadManifest().byKey.get(key);
  if (!spec) throw new Error(`[secret_store] Bí mật chưa khai báo trong config/secrets_manifest.json: ${key}`);

  const fromEnv = text(process.env[spec.env]);
  if (fromEnv) return { value: fromEnv, source: SOURCE.ENV };

  const fromEnvFile = readEnvFile(spec.env);
  if (fromEnvFile) return { value: fromEnvFile, source: SOURCE.ENV_FILE };

  const secretsData = opts.secretsData || readJsonObject(secretsFilePath());
  const fromSecrets = text(getPath(secretsData, spec.path));
  if (fromSecrets) return { value: fromSecrets, source: SOURCE.SECRETS_FILE };

  if (spec.legacy_config_key) {
    const legacy = opts.legacyConfig || readJsonObject(LEGACY_CONFIG_PATH);
    const fromLegacy = text(legacy[spec.legacy_config_key]);
    if (fromLegacy) return { value: fromLegacy, source: SOURCE.LEGACY_CONFIG };
  }
  return { value: '', source: SOURCE.NONE };
}

function getSecret(key) {
  return resolveSecret(key).value;
}

/**
 * Đường dẫn file danh sách bí mật (users.json, nurse_emr_accounts.json).
 *   1. Biến môi trường (EMR_USERS_FILE...)          → mode 'env'
 *   2. secrets/<name> đã tồn tại                    → mode 'secrets'
 *   3. Vị trí cũ config/<name> còn tồn tại           → mode 'legacy' (chưa chuyển)
 *   4. Chưa có ở đâu cả → tạo mới trong secrets/     → mode 'secrets'
 */
function resolveSecretFile(name) {
  const spec = loadManifest().fileByName.get(name);
  if (!spec) throw new Error(`[secret_store] File bí mật chưa khai báo trong config/secrets_manifest.json: ${name}`);
  const configured = text(process.env[spec.env]);
  if (configured) return { path: resolveFromRoot(configured), mode: 'env' };
  const inSecrets = path.join(secretsDir(), name);
  if (fs.existsSync(inSecrets)) return { path: inSecrets, mode: 'secrets' };
  const legacy = spec.legacy ? resolveFromRoot(spec.legacy) : '';
  if (legacy && fs.existsSync(legacy)) return { path: legacy, mode: 'legacy' };
  return { path: inSecrets, mode: 'secrets' };
}

/** Tóm tắt nguồn của mọi bí mật — an toàn để trả về diagnostics (không có giá trị). */
function describeSecrets() {
  const secretsData = readJsonObject(secretsFilePath());
  const legacyConfig = readJsonObject(LEGACY_CONFIG_PATH);
  const { secrets, files } = loadManifest();
  return {
    secrets_dir: secretsDir(),
    secrets_file_exists: fs.existsSync(secretsFilePath()),
    secrets: secrets.map(spec => {
      const { value, source } = resolveSecret(spec.key, { secretsData, legacyConfig });
      return { key: spec.key, configured: Boolean(value), source };
    }),
    files: files.map(spec => {
      const info = resolveSecretFile(spec.name);
      return { name: spec.name, mode: info.mode, exists: fs.existsSync(info.path) };
    }),
  };
}

module.exports = {
  ROOT_DIR,
  MANIFEST_PATH,
  LEGACY_CONFIG_PATH,
  SOURCE,
  loadManifest,
  secretsDir,
  secretsFilePath,
  readJsonObject,
  getPath,
  setPath,
  resolveSecret,
  getSecret,
  resolveSecretFile,
  describeSecrets,
};
