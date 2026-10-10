// server/services/emr_account_overview.js — Mọi tài khoản EMR app đang giữ, gom về một bảng.
//
// Tài khoản EMR nằm ở ba nơi, mỗi nơi một việc:
//   - secrets/secrets.json (hoặc biến môi trường): tài khoản chung, tài khoản Hành chánh;
//   - secrets/nurse_emr_accounts.json: tài khoản theo tên điều dưỡng, dùng khi NHẬP liệu theo lịch;
//   - secrets/emr_read_accounts.json: tài khoản chỉ đọc để Lấy chi tiết song song.
// Màn Thiết lập tài khoản → Tài khoản EMR hiện bảng này để thấy một tài khoản EMR đang khai ở
// mấy chỗ (trùng) và người nào trong lịch chưa có tài khoản. Không bao giờ trả mật khẩu.

'use strict';

const { resolveSecret, SOURCE } = require('./secret_store');
const { readNurseEmrAccounts } = require('../utils/nurse_emr_accounts');

const SOURCE_LABELS = {
  [SOURCE.ENV]: 'biến môi trường',
  [SOURCE.ENV_FILE]: 'file bí mật (biến môi trường _FILE)',
  [SOURCE.SECRETS_FILE]: 'secrets/secrets.json',
  [SOURCE.LEGACY_CONFIG]: 'config/config.json (vị trí cũ, nên chuyển bằng npm run secrets:migrate:apply)',
};

const USE_LABELS = {
  shared: 'Tài khoản chung',
  hchanh: 'Tài khoản Hành chánh',
  nurse: 'Nhập liệu theo lịch',
  doctor: 'Bác sĩ phòng khám',
  read: 'Đọc song song',
};

function key(username) {
  return String(username || '').trim().toLowerCase();
}

function secretPair(userKey, passKey) {
  const user = resolveSecret(userKey);
  const pass = resolveSecret(passKey);
  return { username: String(user.value || '').trim(), source: user.source, has_password: Boolean(pass.value) };
}

/**
 * @param {object} input
 * @param {string[]} [input.roster]  Tên điều dưỡng trong Lịch điều dưỡng.
 * @param {Array}    [input.nurseAccounts]  readNurseEmrAccounts().
 * @param {Array}    [input.readAccounts]   publicFetchAccounts().accounts.
 * @param {object}   [input.shared]  { username, source, has_password } — mặc định đọc secret_store.
 * @param {object}   [input.hchanh]  như shared.
 */
function buildEmrAccountOverview({
  roster = [], nurseAccounts = [], readAccounts = [], shared, hchanh,
} = {}) {
  const sharedInfo = shared || secretPair('emr_username', 'emr_password');
  const hchanhInfo = hchanh || secretPair('hchanh_username', 'hchanh_password');
  const uses = [];
  const add = (row) => { if (key(row.username)) uses.push(row); };

  add({ use: 'shared', owner: '', username: sharedInfo.username, has_password: sharedInfo.has_password });
  add({ use: 'hchanh', owner: '', username: hchanhInfo.username, has_password: hchanhInfo.has_password });
  for (const row of nurseAccounts) {
    add({ use: row.kind === 'doctor' ? 'doctor' : 'nurse', owner: row.name, username: row.emr_username, has_password: Boolean(row.emr_password) });
  }
  for (const acc of readAccounts) {
    // Dòng "chọn người đã lưu" dùng chính tài khoản của người đó (không giữ bản mật khẩu thứ hai):
    // hiện thêm việc "Đọc song song" nhưng không tính là khai trùng.
    const linked = acc.source === 'saved';
    add({ use: 'read', owner: linked ? '' : acc.name, username: acc.emr_username, has_password: Boolean(acc.has_password), enabled: acc.enabled !== false, linked });
  }

  // Gộp theo tên đăng nhập EMR: một dòng = một tài khoản EMR, kèm mọi chỗ đang khai nó.
  const byUser = new Map();
  for (const row of uses) {
    const k = key(row.username);
    if (!byUser.has(k)) byUser.set(k, { username: row.username.trim(), uses: [] });
    byUser.get(k).uses.push({ use: row.use, label: USE_LABELS[row.use], owner: row.owner, has_password: row.has_password, ...(row.enabled === false ? { enabled: false } : {}), ...(row.linked ? { linked: true } : {}) });
  }
  const accounts = [...byUser.values()].map((acc) => {
    const own = acc.uses.filter(u => !u.linked); // chỗ giữ một bản mật khẩu riêng
    const notes = [];
    // Một tài khoản khai ở nhiều chỗ thì mỗi chỗ giữ một bản mật khẩu: đổi một chỗ là chỗ kia sai.
    if (own.length > 1) notes.push(`Đang khai ở ${own.length} chỗ. Đổi mật khẩu EMR thì phải sửa đủ cả ${own.length} chỗ.`);
    if (own.some(u => u.use === 'read') && own.length > 1) notes.push('Tài khoản đọc song song gõ tay trùng tài khoản khác nên không được dùng để đọc song song.');
    if (acc.uses.some(u => u.linked)) notes.push('Cũng dùng để đọc song song (lấy mật khẩu từ tài khoản đã lưu).');
    if (own.some(u => !u.has_password)) notes.push('Thiếu mật khẩu ở ít nhất một chỗ.');
    return { ...acc, duplicate: own.length > 1, notes };
  });
  accounts.sort((a, b) => Number(b.duplicate) - Number(a.duplicate) || a.username.localeCompare(b.username, 'vi'));

  const withAccount = new Set(nurseAccounts.filter(r => r.kind !== 'doctor' && r.emr_username && r.emr_password).map(r => r.name));
  const nursesMissing = (Array.isArray(roster) ? roster : []).filter(name => !withAccount.has(name));

  return {
    shared: {
      configured: Boolean(sharedInfo.username && sharedInfo.has_password),
      username: sharedInfo.username,
      source: SOURCE_LABELS[sharedInfo.source] || '',
    },
    hchanh: {
      configured: Boolean(hchanhInfo.username && hchanhInfo.has_password),
      username: hchanhInfo.username,
      source: SOURCE_LABELS[hchanhInfo.source] || '',
    },
    accounts,
    duplicate_count: accounts.filter(a => a.duplicate).length,
    nurses_missing: nursesMissing,
    generated_at: new Date().toISOString(),
  };
}

function emrAccountOverview({ roster } = {}) {
  const { publicFetchAccounts } = require('./fetch_accounts');
  let nurseAccounts = [];
  try { nurseAccounts = readNurseEmrAccounts(); } catch (_) { /* chưa có file */ }
  let readAccounts = [];
  try { readAccounts = publicFetchAccounts().accounts || []; } catch (_) { /* chưa có file */ }
  return buildEmrAccountOverview({ roster, nurseAccounts, readAccounts });
}

module.exports = { buildEmrAccountOverview, emrAccountOverview, USE_LABELS };
