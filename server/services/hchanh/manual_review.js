// Checklist kiểm HSBA thủ công dùng chung cho API, dashboard và kiểm thử.

'use strict';

const REVIEW_STATUSES = new Set(['pending', 'pass', 'issue', 'na']);

const REVIEW_ITEMS = Object.freeze([
  { key: 'administrative', label: 'Hành chính và BHYT trên EMR' },
  { key: 'clinical', label: 'Bệnh án, chẩn đoán và giấy ra viện' },
  { key: 'orders', label: 'Y lệnh, thuốc và VTYT' },
  { key: 'nursing', label: 'Theo dõi và chăm sóc điều dưỡng trên EMR' },
  { key: 'billing', label: 'Ngày giường và bảng kê' },
  { key: 'surgery', label: 'Hồ sơ phẫu thuật/thủ thuật và gây mê' },
  { key: 'signatures', label: 'Giấy ra viện và giấy tờ kèm theo trên EMR' },
]);

function cleanText(value, max = 1000) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function normalizeItem(value) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const status = REVIEW_STATUSES.has(source.status) ? source.status : 'pending';
  return {
    status,
    note: cleanText(source.note),
    updated_at: cleanText(source.updated_at, 80),
    updated_by: cleanText(source.updated_by, 80),
  };
}

function normalizeManualReview(raw) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const sourceItems = source.items && typeof source.items === 'object' && !Array.isArray(source.items)
    ? source.items
    : {};
  const items = {};
  for (const definition of REVIEW_ITEMS) items[definition.key] = normalizeItem(sourceItems[definition.key]);
  return {
    version: 1,
    items,
    note: cleanText(source.note, 2000),
    updated_at: cleanText(source.updated_at, 80),
  };
}

function viTime(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const opts = { hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit', hour12: false };
  try { return d.toLocaleString('vi-VN', { ...opts, timeZone: 'Asia/Ho_Chi_Minh' }); } catch (_) { return d.toLocaleString('vi-VN', opts); }
}

/**
 * Hai người cùng kiểm một hồ sơ: giao diện gửi kèm `base_updated_at` (thời điểm mục đó lúc họ mở).
 * Mục đã được người khác sửa sau thời điểm đó thì trả về mục bị trùng để báo, không ghi đè.
 * Giao diện cũ không gửi `base_updated_at` thì không kiểm (giữ hành vi cũ).
 */
function manualReviewConflict(current, patch) {
  const review = normalizeManualReview(current);
  const patchItems = patch?.items && typeof patch.items === 'object' && !Array.isArray(patch.items) ? patch.items : {};
  for (const definition of REVIEW_ITEMS) {
    const incoming = patchItems[definition.key];
    if (!incoming || typeof incoming !== 'object' || !Object.prototype.hasOwnProperty.call(incoming, 'base_updated_at')) continue;
    const base = cleanText(incoming.base_updated_at, 80);
    const previous = review.items[definition.key];
    if (previous.updated_at && previous.updated_at !== base) {
      return { key: definition.key, label: definition.label, by: previous.updated_by, at: viTime(previous.updated_at) };
    }
  }
  return null;
}

function applyManualReviewPatch(current, patch, now = new Date().toISOString(), actor = '') {
  const review = normalizeManualReview(current);
  const source = patch && typeof patch === 'object' && !Array.isArray(patch) ? patch : {};
  const patchItems = source.items && typeof source.items === 'object' && !Array.isArray(source.items)
    ? source.items
    : {};

  for (const definition of REVIEW_ITEMS) {
    if (!Object.prototype.hasOwnProperty.call(patchItems, definition.key)) continue;
    const incoming = patchItems[definition.key] && typeof patchItems[definition.key] === 'object'
      ? patchItems[definition.key]
      : {};
    const previous = review.items[definition.key];
    review.items[definition.key] = {
      status: REVIEW_STATUSES.has(incoming.status) ? incoming.status : previous.status,
      note: incoming.note === undefined ? previous.note : cleanText(incoming.note),
      updated_at: now,
      updated_by: cleanText(actor, 80),
    };
  }
  if (source.note !== undefined) review.note = cleanText(source.note, 2000);
  review.updated_at = now;
  return review;
}

function validTime(value) {
  const ms = Date.parse(String(value || ''));
  return Number.isFinite(ms) ? ms : 0;
}

function latestFetchedAt(fetched) {
  const values = fetched && typeof fetched === 'object' && !Array.isArray(fetched)
    ? Object.values(fetched)
    : [];
  const latest = values.reduce((max, value) => Math.max(max, validTime(value)), 0);
  return latest ? new Date(latest).toISOString() : '';
}

function manualReviewSummary(raw, options = {}) {
  const review = normalizeManualReview(raw);
  const latest_fetch_at = latestFetchedAt(options.fetched);
  const latestFetchMs = validTime(latest_fetch_at);
  const rows = REVIEW_ITEMS.map(definition => {
    const item = review.items[definition.key];
    const stale = item.status !== 'pending' && latestFetchMs > validTime(item.updated_at);
    return { ...definition, ...item, stale };
  });
  const pending = rows.filter(row => row.status === 'pending').length;
  const stale = rows.filter(row => row.stale).length;
  const issues = rows.filter(row => row.status === 'issue');
  const complete = pending === 0 && stale === 0;
  return {
    ...review,
    rows,
    pending_count: pending,
    stale_count: stale,
    remaining_count: pending + stale,
    issue_count: issues.length,
    latest_fetch_at,
    complete,
    passed: complete && issues.length === 0,
  };
}

function manualReviewIssues(raw) {
  return manualReviewSummary(raw).rows
    .filter(row => row.status === 'issue')
    .map(row => ({
      group: 'Kiểm thủ công',
      severity: 'warn',
      code: `MANUAL_REVIEW_${row.key.toUpperCase()}`,
      title: row.label,
      detail: row.note || 'Đã đánh dấu có nội dung cần sửa.',
      action: 'Kiểm tra và sửa nội dung này trên hồ sơ/EMR, sau đó đánh dấu Đạt.',
      evidence: 'manual_review',
    }));
}

module.exports = {
  REVIEW_ITEMS,
  normalizeManualReview,
  applyManualReviewPatch,
  manualReviewConflict,
  manualReviewSummary,
  manualReviewIssues,
};
