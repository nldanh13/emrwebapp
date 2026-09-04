// server/middleware.js — Security headers, CORS và khóa API nội bộ

'use strict';

const { IS_DEV, APP_TOKEN, APP_TOKEN_MIN_LENGTH, HOST } = require('./constants');
const authz = require('./services/authz');

// ── Kiểm tra bảo mật khi khởi động ───────────────────────────────────────────
// Nếu HOST mở ra LAN/internet nhưng không đặt EMR_APP_TOKEN → từ chối khởi động.
// Dữ liệu bệnh nhân trong app này quá nhạy cảm để để mở không bảo vệ.
function checkStartupSafety() {
  try { authz.assertAuthConfiguration(); } catch (err) {
    console.error('');
    console.error('=============================================');
    console.error('   LỖI CẤU HÌNH XÁC THỰC');
    console.error(`   ${String(err.message || err)}`);
    console.error('=============================================');
    console.error('');
    process.exit(1);
  }

  const isLocalOnly = HOST === '127.0.0.1' || HOST === 'localhost' || HOST === '::1';
  if (!isLocalOnly && authz.authStatus().mode === 'local_only') {
    console.error('');
    console.error('=============================================');
    console.error('   LỖI BẢO MẬT — SERVER KHÔNG KHỞI ĐỘNG');
    console.error('');
    console.error(`   HOST=${HOST} mở API ra ngoài localhost`);
    console.error('   nhưng chưa có EMR_APP_TOKEN hoặc danh sách EMR_USERS.');
    console.error('');
    console.error('   Cách sửa (chọn một):');
    console.error('   1. Thêm EMR_APP_TOKEN hoặc EMR_USERS_FILE vào .env');
    console.error('   2. Đổi lại HOST=127.0.0.1 nếu chỉ dùng nội bộ máy này');
    console.error('=============================================');
    console.error('');
    process.exit(1);
  }

  if (!isLocalOnly && APP_TOKEN && APP_TOKEN.length < APP_TOKEN_MIN_LENGTH) {
    console.error('');
    console.error('=============================================');
    console.error('   LỖI BẢO MẬT — SERVER KHÔNG KHỞI ĐỘNG');
    console.error('');
    console.error(`   HOST=${HOST} mở API ra ngoài localhost`);
    console.error(`   nhưng EMR_APP_TOKEN quá ngắn (${APP_TOKEN.length} ký tự).`);
    console.error(`   Hãy dùng mã tối thiểu ${APP_TOKEN_MIN_LENGTH} ký tự, ngẫu nhiên/khó đoán.`);
    console.error('=============================================');
    console.error('');
    process.exit(1);
  }
}

function isDevUiOrigin(origin) {
  return IS_DEV && /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\]):(5173|5174)$/.test(String(origin || ''));
}

function isSameOriginRequest(req, origin) {
  try {
    const u = new URL(String(origin || ''));
    const host = String(req.get('host') || '').toLowerCase();
    return Boolean(host) && u.host.toLowerCase() === host;
  } catch (_) {
    return false;
  }
}

function blockCrossSiteApiRequests(req, res, next) {
  if (!req.path.startsWith('/api')) return next();

  const fetchSite = String(req.get('sec-fetch-site') || '').toLowerCase();
  if (fetchSite && ['same-origin', 'same-site', 'none'].includes(fetchSite)) return next();

  const origin = req.get('origin') || '';
  if (!origin && fetchSite !== 'cross-site') return next();
  if (isDevUiOrigin(origin) || isSameOriginRequest(req, origin)) return next();

  return res.status(403).json({
    status: 'error',
    message: 'Request API bị chặn vì không cùng nguồn với ứng dụng.',
  });
}

function applySecurityHeaders(app) {
  app.disable('x-powered-by');

  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    res.setHeader('X-Permitted-Cross-Domain-Policies', 'none');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    res.setHeader(
      'Content-Security-Policy',
      // Không bật script-src 'unsafe-inline'. Inline style vẫn được cho phép vì UI React dùng style={{}}.
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-ancestors 'none';"
    );

    if (req.path.startsWith('/api')) {
      // Dữ liệu EMR/session không nên bị cache bởi trình duyệt hoặc proxy nội bộ.
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Pragma', 'no-cache');
    }

    blockCrossSiteApiRequests(req, res, (err) => {
      if (err) return next(err);

      if (IS_DEV) {
      const origin = req.headers.origin || '';
      if (/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\]):(5173|5174)$/.test(origin)) {
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type,x-session-id,x-app-token,Authorization');
      }
        if (req.method === 'OPTIONS') return res.sendStatus(204);
      }

      return next();
    });
  });
}

function requireAppToken(req, res, next) {
  return authz.authenticateRequest(req, res, next);
}

function authorizeRequest(req, res, next) {
  return authz.authorizeRequest(req, res, next);
}

function isReportOttRequest(req) {
  return req.method === 'GET'
    && req.path === '/run-report-infusion'
    && req.query
    && typeof req.query.ott === 'string'
    && req.query.ott.trim();
}

module.exports = { checkStartupSafety, applySecurityHeaders, requireAppToken, authorizeRequest, isReportOttRequest, blockCrossSiteApiRequests };
