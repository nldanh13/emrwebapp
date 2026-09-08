import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  defaultWorkDateRange,
  dmyToInputDate,
  inputDateToDmy,
  loadWorkDateRange,
  saveWorkDateRange,
  sanitizeWorkDateRange,
  toInputDate,
  workDateRangeLabel,
  workDateRangeToDmy,
} from './workDateRange.js';

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(2026, 6, 20, 10, 0, 0));
  localStorage.clear();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('toInputDate / defaultWorkDateRange', () => {
  it('formats "today" as an ISO yyyy-mm-dd string', () => {
    expect(toInputDate(new Date(2026, 6, 20))).toBe('2026-07-20');
  });

  it('defaults both bounds of the range to today', () => {
    expect(defaultWorkDateRange()).toEqual({ from: '2026-07-20', to: '2026-07-20' });
  });
});

describe('sanitizeWorkDateRange', () => {
  it('falls back to today when the value is missing or malformed', () => {
    expect(sanitizeWorkDateRange(null)).toEqual({ from: '2026-07-20', to: '2026-07-20' });
    expect(sanitizeWorkDateRange({ from: 'not-a-date', to: '2026-07-25' })).toEqual({
      from: '2026-07-20',
      to: '2026-07-25',
    });
  });

  it('swaps the bounds when "from" is after "to"', () => {
    expect(sanitizeWorkDateRange({ from: '2026-07-25', to: '2026-07-20' })).toEqual({
      from: '2026-07-20',
      to: '2026-07-25',
    });
  });

  it('passes through an already-valid range', () => {
    expect(sanitizeWorkDateRange({ from: '2026-07-18', to: '2026-07-22' })).toEqual({
      from: '2026-07-18',
      to: '2026-07-22',
    });
  });
});

describe('inputDateToDmy / dmyToInputDate', () => {
  it('round-trips between ISO and dd/mm/yyyy', () => {
    expect(inputDateToDmy('2026-07-05')).toBe('05/07/2026');
    expect(dmyToInputDate('05/07/2026')).toBe('2026-07-05');
  });

  it('returns empty string for malformed input', () => {
    expect(inputDateToDmy('')).toBe('');
    expect(dmyToInputDate('2026-07-05')).toBe('');
  });
});

describe('workDateRangeToDmy / workDateRangeLabel', () => {
  it('formats a single-day range as one date', () => {
    const range = { from: '2026-07-20', to: '2026-07-20' };
    expect(workDateRangeToDmy(range)).toEqual({ dateFrom: '20/07/2026', dateTo: '20/07/2026' });
    expect(workDateRangeLabel(range)).toBe('20/07/2026');
  });

  it('formats a multi-day range as "from → to"', () => {
    const range = { from: '2026-07-18', to: '2026-07-22' };
    expect(workDateRangeLabel(range)).toBe('18/07/2026 → 22/07/2026');
  });
});

describe('loadWorkDateRange / saveWorkDateRange', () => {
  it('returns today by default when nothing was saved', () => {
    expect(loadWorkDateRange()).toEqual({ from: '2026-07-20', to: '2026-07-20' });
  });

  it('keeps a same-day edit across a reload', () => {
    saveWorkDateRange({ from: '2026-07-15', to: '2026-07-20' });
    expect(loadWorkDateRange()).toEqual({ from: '2026-07-15', to: '2026-07-20' });
  });

  it('resets to today once the saved value is from a previous day', () => {
    saveWorkDateRange({ from: '2026-07-15', to: '2026-07-16' });
    vi.setSystemTime(new Date(2026, 6, 21, 9, 0, 0));
    expect(loadWorkDateRange()).toEqual({ from: '2026-07-21', to: '2026-07-21' });
  });
});
