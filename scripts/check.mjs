import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const ROOT = process.cwd();

const CHECK_TARGETS = [
  { root: 'server', extensions: new Set(['.js']) },
  { root: 'scripts', extensions: new Set(['.js', '.mjs']) },
  { root: 'src', extensions: new Set(['.js']) },
];

const ROOT_FILES = ['server.js', 'vite.config.js'];
const EXCLUDE_DIRS = new Set(['node_modules', 'dist', 'release', '.runtime', 'logs', 'debug_bundle', '__pycache__']);
const files = [];

function extensionOf(name) {
  const dot = name.lastIndexOf('.');
  return dot >= 0 ? name.slice(dot) : '';
}

function walk(dir, extensions) {
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir)) {
    if (EXCLUDE_DIRS.has(name)) continue;
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, extensions);
    else if (extensions.has(extensionOf(name))) files.push(full);
  }
}

for (const file of ROOT_FILES) {
  if (existsSync(file)) files.push(file);
}

for (const target of CHECK_TARGETS) {
  walk(target.root, target.extensions);
}

const uniqueFiles = [...new Set(files.map(file => resolve(file)))].sort();

for (const file of uniqueFiles) {
  execFileSync(process.execPath, ['--check', file], { stdio: 'inherit' });
  console.log(`[check] OK ${relative(ROOT, file)}`);
}

console.log(`[check] Completed: ${uniqueFiles.length} files OK`);
