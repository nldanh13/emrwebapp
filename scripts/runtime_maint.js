#!/usr/bin/env node
'use strict';

const { spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..');
const cmd = process.argv[2] || 'health';
const runtimeArg = process.argv.find(x => x.startsWith('--runtime='));
const runtimeDir = runtimeArg ? runtimeArg.slice('--runtime='.length) : path.join(ROOT, '.runtime');
const script = path.join(ROOT, 'worker', 'runtime_maint.py');
const candidates = [
  process.env.PYTHON_BIN,
  path.join(ROOT, '.venv', 'Scripts', 'python.exe'),
  path.join(ROOT, '.venv', 'bin', 'python'),
  process.platform === 'win32' ? 'python' : 'python3',
].filter(Boolean);
const py = candidates.find(x => x === 'python' || x === 'python3' || fs.existsSync(x));

const args = ['-X', 'utf8', script, cmd, '--runtime-dir', runtimeDir, '--json'];
const r = spawnSync(py, args, {
  cwd: ROOT,
  stdio: 'inherit',
  env: {
    ...process.env,
    PYTHONUTF8: '1',
    PYTHONIOENCODING: 'utf-8',
    PYTHONPATH: path.join(ROOT, 'worker') + (process.env.PYTHONPATH ? path.delimiter + process.env.PYTHONPATH : ''),
  },
});
process.exit(Number(r.status ?? 1));
