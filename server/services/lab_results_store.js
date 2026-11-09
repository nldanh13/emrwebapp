// server/services/lab_results_store.js
//
// Kho kết quả xét nghiệm theo ngày của từng người bệnh (mỗi kho dữ liệu/phiên một file).
// Dữ liệu do worker `main_worker.py lab-day` đọc từ EMR (chỉ đọc), xem worker/lab_result_reader.py.
//
// Quy tắc không mở EMR khi không cần:
// - Đã đọc xong và mọi phiếu XN trong ngày đều Hoàn tất → không đọc lại (trừ khi người dùng bấm Lấy lại).
// - Đã đọc và EMR chưa có phiếu nào trong ngày → chỉ đọc lại sau NONE_RECHECK_MS (y lệnh XN có thể ra muộn).
// - Còn phiếu chờ kết quả, hoặc lần trước lỗi → đọc lại.
// Lần đọc lỗi không xóa kết quả tốt đã có của người bệnh đó.

'use strict';

const path = require('path');
const { readJsonSafe, writeJsonAtomic } = require('../utils/file');

const FILE_NAME = 'lab_results_by_day.json';
const KEEP_DAYS = 14;
const NONE_RECHECK_MS = 60 * 60 * 1000;

function storePath(ctx) {
  return path.join(ctx.dir, FILE_NAME);
}

function dmyKey(value) {
  const m = String(value || '').match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (!m) return '';
  return `${m[1].padStart(2, '0')}/${m[2].padStart(2, '0')}/${m[3]}`;
}

function dmySortValue(dmy) {
  const m = String(dmy).match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  return m ? Number(`${m[3]}${m[2]}${m[1]}`) : 0;
}

function emptyStore() {
  return { version: 1, days: {} };
}

function readStore(ctx) {
  const data = readJsonSafe(storePath(ctx), null);
  if (!data || typeof data !== 'object' || !data.days || typeof data.days !== 'object') return emptyStore();
  return data;
}

function pendingCount(entry) {
  const phieu = Array.isArray(entry?.phieu) ? entry.phieu : [];
  return phieu.filter(p => !p?.hoan_tat).length;
}

// Có cần mở EMR để đọc người bệnh này không. now: số mili giây (để test).
function needsFetch(entry, { force = false, now = Date.now() } = {}) {
  if (force || !entry) return true;
  if (entry.status === 'ok') return pendingCount(entry) > 0;
  if (entry.status === 'none') {
    const at = Date.parse(entry.fetched_at || '');
    return !Number.isFinite(at) || now - at >= NONE_RECHECK_MS;
  }
  return true;
}

function patientsToFetch(store, day, ids, opts = {}) {
  const dayData = store?.days?.[dmyKey(day)] || {};
  const forceIds = new Set((opts.forceIds || []).map(String));
  return ids.filter(id => needsFetch(dayData[id], { force: forceIds.has(String(id)), now: opts.now }));
}

// Gộp kết quả mới vào kho. Lỗi lần này không đè kết quả tốt lần trước:
// giữ bản cũ, gắn thêm lỗi lần đọc gần nhất để màn hình báo.
function mergeResults(store, day, results, { now = new Date() } = {}) {
  const key = dmyKey(day);
  if (!key) throw new Error('Ngày không đúng dạng dd/mm/yyyy');
  const out = { version: 1, days: { ...(store?.days || {}) } };
  const dayData = { ...(out.days[key] || {}) };
  for (const [id, fresh] of Object.entries(results || {})) {
    if (!id || !fresh || typeof fresh !== 'object') continue;
    const old = dayData[id];
    if (fresh.status === 'error' && old && (old.status === 'ok' || old.status === 'none')) {
      dayData[id] = { ...old, last_error: String(fresh.error || 'Lỗi không rõ'), last_error_at: fresh.fetched_at || now.toISOString() };
      continue;
    }
    dayData[id] = {
      status: ['ok', 'none', 'error'].includes(fresh.status) ? fresh.status : 'error',
      phieu: Array.isArray(fresh.phieu) ? fresh.phieu : [],
      tom_tat: fresh.tom_tat || null,
      error: String(fresh.error || ''),
      fetched_at: fresh.fetched_at || now.toISOString(),
    };
  }
  out.days[key] = dayData;
  const keep = Object.keys(out.days).sort((a, b) => dmySortValue(b) - dmySortValue(a)).slice(0, KEEP_DAYS);
  for (const k of Object.keys(out.days)) if (!keep.includes(k)) delete out.days[k];
  return out;
}

function writeStore(ctx, store) {
  writeJsonAtomic(storePath(ctx), store);
}

module.exports = {
  FILE_NAME,
  NONE_RECHECK_MS,
  dmyKey,
  readStore,
  writeStore,
  needsFetch,
  patientsToFetch,
  mergeResults,
  pendingCount,
};
