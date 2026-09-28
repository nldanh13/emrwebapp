function number(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

export function getManualReviewView(card) {
  if ((card?.scope || 'daily') !== 'discharge') {
    return { state:'na', tone:'gray', label:'Không áp dụng', total:0, reviewed:0, remaining:0, issues:0 };
  }

  const review = card?.manual_review || {};
  const rows = Array.isArray(review.rows) ? review.rows : [];
  const total = rows.length || number(review.total_count) || 7;
  if (!card?.manual_review || typeof card.manual_review !== 'object') {
    return { state:'pending', tone:'blue', label:`Đã kiểm 0/${total}`, total, reviewed:0, remaining:total, issues:0 };
  }
  const remaining = number(review.remaining_count) || number(review.pending_count) + number(review.stale_count);
  const issues = number(review.issue_count);
  const reviewed = Math.max(0, total - remaining);

  if (issues > 0) {
    return { state:'issue', tone:'amber', label:`Cần sửa ${issues}`, total, reviewed, remaining, issues };
  }
  if (remaining > 0) {
    const label = number(review.stale_count) > 0
      ? `Kiểm lại ${number(review.stale_count)}`
      : `Đã kiểm ${reviewed}/${total}`;
    return { state:'pending', tone:'blue', label, total, reviewed, remaining, issues };
  }
  return { state:'complete', tone:'green', label:`Đã kiểm ${total}/${total}`, total, reviewed:total, remaining:0, issues:0 };
}

export function matchesManualReviewFilter(card, filter = 'all') {
  if (filter === 'all') return true;
  const view = getManualReviewView(card);
  if (filter === 'pending') return view.state !== 'na' && view.remaining > 0;
  if (filter === 'issue') return view.state !== 'na' && view.issues > 0;
  if (filter === 'complete') return view.state === 'complete';
  return true;
}

export function summarizeManualReviews(cards) {
  const summary = { total:0, pending:0, issue:0, complete:0 };
  for (const card of Array.isArray(cards) ? cards : []) {
    const view = getManualReviewView(card);
    if (view.state === 'na') continue;
    summary.total += 1;
    if (view.remaining > 0) summary.pending += 1;
    if (view.issues > 0) summary.issue += 1;
    if (view.state === 'complete') summary.complete += 1;
  }
  return summary;
}
