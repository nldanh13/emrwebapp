// Thiết bị tin cậy — phía trình duyệt.
//
// Trình duyệt tạo một cặp khóa ECDSA P-256 bằng WebCrypto; khóa riêng "không xuất được"
// (extractable=false) nên chỉ nằm trong trình duyệt này, lưu ở IndexedDB. Sau khi đăng ký và được
// duyệt, MỌI yêu cầu /api tự kèm chữ ký (thời điểm + method + đường dẫn) — người dùng không phải
// làm gì thêm. Máy chủ kiểm chữ ký để biết yêu cầu đến từ thiết bị tin cậy
// (server/services/trusted_devices.js).

const DB_NAME = 'emr-device-trust';
const STORE = 'keys';
const RECORD = 'device';

function openDb() {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') { reject(new Error('Trình duyệt không hỗ trợ IndexedDB.')); return; }
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function readRecord() {
  try {
    const db = await openDb();
    return await new Promise((resolve, reject) => {
      const r = db.transaction(STORE, 'readonly').objectStore(STORE).get(RECORD);
      r.onsuccess = () => resolve(r.result || null);
      r.onerror = () => reject(r.error);
    });
  } catch (_) {
    return null;
  }
}

async function writeRecord(value) {
  const db = await openDb();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(value, RECORD);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

let cache = null; // { keyPair, deviceId }

async function loadDevice() {
  if (cache) return cache;
  cache = await readRecord();
  return cache;
}

// Tạo (một lần) cặp khóa của trình duyệt này; trả khóa công khai dạng JWK để gửi máy chủ.
export async function ensureDeviceKey() {
  const current = await loadDevice();
  if (current?.keyPair) return crypto.subtle.exportKey('jwk', current.keyPair.publicKey);
  if (!globalThis.crypto?.subtle) throw new Error('Trình duyệt không hỗ trợ khóa bảo mật (cần HTTPS).');
  const keyPair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
  cache = { keyPair, deviceId: '' };
  await writeRecord(cache);
  return crypto.subtle.exportKey('jwk', keyPair.publicKey);
}

export async function setDeviceId(deviceId) {
  const current = await loadDevice();
  if (!current?.keyPair) throw new Error('Chưa có khóa thiết bị.');
  cache = { ...current, deviceId: String(deviceId || '') };
  await writeRecord(cache);
}

export async function getDeviceId() {
  return (await loadDevice())?.deviceId || '';
}

function toBase64(buf) {
  let s = '';
  const bytes = new Uint8Array(buf);
  for (let i = 0; i < bytes.length; i += 1) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}

// Chuỗi ký phải giống hệt server/services/trusted_devices.js signingMessage().
export function signingMessage({ ts, method, url }) {
  return `${ts}\n${String(method || 'GET').toUpperCase()}\n${url}`;
}

export async function deviceSignatureHeaders(method, url) {
  const current = await loadDevice();
  if (!current?.keyPair || !current.deviceId) return {};
  const ts = String(Date.now());
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, current.keyPair.privateKey,
    new TextEncoder().encode(signingMessage({ ts, method, url })));
  return { 'x-device-id': current.deviceId, 'x-device-ts': ts, 'x-device-sig': toBase64(sig) };
}

function requestInfo(input, init) {
  const raw = typeof input === 'string' ? input : (input?.url || String(input));
  const u = new URL(raw, window.location.origin);
  const method = String(init?.method || (typeof input === 'object' && input?.method) || 'GET').toUpperCase();
  return { u, method };
}

let installed = false;
// Bọc window.fetch: yêu cầu /api cùng nguồn được tự ký nếu trình duyệt này đã đăng ký thiết bị.
export function installDeviceSigningFetch() {
  if (installed || typeof window === 'undefined' || typeof window.fetch !== 'function') return;
  installed = true;
  const nativeFetch = window.fetch.bind(window);
  window.fetch = async (input, init = {}) => {
    let info;
    try { info = requestInfo(input, init); } catch (_) { return nativeFetch(input, init); }
    if (info.u.origin !== window.location.origin || !info.u.pathname.startsWith('/api/')) return nativeFetch(input, init);
    let extra = {};
    try { extra = await deviceSignatureHeaders(info.method, info.u.pathname + info.u.search); } catch (_) { extra = {}; }
    if (!Object.keys(extra).length) return nativeFetch(input, init);
    const headers = new Headers(init.headers || (typeof input === 'object' ? input.headers : undefined) || {});
    for (const [k, v] of Object.entries(extra)) headers.set(k, v);
    return nativeFetch(input, { ...init, headers });
  };
}

// Chỉ dùng trong test (jsdom không có IndexedDB).
export function __resetDeviceTrust(record = null) {
  cache = record;
  installed = false;
}
