#!/usr/bin/env node
'use strict';

// Kiểm tra scripts/clean.js trên một thư mục tạm (EMR_CLEAN_ROOT): mặc định chỉ
// xem trước, --apply chuyển vào .cleanup_backup, và KHÔNG BAO GIỜ đụng tới
// .runtime / secrets / config thật nếu không bật cờ tương ứng.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SCRIPT = path.join(__dirname, 'clean.js');

let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  console.log(`  ok - ${name}`);
}

function write(root, relative, content = 'x') {
  const full = path.join(root, relative);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

function makeProject() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'emr-clean-'));
  write(root, 'worker/__pycache__/a.cpython-311.pyc');
  write(root, 'worker/main.py', 'print(1)');
  write(root, 'logs/server.log');
  write(root, 'notes.tmp');
  write(root, 'config/config.json', '{}');
  write(root, '.env', 'HOST=127.0.0.1');
  write(root, 'secrets/secrets.json', '{}');
  write(root, 'secrets/app.log');
  write(root, '.runtime/audit/audit.log');
  write(root, '.runtime/sessions/s1/state.tmp');
  write(root, '.runtime/sessions/s1/data/done.json', '{}');
  write(root, '.runtime/sessions/s1/data/logs/run.txt');
  write(root, '.runtime/sessions/s1/debug/page.html');
  fs.mkdirSync(path.join(root, '.runtime/sessions/s2'), { recursive: true });
  write(root, '.runtime/sessions/s1/hchanh/patients/BN1/billing.json');
  write(root, '.runtime/sessions/s1/hchanh/patients/BN1/bang_ke.json');
  write(root, '.runtime/sessions/s1/hchanh/patients/BN2/billing.json');
  return root;
}

function run(root, ...args) {
  const r = spawnSync(process.execPath, [SCRIPT, '--json', ...args], {
    env: { ...process.env, EMR_CLEAN_ROOT: root },
    encoding: 'utf8',
  });
  assert.strictEqual(r.status, 0, r.stderr || r.stdout);
  const reportPath = args.includes('--apply')
    ? path.join(root, '.cleanup_backup', fs.readdirSync(path.join(root, '.cleanup_backup'))[0], 'cleanup_report.json')
    : path.join(root, 'cleanup_report.preview.json');
  return JSON.parse(fs.readFileSync(reportPath, 'utf8')).items.map(i => i.path);
}

const has = (root, relative) => fs.existsSync(path.join(root, relative));

console.log('clean');

test('mặc định chỉ xem trước: không xóa gì', () => {
  const root = makeProject();
  const items = run(root);
  assert(items.includes('worker/__pycache__'));
  assert(items.includes('logs'));
  assert(items.includes('notes.tmp'));
  assert(has(root, 'worker/__pycache__') && has(root, 'logs') && has(root, 'notes.tmp'));
});

test('mặc định không bao giờ liệt kê .runtime, secrets, config thật', () => {
  const root = makeProject();
  const items = run(root);
  const touched = items.filter(p => /^(\.runtime|secrets)(\/|$)/.test(p) || p === '.env' || p === 'config/config.json');
  assert.deepStrictEqual(touched, []);
});

test('--apply chuyển vào .cleanup_backup, dữ liệu thật giữ nguyên', () => {
  const root = makeProject();
  run(root, '--apply');
  assert(!has(root, 'worker/__pycache__'));
  assert(has(root, 'worker/main.py'));
  const backup = fs.readdirSync(path.join(root, '.cleanup_backup'))[0];
  assert(has(root, `.cleanup_backup/${backup}/worker/__pycache__/a.cpython-311.pyc`));
  for (const keep of ['.runtime/audit/audit.log', '.runtime/sessions/s1/state.tmp', '.runtime/sessions/s2', 'secrets/app.log', 'secrets/secrets.json', 'config/config.json', '.env']) {
    assert(has(root, keep), `mất ${keep}`);
  }
});

test('--runtime-logs chỉ dọn log/debug phiên cũ, giữ dữ liệu phiên', () => {
  const root = makeProject();
  run(root, '--runtime-logs', '--apply');
  assert(!has(root, '.runtime/sessions/s1/debug'));
  assert(!has(root, '.runtime/sessions/s1/data/logs'));
  assert(has(root, '.runtime/sessions/s1/data/done.json'));
  assert(has(root, '.runtime/audit/audit.log'));
});

test('--hchanh-data chỉ dọn file cũ khi đã có bản chuẩn', () => {
  const root = makeProject();
  run(root, '--hchanh-data', '--apply');
  assert(!has(root, '.runtime/sessions/s1/hchanh/patients/BN1/billing.json'));
  assert(has(root, '.runtime/sessions/s1/hchanh/patients/BN1/bang_ke.json'));
  assert(has(root, '.runtime/sessions/s1/hchanh/patients/BN2/billing.json'));
});

test('--private-data (xem trước) mới liệt kê .runtime, secrets, config thật', () => {
  const root = makeProject();
  const items = run(root, '--private-data');
  for (const p of ['.runtime', 'secrets', '.env', 'config/config.json']) assert(items.includes(p), p);
  assert(has(root, '.runtime') && has(root, 'secrets'));
});

console.log(`\n${passed} test(s) passed.`);
