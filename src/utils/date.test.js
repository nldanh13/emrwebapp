import { describe, expect, it } from 'vitest';
import {
  addDays,
  diffCalendarDays,
  formatVNDateTime,
  inclusiveTreatmentDays,
  parseVNDateTime,
} from './date.js';

describe('parseVNDateTime', () => {
  it('parses "HH:MM DD/MM/YYYY" into a Date', () => {
    const d = parseVNDateTime('08:05 20/07/2026');
    expect(d.getFullYear()).toBe(2026);
    expect(d.getMonth()).toBe(6); // July -> index 6
    expect(d.getDate()).toBe(20);
    expect(d.getHours()).toBe(8);
    expect(d.getMinutes()).toBe(5);
  });

  it('returns null for malformed or reordered input', () => {
    expect(parseVNDateTime('')).toBeNull();
    expect(parseVNDateTime('20/07/2026 08:05')).toBeNull();
    expect(parseVNDateTime('20/07/2026')).toBeNull();
    expect(parseVNDateTime('not a date')).toBeNull();
  });
});

describe('formatVNDateTime', () => {
  it('formats a Date back into "HH:MM DD/MM/YYYY"', () => {
    const d = new Date(2026, 6, 20, 8, 5);
    expect(formatVNDateTime(d)).toBe('08:05 20/07/2026');
  });

  it('overrides hour/minute without mutating the caller-visible date fields', () => {
    const d = new Date(2026, 6, 20, 8, 5);
    expect(formatVNDateTime(d, 23, 59)).toBe('23:59 20/07/2026');
  });

  it('returns empty string for an invalid date', () => {
    expect(formatVNDateTime(new Date('invalid'))).toBe('');
    expect(formatVNDateTime(null)).toBe('');
  });
});

describe('addDays', () => {
  it('adds days without mutating the input date', () => {
    const original = new Date(2026, 6, 20);
    const result = addDays(original, 3);
    expect(result.getDate()).toBe(23);
    expect(original.getDate()).toBe(20);
  });

  it('supports negative offsets', () => {
    const result = addDays(new Date(2026, 6, 1), -1);
    expect(result.getMonth()).toBe(5);
    expect(result.getDate()).toBe(30);
  });
});

describe('diffCalendarDays', () => {
  it('counts calendar days, ignoring time-of-day', () => {
    const from = new Date(2026, 6, 20, 23, 59);
    const to = new Date(2026, 6, 22, 0, 1);
    expect(diffCalendarDays(from, to)).toBe(2);
  });

  it('returns null when either bound is missing', () => {
    expect(diffCalendarDays(null, new Date())).toBeNull();
    expect(diffCalendarDays(new Date(), null)).toBeNull();
  });
});

describe('inclusiveTreatmentDays', () => {
  it('is at least 1 day for a same-day range', () => {
    const d = new Date(2026, 6, 20);
    expect(inclusiveTreatmentDays(d, d)).toBe(1);
  });

  it('returns null if "to" is before "from" (never invents a positive count)', () => {
    const from = new Date(2026, 6, 20);
    const to = new Date(2026, 6, 19);
    expect(inclusiveTreatmentDays(from, to)).toBeNull();
  });
});
