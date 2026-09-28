#!/usr/bin/env node
'use strict';

const assert = require('assert');
const {
  REVIEW_ITEMS,
  normalizeManualReview,
  applyManualReviewPatch,
  manualReviewSummary,
  manualReviewIssues,
} = require('../server/services/hchanh/manual_review');

const empty = normalizeManualReview(null);
assert.strictEqual(Object.keys(empty.items).length, REVIEW_ITEMS.length);
assert.strictEqual(manualReviewSummary(empty).pending_count, REVIEW_ITEMS.length);
assert.strictEqual(manualReviewSummary(empty).passed, false);
assert.ok(REVIEW_ITEMS.some(item => item.key === 'surgery'));

let review = empty;
for (const item of REVIEW_ITEMS) {
  review = applyManualReviewPatch(review, { items: { [item.key]: { status: 'pass' } } }, '2026-09-29T00:00:00.000Z');
}
assert.strictEqual(manualReviewSummary(review).passed, true);

review = applyManualReviewPatch(review, {
  items: { signatures: { status: 'issue', note: 'Thiếu chữ ký điều dưỡng.' } },
}, '2026-09-29T00:01:00.000Z');
const summary = manualReviewSummary(review);
assert.strictEqual(summary.complete, true);
assert.strictEqual(summary.passed, false);
assert.strictEqual(summary.issue_count, 1);
assert.strictEqual(manualReviewIssues(review)[0].detail, 'Thiếu chữ ký điều dưỡng.');

const refreshed = manualReviewSummary(review, { fetched: { discharge:'2026-09-29T00:02:00.000Z' } });
assert.strictEqual(refreshed.stale_count, REVIEW_ITEMS.length);
assert.strictEqual(refreshed.remaining_count, REVIEW_ITEMS.length);
assert.strictEqual(refreshed.passed, false);

const rechecked = applyManualReviewPatch(review, {
  items: { signatures: { status:'pass', note:'' } },
}, '2026-09-29T00:03:00.000Z');
const afterRecheck = manualReviewSummary(rechecked, { fetched: { discharge:'2026-09-29T00:02:00.000Z' } });
assert.strictEqual(afterRecheck.rows.find(row => row.key === 'signatures').stale, false);

console.log('hchanh_manual_review_test: ok');
