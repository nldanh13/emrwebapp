// scripts/start.js — build UI if needed, then start the Express server.
// Mục tiêu: chạy `npm start` là mở được web app, không còn màn hình đen do thiếu dist/.

'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const DIST_INDEX = path.join(ROOT, 'dist', 'index.html');
const SOURCE_DIRS = [
  path.join(ROOT, 'src'),
  path.join(ROOT, 'index.html'),
  path.join(ROOT, 'vite.config.js'),
  path.join(ROOT, 'package.json'),
];

function latestMtimeMs(target) {
  if (!fs.existsSync(target)) return 0;
  const stat = fs.statSync(target);
  if (!stat.isDirectory()) return stat.mtimeMs;
  let latest = stat.mtimeMs;
  for (const name of fs.readdirSync(target)) {
    if (name === 'node_modules' || name === '.git' || name === 'dist') continue;
    latest = Math.max(latest, latestMtimeMs(path.join(target, name)));
  }
  return latest;
}

function hasBuiltAssets() {
  if (!fs.existsSync(DIST_INDEX)) return false;
  const assetsDir = path.join(ROOT, 'dist', 'assets');
  if (!fs.existsSync(assetsDir)) return false;
  return fs.readdirSync(assetsDir).some((name) => /\.(js|css)$/i.test(name));
}

function shouldBuild() {
  if (process.env.EMR_SKIP_BUILD === '1') return false;
  if (!hasBuiltAssets()) return true;
  const distTime = latestMtimeMs(path.join(ROOT, 'dist'));
  const sourceTime = Math.max(...SOURCE_DIRS.map(latestMtimeMs));
  return sourceTime > distTime;
}

function runBuild() {
  const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  console.log('[start] Đang build giao diện React trước khi mở server...');
  const result = spawnSync(npmCmd, ['run', 'build'], {
    cwd: ROOT,
    stdio: 'inherit',
    env: { ...process.env, NODE_ENV: process.env.NODE_ENV || 'production' },
  });
  if (result.status !== 0) {
    console.error('\n[start] Build giao diện thất bại. Chạy lại: npm install rồi npm start');
    process.exit(result.status || 1);
  }
}

if (shouldBuild()) runBuild();
require(path.join(ROOT, 'server.js'));
