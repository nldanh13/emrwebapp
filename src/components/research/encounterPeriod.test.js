import { describe, it, expect } from 'vitest';
import { encounterPeriod, countOutsideStay, medicationRouteLabel } from './encounterPeriod.js';

describe('encounterPeriod', () => {
  it('đặt nhãn rõ cho dòng trước nhập viện / Cấp cứu', () => {
    expect(encounterPeriod({ encounter_match_method: 'pre_admission' })).toMatchObject({ label: 'Trước nhập viện', outside: true });
    expect(encounterPeriod({ encounter_match_method: 'emergency_before_ward' }).label).toBe('Cấp cứu, trước vào khoa');
    expect(encounterPeriod({ encounter_match_method: 'event_date_range' }).label).toBe('Trong đợt');
  });
  it('đếm dòng ngoài khoảng nằm viện của một đợt', () => {
    const enc = { labs: [{ encounter_match_method: 'pre_admission' }, {}], medications: [{ encounter_match_method: 'pre_admission' }] };
    expect(countOutsideStay(enc)).toBe(2);
  });
  it('đường dùng hiện bằng chữ đã chuẩn hóa, không hiện mã "(u)"', () => {
    expect(medicationRouteLabel({ route_raw: '(u)', route_norm: 'uống' })).toBe('uống');
    expect(medicationRouteLabel({ route_raw: '(ttm)', route_norm: 'truyền_tĩnh_mạch' })).toBe('truyền tĩnh mạch');
    expect(medicationRouteLabel({ route_raw: 'xịt', route_norm: '' })).toBe('xịt');
  });
});
