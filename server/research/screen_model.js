'use strict';

// Mô hình màn hình (screen model) cho Kho nghiên cứu → Thu thập dữ liệu.
//
// Nguyên tắc (docs/UX_RULES.md mục 9): máy chủ tính sẵn MỘT gói số liệu cho cả màn hình từ
// MỘT nguồn — sổ thu thập (collection ledger, dựng lại từ file tiến độ của worker nên luôn mới) —
// rồi giao diện chỉ hiển thị. Trước đây mỗi khung tự gọi API riêng, mỗi lúc một khác, mỗi
// khung một mẫu số (3.016 / 3.015 / 3.041 / 3.127 lượt trên cùng một màn hình).
//
// Bất biến (có test): counts.done + missing + error + waiting + unmatched = total, và
// plan.to_fetch + unchanged + waiting_encounters + unmatched_encounters = total.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const collection = require('./collection');
const { getCell, patientCode } = require('./table_io');
const { readLiveProgress } = require('./case_trace');

const STATE_ORDER = { error: 0, waiting: 1, unmatched: 2, missing: 3, running: 4, done: 5 };
const MAX_ROWS_PER_STATE = 300;

// Tình trạng một lượt, chia rời nhau (mỗi lượt đúng một nhóm):
//   unmatched  chưa ghép chắc lượt trên EMR → không tự lấy
//   done       mọi phần đã lấy và còn mới
//   error      có phần lỗi kỹ thuật, máy SẼ tự thử lại
//   missing    còn phần chưa lấy (máy sẽ lấy)
//   waiting    chỉ còn phần đã hết lượt thử / cần người xem → máy không tự lấy nữa
function encounterState(enc, maxAttempts) {
  if (enc.match_status === 'unmatched') return 'unmatched';
  let pending = false;
  let retryable = false;
  let stuck = false;
  for (const k of collection.PART_KEYS) {
    if (collection.partIsCurrent(enc, k)) continue;
    const p = enc.parts?.[k] || { status: 'pending' };
    if (p.status === 'failed') {
      if ((Number(p.attempts) || 0) >= maxAttempts) stuck = true;
      else retryable = true;
    } else if (p.status === 'blocked') {
      stuck = true;
    } else {
      pending = true; // pending, hoặc đã lấy nhưng EMR đổi (stale) → sẽ lấy lại
    }
  }
  if (retryable) return 'error';
  if (pending) return 'missing';
  if (stuck) return 'waiting';
  return 'done';
}

function partLabel(key) {
  return collection.PARTS.find(p => p.key === key)?.label || key;
}

function reasonOf(enc) {
  if (enc.match_status === 'unmatched') {
    return collection.REASON_LABELS?.[enc.unmatched_reason] || 'Chưa ghép chắc lượt điều trị';
  }
  for (const k of collection.PART_KEYS) {
    const p = enc.parts?.[k];
    if (p && ['failed', 'blocked'].includes(p.status) && !collection.partIsCurrent(enc, k)) {
      const label = collection.REASON_LABELS?.[p.reason] || p.reason || 'Lỗi';
      return `${partLabel(k)}: ${label}`;
    }
  }
  return '';
}

function namesBySource(sourceRows = []) {
  const byCode = new Map();
  for (const row of sourceRows) {
    const code = patientCode(row) || getCell(row, ['Mã BN', 'patient_code']);
    const name = getCell(row, ['Họ tên', 'Ho ten', 'patient_name', 'ho_ten']);
    if (code && name && !byCode.has(code)) byCode.set(code, name);
  }
  return byCode;
}

// Phiên bản số liệu: đổi khi bất kỳ file nguồn nào của màn hình đổi (giờ sửa + kích thước).
// Kênh sự kiện (/research/events) so phiên bản này để báo giao diện tải lại đúng lúc.
const VERSION_FILES = [
  'progress.json', 'hchanh_auto_progress.json', 'order_history_auto_progress.json',
  'collection_ledger.json', 'collection_report.json', 'research_task_state.json',
  'qa_report.json', 'normalize_state.json', 'extract_status.csv', 'research_case_trace_current.json',
];

function screenVersion(runDir, extra = '') {
  const h = crypto.createHash('sha1');
  h.update(String(runDir || ''));
  for (const name of VERSION_FILES) {
    try {
      const st = fs.statSync(path.join(runDir, name));
      h.update(`${name}:${st.mtimeMs}:${st.size};`);
    } catch (_) {
      h.update(`${name}:-;`);
    }
  }
  h.update(String(extra));
  return h.digest('hex').slice(0, 16);
}

// ledger: sổ đã đồng bộ; keys: các lượt của danh sách thu thập (collectionUnitsForRun).
function buildCollectionScreen({
  ledger, keys, sourceRows = [], runDir = '', runId = '', scope = '', maxAttempts = collection.DEFAULT_MAX_ATTEMPTS,
  refreshPolicy, qa = null, taskStatus = null, lastReport = null, exceptionsTotal = 0, pipeline = null, now = new Date(),
} = {}) {
  const scopeKeys = (keys || Object.keys(ledger?.encounters || {})).filter(k => ledger?.encounters?.[k]);
  const plan = collection.planCollection(ledger, { keys: scopeKeys, maxAttempts, refreshPolicy });
  const names = namesBySource(sourceRows);
  const live = runDir ? readLiveProgress(runDir) : null;
  const liveRc = String(live?.research_code || '').trim();
  const liveCode = String(live?.ma_bn || '').trim();

  const counts = { done: 0, missing: 0, error: 0, waiting: 0, unmatched: 0 };
  const parts = Object.fromEntries(collection.PARTS.map(p => [p.key, { key: p.key, label: p.label, done: 0, total: 0, failed: 0 }]));
  const rowsByState = { error: [], waiting: [], unmatched: [], missing: [], running: [] };
  let runningKey = '';

  for (const key of scopeKeys) {
    const enc = ledger.encounters[key];
    const state = encounterState(enc, maxAttempts);
    counts[state] += 1;
    if (state !== 'unmatched') {
      for (const k of collection.PART_KEYS) {
        parts[k].total += 1;
        if (collection.partIsCurrent(enc, k)) parts[k].done += 1;
        else if (['failed', 'blocked'].includes(enc.parts?.[k]?.status)) parts[k].failed += 1;
      }
    }
    const isLive = !runningKey && state !== 'done' && (
      (liveRc && (enc.research_code === liveRc || (enc.data_codes || []).includes(liveRc)))
      || (!liveRc && liveCode && enc.patient_code === liveCode)
    );
    if (isLive) runningKey = key;
    if (state === 'done') continue;
    const bucket = rowsByState[state];
    if (bucket.length >= MAX_ROWS_PER_STATE) continue;
    bucket.push({
      key,
      research_code: enc.research_code || '',
      patient_code: enc.patient_code || '',
      patient_name: names.get(enc.patient_code) || '',
      state,
      missing: collection.PART_KEYS.filter(k => !collection.partIsCurrent(enc, k)).map(partLabel).join(', '),
      reason: reasonOf(enc),
    });
  }

  const total = scopeKeys.length;
  const rows = [...rowsByState.error, ...rowsByState.waiting, ...rowsByState.unmatched, ...rowsByState.missing]
    .sort((a, b) => STATE_ORDER[a.state] - STATE_ORDER[b.state]);

  return {
    generated_at: now.toISOString(),
    version: runDir ? screenVersion(runDir) : '',
    scope,
    run_id: runId,
    total,
    counts,
    parts: Object.values(parts),
    plan: { ...plan.summary, max_attempts: maxAttempts },
    rows,
    running_key: runningKey,
    live,
    qa,
    task: taskStatus,
    last_report: lastReport,
    exceptions_total: exceptionsTotal,
    pipeline,
  };
}

module.exports = { buildCollectionScreen, encounterState, screenVersion, VERSION_FILES };
