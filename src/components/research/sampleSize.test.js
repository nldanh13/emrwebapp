import { describe, expect, it } from 'vitest';
import { computeSampleSize, normalQuantile } from './sampleSize.js';

describe('cỡ mẫu', () => {
  it('phân vị chuẩn', () => {
    expect(normalQuantile(0.975)).toBeCloseTo(1.95996, 4);
    expect(normalQuantile(0.8)).toBeCloseTo(0.84162, 4);
  });
  it('ước lượng một tỉ lệ: p=0,5, d=0,05 → 385 (không hao hụt)', () => {
    expect(computeSampleSize({ design: 'prop_one', p: 0.5, d: 0.05, dropout: 0 }).n).toBe(385);
  });
  it('cộng hao hụt 10%', () => {
    expect(computeSampleSize({ design: 'prop_one', p: 0.5, d: 0.05, dropout: 10 }).n).toBe(Math.ceil(384.146 / 0.9));
  });
  it('so sánh hai trung bình: σ=10, Δ=5 → 63 mỗi nhóm', () => {
    const r = computeSampleSize({ design: 'two_means', sd: 10, delta: 5, power: 0.8, ratio: 1, dropout: 0 });
    expect(r.groups).toEqual([63, 63]);
    expect(r.n).toBe(126);
  });
  it('so sánh hai tỉ lệ: 0,3 vs 0,2 → 294 mỗi nhóm (Fleiss, không hiệu chỉnh liên tục)', () => {
    const r = computeSampleSize({ design: 'two_props', p1: 0.3, p2: 0.2, power: 0.8, ratio: 1, dropout: 0 });
    expect(r.groups[0]).toBe(294);
  });
  it('trước – sau: σd=10, Δ=5 → 32', () => {
    expect(computeSampleSize({ design: 'paired_means', sd_diff: 10, delta: 5, power: 0.8, dropout: 0 }).n).toBe(32);
  });
  it('tương quan r=0,3 → 85', () => {
    expect(computeSampleSize({ design: 'correlation', r: 0.3, power: 0.8, dropout: 0 }).n).toBe(85);
  });
  it('thiếu thông số thì báo lỗi', () => {
    expect(computeSampleSize({ design: 'prop_one', p: '', d: 0.05 }).error).toBeTruthy();
  });
});
