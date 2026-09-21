// server/services/authz.js — Xác thực token, vai trò và phạm vi session.

'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { APP_TOKEN, APP_TOKEN_MIN_LENGTH, HOST, ROOT_DIR } = require('../constants');
const { sanitizeSessionId } = require('../utils/validation');

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

const DEFAULT_USERS_FILE = path.join(ROOT_DIR, 'config', 'users.json');

// Nơi thật sự đọc/ghi danh sách tài khoản. Ưu tiên EMR_USERS_JSON (inline, chỉ
// đọc — không có file để ghi) > EMR_USERS_FILE (đường dẫn tuỳ chỉnh) >
// config/users.json (mặc định, giống config.json/medication_catalog.json —
// không cần khai biến môi trường mới dùng được).
function resolveUsersFileInfo() {
  const inline = String(process.env.EMR_USERS_JSON || '').trim();
  if (inline) return { mode: 'inline', path: null, writable: false };
  const configuredFile = String(process.env.EMR_USERS_FILE || '').trim();
  if (configuredFile) {
    const file = path.isAbsolute(configuredFile) ? configuredFile : path.join(ROOT_DIR, configuredFile);
    return { mode: 'file', path: file, writable: true };
  }
  return { mode: 'default', path: DEFAULT_USERS_FILE, writable: true };
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
    // Tài khoản EMR THẬT riêng của người này — chỉ dùng khi ghi/nhập dữ liệu
    // (chăm sóc, dịch truyền, thủ thuật, VTYT) để thao tác hiện đúng tên người
    // làm trên EMR của bệnh viện. Không đưa vào publicPrincipal() — không bao
    // giờ gửi xuống trình duyệt.
    emrUsername: String(raw.emr_username || '').trim(),
    emrPassword: String(raw.emr_password || ''),
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

function loadUsers() {
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
  const localOnly = HOST === '127.0.0.1' || HOST === 'localhost' || HOST === '::1';
  if (!localOnly && !APP_TOKEN && USERS.length === 0) {
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
    ...(u.emrUsername || u.emrPassword ? { emr_username: u.emrUsername || '', emr_password: u.emrPassword || '' } : {}),
  }));
  normalizeUsersList(payload);
  fs.mkdirSync(path.dirname(info.path), { recursive: true });
  fs.writeFileSync(info.path, JSON.stringify(payload, null, 2), { encoding: 'utf8', mode: 0o600 });
  reloadUsers();
}

function createUser({ name, role, sessions, enabled, emrUsername, emrPassword }) {
  const { users } = listAllUsersRaw();
  const baseId = String(name || 'nhan_vien')
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/đ/g, 'd')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '') || 'nhan_vien';
  let id = baseId;
  let n = 1;
  while (users.some(u => u.id === id)) { n += 1; id = `${baseId}_${n}`; }
  const created = {
    id, name: String(name || id).trim() || id, role: role || 'operator', token: generateToken(),
    sessions: sessions ?? '*', enabled: enabled !== false,
    emrUsername: String(emrUsername || '').trim(), emrPassword: String(emrPassword || ''),
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
    emrUsername: patch.emrUsername !== undefined ? String(patch.emrUsername || '').trim() : current.emrUsername,
    emrPassword: patch.emrPassword !== undefined ? String(patch.emrPassword || '') : current.emrPassword,
    token: patch.regenerateToken ? generateToken() : current.token,
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

// Tài khoản EMR thật riêng của người đang đăng nhập Data Hub — dùng cho các
// thao tác GHI vào EMR (nhập chăm sóc/dịch truyền/thủ thuật/VTYT) để hiện
// đúng tên người làm trên EMR của bệnh viện. Trả về null nếu người này chưa
// được cấp tài khoản riêng — nơi gọi tự rơi về tài khoản chung trong config.json.
function getEmrCredentials(userId) {
  const id = String(userId || '').trim();
  if (!id) return null;
  const user = USERS.find(u => u.id === id);
  if (!user || !user.emrUsername || !user.emrPassword) return null;
  return { username: user.emrUsername, password: user.emrPassword };
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

function authenticateRequest(req, res, next) {
  if (req.method === 'OPTIONS') return next();
  if (isReportOttRequest(req)) {
    req.auth = { id: 'report_ott', name: 'One-time report link', role: 'viewer', sessions: null, auth_type: 'one_time_token' };
    return next();
  }

  if (!APP_TOKEN && USERS.length === 0) {
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
  // Quản lý tài khoản (token, tài khoản EMR riêng) — chỉ admin, mọi method.
  if (routePath.startsWith('/admin/users')) return 'admin';
  if (routePath.startsWith('/audit') || routePath.startsWith('/tasks') || routePath === '/diagnostics' || routePath === '/session-logs') return 'supervisor';
  if (routePath.startsWith('/research')) return ['GET', 'HEAD'].includes(method) ? 'researcher' : 'supervisor';

  // Một số route lịch sử dùng GET nhưng thực chất khởi chạy worker/tạo báo cáo.
  // Phân quyền theo tác động, không chỉ dựa vào HTTP method.
  if (['/run-scan', '/run-emr-structure-scan', '/inspect-emr-page', '/run-postprocess', '/run-report-infusion'].includes(routePath)) return 'operator';
  if (['/export-data', '/care-baseline/export', '/hchanh/export/issues'].includes(routePath)) return 'supervisor';
  if (routePath === '/get-raw') return 'operator';
  if (routePath.startsWith('/features/') && routePath.endsWith('/state')) return 'admin';
  if (routePath.startsWith('/workflows/') && routePath.endsWith('/state')) return 'admin';
  if (routePath.startsWith('/workflows') || routePath === '/artifacts') return ['GET', 'HEAD'].includes(method) ? 'viewer' : 'operator';

  if (method === 'DELETE') return 'admin';
  if (['POST', 'PUT', 'PATCH'].includes(method)) {
    if (/^\/(?:import-data|runtime-migrate|nurse-settings|admin-workflow\/clear|hchanh\/clear)/.test(routePath)) return 'supervisor';
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
  return {
    mode: USERS.length ? 'multi_user_tokens' : (APP_TOKEN ? 'legacy_app_token' : 'local_only'),
    configured_users: USERS.map(user => ({ id: user.id, name: user.name, role: user.role, restricted_sessions: user.sessions })),
    identified_research_export_enabled: isTruthy(process.env.EMR_ALLOW_IDENTIFIED_RESEARCH_EXPORT),
  };
}

module.exports = {
  ROLE_LEVEL,
  assertAuthConfiguration,
  authenticateRequest,
  authorizeRequest,
  requireRole,
  hasRole,
  canAccessSession,
  sessionFromRequest,
  authStatus,
  getEmrCredentials,
  isTruthy,
  requiredRoleForRequest,
  getUsersFileInfo,
  listAllUsersRaw,
  createUser,
  updateUser,
  deleteUser,
};
