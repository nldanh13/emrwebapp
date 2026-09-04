// server/services/hchanh/snapshot_store.js
// Snapshot sáng/chiều cho module hành chánh.
// Lưu ở hchanh/snapshots/ — độc lập với admin_workflow cũ.

'use strict';

const { readJsonSafe, writeJsonAtomic } = require('../../utils/file');
const { hchanh_snapshot_path }          = require('../../hchanh_data_contract');

const SNAPSHOT_TTL_MS = 12 * 60 * 60 * 1000; // 12 tiếng

function createSnapshot(ctx, kind) {
  const safeKind = kind === 'afternoon' ? 'afternoon' : 'morning';
  const now = new Date();

  // Đọc dashboard hiện tại để snapshot
  let dashboard = null;
  try {
    const { buildHchanh_Dashboard } = require('./dashboard');
    dashboard = buildHchanh_Dashboard(ctx);
  } catch (_) {}

  const snapshot = {
    version:    2,
    kind:       safeKind,
    sid:        ctx.sid,
    createdAt:  now.toISOString(),
    expiresAt:  new Date(now.getTime() + SNAPSHOT_TTL_MS).toISOString(),
    counts:     dashboard?.counts || {},
    total_patients: dashboard?.total || 0,
  };

  writeJsonAtomic(hchanh_snapshot_path(ctx, safeKind), snapshot);
  return snapshot;
}

function readSnapshot(ctx, kind) {
  const safeKind = kind === 'afternoon' ? 'afternoon' : 'morning';
  const snapshot = readJsonSafe(hchanh_snapshot_path(ctx, safeKind), null);
  if (!snapshot) return null;
  const exp = Date.parse(snapshot.expiresAt || '');
  if (exp && Date.now() > exp) return { ...snapshot, expired: true };
  return snapshot;
}

module.exports = { createSnapshot, readSnapshot, SNAPSHOT_TTL_MS };
