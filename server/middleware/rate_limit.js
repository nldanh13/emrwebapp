// server/middleware/rate_limit.js — Giới hạn tần suất request cho các endpoint nặng
// Dùng in-memory counter theo IP + session — không cần thư viện ngoài.
// Phù hợp cho internal tool với số lượng session ít (< 50).

'use strict';

const { sanitizeSessionId } = require('../utils/validation');

/**
 * Tạo rate limiter middleware.
 *
 * @param {object} opts
 * @param {number} opts.windowMs    - Cửa sổ thời gian tính (ms). Mặc định 60_000 (1 phút).
 * @param {number} opts.max         - Số request tối đa trong cửa sổ. Mặc định 10.
 * @param {string} [opts.message]   - Thông báo lỗi khi vượt giới hạn.
 * @param {Function} [opts.keyFn]   - Hàm trích key từ req. Mặc định: dùng IP + session ID.
 */
function createRateLimiter({ windowMs = 60_000, max = 10, message, keyFn } = {}) {
  /** Map key → { count, resetAt } */
  const store = new Map();

  // Dọn dẹp entries cũ mỗi 5 phút để tránh memory leak khi chạy lâu
  const cleanup = setInterval(() => {
    const now = Date.now();
    for (const [k, v] of store) {
      if (now > v.resetAt) store.delete(k);
    }
  }, 5 * 60_000);
  cleanup.unref(); // Không giữ process sống khi app exit

  function normalizeIp(value) {
    return String(value || 'unknown').trim().replace(/[^a-zA-Z0-9:._-]/g, '').slice(0, 80) || 'unknown';
  }

  const defaultKeyFn = req => {
    const sid = sanitizeSessionId(req.get('x-session-id') || req.query.sid || 'default');
    const ip = normalizeIp(req.ip || req.socket?.remoteAddress || 'unknown');
    return `${ip}::${sid}`;
  };

  const getKey = typeof keyFn === 'function' ? keyFn : defaultKeyFn;

  return function rateLimitMiddleware(req, res, next) {
    const key = getKey(req);
    const now = Date.now();
    const entry = store.get(key);

    if (!entry || now > entry.resetAt) {
      store.set(key, { count: 1, resetAt: now + windowMs });
      return next();
    }

    entry.count += 1;
    if (entry.count > max) {
      const retryAfter = Math.ceil((entry.resetAt - now) / 1000);
      res.setHeader('Retry-After', retryAfter);
      return res.status(429).json({
        status:  'error',
        message: message || `Quá nhiều request. Thử lại sau ${retryAfter} giây.`,
      });
    }
    return next();
  };
}

// ── Các preset cho từng loại endpoint ────────────────────────────────────────

/** Endpoint kích hoạt Python process (scan, details, input…): tối đa 5 lần/phút/session */
const heavyTaskLimiter = createRateLimiter({
  windowMs: 60_000,
  max:      5,
  message:  'Đang có tác vụ chạy. Chờ hoàn thành trước khi gửi lại.',
});

/** Endpoint đọc/ghi dữ liệu nhẹ: tối đa 60 lần/phút/session */
const readWriteLimiter = createRateLimiter({
  windowMs: 60_000,
  max:      60,
});

/**
 * Endpoint nghiên cứu đọc/poll nhiều API nhỏ khi đang chạy tác vụ dài.
 * Tách khỏi readWriteLimiter để auto-poll/progress không chặn tra cứu danh sách,
 * nhưng vẫn giữ một trần đủ cao để tránh vòng lặp UI lỗi.
 */
const researchReadLimiter = createRateLimiter({
  windowMs: 60_000,
  max:      600,
  message:  'Quá nhiều thao tác nghiên cứu. Vui lòng dừng tải lại liên tục rồi thử lại.',
});

/** Endpoint log giao diện: nhiều event nhỏ, cho phép tần suất cao hơn. */
const clientLogLimiter = createRateLimiter({
  windowMs: 60_000,
  max:      240,
});

module.exports = { createRateLimiter, heavyTaskLimiter, readWriteLimiter, researchReadLimiter, clientLogLimiter };
