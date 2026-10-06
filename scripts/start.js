// scripts/start.js — build UI if source changed, then start the Express server.
// Dùng fingerprint nội dung thay vì mtime để `git pull` trên Windows không bỏ sót frontend mới.

'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
const DIST_INDEX = path.join(ROOT, 'dist', 'index.html');
const BUILD_FINGERPRINT = path.join(ROOT, 'dist', '.source-fingerprint');
const SOURCE_DIRS = [
  path.join(ROOT, 'src'),
  path.join(ROOT, 'index.html'),
  path.join(ROOT, 'vite.config.js'),
  path.join(ROOT, 'package.json'),
];

function hasBuiltAssets() {
  if (!fs.existsSync(DIST_INDEX)) return false;
  const assetsDir = path.join(ROOT, 'dist', 'assets');
  if (!fs.existsSync(assetsDir)) return false;
  return fs.readdirSync(assetsDir).some((name) => /\.(js|css)$/i.test(name));
}

function hashFileTree(target, hash, relativeBase = ROOT) {
  if (!fs.existsSync(target)) {
    hash.update(`missing:${path.relative(relativeBase, target)}\n`);
    return;
  }
  const stat = fs.statSync(target);
  if (!stat.isDirectory()) {
    hash.update(`file:${path.relative(relativeBase, target)}\n`);
    hash.update(fs.readFileSync(target));
    hash.update('\n');
    return;
  }
  const entries = fs.readdirSync(target, { withFileTypes: true })
    .filter(entry => !['node_modules', '.git', 'dist'].includes(entry.name))
    .sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    hashFileTree(path.join(target, entry.name), hash, relativeBase);
  }
}

function sourceFingerprint() {
  const hash = crypto.createHash('sha256');
  for (const target of SOURCE_DIRS) hashFileTree(target, hash);
  return hash.digest('hex');
}

function builtFingerprint() {
  try {
    return fs.readFileSync(BUILD_FINGERPRINT, 'utf8').trim();
  } catch {
    return '';
  }
}

function shouldBuild() {
  if (process.env.EMR_SKIP_BUILD === '1') return false;
  if (!hasBuiltAssets()) return true;
  return builtFingerprint() !== sourceFingerprint();
}

function runBuild() {
  const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const fingerprint = sourceFingerprint();
  console.log('[start] Đang build giao diện React trước khi mở server...');
  const result = spawnSync(npmCmd, ['run', 'build'], {
    cwd: ROOT,
    stdio: 'inherit',
    env: { ...process.env, NODE_ENV: process.env.NODE_ENV || 'production' },
  });
  if (result.status !== 0) {
    console.error('\n[start] Build giao diện thất bại. Chạy lại: npm install rồi npm run build');
    process.exit(result.status || 1);
  }
  fs.writeFileSync(BUILD_FINGERPRINT, `${fingerprint}\n`, 'utf8');
}

if (shouldBuild()) runBuild();
require(path.join(ROOT, 'server.js'));
