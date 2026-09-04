// server/services/session.js — Quản lý session runtime (per-user)

'use strict';

const fs   = require('fs');
const path = require('path');

const {
  RUNTIME_ROOT,
  SESSIONS_DIR,
  SESSION_MAX_AGE_MS,
  SESSION_RETENTION_MODE,
  SESSION_ARCHIVE_DIR,
  ALLOW_PERMANENT_SESSION_DELETE,
} = require('../constants');
const { ensureDir } = require('../utils/file');
const { buildRuntimeDataPaths, migrateLegacyRuntimeFiles, writeManifest } = require('../data_contract');
const { sanitizeSessionId } = require('../utils/validation');

ensureDir(RUNTIME_ROOT);
ensureDir(SESSIONS_DIR);
ensureDir(SESSION_ARCHIVE_DIR);

const SENSITIVE_SESSION_CONFIG_KEY_RE = /password|pass|username|token|secret|cookie|authorization|mat_khau|mật khẩu|ten_tai_khoan/i;

function stripSensitiveConfigKeys(value) {
  if (!value || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(stripSensitiveConfigKeys);
  const out = {};
  for (const [key, child] of Object.entries(value)) {
    if (SENSITIVE_SESSION_CONFIG_KEY_RE.test(key)) continue;
    out[key] = stripSensitiveConfigKeys(child);
  }
  return out;
}

function sanitizeSessionConfigFile(sessionDir) {
  const configPath = path.join(sessionDir, 'config.json');
  try {
    if (!fs.existsSync(configPath)) return;
    const raw = JSON.parse(fs.readFileSync(configPath, 'utf8') || '{}');
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return;
    const clean = stripSensitiveConfigKeys(raw);
    if (JSON.stringify(clean) !== JSON.stringify(raw)) {
      fs.writeFileSync(configPath, JSON.stringify(clean, null, 2), { encoding: 'utf8', mode: 0o600 });
      console.warn(`[SESSION] Đã xoá khóa nhạy cảm khỏi ${configPath}`);
    }
  } catch (err) {
    console.warn(`[SESSION] Không thể làm sạch config session ${configPath}: ${String(err.message || err)}`);
  }
}

function getSessionId(req) {
  return sanitizeSessionId(req._ottSid || req.get('x-session-id') || req.query.sid || 'default');
}

function getSessionDir(sid) {
  if (!sid || sid === 'default') return RUNTIME_ROOT;
  const dir = path.join(SESSIONS_DIR, sid);
  ensureDir(dir);
  try { const now = new Date(); fs.utimesSync(dir, now, now); } catch (_) {}
  return dir;
}

function buildRuntimeContext(sid, dir) {
  const ctx = {
    sid,
    dir,
    ...buildRuntimeDataPaths(dir),
    REPORTS_DIR: path.join(dir, 'reports'),
    LOGS_DIR:    path.join(dir, 'logs'),
  };
  migrateLegacyRuntimeFiles(ctx);
  writeManifest(ctx);
  return ctx;
}

function getRuntimePaths(req) {
  const sid = getSessionId(req);
  const dir = getSessionDir(sid);
  return buildRuntimeContext(sid, dir);
}

function ensureSessionAssets(sessionDir, rootDir) {
  ensureDir(sessionDir);
  sanitizeSessionConfigFile(sessionDir);
  const copies = [
    [path.join(rootDir, 'config', 'd_v2.json'), path.join(sessionDir, 'd_v2.json')],
  ];
  for (const [src, dst] of copies) {
    try {
      if (fs.existsSync(src) && !fs.existsSync(dst)) fs.copyFileSync(src, dst);
    } catch (err) {
      console.warn(`[SESSION] Không copy được ${path.basename(src)}:`, String(err.message || err));
    }
  }
}

function archiveStamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function archiveTarget(sid, reason = 'manual') {
  const safeReason = String(reason || 'manual').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 40) || 'manual';
  return path.join(SESSION_ARCHIVE_DIR, `${archiveStamp()}__${safeReason}__${sanitizeSessionId(sid)}`);
}

function copyDefaultSessionToArchive(target) {
  ensureDir(target);
  const skip = new Set(['sessions', 'session_archive']);
  for (const entry of fs.readdirSync(RUNTIME_ROOT, { withFileTypes: true })) {
    if (skip.has(entry.name)) continue;
    const src = path.join(RUNTIME_ROOT, entry.name);
    const dst = path.join(target, entry.name);
    fs.cpSync(src, dst, { recursive: true, force: false, errorOnExist: true });
  }
}

function archiveSessionData(sid, { reason = 'manual' } = {}) {
  const cleanSid = sanitizeSessionId(sid || 'default');
  const target = archiveTarget(cleanSid, reason);
  ensureDir(path.dirname(target));

  if (cleanSid === 'default') {
    copyDefaultSessionToArchive(target);
    fs.writeFileSync(path.join(target, 'ARCHIVE_META.json'), JSON.stringify({
      archived_at: new Date().toISOString(), sid: cleanSid, reason,
    }, null, 2), { encoding: 'utf8', mode: 0o600 });
    return { sid: cleanSid, archived: true, archive_path: target };
  }

  const source = path.join(SESSIONS_DIR, cleanSid);
  if (!fs.existsSync(source)) return { sid: cleanSid, archived: false, missing: true };
  try {
    fs.renameSync(source, target);
  } catch (err) {
    if (err.code !== 'EXDEV') throw err;
    fs.cpSync(source, target, { recursive: true, force: false, errorOnExist: true });
    fs.rmSync(source, { recursive: true, force: true });
  }
  fs.writeFileSync(path.join(target, 'ARCHIVE_META.json'), JSON.stringify({
    archived_at: new Date().toISOString(), sid: cleanSid, reason,
  }, null, 2), { encoding: 'utf8', mode: 0o600 });
  return { sid: cleanSid, archived: true, archive_path: target };
}

/**
 * Dọn session chỉ khi quản trị viên chủ động bật EMR_SESSION_RETENTION_MODE.
 * - disabled (mặc định): không làm gì.
 * - archive: chuyển session cũ sang thư mục archive, không mất dữ liệu.
 * - delete: xóa vĩnh viễn, chỉ hoạt động khi EMR_ALLOW_PERMANENT_SESSION_DELETE=1.
 */
function cleanOldSessions() {
  const mode = ['disabled', 'archive', 'delete'].includes(SESSION_RETENTION_MODE) ? SESSION_RETENTION_MODE : 'disabled';
  if (mode === 'disabled') return { mode, scanned: 0, archived: 0, deleted: 0 };
  if (mode === 'delete' && !ALLOW_PERMANENT_SESSION_DELETE) {
    console.warn('[CLEANUP] Đã bỏ qua chế độ delete vì EMR_ALLOW_PERMANENT_SESSION_DELETE chưa bật.');
    return { mode: 'blocked_delete', scanned: 0, archived: 0, deleted: 0 };
  }

  const result = { mode, scanned: 0, archived: 0, deleted: 0, errors: [] };
  try {
    const entries = fs.readdirSync(SESSIONS_DIR, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      result.scanned += 1;
      const dir = path.join(SESSIONS_DIR, entry.name);
      try {
        const stat = fs.statSync(dir);
        if (Date.now() - stat.mtimeMs <= SESSION_MAX_AGE_MS) continue;
        if (mode === 'archive') {
          archiveSessionData(entry.name, { reason: 'retention' });
          result.archived += 1;
          console.log(`[CLEANUP] Đã lưu trữ session cũ: ${entry.name}`);
        } else {
          fs.rmSync(dir, { recursive: true, force: true });
          result.deleted += 1;
          console.log(`[CLEANUP] Đã xoá vĩnh viễn session cũ: ${entry.name}`);
        }
      } catch (err) {
        result.errors.push({ sid: entry.name, message: String(err.message || err) });
      }
    }
  } catch (err) {
    result.errors.push({ sid: '', message: String(err.message || err) });
  }
  return result;
}

function buildRuntimePathsForSid(sid) {
  const cleanSid = sanitizeSessionId(sid || 'default');
  const dir = cleanSid === 'default' ? RUNTIME_ROOT : path.join(SESSIONS_DIR, cleanSid);
  return buildRuntimeContext(cleanSid, dir);
}

function listKnownSessionIds() {
  const ids = new Set(['default']);
  try {
    if (fs.existsSync(SESSIONS_DIR)) {
      for (const e of fs.readdirSync(SESSIONS_DIR, { withFileTypes: true })) {
        if (!e.isDirectory()) continue;
        try { ids.add(sanitizeSessionId(e.name)); } catch (_) {}
      }
    }
  } catch (_) {}
  return [...ids];
}

function clearSessionDerivedState(ctx, { clearReports = true } = {}) {
  if (!ctx || !ctx.dir) return;
  const files = [
    ctx.CARE_DONE_PATH,
    ctx.INFUSIONS_DONE_PATH,
    ctx.PROCEDURES_DONE_PATH,
    ctx.VTYT_DONE_PATH,
    ctx.TASK_PROGRESS_PATH,
    path.join(ctx.dir, 'admin_nurse_state.json'),
    ...(ctx.PROCESSED_PATH ? [
      path.join(path.dirname(ctx.PROCESSED_PATH), 'input_care_result.json'),
      path.join(path.dirname(ctx.PROCESSED_PATH), 'input_infusions_result.json'),
      path.join(path.dirname(ctx.PROCESSED_PATH), 'input_procedures_result.json'),
      path.join(path.dirname(ctx.PROCESSED_PATH), 'input_vtyt_result.json'),
      path.join(path.dirname(ctx.PROCESSED_PATH), 'vtyt_input_plan_cache.json'),
    ] : []),
  ];
  for (const file of files) {
    try { if (file && fs.existsSync(file)) fs.rmSync(file, { force: true }); } catch (_) {}
  }
  if (clearReports) {
    try { if (ctx.REPORTS_DIR && fs.existsSync(ctx.REPORTS_DIR)) fs.rmSync(ctx.REPORTS_DIR, { recursive: true, force: true }); } catch (_) {}
  }
}

function permanentlyDeleteSessionData(cleanSid) {
  if (cleanSid === 'default') {
    const ctx = buildRuntimePathsForSid('default');
    const files = [
      ctx.RAW_PATH, ctx.SORTED_PATH, ctx.FINAL_PATH, ctx.PROCESSED_PATH,
      ctx.CARE_DONE_PATH, ctx.INFUSIONS_DONE_PATH, ctx.PROCEDURES_DONE_PATH, ctx.VTYT_DONE_PATH,
      ctx.TASK_PROGRESS_PATH, ctx.MANIFEST_PATH,
      ...Object.values(ctx.LEGACY_PATHS || {}).flat(),
      path.join(ctx.dir, 'd_v2.json'), path.join(ctx.dir, 'config.json'), path.join(ctx.dir, 'admin_nurse_state.json'),
    ];
    for (const file of files) {
      try { if (fs.existsSync(file)) fs.rmSync(file, { force: true }); } catch (_) {}
    }
    for (const dir of [ctx.REPORTS_DIR, ctx.LOGS_DIR]) {
      try { if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
    }
    return { sid: cleanSid, deleted: true };
  }
  const dir = path.join(SESSIONS_DIR, cleanSid);
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  return { sid: cleanSid, deleted: true };
}

function deleteSessionData(sid, { permanent = false, reason = 'manual' } = {}) {
  const cleanSid = sanitizeSessionId(sid || 'default');
  if (permanent) {
    if (!ALLOW_PERMANENT_SESSION_DELETE) {
      const err = new Error('Xóa vĩnh viễn đang bị khóa. Đặt EMR_ALLOW_PERMANENT_SESSION_DELETE=1 nếu thật sự cần.');
      err.code = 'PERMANENT_DELETE_DISABLED';
      throw err;
    }
    return permanentlyDeleteSessionData(cleanSid);
  }

  const archived = archiveSessionData(cleanSid, { reason });
  if (cleanSid === 'default' && archived.archived) permanentlyDeleteSessionData(cleanSid);
  return { ...archived, deleted: false };
}

module.exports = {
  getSessionId,
  getSessionDir,
  getRuntimePaths,
  buildRuntimePathsForSid,
  listKnownSessionIds,
  deleteSessionData,
  archiveSessionData,
  ensureSessionAssets,
  clearSessionDerivedState,
  cleanOldSessions,
};
