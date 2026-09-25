#!/usr/bin/env node
'use strict';

// Kiểm tra nơi quản lý bí mật chung (server/services/secret_store.js),
// bản Python (worker/shared/secret_store.py) cho cùng kết quả, và lệnh
// `secrets:migrate` gom đúng bí mật từ vị trí cũ. Mọi mật khẩu dưới đây là giả.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const store = require('../server/services/secret_store');
const tool = require('./secrets_tool');

let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  console.log(`  ok - ${name}`);
}

// Không để biến môi trường của máy chạy test lẫn vào kết quả.
const manifest = store.loadManifest();
for (const spec of manifest.secrets) {
  delete process.env[spec.env];
  delete process.env[`${spec.env}_FILE`];
}
for (const spec of manifest.files) delete process.env[spec.env];

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'emr-secrets-'));
}

function writeJson(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

function withSecretsDir(dir, fn) {
  const prev = process.env.EMR_SECRETS_DIR;
  process.env.EMR_SECRETS_DIR = dir;
  try { return fn(); } finally {
    if (prev === undefined) delete process.env.EMR_SECRETS_DIR; else process.env.EMR_SECRETS_DIR = prev;
  }
}

console.log('secret_store');

test('manifest: khóa không trùng, mỗi khóa có env và path', () => {
  const keys = new Set();
  const envs = new Set();
  for (const spec of manifest.secrets) {
    assert(spec.key && spec.env && spec.path, JSON.stringify(spec));
    assert(!keys.has(spec.key), `trùng key ${spec.key}`);
    assert(!envs.has(spec.env), `trùng env ${spec.env}`);
    keys.add(spec.key);
    envs.add(spec.env);
  }
});

test('config/secrets.example.json có đủ mọi path trong manifest và đều để trống', () => {
  const example = store.readJsonObject(path.join(store.ROOT_DIR, 'config', 'secrets.example.json'));
  for (const spec of manifest.secrets) {
    assert.strictEqual(store.getPath(example, spec.path), '', `thiếu hoặc không trống: ${spec.path}`);
  }
});

test('thứ tự ưu tiên: env > env_FILE > secrets.json > config.json cũ', () => {
  const dir = tempDir();
  withSecretsDir(dir, () => {
    const legacyConfig = { password: 'legacy-pass' };
    assert.deepStrictEqual(store.resolveSecret('emr_password', { legacyConfig }), { value: 'legacy-pass', source: 'legacy_config' });

    writeJson(path.join(dir, 'secrets.json'), { emr: { password: 'file-pass' } });
    assert.deepStrictEqual(store.resolveSecret('emr_password', { legacyConfig }), { value: 'file-pass', source: 'secrets_file' });

    const valueFile = path.join(dir, 'pw.txt');
    fs.writeFileSync(valueFile, 'envfile-pass\n');
    process.env.EMR_PASSWORD_FILE = valueFile;
    assert.deepStrictEqual(store.resolveSecret('emr_password', { legacyConfig }), { value: 'envfile-pass', source: 'env_file' });

    process.env.EMR_PASSWORD = 'env-pass';
    assert.deepStrictEqual(store.resolveSecret('emr_password', { legacyConfig }), { value: 'env-pass', source: 'env' });
    delete process.env.EMR_PASSWORD;
    delete process.env.EMR_PASSWORD_FILE;
  });
});

test('khóa không có legacy_config_key thì không đọc từ config.json', () => {
  withSecretsDir(tempDir(), () => {
    assert.strictEqual(store.resolveSecret('app_token', { legacyConfig: { app_token: 'x'.repeat(20) } }).value, '');
  });
});

test('khóa chưa khai báo trong manifest → báo lỗi, không âm thầm trả rỗng', () => {
  assert.throws(() => store.getSecret('khong_ton_tai'), /secrets_manifest/);
});

test('resolveSecretFile: env > secrets/ > vị trí cũ, mặc định tạo mới trong secrets/', () => {
  const dir = tempDir();
  withSecretsDir(dir, () => {
    const info = store.resolveSecretFile('users.json');
    assert(['secrets', 'legacy'].includes(info.mode));
    if (info.mode === 'secrets') assert.strictEqual(info.path, path.join(dir, 'users.json'));

    writeJson(path.join(dir, 'users.json'), []);
    assert.deepStrictEqual(store.resolveSecretFile('users.json'), { path: path.join(dir, 'users.json'), mode: 'secrets' });

    process.env.EMR_USERS_FILE = path.join(dir, 'custom.json');
    assert.deepStrictEqual(store.resolveSecretFile('users.json'), { path: path.join(dir, 'custom.json'), mode: 'env' });
    delete process.env.EMR_USERS_FILE;
  });
});

test('describeSecrets không bao giờ chứa giá trị bí mật', () => {
  const dir = tempDir();
  withSecretsDir(dir, () => {
    writeJson(path.join(dir, 'secrets.json'), { emr: { username: 'user-khong-lo', password: 'pass-khong-lo' } });
    const text = JSON.stringify(store.describeSecrets());
    assert(!text.includes('pass-khong-lo'));
    assert(!text.includes('user-khong-lo'));
    assert(text.includes('"secrets_file"'));
  });
});

test('Python secret_store cho cùng giá trị và nguồn với Node', () => {
  const dir = tempDir();
  writeJson(path.join(dir, 'secrets.json'), { emr: { username: 'u-file', password: 'p-file' }, hchanh: { password: 'h-file' } });
  const env = { ...process.env, EMR_SECRETS_DIR: dir, EMR_USERNAME: 'u-env', PYTHONIOENCODING: 'utf-8' };
  const keys = ['emr_username', 'emr_password', 'hchanh_password', 'infusion_password'];
  const code = [
    'import json, sys',
    `sys.path.insert(0, ${JSON.stringify(path.join(__dirname, '..', 'worker'))})`,
    'from shared.secret_store import resolve_secret',
    `print(json.dumps({k: list(resolve_secret(k)) for k in ${JSON.stringify(keys)}}))`,
  ].join('\n');
  const py = process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
  const r = spawnSync(py, ['-X', 'utf8', '-c', code], { env, encoding: 'utf-8' });
  assert.strictEqual(r.status, 0, r.stderr);
  const fromPython = JSON.parse(r.stdout);

  const prev = { ...process.env };
  Object.assign(process.env, { EMR_SECRETS_DIR: dir, EMR_USERNAME: 'u-env' });
  try {
    for (const key of keys) {
      const { value, source } = store.resolveSecret(key, { legacyConfig: {} });
      assert.deepStrictEqual(fromPython[key], [value, source], key);
    }
  } finally {
    delete process.env.EMR_USERNAME;
    if (prev.EMR_SECRETS_DIR === undefined) delete process.env.EMR_SECRETS_DIR;
  }
  assert.deepStrictEqual(fromPython.emr_username, ['u-env', 'env']);
});

test('isWeakPassword nhận ra mật khẩu yếu', () => {
  for (const weak of ['123', '7998', '000000', 'password', 'aaaaaaa']) assert(tool.isWeakPassword(weak), weak);
  assert(!tool.isWeakPassword('Kh0-d0an!2026'));
  assert(!tool.isWeakPassword(''));
});

function silently(fn) {
  const log = console.log;
  console.log = () => {};
  try { return fn(); } finally { console.log = log; }
}

function makeLegacyInstall() {
  const root = tempDir();
  const secrets = path.join(root, 'secrets');
  const configPath = path.join(root, 'config', 'config.json');
  const envPath = path.join(root, '.env');
  writeJson(configPath, { url_login: 'http://emr.test/login.aspx', username: 'dd01', password: 'p-config', hchanh_username: 'hc01', hchanh_password: 'p-hchanh', headless: false });
  fs.writeFileSync(envPath, 'HOST=0.0.0.0\nEMR_APP_TOKEN="tok-aaaaaaaaaaaaaaaa"\n# ghi chú giữ nguyên\n');
  writeJson(path.join(root, 'config', 'users.json'), [{ id: 'op1', token: 't'.repeat(20) }]);
  writeJson(path.join(root, 'config', 'nurse_emr_accounts.json'), [{ name: 'A', emr_username: 'a', emr_password: 'p-a' }]);
  return { root, secrets, configPath, envPath, opts: { configPath, envPath, legacyRoot: root } };
}

test('migrate (xem trước) không thay đổi file nào', () => {
  const inst = makeLegacyInstall();
  const before = fs.readFileSync(inst.configPath, 'utf8') + fs.readFileSync(inst.envPath, 'utf8');
  withSecretsDir(inst.secrets, () => silently(() => tool.migrate({ apply: false, ...inst.opts })));
  assert.strictEqual(fs.readFileSync(inst.configPath, 'utf8') + fs.readFileSync(inst.envPath, 'utf8'), before);
  assert(!fs.existsSync(inst.secrets));
});

test('migrate --apply gom hết về secrets/, xóa bản cũ, có backup', () => {
  const inst = makeLegacyInstall();
  withSecretsDir(inst.secrets, () => silently(() => tool.migrate({ apply: true, ...inst.opts })));

  const secrets = store.readJsonObject(path.join(inst.secrets, 'secrets.json'));
  assert.strictEqual(secrets.emr.username, 'dd01');
  assert.strictEqual(secrets.emr.password, 'p-config');
  assert.strictEqual(secrets.hchanh.password, 'p-hchanh');
  assert.strictEqual(secrets.app.token, 'tok-aaaaaaaaaaaaaaaa');
  assert.strictEqual(secrets.infusion.password, '');

  const config = store.readJsonObject(inst.configPath);
  assert.strictEqual(config.password, '');
  assert.strictEqual(config.hchanh_password, '');
  assert.strictEqual(config.url_login, 'http://emr.test/login.aspx');

  const envText = fs.readFileSync(inst.envPath, 'utf8');
  assert(!envText.includes('tok-aaaa'));
  assert(envText.includes('HOST=0.0.0.0'));
  assert(envText.includes('# ghi chú giữ nguyên'));

  assert(fs.existsSync(path.join(inst.secrets, 'users.json')));
  assert(fs.existsSync(path.join(inst.secrets, 'nurse_emr_accounts.json')));
  assert(!fs.existsSync(path.join(inst.root, 'config', 'users.json')));

  const backups = fs.readdirSync(path.join(inst.secrets, 'backup'));
  assert.strictEqual(backups.length, 1);
  assert(fs.readFileSync(path.join(inst.secrets, 'backup', backups[0], 'config.json'), 'utf8').includes('p-config'));
  if (process.platform !== 'win32') {
    assert.strictEqual(fs.statSync(path.join(inst.secrets, 'secrets.json')).mode & 0o777, 0o600);
    assert.strictEqual(fs.statSync(inst.secrets).mode & 0o777, 0o700);
  }
});

test('migrate không ghi đè khi secrets.json đã có giá trị khác (giữ cả hai)', () => {
  const inst = makeLegacyInstall();
  writeJson(path.join(inst.secrets, 'secrets.json'), { emr: { password: 'p-moi' } });
  withSecretsDir(inst.secrets, () => silently(() => tool.migrate({ apply: true, ...inst.opts })));
  assert.strictEqual(store.readJsonObject(path.join(inst.secrets, 'secrets.json')).emr.password, 'p-moi');
  assert.strictEqual(store.readJsonObject(inst.configPath).password, 'p-config');
  assert.strictEqual(store.readJsonObject(inst.configPath).hchanh_password, '');
});

test('repo hiện tại không commit mật khẩu/token thật', () => {
  const result = tool.scanRepo();
  assert(result.ok, JSON.stringify(result));
});

console.log(`\n${passed} test(s) passed.`);
