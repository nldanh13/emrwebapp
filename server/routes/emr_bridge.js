// server/routes/emr_bridge.js — /api/emr-bridge: trang cầu nối (trên máy bệnh viện) hỏi việc và trả
// nội dung trang EMR; Data Hub xem trạng thái "Máy BV: đang nối". Xem server/services/emr_bridge.js.

'use strict';

const express = require('express');
const bridge = require('../services/emr_bridge');

const router = express.Router();
const fail = (res, status, message, code = '') => res.status(status).json({ status: 'error', message, ...(code ? { code } : {}) });

router.get('/emr-bridge/status', (_req, res) => res.json({ status: 'ok', bridge: bridge.status() }));

router.post('/emr-bridge/hello', (req, res) => {
  try {
    const s = bridge.hello({
      bridgeId: req.body?.bridge_id,
      userId: req.auth?.id || '',
      userName: req.auth?.name || req.auth?.display_name || req.auth?.id || '',
      emrOrigin: req.body?.emr_origin,
      emrUrl: req.body?.emr_url,
      emrLoggedIn: req.body?.emr_logged_in !== false,
    });
    return res.json({ status: 'ok', bridge: s });
  } catch (e) {
    return fail(res, 400, String(e.message || e));
  }
});

router.post('/emr-bridge/poll', async (req, res) => {
  const id = String(req.body?.bridge_id || '');
  const signal = {};
  let closed = false;
  res.on('close', () => { if (!res.writableFinished) { closed = true; signal.cancel?.(); } });
  try {
    const requests = await bridge.poll(id, { signal });
    if (closed || res.destroyed) { bridge.requeue(id, requests); return undefined; }
    return res.json({ status: 'ok', requests });
  } catch (e) {
    return fail(res, 409, String(e.message || e), e.code || '');
  }
});

router.post('/emr-bridge/result', (req, res) => {
  const ok = bridge.submitResult(String(req.body?.bridge_id || ''), req.body || {});
  return res.json({ status: 'ok', accepted: ok });
});

router.post('/emr-bridge/disconnect', (req, res) => {
  bridge.disconnect(String(req.body?.bridge_id || ''));
  return res.json({ status: 'ok' });
});

// Dành cho worker Python chạy trong cùng máy chủ: mount TRƯỚC lớp đăng nhập (server.js), chỉ nhận
// kết nối từ chính máy chủ và phải kèm mã nội bộ (sinh ngẫu nhiên mỗi lần khởi động).
const internalRouter = express.Router();
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

function internalOnly(req, res, next) {
  if (!LOOPBACK.has(String(req.socket?.remoteAddress || '')) || !bridge.checkInternalToken(req.get('x-bridge-token'))) {
    return fail(res, 403, 'Chỉ worker trong máy chủ được dùng cầu nối.');
  }
  return next();
}

internalRouter.post('/info', internalOnly, (_req, res) => {
  const blocker = bridge.collectionBlocker();
  if (blocker) return fail(res, 502, blocker, 'BRIDGE_OFFLINE');
  return res.json({ status: 'ok', emr_origin: bridge.status().emr_origin, emr_url: bridge.currentEmrUrl() });
});

internalRouter.post('/fetch', internalOnly, express.json({ limit: '5mb' }), async (req, res) => {
  try {
    const r = await bridge.request({
      method: req.body?.method,
      url: req.body?.url,
      body: req.body?.body ?? null,
      contentType: req.body?.content_type || '',
      referrer: req.body?.referrer || '',
      headers: req.body?.headers || null,
    });
    return res.json({ status: 'ok', http_status: r.status, url: r.url, text: r.text });
  } catch (e) {
    return fail(res, 502, String(e.message || e), e.code || 'BRIDGE_ERROR');
  }
});

module.exports = router;
module.exports.internalRouter = internalRouter;
