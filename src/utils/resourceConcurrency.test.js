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

  it('does not version unrelated APIs', () => {
    expect(resourceKeyFor('/api/health')).toBe('');
    expect(resourceKeyFor('/api/run-details')).toBe('');
  });
});
