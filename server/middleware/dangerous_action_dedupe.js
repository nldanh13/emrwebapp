'use strict';

const crypto = require('crypto');
const { getRuntimePaths } = require('../services/session');

// Chỉ áp cho các thao tác có tác dụng bên ngoài / có nguy cơ lặp lại trên EMR.
// Các API đọc, preview, normalize... không bị giữ cache để tránh thay đổi hành vi.
const PROTECTED_ACTIONS = new Set([
  '/run-input-care',
  '/run-input-infusions',
  '/run-input-procedures',
  '/run-input-vtyt',
  '/clinic/input-care',
  '/clinic/monitor/complete',
  '/clinic/monitor/ngoaitru',
  '/clinic/monitor/bbhc/run',
  '/hchanh/sign-discharge-bundle',
]);

const ACTIVE = new Map();
const RECENT = new Map();
const TTL_MS = Math.max(5_000, Number.parseInt(process.env.EMR_ACTION_DEDUPE_TTL_MS || '20000', 10) || 20_000);
const MAX_RECENT = Math.max(50, Number.parseInt(process.env.EMR_ACTION_DEDUPE_MAX || '500', 10) || 500);
const MAX_REPLAY_BYTES = 512 * 1024;

function stableValue(value, depth = 0) {
  if (depth > 20) return '[depth-limit]';
  if (Array.isArray(value)) return value.map(v => stableValue(v, depth + 1));
  if (!value || typeof value !== 'object') return value;
  const out = {};
  for (const key of Object.keys(value).sort()) out[key] = stableValue(value[key], depth + 1);
  return out;
}

function actionPath(req) {
  return String(req.path || '').trim();
}

function isProtectedAction(req) {
  return String(req.method || '').toUpperCase() === 'POST' && PROTECTED_ACTIONS.has(actionPath(req));
}

function actionFingerprint(req) {
  const ctx = getRuntimePaths(req);
  const basis = JSON.stringify({
    sid: ctx.sid,
    method: String(req.method || '').toUpperCase(),
    path: actionPath(req),
    query: req.query && typeof req.query === 'object' ? stableValue(req.query) : {},
    body: stableValue(req.body),
  });
  const digest = crypto.createHash('sha256').update(basis).digest('hex');
  return { key: `${ctx.sid}:${actionPath(req)}:${digest}`, sid: ctx.sid, digest };
}

function pruneRecent(now = Date.now()) {
  for (const [key, entry] of RECENT) {
    if (!entry || entry.expires_at <= now) RECENT.delete(key);
  }
  if (RECENT.size <= MAX_RECENT) return;
  const rows = [...RECENT.entries()].sort((a, b) => Number(b[1]?.created_at || 0) - Number(a[1]?.created_at || 0));
  RECENT.clear();
  for (const [key, value] of rows.slice(0, MAX_RECENT)) RECENT.set(key, value);
}

function dangerousActionDedupe(req, res, next) {
  if (!isProtectedAction(req)) return next();

  pruneRecent();
  const fp = actionFingerprint(req);
  const running = ACTIVE.get(fp.key);
  if (running) {
    return res.status(409).json({
      status: 'conflict',
      code: 'ACTION_ALREADY_RUNNING',
      message: 'Thao tác giống hệt đang chạy từ một thiết bị khác hoặc do bấm lặp. Hệ thống không chạy lần thứ hai.',
      started_at: running.started_at,
    });
  }

  const cached = RECENT.get(fp.key);
  if (cached && cached.expires_at > Date.now()) {
    res.setHeader('X-Idempotent-Replay', '1');
    res.setHeader('X-Action-Fingerprint', fp.digest.slice(0, 16));
    return res.status(cached.status_code).json(cached.body);
  }

  ACTIVE.set(fp.key, { started_at: new Date().toISOString() });
  res.setHeader('X-Action-Fingerprint', fp.digest.slice(0, 16));

  let capturedBody;
  const originalJson = res.json.bind(res);
  res.json = function dedupeJson(body) {
    capturedBody = body;
    return originalJson(body);
  };

  let finalized = false;
  const finalize = () => {
    if (finalized) return;
    finalized = true;
    ACTIVE.delete(fp.key);
    if (res.statusCode >= 200 && res.statusCode < 400 && capturedBody !== undefined) {
      try {
        const size = Buffer.byteLength(JSON.stringify(capturedBody), 'utf8');
        if (size <= MAX_REPLAY_BYTES) {
          RECENT.set(fp.key, {
            created_at: Date.now(),
            expires_at: Date.now() + TTL_MS,
            status_code: res.statusCode,
            body: capturedBody,
          });
          pruneRecent();
        }
      } catch (_) {}
    }
  };

  res.once('finish', finalize);
  res.once('close', finalize);
  return next();
}

function getDedupeState() {
  pruneRecent();
  return { active: ACTIVE.size, recent: RECENT.size, ttl_ms: TTL_MS };
}

module.exports = {
  dangerousActionDedupe,
  isProtectedAction,
  actionFingerprint,
  getDedupeState,
  PROTECTED_ACTIONS,
};
