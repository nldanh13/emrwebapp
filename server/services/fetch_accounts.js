// server/services/fetch_accounts.js — Tài khoản EMR thêm để "Lấy chi tiết" chạy song song.
//
// "Lấy chi tiết" đọc từng người bệnh lần lượt bằng một tài khoản, nên càng nhiều người bệnh càng
// lâu. Quản trị khai thêm tài khoản EMR chỉ dùng để ĐỌC dữ liệu (secrets/emr_read_accounts.json);
// máy chủ chia danh sách thành nhiều phần, mỗi phần chạy bằng một tài khoản khác nhau.
//
// Hai cách khai một tài khoản đọc:
// - Chọn người đã lưu (điều dưỡng hoặc bác sĩ phòng khám ở secrets/nurse_emr_accounts.json): dòng chỉ
//   ghi { source: 'saved', name }, tên đăng nhập và mật khẩu lấy từ tài khoản đã lưu lúc chạy, nên
//   đổi mật khẩu một chỗ là đủ. Lấy chi tiết chạy trong làn 'default' của hàng đợi tác vụ nặng, cùng
//   làn với nhập liệu, nên không bao giờ chạy cùng lúc với nhập liệu bằng tài khoản điều dưỡng.
// - Gõ tay một tài khoản khác (tài khoản không ai dùng hằng ngày).
//
// Quy tắc an toàn:
// - Một tài khoản chỉ chạy một phần tại một thời điểm (khóa theo làn tài khoản trong task_queue).
// - Tài khoản trùng tài khoản chung / Hành chánh / dịch truyền thì không dùng.
// - Gõ tay trùng tài khoản đã lưu của một người thì không dùng (chọn người đó trong danh sách, để
//   không giữ hai bản mật khẩu).
// - Tài khoản đang được Theo dõi phòng khám giữ phiên (emr_logins_in_use) thì bỏ qua lần chạy đó.
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

function savedAccountsByName() {
  try {
    const { readNurseEmrAccounts } = require('../utils/nurse_emr_accounts');
    return new Map(readNurseEmrAccounts().map(r => [norm(r.name), r]));
  } catch (_) { return new Map(); }
}

function normalizeAccount(row) {
  if (!row || typeof row !== 'object') return null;
  if (row.source === 'saved') {
    const name = norm(row.name).slice(0, 80);
    if (!name) return null;
    return {
      id: /^[a-f0-9]{6,32}$/.test(String(row.id || '')) ? String(row.id) : stableId(`saved:${name}`),
      source: 'saved', name, enabled: row.enabled !== false,
    };
  }
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
    if (!acc) continue;
    const dedupe = acc.source === 'saved' ? `saved:${acc.name}` : userKey(acc.emr_username);
    if (seen.has(dedupe)) continue;
    seen.add(dedupe);
    accounts.push(acc);
  }
  return { max_parallel: clampParallel(obj.max_parallel), accounts: accounts.slice(0, MAX_ACCOUNTS) };
}

/** Dòng "chọn người đã lưu" → điền tên đăng nhập/mật khẩu hiện tại của người đó (không ghi ra file). */
function resolveAccounts(accounts, saved = savedAccountsByName()) {
  return accounts.map((acc) => {
    if (acc.source !== 'saved') return acc;
    const row = saved.get(acc.name);
    return {
      ...acc,
      kind: row ? (row.kind === 'doctor' ? 'doctor' : 'nurse') : '',
      missing: !row,
      emr_username: norm(row?.emr_username),
      emr_password: String(row?.emr_password || ''),
    };
  });
}

/** Tài khoản đã lưu theo người: tên đăng nhập → tên người (gõ tay trùng thì báo chọn người đó). */
function savedUsernames(saved = savedAccountsByName()) {
  const out = new Map();
  for (const row of saved.values()) if (row?.emr_username) out.set(userKey(row.emr_username), row.name);
  return out;
}

/** Tài khoản riêng của module khác (Hành chánh, dịch truyền) — không dùng để đọc song song. */
function moduleAccountUsernames() {
  const out = new Set();
  for (const key of ['hchanh_username', 'infusion_username']) {
    try { const v = getSecret(key); if (v) out.add(userKey(v)); } catch (_) { /* chưa khai báo */ }
  }
  return out;
}

function mainUsername() {
  try { return norm(getSecret('emr_username')); } catch (_) { return ''; }
}

/** Lý do không dùng được một tài khoản; '' nếu dùng được. */
function exclusionReason(acc, { main, moduleUsers, savedUsers }) {
  if (!acc.enabled) return 'Đang tắt.';
  if (acc.source === 'saved' && acc.missing) return `Không còn tài khoản đã lưu của ${acc.name}. Chọn người khác hoặc bỏ dòng này.`;
  if (!acc.emr_username) return `${acc.name} chưa có tên đăng nhập EMR. Khai ở mục Điều dưỡng hoặc Bác sĩ phòng khám.`;
  if (!acc.emr_password) return acc.source === 'saved' ? `${acc.name} chưa có mật khẩu EMR. Khai ở mục Điều dưỡng hoặc Bác sĩ phòng khám.` : 'Chưa có mật khẩu.';
  if (main && userKey(acc.emr_username) === userKey(main)) return 'Trùng tài khoản chung, không cần khai thêm.';
  if (moduleUsers.has(userKey(acc.emr_username))) {
    return 'Tài khoản này đang dùng cho Hành chánh hoặc dịch truyền; dùng song song có thể bị đăng xuất lẫn nhau.';
  }
  if (acc.source !== 'saved' && savedUsers.has(userKey(acc.emr_username))) {
    return `Trùng tài khoản đã lưu của ${savedUsers.get(userKey(acc.emr_username))}. Bỏ dòng này rồi chọn ${savedUsers.get(userKey(acc.emr_username))} trong danh sách.`;
  }
  return '';
}

function exclusionContext() {
  return { main: mainUsername(), moduleUsers: moduleAccountUsernames(), savedUsers: savedUsernames() };
}

function cookieFileFor(username) {
  const hash = crypto.createHash('sha256').update(userKey(username)).digest('hex').slice(0, 16);
  return path.join(RUNTIME_ROOT, 'auth', `emr_http_cookies_${hash}.json`);
}

/** Danh sách cho giao diện quản trị: không có mật khẩu. */
function publicFetchAccounts() {
  const store = readStore();
  const ctx = exclusionContext();
  const { emrLoginInUseReason } = require('./emr_logins_in_use');
  return {
    max_parallel: store.max_parallel,
    max_parallel_limit: MAX_PARALLEL_LIMIT,
    main_configured: Boolean(ctx.main),
    accounts: resolveAccounts(store.accounts).map((acc) => {
      const note = exclusionReason(acc, ctx);
      const busy = note ? '' : emrLoginInUseReason(acc.emr_username);
      return {
        id: acc.id,
        source: acc.source === 'saved' ? 'saved' : 'manual',
        ...(acc.source === 'saved' ? { kind: acc.kind } : {}),
        name: acc.name,
        emr_username: acc.emr_username,
        has_password: Boolean(acc.emr_password),
        enabled: acc.enabled,
        usable: !note,
        note: note || (busy ? `${busy} Lần lấy dữ liệu lúc này sẽ bỏ qua tài khoản này.` : ''),
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
    if (row?.source === 'saved') {
      const acc = normalizeAccount({ ...row, id: oldById.has(String(row?.id || '')) ? row.id : '' });
      if (!acc) continue;
      if (seen.has(`saved:${acc.name}`)) throw new Error(`${acc.name} bị chọn hai lần.`);
      seen.add(`saved:${acc.name}`);
      next.push(acc);
      continue;
    }
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
  const ctx = exclusionContext();
  const { emrLoginInUseReason } = require('./emr_logins_in_use');
  const pool = [{ key: 'default', label: 'Tài khoản chung', env: {}, main: true }];
  const used = new Set();
  for (const acc of resolveAccounts(store.accounts)) {
    if (pool.length >= store.max_parallel) break;
    if (exclusionReason(acc, ctx) || emrLoginInUseReason(acc.emr_username)) continue;
    if (used.has(userKey(acc.emr_username))) continue; // hai dòng cùng một tài khoản EMR
    used.add(userKey(acc.emr_username));
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

module.exports = {
  fetchAccountsFilePath,
  publicFetchAccounts,
  saveFetchAccounts,
  fetchAccountPool,
  cookieFileFor,
  MAX_PARALLEL_LIMIT,
};
