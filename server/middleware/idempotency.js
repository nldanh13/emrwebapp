'use strict';

const crypto = require('crypto');
const { getRuntimePaths } = require('../services/session');

const TTL_MS = Math.max(30_000, Number.parseInt(process.env.EMR_IDEMPOTENCY_TTL_MS || '600000', 10) || 600000);
const MAX_ENTRIES = Math.max(100, Number.parseInt(process.env.EMR_IDEMPOTENCY_MAX || '5000', 10) || 5000);
const AUTO_WINDOW_MS = Math.max(1500, Number.parseInt(process.env.EMR_IDEMPOTENCY_AUTO_WINDOW_MS || '4000', 10) || 4000);
const STORE = new Map();

const PROTECTED_PREFIXES = [
  '/run-',
  '/hchanh/fetch',
  '/hchanh/rescan',
  '/hchanh/print-',
  '/hchanh/sign-',
  '/clinic/input-',
  '/clinic/monitor/complete',
  '/clinic/monitor/ngoaitru',
  '/research/archive/run',
  '/research/archive/collect-auto',
  '/research/archive/fetch-',
  '/research/archive/normalize',
  '/research/archive/finalize-dataset',
  '/research/archive/build-encoded-dataset',
  '/research/refetch-missing',
  '/research/studies/',
  '/workflows/',
  '/check-current-bed',
];

function isMutation(req) {
  return ['POST', 'PUT', 'PATCH', 'DELETE'].includes(String(req.method || '').toUpperCase());
}

function isProtectedPath(req) {
  const p = String(req.path || '');
  if (p === '/cancel' || p.startsWith('/client-log')) return false;
  return PROTECTED_PREFIXES.some(prefix => p.startsWith(prefix));
}

function requestFingerprint(req) {
  const body = req.body == null ? null : req.body;
  const canonical = JSON.stringify({
    method: String(req.method || '').toUpperCase(),
    path: String(req.originalUrl || req.path || ''),
    body,
  });
  return crypto.createHash('sha256').update(canonical).digest('hex');
}

function cleanup() {
  const now = Date.now();
  for (const [key, entry] of STORE.entries()) {
    if (now - entry.created_at > TTL_MS) STORE.delete(key);
  }
  if (STORE.size <= MAX_ENTRIES) return;
  const ordered = [...STORE.entries()].sort((a, b) => a[1].created_at - b[1].created_at);
  for (const [key] of ordered.slice(0, STORE.size - MAX_ENTRIES)) STORE.delete(key);
}

function effectiveKey(req, fingerprint) {
  const explicit = String(req.get('idempotency-key') || '').trim();
  if (explicit) return { value: explicit, explicit: true };
  // Client cũ/thiết bị khác chưa hỗ trợ header vẫn được bảo vệ trước double-click
  // hoặc hai thiết bị gửi cùng payload gần như đồng thời. Cửa sổ ngắn tránh chặn
  // các lần chạy chủ động lặp lại về sau.
  const bucket = Math.floor(Date.now() / AUTO_WINDOW_MS);
  return { value: `auto-${fingerprint.slice(0, 24)}-${bucket}`, explicit: false };
}

function idempotencyMiddleware(req, res, next) {
  if (!isMutation(req) || !isProtectedPath(req)) return next();

  const fingerprint = requestFingerprint(req);
  const selectedKey = effectiveKey(req, fingerprint);
  const rawKey = selectedKey.value;
  if (!/^[a-zA-Z0-9._:-]{8,180}$/.test(rawKey)) {
    return res.status(400).json({ status: 'error', code: 'INVALID_IDEMPOTENCY_KEY', message: 'Idempotency-Key không hợp lệ.' });
  }

  cleanup();
  const sid = getRuntimePaths(req).sid;
  const key = `${sid}:${String(req.method).toUpperCase()}:${String(req.path || '')}:${rawKey}`;
  const existing = STORE.get(key);

  if (existing) {
    if (existing.fingerprint !== fingerprint) {
      return res.status(409).json({
        status: 'conflict',
        code: 'IDEMPOTENCY_KEY_REUSED',
        message: 'Cùng Idempotency-Key đã được dùng cho nội dung khác.',
      });
    }
    if (existing.state === 'running') {
      return res.status(409).json({
        status: 'conflict',
        code: 'IDEMPOTENCY_IN_PROGRESS',
        auto_dedupe: !selectedKey.explicit,
        message: 'Thao tác giống hệt đang được xử lý trên thiết bị khác. Không chạy lặp lại.',
      });
    }
    res.setHeader('X-Idempotent-Replay', '1');
    if (!selectedKey.explicit) res.setHeader('X-Idempotent-Auto', '1');
    res.status(existing.status_code || 200);
    return res.json(existing.body);
  }

  const entry = {
    state: 'running',
    fingerprint,
    created_at: Date.now(),
    status_code: 0,
    body: null,
    auto: !selectedKey.explicit,
  };
  STORE.set(key, entry);

  const originalJson = res.json.bind(res);
  res.json = function wrappedJson(body) {
    const status = Number(res.statusCode || 200);
    if (status >= 200 && status < 500) {
      entry.state = 'done';
      entry.status_code = status;
      entry.body = body;
      entry.finished_at = Date.now();
    } else {
      STORE.delete(key);
    }
    return originalJson(body);
  };

  const releaseOnAbort = () => {
    if (entry.state === 'running') STORE.delete(key);
  };
  res.once('close', releaseOnAbort);
  return next();
}

function getIdempotencyStats() {
  cleanup();
  let running = 0;
  let done = 0;
  let auto = 0;
  for (const item of STORE.values()) {
    item.state === 'running' ? running++ : done++;
    if (item.auto) auto++;
  }
  return { total: STORE.size, running, done, auto, ttl_ms: TTL_MS, auto_window_ms: AUTO_WINDOW_MS };
}

module.exports = { idempotencyMiddleware, getIdempotencyStats, isProtectedPath, requestFingerprint, effectiveKey };
