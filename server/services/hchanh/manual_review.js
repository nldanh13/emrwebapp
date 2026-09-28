// Checklist kiểm HSBA thủ công dùng chung cho API, dashboard và kiểm thử.

'use strict';

const REVIEW_STATUSES = new Set(['pending', 'pass', 'issue', 'na']);

const REVIEW_ITEMS = Object.freeze([
  { key: 'administrative', label: 'Hành chính và BHYT' },
  { key: 'clinical', label: 'Bệnh án, chẩn đoán và giấy ra viện' },
  { key: 'orders', label: 'Y lệnh, thuốc và VTYT' },
  { key: 'nursing', label: 'Theo dõi và chăm sóc điều dưỡng' },
  { key: 'billing', label: 'Ngày giường và bảng kê' },
  { key: 'signatures', label: 'Chữ ký và giấy tờ kèm theo' },
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

function applyManualReviewPatch(current, patch, now = new Date().toISOString()) {
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
  manualReviewSummary,
  manualReviewIssues,
};
