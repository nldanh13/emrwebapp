#!/usr/bin/env node
'use strict';

/**
 * scripts/health_check.js
 * Chạy các kiểm tra nhanh trước khi đóng gói/gửi bản release.
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');

function commandExists(command) {
  const checker = process.platform === 'win32' ? 'where' : 'command';
  const args = process.platform === 'win32' ? [command] : ['-v', command];
  const result = spawnSync(checker, args, { stdio: 'ignore', shell: process.platform !== 'win32' });
  return result.status === 0;
}

function resolvePythonBin() {
  const envPy = String(process.env.PYTHON_BIN || process.env.PYTHON || '').trim();
  if (envPy) return envPy;
  const candidates = [
    path.join(ROOT, '.venv', 'Scripts', 'python.exe'),
    path.join(ROOT, '.venv', 'bin', 'python'),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  // Ưu tiên `python` để khớp npm test hiện tại; fallback `python3` cho môi trường Linux không có alias python.
  if (commandExists('python')) return 'python';
  if (commandExists('python3')) return 'python3';
  return process.platform === 'win32' ? 'python' : 'python3';
}

const PYTHON = resolvePythonBin();
const PYTEST_TIMEOUT_MS = Number(process.env.HEALTH_CHECK_PYTEST_TIMEOUT_MS || 90000);
const SKIP_PYTEST = ['1', 'true', 'yes'].includes(String(process.env.HEALTH_CHECK_SKIP_PYTEST || '').toLowerCase());
const NODE_CHECK_TIMEOUT_MS = Number(process.env.HEALTH_CHECK_NODE_TIMEOUT_MS || 10000);

function buildCleanPythonEnv(extra = {}) {
  const keep = ['PATH', 'Path', 'SystemRoot', 'WINDIR', 'COMSPEC', 'PATHEXT', 'HOME', 'USERPROFILE', 'TMP', 'TEMP', 'TMPDIR'];
  const env = {};
  for (const key of keep) {
    if (process.env[key]) env[key] = process.env[key];
  }
  return {
    ...env,
    PYTHONUTF8: '1',
    PYTHONIOENCODING: 'utf-8',
    PYTHONNOUSERSITE: process.env.PYTHONNOUSERSITE || '1',
    PYTEST_DISABLE_PLUGIN_AUTOLOAD: process.env.PYTEST_DISABLE_PLUGIN_AUTOLOAD || '1',
    ...extra,
  };
}

function run(label, command, args, options = {}) {
  console.log(`\n[check] ${label}`);
  const result = spawnSync(command, args, {
    cwd: ROOT,
    stdio: 'inherit',
    shell: false,
    ...options,
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);

  if (result.error) {
    console.error(`[check] Không chạy được: ${command} ${args.join(' ')}`);
    if (result.error.code === 'ETIMEDOUT') {
      console.error(`[check] Quá thời gian ở bước: ${label}. Có thể bỏ qua pytest bằng HEALTH_CHECK_SKIP_PYTEST=1 nếu chỉ cần kiểm tra nhanh.`);
    } else {
      console.error(result.error.message);
    }
    process.exit(1);
  }
  if (result.status !== 0) {
    console.error(`[check] Lỗi ở bước: ${label}`);
    process.exit(result.status || 1);
  }
}

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

function nodeCheckFiles() {
  const files = [path.join(ROOT, 'server.js')];
  for (const rel of ['server', 'scripts']) {
    const dir = path.join(ROOT, rel);
    if (!fs.existsSync(dir)) continue;
    files.push(...walk(dir).filter(f => f.endsWith('.js') && path.resolve(f) !== __filename));
  }

  // Kiểm tra thêm các utility frontend thuần JS chọn lọc. File .jsx cần Vite/Babel nên để npm run build xử lý khi có node_modules.
  const frontendChecks = [
    'src/api.js',
    'src/tokens.js',
    'src/components/bedboard/bedBoardUtils.js',
    'src/components/patient/patientDetailUtils.js',
    'src/components/nurse/nurseScheduleUtils.js',
    'src/components/nurse/useIsMobile.js',
    'src/components/shift/shiftUtils.js',
    'src/components/report/reportBaseUtils.js',
    'src/components/report/reportRouteUtils.js',
    'src/components/report/reportMedicationBasics.js',
    'src/components/report/reportMedicationFlags.js',
    'src/components/report/reportMedicationCollect.js',
    'src/components/report/reportUtils.js',
  ];
  for (const rel of frontendChecks) {
    const file = path.join(ROOT, rel);
    if (fs.existsSync(file)) files.push(file);
  }

  const uniqueFiles = [...new Set(files)];
  for (const file of uniqueFiles) {
    run(`node --check ${path.relative(ROOT, file)}`, process.execPath, ['--check', file], {
      timeout: NODE_CHECK_TIMEOUT_MS,
      stdio: 'pipe',
      encoding: 'utf-8',
    });
  }
}

run('Python compile worker/', PYTHON, ['-S', '-m', 'compileall', '-q', 'worker']);
nodeCheckFiles();
run('Workflow smoke test', process.execPath, ['scripts/workflow_smoke_test.js'], {
  timeout: NODE_CHECK_TIMEOUT_MS,
  stdio: 'pipe',
  encoding: 'utf-8',
});

if (fs.existsSync(path.join(ROOT, 'node_modules'))) {
  run('Vite build', process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'build']);
} else {
  console.log('\n[check] Bỏ qua npm run build vì chưa có node_modules. Chạy npm install rồi npm run check để kiểm tra build UI.');
}

// Chạy pytest sau cùng để tránh một số môi trường Python giữ handle stdio khiến Node child-process tiếp theo bị treo.
if (SKIP_PYTEST) {
  console.log('\n[check] Bỏ qua pytest vì HEALTH_CHECK_SKIP_PYTEST=1.');
} else {
  run('Python pytest tests/', PYTHON, ['-m', 'pytest', 'tests/', '-q'], {
    timeout: PYTEST_TIMEOUT_MS,
    stdio: 'pipe',
    encoding: 'utf-8',
    env: buildCleanPythonEnv(),
  });
}

console.log('\n[check] OK');
