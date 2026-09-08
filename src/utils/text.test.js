import { describe, expect, it } from 'vitest';
import {
  includesAny,
  normalizeName,
  normalizeRoom,
  normalizeText,
  safeText,
  toNumber,
} from './text.js';

describe('normalizeText', () => {
  it('strips Vietnamese diacritics, lowercases, and collapses whitespace', () => {
    expect(normalizeText('  Đang   Thực  Hiện  ')).toBe('dang thuc hien');
  });

  it('returns empty string for nullish input', () => {
    expect(normalizeText(null)).toBe('');
    expect(normalizeText(undefined)).toBe('');
  });
});

describe('normalizeName', () => {
  it('lowercases and collapses whitespace but keeps diacritics', () => {
    expect(normalizeName('  Trần   Quang Sơn ')).toBe('trần quang sơn');
  });
});

describe('includesAny', () => {
  it('matches case- and accent-insensitively against a keyword list', () => {
    expect(includesAny('Bệnh nhân ĐANG THỰC HIỆN thủ thuật', ['dang thuc hien'])).toBe(true);
  });

  it('returns false when no keyword matches', () => {
    expect(includesAny('Chờ khám', ['hoan tat', 'da tat toan'])).toBe(false);
  });
});

describe('toNumber', () => {
  it('parses numbers with thousands separators', () => {
    expect(toNumber('1, 234')).toBe(1234);
  });

  it('falls back on unparsable input', () => {
    expect(toNumber('abc', -1)).toBe(-1);
    expect(toNumber(undefined)).toBe(0);
  });
});

describe('normalizeRoom', () => {
  it('extracts and zero-pads a room number', () => {
    expect(normalizeRoom('P9')).toBe('P09');
    expect(normalizeRoom('Phòng 09')).toBe('P09');
    expect(normalizeRoom('Giường 3')).toBe('P03');
  });

  it('returns empty string when no digits are present', () => {
    expect(normalizeRoom('')).toBe('');
    expect(normalizeRoom('Phòng khám')).toBe('');
  });
});

describe('safeText', () => {
  it('collapses internal whitespace and trims', () => {
    expect(safeText('  a   b\n c  ')).toBe('a b c');
  });
});
