// server/services/trusted_devices.js — Thiết bị tin cậy.
//
// Mỗi trình duyệt tự tạo một cặp khóa ECDSA P-256 bằng WebCrypto; khóa riêng đánh dấu "không
// xuất được" nên nằm yên trong trình duyệt đó (chép hồ sơ trình duyệt sang máy khác cũng không
// mang theo). Máy chủ chỉ giữ khóa CÔNG KHAI. Mỗi yêu cầu /api từ thiết bị đã đăng ký được ký
// (thời điểm + method + đường dẫn); máy chủ kiểm chữ ký để biết yêu cầu đến từ thiết bị tin cậy.
//
// Thiết bị đầu tiên được duyệt bằng mã 8 số dùng một lần, lấy trên máy chủ
// (node scripts/users_cli.js ma-tin-cay) — biết mật khẩu thôi chưa đủ để tự biến máy lạ thành
// máy tin cậy. Thiết bị sau do quản trị duyệt TỪ một thiết bị đã tin cậy.

'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { ROOT_DIR } = require('../constants');

const SIGNATURE_WINDOW_MS = 2 * 60 * 1000;
const SETUP_CODE_TTL_MS = 10 * 60 * 1000;
const NAME_MAX = 80;

function storePath() {
  const configured = String(process.env.EMR_TRUSTED_DEVICES_FILE || '').trim();
  if (configured) return path.isAbsolute(configured) ? configured : path.join(ROOT_DIR, configured);
  return path.join(ROOT_DIR, 'secrets', 'trusted_devices.json');
}

// Mỗi yêu cầu có chữ ký đều đọc danh sách thiết bị: giữ bản đã đọc, chỉ đọc lại khi file đổi.
let cached = { file: '', mtimeMs: -1, size: -1, data: null };

function readStore() {
  const file = storePath();
  try {
    const st = fs.statSync(file);
    if (cached.data && cached.file === file && cached.mtimeMs === st.mtimeMs && cached.size === st.size) {
      return JSON.parse(JSON.stringify(cached.data));
    }
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    const data = {
      devices: Array.isArray(raw.devices) ? raw.devices : [],
      setup_codes: Array.isArray(raw.setup_codes) ? raw.setup_codes : [],
    };
    cached = { file, mtimeMs: st.mtimeMs, size: st.size, data };
    return JSON.parse(JSON.stringify(data));
  } catch (_) {
    return { devices: [], setup_codes: [] };
  }
}

function writeStore(store) {
  const file = storePath();
  cached = { file: '', mtimeMs: -1, size: -1, data: null };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2), { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmp, file);
}

function validJwk(jwk) {
  return jwk && typeof jwk === 'object' && jwk.kty === 'EC' && jwk.crv === 'P-256'
    && typeof jwk.x === 'string' && typeof jwk.y === 'string' && !('d' in jwk);
}

function publicDevice(d, lastSeen = null) {
  return {
    id: d.id, user_id: d.user_id, name: d.name, status: d.status,
    created_at: d.created_at, approved_at: d.approved_at || '', approved_by: d.approved_by || '',
    revoked_at: d.revoked_at || '', last_seen_at: lastSeen || d.last_seen_at || '',
  };
}

// Lần thấy gần nhất giữ trong bộ nhớ (ghi file mỗi yêu cầu thì quá nhiều).
const lastSeen = new Map();

function listDevices({ userId = null } = {}) {
  return readStore().devices
    .filter(d => !userId || d.user_id === userId)
    .map(d => publicDevice(d, lastSeen.get(d.id)));
}

function getDevice(id) {
  const d = readStore().devices.find(x => x.id === id);
  return d ? publicDevice(d, lastSeen.get(d.id)) : null;
}

function registerDevice({ userId, name, publicKeyJwk, now = Date.now() }) {
  if (!validJwk(publicKeyJwk)) throw new Error('Khóa thiết bị không hợp lệ. Tải lại trang rồi đăng ký lại.');
  const cleanName = String(name || '').trim().slice(0, NAME_MAX) || 'Thiết bị';
  const jwk = { kty: 'EC', crv: 'P-256', x: publicKeyJwk.x, y: publicKeyJwk.y };
  const store = readStore();
  const same = store.devices.find(d => d.public_key.x === jwk.x && d.public_key.y === jwk.y && d.user_id === userId && d.status !== 'revoked');
  if (same) return publicDevice(same);
  const device = {
    id: crypto.randomBytes(12).toString('base64url'),
    user_id: String(userId || ''),
    name: cleanName,
    public_key: jwk,
    status: 'pending',
    created_at: new Date(now).toISOString(),
  };
  store.devices.push(device);
  writeStore(store);
  return publicDevice(device);
}

function setStatus(id, status, patch) {
  const store = readStore();
  const d = store.devices.find(x => x.id === id);
  if (!d) throw new Error('Không tìm thấy thiết bị.');
  if (d.status === 'revoked' && status === 'trusted') throw new Error('Thiết bị đã bị thu hồi. Đăng ký lại trên thiết bị đó.');
  Object.assign(d, { status }, patch);
  writeStore(store);
  return publicDevice(d);
}

function approveDevice(id, { by, now = Date.now() } = {}) {
  return setStatus(id, 'trusted', { approved_at: new Date(now).toISOString(), approved_by: String(by || '') });
}

function revokeDevice(id, { by, now = Date.now() } = {}) {
  lastSeen.delete(id);
  return setStatus(id, 'revoked', { revoked_at: new Date(now).toISOString(), revoked_by: String(by || '') });
}

const hashCode = code => crypto.createHash('sha256').update(String(code)).digest('hex');

function createSetupCode({ now = Date.now() } = {}) {
  const code = String(crypto.randomInt(0, 100000000)).padStart(8, '0');
  const store = readStore();
  store.setup_codes = store.setup_codes.filter(c => c.expires_at > now);
  store.setup_codes.push({ hash: hashCode(code), expires_at: now + SETUP_CODE_TTL_MS });
  writeStore(store);
  return code;
}

// Mã đúng, còn hạn, chưa dùng → duyệt thiết bị của chính người đang đăng nhập.
function approveWithSetupCode(id, { code, userId, now = Date.now() } = {}) {
  const store = readStore();
  const hash = hashCode(String(code || '').trim());
  const idx = store.setup_codes.findIndex(c => c.expires_at > now
    && crypto.timingSafeEqual(Buffer.from(c.hash, 'hex'), Buffer.from(hash, 'hex')));
  if (idx === -1) throw new Error('Mã xác nhận không đúng hoặc đã hết hạn (mã dùng một lần, trong 10 phút). Lấy mã mới trên máy chủ.');
  const d = store.devices.find(x => x.id === id);
  if (!d || d.user_id !== userId) throw new Error('Chỉ xác nhận được thiết bị của chính bạn.');
  store.setup_codes.splice(idx, 1);
  writeStore(store);
  return approveDevice(id, { by: `${userId} (mã xác nhận)`, now });
}

// Nội dung được ký: thời điểm + method + đường dẫn (kèm query). Trình duyệt ký đúng chuỗi này.
function signingMessage({ ts, method, url }) {
  return `${ts}\n${String(method || 'GET').toUpperCase()}\n${url}`;
}

// Trả thiết bị nếu: đã duyệt, thuộc đúng người đăng nhập, chữ ký đúng, thời điểm trong ±2 phút.
function verifyRequest({ deviceId, ts, sig, method, url, userId, now = Date.now() }) {
  if (!deviceId || !ts || !sig) return null;
  const t = Number(ts);
  if (!Number.isFinite(t) || Math.abs(now - t) > SIGNATURE_WINDOW_MS) return null;
  const d = readStore().devices.find(x => x.id === deviceId);
  if (!d || d.status !== 'trusted' || d.user_id !== userId) return null;
  try {
    const key = crypto.createPublicKey({ key: d.public_key, format: 'jwk' });
    const ok = crypto.verify('sha256', Buffer.from(signingMessage({ ts, method, url })), { key, dsaEncoding: 'ieee-p1363' }, Buffer.from(String(sig), 'base64'));
    if (!ok) return null;
  } catch (_) {
    return null;
  }
  lastSeen.set(d.id, new Date(now).toISOString());
  return publicDevice(d, lastSeen.get(d.id));
}

function hasTrustedDevice(userId) {
  return readStore().devices.some(d => d.status === 'trusted' && (!userId || d.user_id === userId));
}

module.exports = {
  listDevices, getDevice, registerDevice, approveDevice, revokeDevice,
  createSetupCode, approveWithSetupCode, signingMessage, verifyRequest, hasTrustedDevice,
  SIGNATURE_WINDOW_MS,
};
