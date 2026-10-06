// server/services/emr_bridge.js — Cầu nối tab EMR.
//
// Dùng khi Data Hub chạy trên cloud (VPS) mà EMR chỉ mở được trong mạng bệnh viện. Trên một máy
// bệnh viện, người dùng mở EMR, đăng nhập rồi bấm nút dấu trang "Data Hub": tab EMR mở trang
// /emr-bridge của Data Hub và hai tab nói chuyện qua postMessage. Trang cầu nối hỏi máy chủ
// (long-poll) "có trang EMR nào cần lấy không", chuyển yêu cầu sang tab EMR; tab EMR tự gọi
// fetch() cùng nguồn (dùng phiên đăng nhập EMR sẵn có) rồi trả nội dung về.
//
// Worker Python trên VPS không vào EMR trực tiếp: mọi get_html/post_html gọi
// POST /api/emr-bridge/internal/fetch (chỉ từ trong máy, kèm mã nội bộ) → hàng đợi ở đây.
//
// Bảo vệ:
// - Chỉ đường dẫn CÙNG NGUỒN với EMR (tab EMR cũng tự chặn) — cầu nối không thể bị dùng để gọi
//   máy khác trong mạng bệnh viện.
// - Trang cầu nối phải đăng nhập + qua thiết bị tin cậy như mọi trang khác.
// - Không lưu nội dung trang EMR ở đây; chỉ chuyển tiếp trong bộ nhớ.

'use strict';

const crypto = require('crypto');
const { EventEmitter } = require('events');

const POLL_WAIT_MS = 25 * 1000;
const OFFLINE_AFTER_MS = 75 * 1000;
const REQUEST_TIMEOUT_MS = 90 * 1000;
const MAX_QUEUE = 200;

const emitter = new EventEmitter();
emitter.setMaxListeners(200);

const INTERNAL_TOKEN = crypto.randomBytes(24).toString('base64url');

let bridge = null; // { id, userId, userName, emrOrigin, emrUrl, connectedAt, lastSeen, emrLoggedIn, queue, waiters }
const pending = new Map(); // requestId → { resolve, reject, timer, bridgeId }
let sweepTimer = null;
let lastPublished = '';

function bridgeModeEnabled() {
  return /^(1|true|yes|on)$/i.test(String(process.env.EMR_BRIDGE_MODE || '').trim());
}

function isOnline(b = bridge, now = Date.now()) {
  return Boolean(b && now - b.lastSeen <= OFFLINE_AFTER_MS);
}

function status(now = Date.now()) {
  const online = isOnline(bridge, now);
  return {
    enabled: bridgeModeEnabled(),
    connected: online,
    emr_logged_in: online ? bridge.emrLoggedIn !== false : null,
    emr_origin: bridge?.emrOrigin || '',
    user: bridge ? { id: bridge.userId, name: bridge.userName } : null,
    connected_at: bridge?.connectedAt ? new Date(bridge.connectedAt).toISOString() : '',
    last_seen_at: bridge?.lastSeen ? new Date(bridge.lastSeen).toISOString() : '',
    pending: bridge ? bridge.queue.length + [...pending.values()].filter(p => p.bridgeId === bridge.id).length : 0,
  };
}

function publish() {
  const s = status();
  const sig = JSON.stringify([s.connected, s.emr_logged_in, s.emr_origin, s.user?.id || '']);
  if (sig === lastPublished) return;
  lastPublished = sig;
  emitter.emit('bridge', { event: 'bridge_status', at: new Date().toISOString(), ...s });
}

function subscribeBridgeEvents(listener) {
  emitter.on('bridge', listener);
  return () => emitter.off('bridge', listener);
}

function ensureSweep() {
  if (sweepTimer) return;
  sweepTimer = setInterval(() => {
    if (bridge && !isOnline(bridge)) failBridgeRequests(bridge.id, 'Mất nối với tab EMR trên máy bệnh viện.');
    publish();
  }, 15 * 1000);
  sweepTimer.unref?.();
}

function failBridgeRequests(bridgeId, message) {
  if (bridge && bridge.id === bridgeId) {
    bridge.queue.splice(0);
  }
  for (const [id, p] of pending) {
    if (p.bridgeId !== bridgeId) continue;
    clearTimeout(p.timer);
    pending.delete(id);
    p.reject(new Error(message));
  }
}

function normalizeOrigin(value) {
  try {
    const u = new URL(String(value || ''));
    if (!/^https?:$/.test(u.protocol)) return '';
    return u.origin;
  } catch (_) {
    return '';
  }
}

// Tab cầu nối báo "tôi đang nối với tab EMR ở <origin>".
function hello({ bridgeId, userId = '', userName = '', emrOrigin, emrUrl = '', emrLoggedIn = true, now = Date.now() } = {}) {
  const origin = normalizeOrigin(emrOrigin);
  if (!origin) throw new Error('Không nhận ra địa chỉ EMR. Mở trang EMR rồi bấm lại nút Data Hub.');
  const id = String(bridgeId || '').slice(0, 64);
  if (!id) throw new Error('Thiếu mã cầu nối. Tải lại trang cầu nối.');
  if (bridge && bridge.id !== id) {
    // Cầu nối mới thay cầu nối cũ (vd. bấm nút trên máy khác): yêu cầu đang chờ ở cầu cũ báo lỗi để chạy lại.
    failBridgeRequests(bridge.id, 'Cầu nối EMR vừa được mở ở tab/máy khác.');
    for (const w of bridge.waiters) w([]);
    bridge = null;
  }
  if (!bridge) {
    bridge = { id, connectedAt: now, queue: [], waiters: [] };
  }
  Object.assign(bridge, {
    userId: String(userId || ''),
    userName: String(userName || ''),
    emrOrigin: origin,
    emrUrl: String(emrUrl || '').slice(0, 2000),
    lastSeen: now,
    emrLoggedIn: emrLoggedIn !== false,
  });
  ensureSweep();
  publish();
  return status(now);
}

function disconnect(bridgeId) {
  if (!bridge || bridge.id !== bridgeId) return;
  failBridgeRequests(bridge.id, 'Tab EMR trên máy bệnh viện đã đóng.');
  for (const w of bridge.waiters) w([]);
  bridge = null;
  publish();
}

function takeQueue(b) {
  return b.queue.splice(0, 10);
}

// Trang cầu nối hỏi việc. Có việc thì trả ngay, không thì chờ tối đa waitMs.
// signal.cancel được gán để route hủy lượt chờ khi kết nối đóng (không lấy mất việc của lượt sau).
function poll(bridgeId, { waitMs = POLL_WAIT_MS, now = Date.now(), signal = null } = {}) {
  if (!bridge || bridge.id !== bridgeId) {
    return Promise.reject(Object.assign(new Error('Cầu nối chưa đăng ký hoặc đã bị thay. Bấm lại nút Data Hub trên tab EMR.'), { code: 'BRIDGE_UNKNOWN' }));
  }
  bridge.lastSeen = now;
  publish();
  if (bridge.queue.length) return Promise.resolve(takeQueue(bridge));
  const b = bridge;
  return new Promise((resolve) => {
    let done = false;
    const finish = (items) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      const i = b.waiters.indexOf(waiter);
      if (i >= 0) b.waiters.splice(i, 1);
      resolve(items);
    };
    const waiter = () => finish(takeQueue(b));
    const timer = setTimeout(() => finish([]), Math.max(0, waitMs));
    timer.unref?.();
    b.waiters.push(waiter);
    if (signal) signal.cancel = () => finish([]);
  });
}

// Kết nối hỏi việc đóng trước khi kịp gửi việc đi: trả việc về đầu hàng đợi.
function requeue(bridgeId, items = []) {
  if (!bridge || bridge.id !== bridgeId || !items.length) return;
  bridge.queue.unshift(...items.filter(it => pending.has(it.id)));
  const w = bridge.waiters.shift();
  if (w) w();
}

function submitResult(bridgeId, result = {}) {
  if (bridge && bridge.id === bridgeId) {
    bridge.lastSeen = Date.now();
    if (typeof result.emr_logged_in === 'boolean') bridge.emrLoggedIn = result.emr_logged_in;
  }
  const p = pending.get(String(result.id || ''));
  if (!p || p.bridgeId !== bridgeId) return false;
  clearTimeout(p.timer);
  pending.delete(String(result.id));
  if (result.ok) {
    p.resolve({ status: Number(result.status) || 0, url: String(result.url || ''), text: String(result.text ?? '') });
  } else {
    p.reject(new Error(`Tab EMR không lấy được trang: ${String(result.error || 'lỗi không rõ').slice(0, 300)}`));
  }
  publish();
  return true;
}

// Đổi URL tuyệt đối/tương đối thành đường dẫn cùng nguồn EMR. Khác nguồn → từ chối.
function toEmrPath(url, origin) {
  const raw = String(url || '').trim();
  if (!raw) throw new Error('Thiếu địa chỉ trang EMR.');
  const u = new URL(raw, `${origin}/`);
  if (u.origin !== origin) {
    throw new Error(`Chỉ lấy được trang thuộc EMR (${origin}); bỏ qua ${u.origin}.`);
  }
  return u.pathname + u.search;
}

// Worker xin một trang EMR qua tab trình duyệt ở bệnh viện.
// Tiêu đề thêm cho fetch() trong tab EMR (vd. X-AjaxPro-Method). Bỏ tiêu đề trình duyệt tự quản.
const FORBIDDEN_HEADER = /^(origin|referer|host|cookie|cookie2|user-agent|connection|content-length|accept-encoding|accept-charset|date|dnt|expect|keep-alive|te|trailer|transfer-encoding|upgrade|via|proxy-.*|sec-.*)$/i;
function cleanHeaders(headers) {
  const out = {};
  if (!headers || typeof headers !== 'object') return out;
  for (const [k, v] of Object.entries(headers).slice(0, 20)) {
    const key = String(k || '').trim();
    if (!/^[A-Za-z0-9-]{1,60}$/.test(key) || FORBIDDEN_HEADER.test(key)) continue;
    out[key] = String(v ?? '').slice(0, 500);
  }
  return out;
}

function request({ method = 'GET', url, body = null, contentType = '', referrer = '', headers = null, timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
  if (!isOnline()) {
    return Promise.reject(Object.assign(new Error(
      'Chưa nối tab EMR. Trên một máy trong bệnh viện: mở EMR, đăng nhập, bấm nút "Data Hub" trên thanh dấu trang rồi chạy lại.'
    ), { code: 'BRIDGE_OFFLINE' }));
  }
  if (bridge.emrLoggedIn === false) {
    return Promise.reject(Object.assign(new Error(
      'EMR trên máy bệnh viện đã đăng xuất. Đăng nhập lại EMR trên máy đó, bấm lại nút "Data Hub" rồi chạy lại.'
    ), { code: 'BRIDGE_EMR_LOGGED_OUT' }));
  }
  const m = String(method || 'GET').toUpperCase();
  if (!['GET', 'POST'].includes(m)) return Promise.reject(new Error('Cầu nối chỉ hỗ trợ GET/POST.'));
  let path;
  let ref = '';
  try {
    path = toEmrPath(url, bridge.emrOrigin);
    if (referrer) ref = toEmrPath(referrer, bridge.emrOrigin);
  } catch (e) {
    return Promise.reject(e);
  }
  if (bridge.queue.length >= MAX_QUEUE) return Promise.reject(new Error('Hàng đợi cầu nối EMR đang đầy. Thử lại sau ít phút.'));
  const id = crypto.randomBytes(9).toString('base64url');
  const b = bridge;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      const i = b.queue.findIndex(q => q.id === id);
      if (i >= 0) b.queue.splice(i, 1);
      reject(Object.assign(new Error('Tab EMR không trả lời kịp (quá 90 giây). Kiểm tra máy bệnh viện còn mở tab EMR và tab Data Hub.'), { code: 'BRIDGE_TIMEOUT' }));
    }, timeoutMs);
    timer.unref?.();
    pending.set(id, { resolve, reject, timer, bridgeId: b.id });
    b.queue.push({
      id, method: m, path,
      body: body == null ? null : String(body),
      content_type: contentType ? String(contentType) : '',
      headers: cleanHeaders(headers),
      referrer: ref,
    });
    const w = b.waiters.shift();
    if (w) w();
  });
}

// Lý do không thể bắt đầu lấy dữ liệu EMR lúc này (chế độ cầu nối), '' nếu được.
function collectionBlocker() {
  if (!bridgeModeEnabled()) return '';
  const s = status();
  if (!s.connected) return 'Chưa nối tab EMR. Trên một máy trong bệnh viện: mở EMR, đăng nhập, bấm nút "Data Hub" trên thanh dấu trang (dòng trạng thái hiện "Máy BV: đang nối") rồi bấm lại.';
  if (s.emr_logged_in === false) return 'EMR trên máy bệnh viện đã đăng xuất. Đăng nhập lại EMR trên máy đó, bấm lại nút "Data Hub" rồi bấm lại.';
  return '';
}

function currentEmrUrl() {
  return isOnline() ? String(bridge.emrUrl || '') : '';
}

function internalToken() {
  return INTERNAL_TOKEN;
}

function checkInternalToken(value) {
  const a = Buffer.from(String(value || ''));
  const b = Buffer.from(INTERNAL_TOKEN);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Biến môi trường cho worker Python (chỉ khi bật chế độ cầu nối).
function workerEnv() {
  if (!bridgeModeEnabled()) return {};
  const { PORT, HOST } = require('../constants');
  const host = !HOST || ['0.0.0.0', '::', '[::]'].includes(HOST) ? '127.0.0.1' : HOST;
  return {
    EMR_BRIDGE_URL: `http://${host.includes(':') && !host.startsWith('[') ? `[${host}]` : host}:${PORT}/api/emr-bridge/internal/fetch`,
    EMR_BRIDGE_TOKEN: INTERNAL_TOKEN,
  };
}

// Chỉ dùng trong test.
function __resetEmrBridge() {
  if (bridge) for (const w of bridge.waiters) w([]);
  for (const p of pending.values()) clearTimeout(p.timer);
  pending.clear();
  bridge = null;
  lastPublished = '';
  if (sweepTimer) clearInterval(sweepTimer);
  sweepTimer = null;
  emitter.removeAllListeners('bridge');
}

module.exports = {
  bridgeModeEnabled, status, collectionBlocker, currentEmrUrl, hello, disconnect, poll, requeue, submitResult, request, toEmrPath,
  subscribeBridgeEvents, cleanHeaders, internalToken, checkInternalToken, workerEnv, __resetEmrBridge,
  POLL_WAIT_MS, OFFLINE_AFTER_MS,
};
