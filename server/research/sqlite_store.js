// server/research/sqlite_store.js — Đồng bộ CSV nghiên cứu vào SQLite không cần dependency ngoài.

'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const { ROOT_DIR } = require('../constants');
const { PYTHON_BIN } = require('../services/python_runner');
const { ensureDir, writeJsonAtomic, readJsonSafe, safeFilePart } = require('../utils/file');

const SQLITE_SCRIPT = path.join(ROOT_DIR, 'research', 'sqlite_store.py');
const DATABASE_FILE = 'research.sqlite3';
const DATABASE_MANIFEST_FILE = 'research.sqlite3.manifest.json';

function databasePaths(datasetDir) {
  const dir = path.resolve(datasetDir);
  return {
    dir,
    databasePath: path.join(dir, DATABASE_FILE),
    manifestPath: path.join(dir, DATABASE_MANIFEST_FILE),
  };
}

function databaseInfo(datasetDir) {
  const { databasePath, manifestPath } = databasePaths(datasetDir);
  const manifest = readJsonSafe(manifestPath, null);
  if (!manifest || !fs.existsSync(databasePath)) {
    return {
      exists: false,
      database_file: DATABASE_FILE,
      database_path: databasePath,
      manifest_path: manifestPath,
    };
  }
  let sizeBytes = Number(manifest.size_bytes || 0);
  let updatedAt = manifest.loaded_at || '';
  try {
    const stat = fs.statSync(databasePath);
    sizeBytes = stat.size;
    updatedAt = updatedAt || stat.mtime.toISOString();
  } catch (_) {}
  return {
    ...manifest,
    exists: true,
    database_file: DATABASE_FILE,
    database_path: databasePath,
    manifest_path: manifestPath,
    size_bytes: sizeBytes,
    updated_at: updatedAt,
  };
}

function syncResearchDatabase({
  datasetDir,
  datasetId,
  datasetType,
  runId,
  inputSignature,
  normalizedSchemaVersion,
  tables,
  force = false,
}) {
  if (!fs.existsSync(SQLITE_SCRIPT)) throw new Error('Thiếu research/sqlite_store.py.');
  const paths = databasePaths(datasetDir);
  ensureDir(paths.dir);

  const current = databaseInfo(paths.dir);
  if (!force
      && current.exists
      && String(current.run_id || '') === String(runId || '')
      && String(current.input_signature || '') === String(inputSignature || '')
      && Number(current.normalized_schema_version || 0) === Number(normalizedSchemaVersion || 0)) {
    return { ...current, cached: true };
  }

  const request = {
    database_path: paths.databasePath,
    manifest_path: paths.manifestPath,
    dataset_id: String(datasetId || path.basename(paths.dir)),
    dataset_type: String(datasetType || 'study'),
    run_id: String(runId || ''),
    input_signature: String(inputSignature || ''),
    normalized_schema_version: Number(normalizedSchemaVersion || 0),
    tables: (Array.isArray(tables) ? tables : [])
      .filter(item => item && fs.existsSync(item.file_path))
      .map(item => ({
        table_name: String(item.table_name || ''),
        source_file: String(item.source_file || path.basename(item.file_path || '')),
        file_path: path.resolve(item.file_path),
      })),
  };
  const requestPath = path.join(paths.dir, `.sqlite_sync_${process.pid}_${Date.now()}_${safeFilePart(runId || 'latest')}.json`);
  writeJsonAtomic(requestPath, request);

  try {
    const result = spawnSync(PYTHON_BIN, ['-X', 'utf8', SQLITE_SCRIPT, '--request', requestPath], {
      cwd: ROOT_DIR,
      shell: false,
      windowsHide: true,
      encoding: 'utf8',
      timeout: 180000,
      maxBuffer: 20 * 1024 * 1024,
      env: {
        ...process.env,
        PYTHONUTF8: '1',
        PYTHONIOENCODING: 'utf-8',
      },
    });
    if (result.error) throw new Error(`Không chạy được Python tạo SQLite: ${result.error.message}`);
    if (result.status !== 0) {
      const stderr = String(result.stderr || '').trim().split(/\r?\n/).slice(-12).join('\n');
      throw new Error(`Tạo SQLite thất bại${stderr ? `:\n${stderr}` : '.'}`);
    }
    let payload = null;
    try { payload = JSON.parse(String(result.stdout || '').trim()); } catch (_) {}
    if (!payload || payload.status !== 'ok') throw new Error('Python không trả kết quả SQLite hợp lệ.');
    return { ...payload, exists: true, cached: false };
  } finally {
    try { fs.unlinkSync(requestPath); } catch (_) {}
  }
}


function queryResearchDatabase({
  datasetDir,
  queries,
  timeoutMs = 30000,
}) {
  if (!fs.existsSync(SQLITE_SCRIPT)) throw new Error('Thiếu research/sqlite_store.py.');
  const paths = databasePaths(datasetDir);
  if (!fs.existsSync(paths.databasePath)) {
    return { status: 'missing', results: {}, database_path: paths.databasePath };
  }

  const request = {
    action: 'query',
    database_path: paths.databasePath,
    queries: Array.isArray(queries) ? queries : [],
  };
  const requestPath = path.join(
    paths.dir,
    `.sqlite_query_${process.pid}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.json`
  );
  writeJsonAtomic(requestPath, request);

  try {
    const result = spawnSync(PYTHON_BIN, ['-X', 'utf8', SQLITE_SCRIPT, '--request', requestPath], {
      cwd: ROOT_DIR,
      shell: false,
      windowsHide: true,
      encoding: 'utf8',
      timeout: Math.max(1000, Number(timeoutMs || 30000)),
      maxBuffer: 30 * 1024 * 1024,
      env: {
        ...process.env,
        PYTHONUTF8: '1',
        PYTHONIOENCODING: 'utf-8',
      },
    });
    if (result.error) throw new Error(`Không chạy được SQLite query: ${result.error.message}`);
    if (result.status !== 0) {
      const stderr = String(result.stderr || '').trim().split(/\r?\n/).slice(-12).join('\n');
      throw new Error(`SQLite query thất bại${stderr ? `:\n${stderr}` : '.'}`);
    }
    let payload = null;
    try { payload = JSON.parse(String(result.stdout || '').trim()); } catch (_) {}
    if (!payload || payload.status !== 'ok') throw new Error('SQLite query không trả JSON hợp lệ.');
    return payload;
  } finally {
    try { fs.unlinkSync(requestPath); } catch (_) {}
  }
}


module.exports = {
  DATABASE_FILE,
  DATABASE_MANIFEST_FILE,
  databasePaths,
  databaseInfo,
  syncResearchDatabase,
  queryResearchDatabase,
};
