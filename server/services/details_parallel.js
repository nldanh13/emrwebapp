// server/services/details_parallel.js — Chia "Lấy chi tiết" cho nhiều người/máy cùng làm.
//
// "Người làm" (runner) là một trong hai loại:
// - tài khoản EMR trên máy chủ (tài khoản chung + tài khoản đọc thêm): mở Chrome, đọc được mọi ca;
// - máy góp sức: tab EMR của một người trong bệnh viện (emr_bridge helpers), đọc qua phiên của họ,
//   không mở được Chrome nên ca nào không đọc được thì trả lại.
//
// Danh sách được chia thành các lô nhỏ trong một hàng đợi. Người làm nào rảnh thì nhận lô kế tiếp,
// nên máy nhanh làm nhiều hơn và máy mới nối giữa chừng cũng được nhận việc.
// - Không trùng: một lô chỉ ở một chỗ (hàng đợi hoặc đúng một người làm); chỉ nhận kết quả của
//   đúng các ca trong lô.
// - Không mất: lô lỗi quay lại hàng đợi cho người khác (không giao lại cho người vừa lỗi), tối đa
//   3 lần; người làm lỗi 2 lô liền thì nghỉ (thường là bị đăng xuất hoặc đã đóng tab).
// - Không đoán: ca máy góp sức không đọc được thành lô riêng chỉ dành cho tài khoản trên máy chủ.
// Không phụ thuộc Express/Python để test được bằng runBatch giả.

'use strict';

const MAX_ATTEMPTS = 3;
const MAX_CONSECUTIVE_FAILURES = 2;
const MAX_ACCOUNT_BATCHES = 3;
const parsedMaxRunners = Number.parseInt(process.env.MAX_FETCH_RUNNERS || '6', 10);
const DEFAULT_MAX_RUNNERS = Number.isFinite(parsedMaxRunners) && parsedMaxRunners > 0 ? Math.min(parsedMaxRunners, 20) : 6;

function chunk(list, size) {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

function defaultBatchSize(total, runnerCount) {
  // Khoảng 3 lô cho mỗi người làm lúc đầu: đủ nhỏ để chia lại khi có máy nhanh/chậm/rớt,
  // đủ lớn để không tốn công mở phiên cho từng ca.
  return Math.max(3, Math.min(8, Math.ceil(total / (Math.max(2, runnerCount) * 3))));
}

/**
 * @param {object}   o
 * @param {object[]} o.rows             danh sách người bệnh
 * @param {object[]} o.runners          người làm lúc bắt đầu: { key, label, kind: 'account'|'helper', direct, main }
 * @param {Function} [o.discoverRunners] () => người làm mới nối giữa chừng (máy góp sức)
 * @param {Function} [o.isAlive]        (runner) => còn làm được không (máy góp sức còn nối)
 * @param {Function} o.runBatch         (runner, rows) => Promise<{ ok, records, skippedIds, message }>
 * @param {Function} o.laneRunner       (accountKey, fn) => Promise — khóa làn tài khoản (task_queue)
 * @param {Function} [o.isCancelled]
 * @param {Function} [o.onProgress]     (event) => void — báo tiến độ (máy góp sức nào đang làm/đã xong)
 * @param {Function} o.getId            row => mã người bệnh
 * @returns {Promise<null|object>} null khi chỉ có một người làm (chạy một worker như cũ)
 */
async function runDetailsQueue({
  rows,
  runners: initialRunners,
  discoverRunners = () => [],
  isAlive = () => true,
  runBatch,
  laneRunner,
  isCancelled = () => false,
  onProgress = () => {},
  getId,
  batchSize,
  pollMs = 2000,
  minPatients = 8,
  maxRunners = DEFAULT_MAX_RUNNERS,
}) {
  const list = Array.isArray(rows) ? rows : [];
  const runners = [];
  const known = new Set();
  // Trần tổng số người làm cùng lúc: mỗi người làm là một phiên EMR + một tiến trình đọc trên máy chủ.
  const addRunner = (r) => {
    if (!r || known.has(r.key)) return null;
    if (runners.filter(x => !x.retired).length >= maxRunners) return null;
    known.add(r.key);
    const runner = { ...r, retired: false, consecutiveFailures: 0, patients: 0, batches: 0, failures: 0 };
    runners.push(runner);
    return runner;
  };
  for (const r of initialRunners || []) addRunner(r);
  if (runners.length <= 1 || list.length < minPatients) return null;

  const size = batchSize || defaultBatchSize(list.length, runners.length);
  const queue = chunk(list, size).map(b => ({ rows: b, attempts: 0, excluded: new Set(), directOnly: false }));
  const records = [];
  const okIds = new Set();
  let failedRows = [];
  const failureMessages = [];
  let inflight = 0;

  let wakers = [];
  const changed = () => { const w = wakers; wakers = []; for (const fn of w) fn(); };
  const waitChange = (ms) => new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    wakers.push(() => { clearTimeout(t); resolve(); });
  });

  const activeRunners = () => runners.filter(r => !r.retired);
  const canTake = (runner, batch) => !batch.excluded.has(runner.key) && (!batch.directOnly || runner.direct);

  // Tài khoản trên máy chủ mở Chrome và đăng nhập cho mỗi lần nhận việc, nên nhận nhiều lô một lúc
  // (chia đều phần còn lại); máy góp sức dùng phiên sẵn có, nhận từng lô.
  function pick(runner) {
    const takeable = queue.filter(b => canTake(runner, b));
    if (!takeable.length) return [];
    // Tối đa 3 lô một lần, để luôn còn việc cho máy góp sức nối sau và cho máy nhanh nhận thêm.
    const share = runner.kind === 'account'
      ? Math.max(1, Math.min(MAX_ACCOUNT_BATCHES, Math.floor(queue.length / Math.max(1, activeRunners().length))))
      : 1;
    // Lô vừa nằm trong một lần nhận nhiều lô bị lỗi thì chạy riêng, để một ca lỗi không kéo lô khác theo.
    if (takeable[0].solo) { queue.splice(queue.indexOf(takeable[0]), 1); return [takeable[0]]; }
    const picked = takeable.filter(b => !b.solo).slice(0, share);
    for (const b of picked) queue.splice(queue.indexOf(b), 1);
    return picked;
  }

  // Lô không người làm nào còn nhận được (mọi người hợp lệ đã lỗi với nó hoặc đã nghỉ) → thất bại.
  function dropStuckBatches() {
    const active = activeRunners();
    for (const b of [...queue]) {
      if (!active.some(r => canTake(r, b))) {
        queue.splice(queue.indexOf(b), 1);
        failedRows = failedRows.concat(b.rows);
      }
    }
  }

  const finished = () => (queue.length === 0 && inflight === 0) || (isCancelled() && inflight === 0);

  function retire(runner, reason) {
    if (runner.retired) return;
    runner.retired = true;
    runner.retireReason = reason;
    onProgress({ type: 'retired', runner, reason });
  }

  async function execute(runner, batchRows) {
    const job = () => Promise.resolve().then(() => runBatch(runner, batchRows));
    try {
      const r = (runner.kind === 'account' && !runner.main) ? await laneRunner(runner.key, job) : await job();
      return r && r.ok
        ? { ok: true, records: Array.isArray(r.records) ? r.records : [], skippedIds: Array.isArray(r.skippedIds) ? r.skippedIds : [] }
        : { ok: false, message: String(r?.message || 'Lỗi không rõ').slice(0, 500) };
    } catch (err) {
      return { ok: false, message: String(err?.message || err || 'Lỗi không rõ').slice(0, 500) };
    }
  }

  function accept(runner, batches, result) {
    const batchRows = batches.flatMap(b => b.rows);
    const ids = new Set(batchRows.map(getId).filter(Boolean));
    const skipped = new Set(result.skippedIds.map(String).filter(id => ids.has(id)));
    // Chỉ nhận dòng của đúng các ca trong lô, trừ ca bị trả lại.
    for (const rec of result.records) {
      const id = getId(rec);
      if (id && ids.has(id) && !skipped.has(id)) records.push(rec);
    }
    const doneRows = batchRows.filter(r => !skipped.has(getId(r)));
    for (const row of doneRows) { const id = getId(row); if (id) okIds.add(id); }
    const skippedRows = batchRows.filter(r => skipped.has(getId(r)));
    if (skippedRows.length) queue.push({ rows: skippedRows, attempts: 0, excluded: new Set(), directOnly: true });
    runner.patients += doneRows.length;
    runner.batches += batches.length;
    runner.consecutiveFailures = 0;
    onProgress({ type: 'done', runner, patients: doneRows.length });
  }

  function reject(runner, batches, message) {
    runner.failures += 1;
    runner.consecutiveFailures += 1;
    failureMessages.push(`${runner.label}: ${message}`);
    if (batches.length > 1) {
      // Không biết lô nào gây lỗi: trả từng lô về hàng đợi để chạy riêng, chưa tính là một lần thử.
      for (const b of batches) { b.solo = true; queue.unshift(b); }
      if (runner.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) retire(runner, message);
      return;
    }
    for (const b of batches) {
      b.attempts += 1;
      b.excluded.add(runner.key);
      if (b.attempts >= MAX_ATTEMPTS) failedRows = failedRows.concat(b.rows);
      else queue.unshift(b);
    }
    if (runner.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) retire(runner, message);
  }

  async function work(runner) {
    while (!runner.retired) {
      if (isCancelled()) return;
      if (!isAlive(runner)) { retire(runner, 'Đã ngừng nối.'); changed(); return; }
      const batches = pick(runner);
      if (!batches.length) {
        dropStuckBatches();
        if (finished()) { changed(); return; }
        await waitChange(pollMs);
        continue;
      }
      inflight += 1;
      onProgress({ type: 'start', runner });
      const result = await execute(runner, batches.flatMap(b => b.rows));
      inflight -= 1;
      if (result.ok) accept(runner, batches, result);
      else reject(runner, batches, result.message);
      changed();
    }
  }

  const loops = runners.map(r => work(r));
  while (!finished()) {
    for (const r of discoverRunners() || []) {
      const runner = addRunner(r);
      if (runner) { loops.push(work(runner)); onProgress({ type: 'joined', runner }); }
    }
    if (!activeRunners().length && inflight === 0) {
      for (const b of queue.splice(0)) failedRows = failedRows.concat(b.rows);
      break;
    }
    dropStuckBatches();
    await waitChange(pollMs);
  }
  changed();
  await Promise.all(loops);

  return {
    records,
    okIds,
    failedRows,
    failureMessages,
    cancelled: Boolean(isCancelled()),
    runners: runners.map(r => ({ key: r.key, label: r.label, kind: r.kind, patients: r.patients, batches: r.batches, failures: r.failures, retired: r.retired })),
  };
}

module.exports = { runDetailsQueue, defaultBatchSize };
