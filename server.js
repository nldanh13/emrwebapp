// server.js — Entry point
// Chỉ chịu trách nhiệm: khởi tạo app, gắn middleware, đăng ký routes, lắng nghe port.
// Toàn bộ logic nằm trong server/

'use strict';

// Load .env trước mọi thứ
require('dotenv').config();

const express = require('express');
const path    = require('path');
const fs      = require('fs');

const { PORT, HOST, DIST_DIR, PUBLIC_DIR, CONFIG_PATH, SESSION_RETENTION_MODE } = require('./server/constants');
const middleware                      = require('./server/middleware');
const routes                          = require('./server/routes');
const { cleanOldSessions }            = require('./server/services/session');
const { authStatus }                   = require('./server/services/authz');
const { patientNameResponseMiddleware } = require('./server/utils/person_name');

// ── Kiểm tra bảo mật trước khi làm bất cứ điều gì ───────────────────────────
middleware.checkStartupSafety();

function warnMissingRuntimeConfig() {
  if (fs.existsSync(CONFIG_PATH)) return;
  console.warn('');
  console.warn('=============================================');
  console.warn('   CẢNH BÁO CẤU HÌNH');
  console.warn('   Chưa có config/config.json.');
  console.warn('   Hãy copy config/config.example.json thành config/config.json');
  console.warn('   rồi điền tài khoản/thông tin EMR trước khi quét hoặc nhập dữ liệu.');
  console.warn('=============================================');
  console.warn('');
}
warnMissingRuntimeConfig();

const app = express();

// ── Hardening & CORS ──────────────────────────────────────────────────────────
middleware.applySecurityHeaders(app);

// ── API authentication + body parser ──────────────────────────────────────────
// Xác thực trước khi parse JSON để request không hợp lệ không thể buộc server giữ
// payload lớn trong RAM.
app.use('/api', middleware.requireAppToken);
// Chỉ các endpoint upload thực sự cần payload lớn. Các API khác bị giới hạn.
app.use('/api/research/archive/source', express.json({ limit: process.env.EMR_RESEARCH_UPLOAD_LIMIT || '50mb' }));
app.use('/api/clinic/preview', express.json({ limit: process.env.EMR_CLINIC_UPLOAD_LIMIT || '12mb' }));
app.use('/api', express.json({ limit: process.env.EMR_JSON_BODY_LIMIT || '10mb' }));
// Chuẩn hóa tên người bệnh ở một điểm chung trước khi mọi API trả JSON.
app.use('/api', patientNameResponseMiddleware);
app.use('/api', (err, _req, res, next) => {
  if (!err) return next();
  if (err.type === 'entity.too.large') {
    return res.status(413).json({ status: 'error', code: 'PAYLOAD_TOO_LARGE', message: 'Dữ liệu gửi lên vượt quá giới hạn cho phép.' });
  }
  if (err instanceof SyntaxError && Object.prototype.hasOwnProperty.call(err, 'body')) {
    return res.status(400).json({ status: 'error', code: 'INVALID_JSON', message: 'Nội dung JSON không hợp lệ.' });
  }
  return next(err);
});

// ── Static UI (built React) ───────────────────────────────────────────────────

if (fs.existsSync(DIST_DIR))   app.use(express.static(DIST_DIR,   { index: false }));
if (fs.existsSync(PUBLIC_DIR)) app.use(express.static(PUBLIC_DIR, { index: false }));

// ── API routes ────────────────────────────────────────────────────────────────
// Mọi API dùng xác thực local-only, legacy token hoặc multi-user token theo cấu hình.
app.use('/api', middleware.authorizeRequest, routes);
app.use('/api', (err, _req, res, _next) => {
  console.error('[API_ERROR]', err?.stack || err);
  return res.status(Number(err?.status) || 500).json({
    status: 'error',
    code: String(err?.code || 'INTERNAL_ERROR'),
    message: Number(err?.status) && Number(err.status) < 500 ? String(err.message || err) : 'Lỗi nội bộ. Kiểm tra audit/log server.',
  });
});

function sendMissingBuildPage(res) {
  return res.status(503).type('html').send(`<!doctype html>
<html lang="vi">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>EMR Dashboard - Chưa build giao diện</title>
  <style>
    body { margin:0; font-family: Segoe UI, Arial, sans-serif; background:#0d1117; color:#e6edf3; }
    main { max-width:760px; margin:64px auto; padding:24px; border:1px solid #30363d; border-radius:14px; background:#161b22; }
    h1 { margin:0 0 12px; font-size:22px; }
    p { line-height:1.6; color:#c9d1d9; }
    code { display:block; padding:12px 14px; margin:12px 0; border-radius:10px; background:#0d1117; color:#79c0ff; }
  </style>
</head>
<body>
  <main>
    <h1>Giao diện chưa được build</h1>
    <p>Server Express đang chạy, nhưng thư mục <b>dist/</b> chưa có file giao diện React hợp lệ. Vì vậy trang cũ có thể chỉ hiện nền đen.</p>
    <p>Trong thư mục project, chạy:</p>
    <code>npm install</code>
    <code>npm start</code>
    <p>Lệnh <b>npm start</b> mới sẽ tự build giao diện trước khi mở server.</p>
  </main>
</body>
</html>`);
}

// ── SPA fallback ──────────────────────────────────────────────────────────────
app.get(/^(?!\/api).*/, (_req, res) => {
  const distIndex = path.join(DIST_DIR, 'index.html');
  const publicIndex = path.join(PUBLIC_DIR, 'index.html');

  if (fs.existsSync(distIndex)) return res.sendFile(distIndex);
  if (fs.existsSync(publicIndex)) return res.sendFile(publicIndex);

  // Không serve file index.html ở thư mục gốc vì file đó dành cho Vite dev server.
  // Express không transform /src/main.jsx; serve nhầm file này sẽ làm trình duyệt chỉ hiện nền đen.
  return sendMissingBuildPage(res);
});

// ── Startup ───────────────────────────────────────────────────────────────────
cleanOldSessions();
if (SESSION_RETENTION_MODE !== 'disabled') {
  const timer = setInterval(cleanOldSessions, 6 * 60 * 60 * 1000);
  timer.unref?.();
}

app.listen(PORT, HOST, () => {
  const shownHost = HOST === '0.0.0.0' ? 'localhost' : HOST;
  console.log('=============================================');
  console.log(`   SERVER ĐANG CHẠY: http://${shownHost}:${PORT}`);
  console.log(`   BIND HOST: ${HOST}`);
  const auth = authStatus();
  console.log(`   XÁC THỰC: ${auth.mode}`);
  console.log(`   RETENTION: ${SESSION_RETENTION_MODE}`);
  console.log('   (Giữ cửa sổ này mở để hệ thống hoạt động)');
  console.log('=============================================');
});
