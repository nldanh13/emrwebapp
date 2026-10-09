// server/services/details_parallel.js — Chia "Lấy chi tiết" cho nhiều tài khoản EMR chạy song song.
//
// Mỗi phần chạy một worker riêng, bằng một tài khoản riêng, ghi vào thư mục tạm riêng (nơi gọi lo).
// Phần lỗi được chạy lại MỘT lần bằng tài khoản chung; vẫn lỗi thì báo rõ người bệnh nào chưa lấy được,
// phần đã lấy được vẫn giữ. Không phụ thuộc Express/Python để test được bằng runPart giả.

'use strict';

const { planParts, MIN_PATIENTS_PER_PART } = require('./fetch_accounts');

function asFailure(err) {
  return { ok: false, records: [], message: String(err?.message || err || 'Lỗi không rõ').slice(0, 500) };
}

/**
 * @param {object}   o
 * @param {object[]} o.rows        danh sách người bệnh cần lấy
 * @param {object[]} o.pool        tài khoản dùng được (fetchAccountPool), phần tử đầu là tài khoản chung
 * @param {Function} o.runPart     ({ rows, account, label }) => Promise<{ ok, records, message }>
 * @param {Function} o.laneRunner  (accountKey, fn) => Promise — khóa làn tài khoản (task_queue)
 * @param {Function} [o.isCancelled]
 * @param {Function} o.getId       row => mã người bệnh
 * @returns {Promise<null|object>} null khi không cần chia (chạy một worker như cũ)
 */
async function runDetailsInParts({ rows, pool, runPart, laneRunner, isCancelled = () => false, getId, minPerPart = MIN_PATIENTS_PER_PART }) {
  const accounts = Array.isArray(pool) ? pool : [];
  const parts = planParts(rows, accounts.length, minPerPart);
  if (parts.length <= 1) return null;

  const runOn = (account, partRows, label) => {
    const job = () => Promise.resolve()
      .then(() => runPart({ rows: partRows, account, label }))
      .then(r => (r && r.ok ? { ok: true, records: Array.isArray(r.records) ? r.records : [], message: '' } : asFailure(r?.message)))
      .catch(asFailure);
    // Tài khoản chung: tác vụ gọi đã giữ làn 'default' rồi, khóa lại sẽ tự chờ chính mình.
    return account.main ? job() : laneRunner(account.key, job);
  };

  const results = await Promise.all(parts.map((partRows, i) => runOn(accounts[i], partRows, accounts[i].label)));
  const summary = parts.map((partRows, i) => ({
    label: accounts[i].label,
    count: partRows.length,
    ok: results[i].ok,
    message: results[i].message,
  }));

  const records = [];
  const okIds = new Set();
  let failedRows = [];
  results.forEach((r, i) => {
    if (r.ok) {
      records.push(...r.records);
      for (const row of parts[i]) { const id = getId(row); if (id) okIds.add(id); }
    } else {
      failedRows = failedRows.concat(parts[i]);
    }
  });

  let retry = null;
  if (failedRows.length && !isCancelled()) {
    const main = accounts.find(a => a.main) || accounts[0];
    const r = await runOn(main, failedRows, `${main.label} (chạy lại phần lỗi)`);
    retry = { label: main.label, count: failedRows.length, ok: r.ok, message: r.message };
    if (r.ok) {
      records.push(...r.records);
      for (const row of failedRows) { const id = getId(row); if (id) okIds.add(id); }
      failedRows = [];
    }
  }

  return { records, okIds, failedRows, parts: summary, retry, cancelled: Boolean(isCancelled()) };
}

module.exports = { runDetailsInParts };
