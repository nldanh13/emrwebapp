// server/services/fetch_accounts.js — Tài khoản EMR thêm để "Lấy chi tiết" chạy song song.
//
// "Lấy chi tiết" đọc từng người bệnh lần lượt bằng một tài khoản, nên càng nhiều người bệnh càng
// lâu. Quản trị khai thêm tài khoản EMR chỉ dùng để ĐỌC dữ liệu (secrets/emr_read_accounts.json);
// máy chủ chia danh sách thành nhiều phần, mỗi phần chạy bằng một tài khoản khác nhau.
//
// Quy tắc an toàn:
// - Một tài khoản chỉ chạy một phần tại một thời điểm (khóa theo làn tài khoản trong task_queue).
// - Tài khoản trùng tài khoản chung, hoặc đang dùng để NHẬP liệu (tài khoản EMR riêng của người dùng
//   app, tài khoản theo tên điều dưỡng) thì không dùng: tác vụ nhập liệu không khóa theo làn đó nên
//   có thể đăng nhập cùng lúc và hai bên đá phiên nhau.
// - Mỗi tài khoản có file cookie riêng, không ghi đè cookie của nhau.
// - Mật khẩu không bao giờ trả về giao diện hay ghi log.

'use strict';

const crypto = require('crypto');
const path = require('path');

const { RUNTIME_ROOT } = require('../constants');
const { resolveSecretFile, getSecret } = require('./secret_store');
const { readJsonSafe, writeJsonAtomic } = require('../utils/file');

const MAX_PARALLEL_LIMIT = 4;
const DEFAULT_MAX_PARALLEL = 2;
const MAX_ACCOUNTS = 12;
// Ít người bệnh thì chia nhỏ không đáng: mỗi phần còn phải đăng nhập và đọc danh sách nội trú.
const MIN_PATIENTS_PER_PART = 4;

function fetchAccountsFilePath() {
  return resolveSecretFile('emr_read_accounts.json').path;
}

function norm(value) {
  return String(value || '').trim();
}

function userKey(username) {
  return norm(username).toLowerCase();
}

function clampParallel(value) {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n)) return DEFAULT_MAX_PARALLEL;
  return Math.max(1, Math.min(MAX_PARALLEL_LIMIT, n));
}

function stableId(username) {
  return crypto.createHash('sha256').update(`acc:${userKey(username)}`).digest('hex').slice(0, 12);
}

function normalizeAccount(row) {
  if (!row || typeof row !== 'object') return null;
  const username = norm(row.emr_username);
  if (!username) return null;
  return {
    // Dòng chưa có id (file sửa tay) lấy id cố định theo tên đăng nhập, để lần đọc sau vẫn khớp.
    id: /^[a-f0-9]{6,32}$/.test(String(row.id || '')) ? String(row.id) : stableId(username),
    name: norm(row.name).slice(0, 80) || username,
    emr_username: username.slice(0, 120),
    emr_password: String(row.emr_password || ''),
    enabled: row.enabled !== false,
  };
}

function readStore() {
  const raw = readJsonSafe(fetchAccountsFilePath(), null);
  const obj = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : { accounts: Array.isArray(raw) ? raw : [] };
  const seen = new Set();
  const accounts = [];
  for (const row of Array.isArray(obj.accounts) ? obj.accounts : []) {
    const acc = normalizeAccount(row);
    if (!acc || seen.has(userKey(acc.emr_username))) continue;
    seen.add(userKey(acc.emr_username));
    accounts.push(acc);
  }
  return { max_parallel: clampParallel(obj.max_parallel), accounts: accounts.slice(0, MAX_ACCOUNTS) };
}

/** Tài khoản đang dùng để NHẬP liệu — không được dùng để lấy dữ liệu song song. */
function inputAccountUsernames() {
  const out = new Set();
  try {
    const { listAllUsersRaw } = require('./authz');
    for (const u of listAllUsersRaw().users || []) {
      if (u?.emrUsername) out.add(userKey(u.emrUsername));
    }
  } catch (_) { /* users.json lỗi: bỏ qua, không chặn */ }
  try {
    const { readNurseEmrAccounts } = require('../utils/nurse_emr_accounts');
    for (const row of readNurseEmrAccounts()) {
      if (row?.emr_username) out.add(userKey(row.emr_username));
    }
  } catch (_) { /* không có file: bỏ qua */ }
  for (const key of ['hchanh_username', 'infusion_username']) {
    try { const v = getSecret(key); if (v) out.add(userKey(v)); } catch (_) { /* chưa khai báo */ }
  }
  return out;
}

function mainUsername() {
  try { return norm(getSecret('emr_username')); } catch (_) { return ''; }
}

/** Lý do không dùng được một tài khoản; '' nếu dùng được. */
function exclusionReason(acc, { main, inputUsers }) {
  if (!acc.enabled) return 'Đang tắt.';
  if (!acc.emr_password) return 'Chưa có mật khẩu.';
  if (main && userKey(acc.emr_username) === userKey(main)) return 'Trùng tài khoản chung, không cần khai thêm.';
  if (inputUsers.has(userKey(acc.emr_username))) {
    return 'Tài khoản này đang dùng để nhập liệu; dùng song song có thể bị đăng xuất lẫn nhau.';
  }
  return '';
}

function cookieFileFor(username) {
  const hash = crypto.createHash('sha256').update(userKey(username)).digest('hex').slice(0, 16);
  return path.join(RUNTIME_ROOT, 'auth', `emr_http_cookies_${hash}.json`);
}

/** Danh sách cho giao diện quản trị: không có mật khẩu. */
function publicFetchAccounts() {
  const store = readStore();
  const ctx = { main: mainUsername(), inputUsers: inputAccountUsernames() };
  return {
    max_parallel: store.max_parallel,
    max_parallel_limit: MAX_PARALLEL_LIMIT,
    main_configured: Boolean(ctx.main),
    accounts: store.accounts.map((acc) => {
      const note = exclusionReason(acc, ctx);
      return {
        id: acc.id,
        name: acc.name,
        emr_username: acc.emr_username,
        has_password: Boolean(acc.emr_password),
        enabled: acc.enabled,
        usable: !note,
        note,
      };
    }),
  };
}

/**
 * Ghi danh sách. Dòng có id cũ mà để trống mật khẩu thì giữ mật khẩu cũ (giao diện không bao giờ
 * nhận mật khẩu thật nên không gửi lại được).
 */
function saveFetchAccounts({ accounts, max_parallel } = {}) {
  if (!Array.isArray(accounts)) throw new Error('Thiếu danh sách tài khoản.');
  if (accounts.length > MAX_ACCOUNTS) throw new Error(`Tối đa ${MAX_ACCOUNTS} tài khoản.`);
  const current = readStore();
  const oldById = new Map(current.accounts.map(a => [a.id, a]));
  const seen = new Set();
  const next = [];
  for (const row of accounts) {
    const username = norm(row?.emr_username);
    if (!username) continue;
    if (seen.has(userKey(username))) throw new Error(`Tài khoản ${username} bị nhập hai lần.`);
    seen.add(userKey(username));
    const found = oldById.get(String(row?.id || ''));
    // Chỉ coi là "cùng dòng cũ" khi cùng tên đăng nhập: đổi tên đăng nhập là tài khoản khác, phải nhập mật khẩu mới.
    const old = found && userKey(found.emr_username) === userKey(username) ? found : null;
    const password = String(row?.emr_password || '') || (old ? old.emr_password : '');
    next.push(normalizeAccount({ ...row, id: old ? old.id : '', emr_password: password }));
  }
  writeJsonAtomic(fetchAccountsFilePath(), {
    max_parallel: clampParallel(max_parallel ?? current.max_parallel),
    accounts: next,
  });
  return publicFetchAccounts();
}

/**
 * Các tài khoản chạy được ngay, tài khoản chung luôn đứng đầu. Mỗi phần tử:
 * { key, label, env, main } — env là biến môi trường truyền cho worker (có mật khẩu: không log).
 */
function fetchAccountPool() {
  const store = readStore();
  const ctx = { main: mainUsername(), inputUsers: inputAccountUsernames() };
  const pool = [{ key: 'default', label: 'Tài khoản chung', env: {}, main: true }];
  for (const acc of store.accounts) {
    if (pool.length >= store.max_parallel) break;
    if (exclusionReason(acc, ctx)) continue;
    pool.push({
      key: `read:${userKey(acc.emr_username)}`,
      label: acc.name,
      main: false,
      env: {
        EMR_USERNAME: acc.emr_username,
        EMR_PASSWORD: acc.emr_password,
        EMR_HTTP_COOKIE_FILE: cookieFileFor(acc.emr_username),
      },
    });
  }
  return pool;
}

/**
 * Chia danh sách thành tối đa `slots` phần liền nhau, lệch nhau nhiều nhất 1 người bệnh.
 * Mỗi người bệnh nằm đúng một phần.
 */
function planParts(rows, slots, minPerPart = MIN_PATIENTS_PER_PART) {
  const list = Array.isArray(rows) ? rows : [];
  const n = Math.max(1, Math.min(Number(slots) || 1, Math.floor(list.length / Math.max(1, minPerPart)) || 1));
  const parts = [];
  const base = Math.floor(list.length / n);
  let extra = list.length % n;
  let start = 0;
  for (let i = 0; i < n; i++) {
    const size = base + (extra > 0 ? 1 : 0);
    if (extra > 0) extra--;
    parts.push(list.slice(start, start + size));
    start += size;
  }
  return parts.filter(p => p.length);
}

module.exports = {
  fetchAccountsFilePath,
  publicFetchAccounts,
  saveFetchAccounts,
  fetchAccountPool,
  planParts,
  cookieFileFor,
  MIN_PATIENTS_PER_PART,
  MAX_PARALLEL_LIMIT,
};
