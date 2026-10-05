import { describe, expect, it } from 'vitest';
import { resourceKeyFor } from './resourceConcurrency.js';

describe('resource concurrency routing', () => {
  it('maps board read and save to the same resource', () => {
    expect(resourceKeyFor('/api/data')).toBe('/api/data');
    expect(resourceKeyFor('/api/save')).toBe('/api/data');
  });

  it('maps sick leave row deletion to the imported-list resource', () => {
    expect(resourceKeyFor('/api/sick-leave-import')).toBe('/api/sick-leave-import');
    expect(resourceKeyFor('/api/sick-leave-import/delete-row')).toBe('/api/sick-leave-import');
  });

  it('maps shared catalogs and dynamic mutations to their read resource', () => {
    expect(resourceKeyFor('/api/medication-catalog')).toBe('/api/medication-catalog');
    expect(resourceKeyFor('/api/medication-catalog/abc')).toBe('/api/medication-catalog');
    expect(resourceKeyFor('/api/routes/custom')).toBe('/api/routes');
    expect(resourceKeyFor('/api/vtyt-catalog/item-1')).toBe('/api/vtyt-catalog');
    expect(resourceKeyFor('/api/vtyt-combos/combo-1')).toBe('/api/vtyt-combos');
  });

  it('does not version unrelated APIs', () => {
    expect(resourceKeyFor('/api/health')).toBe('');
    expect(resourceKeyFor('/api/run-details')).toBe('');
  });
});
