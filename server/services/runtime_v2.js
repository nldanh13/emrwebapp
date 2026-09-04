// server/services/runtime_v2.js — Đồng bộ schema data v2 từ legacy runtime files.
'use strict';

const fs = require('fs');
const { runScript } = require('./python_runner');
const { readJsonSafe } = require('../utils/file');

async function refreshRuntimeV2(ctx, reason = 'manual') {
  if (!ctx || !ctx.dir) return { ok: false, reason, error: 'missing runtime context' };
  try {
    const result = await runScript('runtime_maint.py', ['generate', '--runtime-dir', ctx.dir], {
      cwd: ctx.dir,
      runtimeDir: ctx.dir,
    });
    if (result.spawnError || result.killedByTimeout || result.code !== 0) {
      const error = result.spawnError || (result.killedByTimeout ? 'timeout' : `exit ${result.code}`);
      console.warn(`[RUNTIME_V2] Refresh failed (${reason}): ${error}`);
      return { ok: false, reason, error };
    }
    const indexes = readJsonSafe(ctx.INDEXES_PATH, null);
    return { ok: true, reason, indexes };
  } catch (err) {
    console.warn(`[RUNTIME_V2] Refresh error (${reason}):`, String(err.message || err));
    return { ok: false, reason, error: String(err.message || err) };
  }
}

async function migrateRuntimeKeys(ctx) {
  const result = await runScript('runtime_maint.py', ['migrate-keys', '--runtime-dir', ctx.dir], {
    cwd: ctx.dir,
    runtimeDir: ctx.dir,
  });
  return result;
}

async function checkRuntimeHealth(ctx) {
  const result = await runScript('runtime_maint.py', ['health', '--runtime-dir', ctx.dir, '--json'], {
    cwd: ctx.dir,
    runtimeDir: ctx.dir,
  });
  // runtime_maint prints JSON to stdout, but python_runner only logs stdout.
  // API reads the health directly from files by spawning is not necessary here,
  // so caller should prefer a separate JSON helper if full payload is needed.
  return result;
}

function v2FileStatus(ctx) {
  const files = {
    patients: ctx.PATIENTS_PATH,
    board_state: ctx.BOARD_STATE_PATH,
    order_days: ctx.ORDER_DAYS_PATH,
    classified_days: ctx.CLASSIFIED_DAYS_PATH,
    warnings: ctx.WARNINGS_PATH,
    indexes: ctx.INDEXES_PATH,
  };
  const out = {};
  for (const [name, p] of Object.entries(files)) {
    try {
      out[name] = { exists: Boolean(p && fs.existsSync(p)), path: p };
    } catch (_) {
      out[name] = { exists: false, path: p };
    }
  }
  return out;
}

module.exports = { refreshRuntimeV2, migrateRuntimeKeys, checkRuntimeHealth, v2FileStatus };
