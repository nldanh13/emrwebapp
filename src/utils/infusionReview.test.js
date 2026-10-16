import { describe, expect, it } from 'vitest';
import { infusionReview, groupInfusionRows } from './infusionReview.js';

describe('infusion review safeguards', () => {
  it('distinguishes the original time from the next-day calculated start', () => {
    const row = infusionReview({
      gio_dung: '23 giờ', tg_bat_dau: '00:06 16/10/2026',
      tg_ket_thuc: '01:13 16/10/2026',
      the_tich: 100, toc_do: 30,
    }, '15/10/2026');
    expect(row.orderTime).toBe('23 giờ');
    expect(row.scheduled).toBe('00:06 16/10/2026');
    expect(row.otherDay).toBe(true);
  });

  it('shows inferred drip rates and stale times as requiring review', () => {
    const row = infusionReview({
      gio_dung: '8 giờ', tg_bat_dau: '08:00 15/10/2026',
      toc_do: 30, toc_do_inferred: true, infusion_schedule_stale: true,
    }, '15/10/2026');
    expect(row.needsReview).toBe(true);
    expect(row.concerns).toHaveLength(2);
  });

  it('separates infusions missing a start time from calculated infusions', () => {
    const groups = groupInfusionRows([
      {ten_thuoc: 'TEST-NO-TIME', missing_infusion_time: true},
      {ten_thuoc: 'TEST-WITH-TIME', tg_bat_dau: '09:26 15/10/2026'},
    ], '15/10/2026');
    expect(groups.unresolved).toHaveLength(1);
    expect(groups.scheduled).toHaveLength(1);
    expect(groups.unresolved[0].review.needsReview).toBe(true);
    const missingRate = infusionReview({ missing_infusion_rate: true, the_tich: 100 });
    expect(missingRate.concerns.join(' ')).toMatch(/tốc độ/);
  });
});
