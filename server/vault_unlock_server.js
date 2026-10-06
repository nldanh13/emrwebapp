// server/vault_unlock_server.js — Trang "Mở kho dữ liệu" khi kho mã hóa trên VPS đang khóa.
//
// Chạy bằng dịch vụ emrwebapp-unlock (quyền root, để gắn ổ mã hóa) MỖI KHI VPS khởi động lại và kho
// chưa mở. Ứng dụng chính (emrwebapp) chưa chạy lúc này — nó chỉ chạy khi kho đã mở.
//
// Chỉ làm 3 việc, không đọc dữ liệu nào:
//   GET  /api/vault/status   → { locked: true }
//   POST /api/vault/unlock   → mật khẩu kho, CHỈ nhận từ thiết bị tin cậy (chữ ký thiết bị)
//   GET  (mọi đường dẫn khác) → trang public/vault-unlock.html
// Mở được: gắn ổ mã hóa (gocryptfs, mật khẩu qua stdin — không qua dòng lệnh/nhật ký), khởi động
// ứng dụng chính rồi tự thoát. Mật khẩu không được ghi lại ở đâu.

'use strict';

const express = require('express');
const path = require('path');
const { spawn } = require('child_process');
const td = require('./services/trusted_devices');

const MAX_FAILS = 5;
const LOCK_MS = 15 * 60 * 1000;
const PAGE = path.join(__dirname, 'static', 'vault-unlock.html');

function clientIp(req) {
  const remote = String(req.socket?.remoteAddress || '');
  const local = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(remote);
  const fwd = String(req.get('x-forwarded-for') || '').split(',')[0].trim();
  return local && fwd ? fwd : remote;
}

function runWithStdin(cmd, input) {
  return new Promise((resolve) => {
    const [bin, ...args] = cmd;
    const child = spawn(bin, args, { stdio: ['pipe', 'ignore', 'pipe'] });
    let err = '';
    child.stderr.on('data', d => { err += d; });
    child.on('error', e => resolve({ ok: false, err: String(e.message || e) }));
    child.on('close', code => resolve({ ok: code === 0, err }));
    child.stdin.end(`${input}\n`);
  });
}

function defaultMountCommand() {
  const cipher = process.env.EMR_VAULT_CIPHER_DIR || '/opt/emrwebapp/vault.enc';
  const mount = process.env.EMR_VAULT_MOUNT_DIR || '/opt/emrwebapp/vault';
  // -allow_other: ứng dụng chạy bằng người dùng "emr" đọc/ghi được ổ do root gắn.
  return ['gocryptfs', '-q', '-allow_other', cipher, mount];
}

function defaultAfterUnlock() {
  return new Promise((resolve) => {
    spawn('systemctl', ['start', '--no-block', 'emrwebapp'], { stdio: 'ignore' }).on('close', () => resolve());
  });
}

function createUnlockApp({ mountCommand = defaultMountCommand(), afterUnlock = defaultAfterUnlock, onUnlocked = () => {} } = {}) {
  const app = express();
  const fails = new Map(); // ip → { count, first, lockedUntil }
  let unlocking = false;

  app.disable('x-powered-by');
  app.use((_req, res, next) => {
    res.set('Cache-Control', 'no-store');
    res.set('X-Content-Type-Options', 'nosniff');
    next();
  });

  app.get('/api/vault/status', (_req, res) => res.json({ status: 'ok', locked: true }));
  app.get('/api/health', (_req, res) => res.status(503).json({ status: 'locked' }));

  app.post('/api/vault/unlock', express.json({ limit: '2kb' }), async (req, res) => {
    const ip = clientIp(req);
    const now = Date.now();
    const st = fails.get(ip);
    if (st?.lockedUntil > now) {
      return res.status(429).json({ status: 'error', message: `Nhập sai quá ${MAX_FAILS} lần. Thử lại sau ${Math.ceil((st.lockedUntil - now) / 60000)} phút.` });
    }
    const device = td.verifyRequest({
      deviceId: req.get('x-device-id'), ts: req.get('x-device-ts'), sig: req.get('x-device-sig'),
      method: req.method, url: req.originalUrl, anyUser: true, now,
    });
    if (!device) {
      return res.status(403).json({ status: 'error', message: 'Chỉ thiết bị tin cậy mới mở được kho. Hãy dùng điện thoại/máy đã đăng ký.' });
    }
    const passphrase = String(req.body?.passphrase || '');
    if (!passphrase) return res.status(400).json({ status: 'error', message: 'Nhập mật khẩu kho.' });
    if (unlocking) return res.status(409).json({ status: 'error', message: 'Đang mở kho, chờ vài giây.' });

    unlocking = true;
    const result = await runWithStdin(mountCommand, passphrase);
    unlocking = false;
    if (!result.ok) {
      const cur = !st || now - st.first > LOCK_MS ? { count: 0, first: now, lockedUntil: 0 } : st;
      cur.count += 1;
      if (cur.count >= MAX_FAILS) cur.lockedUntil = now + LOCK_MS;
      fails.set(ip, cur);
      return res.status(401).json({ status: 'error', message: 'Mật khẩu kho không đúng (hoặc không gắn được ổ mã hóa). Kiểm tra lại rồi thử lần nữa.' });
    }
    fails.delete(ip);
    console.log(`[vault] Đã mở kho bằng thiết bị "${device.name}" (${device.user_id}) lúc ${new Date(now).toISOString()}.`);
    res.json({ status: 'ok', message: 'Đã mở kho. Ứng dụng đang khởi động, trang sẽ tự chuyển.' });
    await afterUnlock();
    onUnlocked();
  });

  app.use((req, res) => {
    if (req.method === 'GET' && !req.path.startsWith('/api/')) return res.sendFile(PAGE);
    return res.status(503).json({ status: 'error', message: 'Kho dữ liệu đang khóa. Mở kho trên thiết bị tin cậy rồi thử lại.' });
  });
  return app;
}

module.exports = { createUnlockApp };

if (require.main === module) {
  const host = process.env.HOST || '127.0.0.1';
  const port = Number(process.env.PORT || 3001);
  let server;
  // Nhả cổng trước rồi mới khởi động ứng dụng chính (cùng cổng), xong thì thoát.
  const app = createUnlockApp({
    afterUnlock: async () => {
      await new Promise(r => { server.close(() => r()); setTimeout(r, 2000).unref(); });
      await defaultAfterUnlock();
    },
    onUnlocked: () => process.exit(0),
  });
  server = app.listen(port, host, () => console.log(`[vault] Kho đang khóa. Trang Mở kho: http://${host}:${port}`));
}
