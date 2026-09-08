import { describe, expect, it } from 'vitest';
import { formatPersonName } from './personName.js';

describe('formatPersonName', () => {
  it('collapses whitespace/newlines', () => {
    expect(formatPersonName('  Nguyễn\n  Văn   A  ')).toBe('Nguyễn Văn A');
  });

  it('strips a trailing "- PM: ..." room annotation', () => {
    expect(formatPersonName('Nguyễn Văn A - PM: PHÒNG KHÁM')).toBe('Nguyễn Văn A');
  });

  it('falls back to the given fallback for empty input', () => {
    expect(formatPersonName('')).toBe('—');
    expect(formatPersonName(null, 'Chưa có tên')).toBe('Chưa có tên');
  });

  it('does not fall back when the name survives suffix-stripping', () => {
    expect(formatPersonName('Trần Thị B')).toBe('Trần Thị B');
  });
});
