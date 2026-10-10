// server/services/authz.js — Xác thực token, vai trò và phạm vi session.

'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { APP_TOKEN, APP_TOKEN_MIN_LENGTH, HOST, ROOT_DIR } = require('../constants');
const { sanitizeSessionId } = require('../utils/validation');
const { resolveSecretFile } = require('./secret_store');

const ROLE_LEVEL = Object.freeze({
  viewer: 10,
  researcher: 20,
  operator: 30,
  supervisor: 40,
  admin: 50,
});

function isTruthy(value) {
  return ['1', 'true', 'yes', 'on'].includes(String(value || '').trim().toLowerCase());
}

function timingSafeEqualString(a, b) {
  const left = Buffer.from(String(a || ''), 'utf8');
  const right = Buffer.from(String(b || ''), 'utf8');
  if (!left.length || left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

function normalizeRole(value) {
  const role = String(value || 'viewer').trim().toLowerCase();
  if (!Object.prototype.hasOwnProperty.call(ROLE_LEVEL, role)) {
    throw new Error(`Vai trò EMR không hợp lệ: ${role}`);
  }
  return role;
}

function normalizeSessions(value) {
  if (value == null || value === '*' || (Array.isArray(value) && value.includes('*'))) return null;
  const arr = Array.isArray(value) ? value : [value];
  return [...new Set(arr.map(sanitizeSessionId).filter(Boolean))];
}

function isLocalHostBinding() {
  return HOST === '127.0.0.1' || HOST === 'localhost' || HOST === '::1';
}

// Nơi thật sự đọc/ghi danh sách tài khoản. Ưu tiên EMR_USERS_JSON (inline, chỉ
// đọc — không có file để ghi) > EMR_USERS_FILE (đường dẫn tuỳ chỉnh) >
// secrets/users.json (mặc định; máy chưa chuyển thì vẫn đọc config/users.json cũ
// — xem secret_store.resolveSecretFile), không cần khai biến môi trường mới dùng được.
function resolveUsersFileInfo() {
  const inline = String(process.env.EMR_USERS_JSON || '').trim();
  if (inline) return { mode: 'inline', path: null, writable: false };
  const configuredFile = String(process.env.EMR_USERS_FILE || '').trim();
  if (configuredFile) {
    const file = path.isAbsolute(configuredFile) ? configuredFile : path.join(ROOT_DIR, configuredFile);
    return { mode: 'file', path: file, writable: true };
  }
  return { mode: 'default', path: resolveSecretFile('users.json').path, writable: true };
}

function loadUsersPayload() {
  const info = resolveUsersFileInfo();
  if (info.mode === 'inline') return JSON.parse(process.env.EMR_USERS_JSON);
  if (!fs.existsSync(info.path)) return [];
  return JSON.parse(fs.readFileSync(info.path, 'utf8'));
}

function normalizeUser(raw, index) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`EMR user #${index + 1} phải là object.`);
  }
  const id = String(raw.id || raw.username || raw.name || `user_${index + 1}`).trim();
  const token = String(raw.token || '').trim();
  if (!id) throw new Error(`EMR user #${index + 1} thiếu id.`);
  if (token.length < APP_TOKEN_MIN_LENGTH) {
    throw new Error(`Token của EMR user '${id}' phải dài tối thiểu ${APP_TOKEN_MIN_LENGTH} ký tự.`);
  }
  return Object.freeze({
    id,
    name: String(raw.name || id).trim(),
    role: normalizeRole(raw.role || 'operator'),
    token,
    sessions: normalizeSessions(raw.sessions ?? raw.session_ids ?? null),
    enabled: raw.enabled !== false,
    // emr_username/emr_password cũ (tài khoản EMR dự phòng theo người dùng) đã bỏ: tài khoản EMR
    // nhập liệu chỉ còn theo tên điều dưỡng (Thiết lập tài khoản → Tài khoản EMR). Không đọc nữa;
    // lần ghi users.json kế tiếp tự xoá khỏi file.
    // Mật khẩu đăng nhập Data Hub (tùy chọn): chỉ lưu bản băm scrypt, không bao giờ lưu bản rõ.
    passwordHash: String(raw.password_hash || ''),
  });
}

// Chuẩn hoá + kiểm tra toàn bộ danh sách (kể cả tài khoản enabled:false) — dùng
// chung cho việc load lúc khởi động VÀ để admin UI kiểm tra trước khi ghi file
// (không bao giờ để ghi ra file users.json không hợp lệ).
function normalizeUsersList(payload) {
  const rows = Array.isArray(payload) ? payload : Object.entries(payload || {}).map(([id, value]) => ({ id, ...(value || {}) }));
  const users = rows.map(normalizeUser);
  const seenIds = new Set();
  const seenTokenHashes = new Set();
  for (const user of users) {
    if (seenIds.has(user.id)) throw new Error(`Trùng EMR user id: ${user.id}`);
    seenIds.add(user.id);
    const hash = crypto.createHash('sha256').update(user.token).digest('hex');
    if (seenTokenHashes.has(hash)) throw new Error('Hai EMR user không được dùng chung token.');
    seenTokenHashes.add(hash);
  }
  return users;
}

// Khai EMR_USERS_JSON / EMR_USERS_FILE = luôn bắt đăng nhập, kể cả khi danh sách đang trống.
function loginExplicitlyRequired() {
  const mode = resolveUsersFileInfo().mode;
  return mode === 'inline' || mode === 'file';
}

function loadUsers() {
  const info = resolveUsersFileInfo();
  const isExplicit = info.mode === 'inline' || info.mode === 'file';
  // secrets/users.json tự nhận (không khai EMR_USERS_JSON/EMR_USERS_FILE) chỉ
  // thật sự bắt đăng nhập khi server mở ra ngoài máy này (HOST=0.0.0.0/IP —
  // máy dùng chung nhiều người). Khi HOST vẫn là localhost mặc định (chỉ máy
  // này dùng), bỏ qua để giữ trải nghiệm không cần đăng nhập như cũ — file
  // vẫn xem/sửa được bình thường qua tab "Thiết lập tài khoản"
  // (listAllUsersRaw() đọc thẳng loadUsersPayload(), không qua bước này).
  // Khai rõ EMR_USERS_JSON/EMR_USERS_FILE thì luôn bắt đăng nhập, bất kể HOST.
  if (!isExplicit && isLocalHostBinding()) return Object.freeze([]);
  return Object.freeze(normalizeUsersList(loadUsersPayload()).filter(user => user.enabled));
}

let USERS;
let USERS_ERROR = null;
function reloadUsers() {
  try {
    USERS = loadUsers();
    USERS_ERROR = null;
  } catch (err) {
    USERS = Object.freeze([]);
    USERS_ERROR = err;
  }
  return USERS_ERROR;
}
reloadUsers();

function assertAuthConfiguration() {
  if (USERS_ERROR) throw USERS_ERROR;
  if (!isLocalHostBinding() && !APP_TOKEN && USERS.length === 0) {
    throw new Error('HOST mở ra ngoài localhost nhưng chưa có EMR_APP_TOKEN hoặc EMR_USERS_JSON/EMR_USERS_FILE.');
  }
}

function readTokenFromRequest(req) {
  const headerToken = req.get('x-app-token');
  if (headerToken) return String(headerToken).trim();
  const auth = req.get('authorization') || '';
  const match = auth.match(/^Bearer\s+(.+)$/i);
  return match ? String(match[1]).trim() : '';
}

function publicPrincipal(user) {
  if (!user) return null;
  return {
    id: user.id,
    name: user.name,
    role: user.role,
    sessions: user.sessions,
    auth_type: user.auth_type || 'user_token',
  };
}

function resolvePrincipal(token) {
  for (const user of USERS) {
    if (timingSafeEqualString(token, user.token)) return publicPrincipal(user);
  }
  if (APP_TOKEN && timingSafeEqualString(token, APP_TOKEN)) {
    return { id: 'legacy_admin', name: 'Legacy administrator', role: 'admin', sessions: null, auth_type: 'legacy_app_token' };
  }
  return null;
}

// ── Quản lý tài khoản (dùng bởi /api/admin/users) ───────────────────────────

function getUsersFileInfo() {
  return resolveUsersFileInfo();
}

// Đọc thẳng từ file trên đĩa (không dùng USERS cache đang lọc enabled:true)
// để trang "Thiết lập tài khoản" thấy đúng nội dung file hiện tại, kể cả tài
// khoản đang tắt. Không throw khi file lỗi — trả kèm error để UI hiển thị.
function listAllUsersRaw() {
  try {
    const users = normalizeUsersList(loadUsersPayload());
    return { users, error: null };
  } catch (err) {
    return { users: [], error: String(err.message || err) };
  }
}

function generateToken() {
  return crypto.randomBytes(24).toString('base64url');
}

function writeUsersFile(users) {
  const info = resolveUsersFileInfo();
  if (info.mode === 'inline') {
    throw new Error('Danh sách tài khoản đang được cấu hình qua biến môi trường EMR_USERS_JSON — không thể sửa từ giao diện. Hãy sửa biến môi trường đó rồi khởi động lại server.');
  }
  // Validate toàn bộ danh sách trước khi ghi — không bao giờ để file trên đĩa
  // rơi vào trạng thái không hợp lệ (trùng id/token, token quá ngắn...).
  const payload = users.map(u => ({
    id: u.id,
    name: u.name,
    role: u.role,
    token: u.token,
    sessions: u.sessions == null ? '*' : u.sessions,
    enabled: u.enabled !== false,
    ...(u.passwordHash ? { password_hash: u.passwordHash } : {}),
  }));
  normalizeUsersList(payload);
  fs.mkdirSync(path.dirname(info.path), { recursive: true });
  fs.writeFileSync(info.path, JSON.stringify(payload, null, 2), { encoding: 'utf8', mode: 0o600 });
  reloadUsers();
}

function createUser({ name, role, sessions, enabled, password, id: wantedId }) {
  const { users } = listAllUsersRaw();
  const baseId = String(name || 'nhan_vien')
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/đ/g, 'd')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '') || 'nhan_vien';
  let id = wantedId ? String(wantedId).trim().toLowerCase() : baseId;
  if (wantedId && !/^[a-z0-9_.-]{2,40}$/.test(id)) throw new Error('Tên đăng nhập chỉ gồm chữ không dấu, số, dấu chấm, gạch dưới (2–40 ký tự).');
  if (wantedId && users.some(u => u.id === id)) throw new Error(`Tên đăng nhập đã có: ${id}`);
  let n = 1;
  while (users.some(u => u.id === id)) { n += 1; id = `${baseId}_${n}`; }
  const created = {
    id, name: String(name || id).trim() || id, role: role || 'operator', token: generateToken(),
    sessions: sessions ?? '*', enabled: enabled !== false,
    passwordHash: password ? hashPassword(password) : '',
  };
  writeUsersFile([...users, created]);
  return created;
}

function updateUser(id, patch = {}) {
  const { users } = listAllUsersRaw();
  const idx = users.findIndex(u => u.id === id);
  if (idx === -1) throw new Error(`Không tìm thấy tài khoản: ${id}`);
  const current = users[idx];
  const next = {
    ...current,
    name: patch.name !== undefined ? String(patch.name || '').trim() || current.name : current.name,
    role: patch.role !== undefined ? patch.role : current.role,
    sessions: patch.sessions !== undefined ? patch.sessions : current.sessions,
    enabled: patch.enabled !== undefined ? Boolean(patch.enabled) : current.enabled,
    token: patch.regenerateToken ? generateToken() : current.token,
    passwordHash: patch.password ? hashPassword(patch.password)
      : (patch.clearPassword ? '' : current.passwordHash),
  };
  const updated = [...users];
  updated[idx] = next;
  writeUsersFile(updated);
  return next;
}

function deleteUser(id) {
  const { users } = listAllUsersRaw();
  if (!users.some(u => u.id === id)) throw new Error(`Không tìm thấy tài khoản: ${id}`);
  writeUsersFile(users.filter(u => u.id !== id));
}

// ── Đăng nhập bằng tên + mật khẩu ──────────────────────────────────────────
// Dùng khi chạy trên máy chủ (VPS) và mọi máy trong bệnh viện mở cùng một link: nhớ tên +
// mật khẩu dễ hơn mã truy cập dài. Đăng nhập đúng thì trả về mã truy cập sẵn có của người
// đó (trình duyệt dùng như trước), nên mọi phân quyền/phiên giữ nguyên.

const PASSWORD_MIN_LENGTH = 8;
const LOGIN_MAX_FAILS = 5;
const LOGIN_LOCK_MS = 15 * 60 * 1000;
const loginFails = new Map(); // `${ip}|${username}` → { count, first, lockedUntil }
const GENERIC_LOGIN_ERROR = 'Tên đăng nhập hoặc mật khẩu không đúng.';

function hashPassword(password) {
  const pw = String(password || '');
  if (pw.length < PASSWORD_MIN_LENGTH) throw new Error(`Mật khẩu phải có ít nhất ${PASSWORD_MIN_LENGTH} ký tự.`);
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(pw, salt, 32, { N: 16384, r: 8, p: 1 });
  return `scrypt$16384$8$1$${salt.toString('base64')}$${hash.toString('base64')}`;
}

function verifyPassword(password, stored) {
  const parts = String(stored || '').split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, N, r, p, saltB64, hashB64] = parts;
  try {
    const expected = Buffer.from(hashB64, 'base64');
    const actual = crypto.scryptSync(String(password || ''), Buffer.from(saltB64, 'base64'), expected.length, { N: Number(N), r: Number(r), p: Number(p) });
    return expected.length > 0 && crypto.timingSafeEqual(actual, expected);
  } catch (_) {
    return false;
  }
}

// Mật khẩu giả để tài khoản không tồn tại vẫn tốn cùng thời gian băm (không đoán được tên nào có).
const DUMMY_HASH = `scrypt$16384$8$1$${Buffer.alloc(16).toString('base64')}$${Buffer.alloc(32).toString('base64')}`;

function loginWithPassword({ username, password, ip = '', now = Date.now() } = {}) {
  const name = String(username || '').trim().toLowerCase();
  const key = `${ip}|${name}`;
  const state = loginFails.get(key);
  if (state?.lockedUntil && state.lockedUntil > now) {
    const minutes = Math.ceil((state.lockedUntil - now) / 60000);
    return { ok: false, locked: true, message: `Đăng nhập sai quá ${LOGIN_MAX_FAILS} lần. Hãy thử lại sau ${minutes} phút, hoặc nhờ quản trị đặt lại mật khẩu.` };
  }
  const user = USERS.find(u => u.id.toLowerCase() === name && u.enabled !== false);
  const ok = verifyPassword(password, user?.passwordHash || DUMMY_HASH) && Boolean(user?.passwordHash);
  if (!ok) {
    const fresh = !state || now - state.first > LOGIN_LOCK_MS ? { count: 0, first: now, lockedUntil: 0 } : state;
    fresh.count += 1;
    if (fresh.count >= LOGIN_MAX_FAILS) fresh.lockedUntil = now + LOGIN_LOCK_MS;
    loginFails.set(key, fresh);
    if (loginFails.size > 5000) loginFails.delete(loginFails.keys().next().value);
    return { ok: false, message: GENERIC_LOGIN_ERROR };
  }
  loginFails.delete(key);
  return { ok: true, token: user.token, user: publicPrincipal(user) };
}

function localPrincipal() {
  return { id: 'local_system', name: 'Local system user', role: 'admin', sessions: null, auth_type: 'local_only' };
}

function hasRole(principal, minimumRole) {
  if (!principal) return false;
  return Number(ROLE_LEVEL[principal.role] || 0) >= Number(ROLE_LEVEL[minimumRole] || Number.MAX_SAFE_INTEGER);
}

function sessionFromRequest(req) {
  return sanitizeSessionId(req.get('x-session-id') || req.query?.sid || 'default');
}

function canAccessSession(principal, sid) {
  if (!principal) return false;
  if (principal.sessions == null || hasRole(principal, 'admin')) return true;
  return principal.sessions.includes(sanitizeSessionId(sid));
}

function isReportOttRequest(req) {
  return req.method === 'GET'
    && req.path === '/run-report-infusion'
    && req.query
    && typeof req.query.ott === 'string'
    && req.query.ott.trim();
}

// Gắn sau authenticateRequest: yêu cầu có chữ ký hợp lệ của thiết bị đã duyệt thì
// req.deviceTrusted = true. Chạy một máy không đăng nhập (localhost) thì coi là tin cậy.
function attachDeviceTrust(req, _res, next) {
  const trusted = require('./trusted_devices');
  req.device = null;
  req.deviceTrusted = req.auth?.auth_type === 'local_only';
  if (req.auth && !req.deviceTrusted) {
    const device = trusted.verifyRequest({
      deviceId: req.get('x-device-id'),
      ts: req.get('x-device-ts'),
      sig: req.get('x-device-sig'),
      method: req.method,
      url: req.originalUrl,
      userId: req.auth.id,
    });
    if (device) { req.device = device; req.deviceTrusted = true; }
  }
  return next();
}

// EMR_REQUIRE_TRUSTED_DEVICE=1 (bật trên VPS): máy chưa tin cậy, dù đăng nhập đúng, KHÔNG nhận
// dữ liệu nào — chỉ được xem trạng thái đăng nhập/thiết bị và đăng ký thiết bị. Chạy một máy
// không đăng nhập (localhost) và link báo cáo dùng một lần không bị ảnh hưởng.
// /emr-bridge: máy bệnh viện chỉ chuyển trang EMR LÊN máy chủ (không đọc được dữ liệu trong kho),
// nên không bắt từng máy bệnh viện phải đăng ký thiết bị tin cậy; vẫn phải đăng nhập.
const TRUSTED_DEVICE_OPEN_PATHS = ['/auth/me', '/health', '/devices', '/emr-bridge'];

function trustedDeviceRequired() {
  return isTruthy(process.env.EMR_REQUIRE_TRUSTED_DEVICE);
}

function requireTrustedDevice(req, res, next) {
  if (!trustedDeviceRequired() || req.method === 'OPTIONS') return next();
  if (req.deviceTrusted) return next();
  const type = req.auth?.auth_type;
  if (type === 'local_only' || type === 'one_time_token') return next();
  const p = String(req.path || '');
  if (TRUSTED_DEVICE_OPEN_PATHS.some(open => p === open || p.startsWith(`${open}/`))) return next();
  res.set('x-device-required', '1');
  return res.status(403).json({
    status: 'error',
    code: 'DEVICE_NOT_TRUSTED',
    message: 'Thiết bị này chưa được tin cậy nên không xem được dữ liệu. Vào "Đăng ký thiết bị này", rồi nhập mã xác nhận hoặc nhờ quản trị duyệt.',
  });
}

function authenticateRequest(req, res, next) {
  if (req.method === 'OPTIONS') return next();
  if (isReportOttRequest(req)) {
    req.auth = { id: 'report_ott', name: 'One-time report link', role: 'viewer', sessions: null, auth_type: 'one_time_token' };
    return next();
  }

  if (!APP_TOKEN && USERS.length === 0) {
    // Đã khai rõ file tài khoản (vd. trên VPS) nhưng chưa có ai: KHÔNG cho vào. Trước đây chỗ này
    // coi như "chỉ một máy dùng" và cho mọi người quyền quản trị — sau HTTPS là ai cũng vào được.
    if (loginExplicitlyRequired()) {
      return res.status(401).json({
        status: 'error',
        code: 'NO_USERS_CONFIGURED',
        message: 'Chưa có tài khoản nào. Trên máy chủ chạy: node scripts/users_cli.js tao-admin <tên> "<Họ tên>" rồi khởi động lại.',
      });
    }
    req.auth = localPrincipal();
    return next();
  }

  const principal = resolvePrincipal(readTokenFromRequest(req));
  if (!principal) {
    return res.status(401).json({
      status: 'error',
      code: 'AUTH_REQUIRED',
      message: 'Cần mã truy cập nội bộ hợp lệ.',
    });
  }
  req.auth = principal;
  return next();
}

function requiredRoleForRequest(req) {
  const method = String(req.method || 'GET').toUpperCase();
  const routePath = String(req.path || '');
  if (method === 'OPTIONS') return 'viewer';
  if (routePath === '/auth/me' || routePath === '/health') return 'viewer';
  // Thiết bị tin cậy: ai cũng đăng ký được máy của mình; quyền duyệt/thu hồi kiểm trong route.
  if (routePath.startsWith('/devices')) return 'viewer';
  // Quản lý tài khoản (token, tài khoản EMR riêng) — chỉ admin, mọi method.
  if (routePath.startsWith('/admin/users')) return 'admin';
  // Tài khoản EMR theo điều dưỡng (ca làm/ca trực) — chứa mật khẩu thật, chỉ admin.
  if (routePath.startsWith('/nurse-emr-accounts')) return 'admin';
  // Tài khoản EMR thêm để lấy dữ liệu song song — chứa mật khẩu thật, chỉ admin.
  if (routePath.startsWith('/fetch-accounts')) return 'admin';
  // Bảng gom mọi tài khoản EMR (tên đăng nhập, nơi khai) — chỉ admin.
  if (routePath.startsWith('/emr-accounts')) return 'admin';
  // Kho chung đổi dữ liệu mặc định của mọi máy: đặt/bỏ cần giám sát; xem thì ai cũng được.
  if (routePath === '/workspace/shared' && method !== 'GET' && method !== 'HEAD') return 'supervisor';
  if (routePath.startsWith('/audit') || routePath.startsWith('/tasks') || routePath === '/diagnostics' || routePath === '/session-logs') return 'supervisor';
  if (routePath.startsWith('/research')) {
    // Xóa nghiên cứu là thao tác phá hủy dữ liệu: chỉ admin.
    if (method === 'DELETE') return 'admin';
    // Nhập phiếu theo dõi từng mẫu (CRF) là việc của người thu thập số liệu: researcher được ghi.
    // Thiết kế phiếu và mọi thao tác ghi khác vẫn cần supervisor.
    if (method === 'PUT' && /^\/research\/studies\/[^/]+\/crf\/entries\/[^/]+$/.test(routePath)) return 'researcher';
    // Xem thống kê / xuất dữ liệu theo biến từ kho chỉ đọc và luôn ẩn định danh (giống GET xuất CSV);
    // dùng POST vì gửi kèm danh sách biến dài.
    if (method === 'POST' && ['/research/archive/variable-preview', '/research/archive/variable-export'].includes(routePath)) return 'researcher';
    return ['GET', 'HEAD'].includes(method) ? 'researcher' : 'supervisor';
  }

  // Một số route lịch sử dùng GET nhưng thực chất khởi chạy worker/tạo báo cáo.
  // Phân quyền theo tác động, không chỉ dựa vào HTTP method.
  if (['/run-scan', '/run-emr-structure-scan', '/inspect-emr-page', '/run-postprocess', '/run-report-infusion'].includes(routePath)) return 'operator';
  if (['/export-data', '/hchanh/export/issues'].includes(routePath)) return 'supervisor';
  if (routePath === '/get-raw') return 'operator';
  if (routePath.startsWith('/features/') && routePath.endsWith('/state')) return 'admin';
  if (routePath.startsWith('/workflows/') && routePath.endsWith('/state')) return 'admin';
  if (routePath.startsWith('/workflows') || routePath === '/artifacts') return ['GET', 'HEAD'].includes(method) ? 'viewer' : 'operator';

  // Xoá bộ phiếu ra viện đã in/đã ký (dọn thư mục in) — xoá dữ liệu: giám sát.
  if (method === 'DELETE' && routePath.startsWith('/hchanh/discharge-bundle/')) return 'supervisor';
  if (method === 'POST' && routePath === '/hchanh/discharge-bundles/cleanup') return 'supervisor';
  if (method === 'DELETE') return 'admin';
  if (['POST', 'PUT', 'PATCH'].includes(method)) {
    if (/^\/(?:import-data|runtime-migrate|nurse-settings|hchanh\/clear)/.test(routePath)) return 'supervisor';
    return 'operator';
  }
  return 'viewer';
}

function authorizeRequest(req, res, next) {
  if (isReportOttRequest(req)) return next();
  const minimumRole = requiredRoleForRequest(req);
  if (!hasRole(req.auth, minimumRole)) {
    return res.status(403).json({
      status: 'error',
      code: 'ROLE_FORBIDDEN',
      message: `Tác vụ yêu cầu vai trò ${minimumRole}.`,
    });
  }

  const routePath = String(req.path || '');
  if (routePath === '/auth/me' || routePath === '/health' || routePath === '/data-sessions') return next();

  const sid = sessionFromRequest(req);
  if (!canAccessSession(req.auth, sid)) {
    return res.status(403).json({
      status: 'error',
      code: 'SESSION_FORBIDDEN',
      message: 'Tài khoản không có quyền truy cập session này.',
    });
  }
  return next();
}

function requireRole(minimumRole) {
  normalizeRole(minimumRole);
  return (req, res, next) => {
    if (hasRole(req.auth, minimumRole)) return next();
    return res.status(403).json({ status: 'error', code: 'ROLE_FORBIDDEN', message: `Tác vụ yêu cầu vai trò ${minimumRole}.` });
  };
}

function authStatus() {
  const info = resolveUsersFileInfo();
  const isExplicit = info.mode === 'inline' || info.mode === 'file';
  const { users: fileUsers } = listAllUsersRaw();
  const bypassedLocalOnly = !isExplicit && isLocalHostBinding() && fileUsers.length > 0;
  return {
    mode: USERS.length ? 'multi_user_tokens' : (APP_TOKEN ? 'legacy_app_token' : 'local_only'),
    configured_users: USERS.map(user => ({ id: user.id, name: user.name, role: user.role, restricted_sessions: user.sessions })),
    identified_research_export_enabled: isTruthy(process.env.EMR_ALLOW_IDENTIFIED_RESEARCH_EXPORT),
    // true khi secrets/users.json (tự nhận) đã có tài khoản nhưng server chỉ
    // mở nội bộ (HOST=127.0.0.1) nên đang bỏ qua đăng nhập — dùng để tab
    // "Thiết lập tài khoản" giải thích đúng lý do, tránh gây hiểu nhầm là lỗi.
    local_only_bypassed_users_count: bypassedLocalOnly ? fileUsers.length : 0,
  };
}

module.exports = {
  ROLE_LEVEL,
  assertAuthConfiguration,
  authenticateRequest,
  attachDeviceTrust,
  requireTrustedDevice,
  trustedDeviceRequired,
  authorizeRequest,
  requireRole,
  hasRole,
  canAccessSession,
  sessionFromRequest,
  authStatus,
  isTruthy,
  requiredRoleForRequest,
  getUsersFileInfo,
  listAllUsersRaw,
  createUser,
  updateUser,
  deleteUser,
  reloadUsers,
  loginWithPassword,
  hashPassword,
  verifyPassword,
  PASSWORD_MIN_LENGTH,
};
