import { describe, expect, it } from 'vitest';
import { getManualReviewView, matchesManualReviewFilter, summarizeManualReviews } from './hchanhManualReviewView.js';

describe('manual-review list view', () => {
  it('does not apply to a non-discharge patient', () => {
    expect(getManualReviewView({ scope:'daily' }).state).toBe('na');
  });

  it('shows checklist progress', () => {
    const card = { scope:'discharge', manual_review:{ rows:Array(7).fill({}), remaining_count:3 } };
    expect(getManualReviewView(card)).toMatchObject({ state:'pending', reviewed:4, total:7, label:'Đã kiểm 4/7' });
    expect(matchesManualReviewFilter(card, 'pending')).toBe(true);
  });

  it('does not mark legacy data without a checklist as completed', () => {
    expect(getManualReviewView({ scope:'discharge' })).toMatchObject({ state:'pending', reviewed:0, remaining:7 });
  });

  it('prioritizes items marked for correction', () => {
    const card = { scope:'discharge', manual_review:{ rows:Array(7).fill({}), remaining_count:2, issue_count:1 } };
    expect(getManualReviewView(card)).toMatchObject({ state:'issue', issues:1, label:'Cần sửa 1' });
    expect(matchesManualReviewFilter(card, 'issue')).toBe(true);
    expect(matchesManualReviewFilter(card, 'pending')).toBe(true);
  });

  it('shows stale checks separately', () => {
    const card = { scope:'discharge', manual_review:{ rows:Array(7).fill({}), stale_count:2, remaining_count:2 } };
    expect(getManualReviewView(card).label).toBe('Kiểm lại 2');
  });

  it('recognizes a completed checklist', () => {
    const card = { scope:'discharge', manual_review:{ rows:Array(7).fill({}), remaining_count:0, issue_count:0 } };
    expect(getManualReviewView(card)).toMatchObject({ state:'complete', reviewed:7, label:'Đã kiểm 7/7' });
    expect(matchesManualReviewFilter(card, 'complete')).toBe(true);
  });

  it('summarizes discharge checklists without counting other scopes', () => {
    const rows = Array(7).fill({});
    const summary = summarizeManualReviews([
      { scope:'discharge', manual_review:{ rows, remaining_count:3 } },
      { scope:'discharge', manual_review:{ rows, remaining_count:2, issue_count:1 } },
      { scope:'discharge', manual_review:{ rows, remaining_count:0, issue_count:0 } },
      { scope:'daily' },
    ]);
    expect(summary).toEqual({ total:3, pending:2, issue:1, complete:1 });
  });
});
