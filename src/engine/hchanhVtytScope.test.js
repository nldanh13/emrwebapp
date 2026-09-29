import { describe, expect, it } from 'vitest';
import { buildVtytReviewWindow } from './hchanhVtytScope.js';

describe('buildVtytReviewWindow', () => {
  it('reviews the whole admission for a discharged patient', () => {
    const result = buildVtytReviewWindow({
      ma_bn:'01', scope:'discharge', admission_time:'27/09/2026 08:00',
      profile:{ ngay_ra_vien:'29/09/2026 10:00' },
    }, { from:'2026-09-29', to:'2026-09-29' });
    expect(result).toMatchObject({ mode:'full_episode', from:'27/09/2026', to:'29/09/2026', error:'' });
    expect(result.dates).toEqual(['27/09/2026', '28/09/2026', '29/09/2026']);
  });

  it('reviews only the next day for a patient who continues treatment', () => {
    const result = buildVtytReviewWindow({ ma_bn:'02', scope:'daily' }, { from:'2026-09-29', to:'2026-09-29' });
    expect(result).toMatchObject({ mode:'next_day', from:'30/09/2026', to:'30/09/2026', dates:['30/09/2026'] });
  });

  it('does not silently shorten a discharge review when episode dates are missing', () => {
    const result = buildVtytReviewWindow({ ma_bn:'03', scope:'discharge', admission_time:'27/09/2026' }, { from:'2026-09-29' });
    expect(result.dates).toEqual([]);
    expect(result.error).toContain('Thiếu ngày');
  });
});
