import { describe, it, expect } from 'vitest';
import { encounterPeriod, countOutsideStay } from './encounterPeriod.js';

describe('encounterPeriod', () => {
  it('đặt nhãn rõ cho dòng trước nhập viện / Cấp cứu / sau ra viện', () => {
    expect(encounterPeriod({ encounter_match_method: 'pre_admission' })).toMatchObject({ label: 'Trước nhập viện', outside: true });
    expect(encounterPeriod({ encounter_match_method: 'post_discharge' })).toMatchObject({ label: 'Sau ra viện', outside: true });
    expect(encounterPeriod({ encounter_match_method: 'emergency_before_ward' }).label).toBe('Cấp cứu, trước vào khoa');
    expect(encounterPeriod({ encounter_match_method: 'event_date_range' }).label).toBe('Trong đợt');
  });
  it('đếm dòng ngoài khoảng nằm viện của một đợt', () => {
    const enc = { labs: [{ encounter_match_method: 'pre_admission' }, {}], medications: [{ encounter_match_method: 'post_discharge' }] };
    expect(countOutsideStay(enc)).toBe(2);
  });
});
