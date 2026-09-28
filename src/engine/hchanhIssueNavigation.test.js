import { describe, expect, it } from 'vitest';
import { getHchanhIssueTarget } from './hchanhIssueNavigation.js';

describe('getHchanhIssueTarget', () => {
  it.each([
    ['Kiểm thủ công', 'MANUAL_REVIEW_SIGNATURES', 'checklist'],
    ['Y lệnh', 'ORDER_INCOMPLETE', 'order_history'],
    ['Phẫu thuật/thủ thuật', 'SURGERY_METHOD_MISSING', 'surgery'],
    ['Chẩn đoán ↔ PT/TT', 'BHYT_DIAGNOSIS_SURGERY', 'surgery'],
    ['Tiền giường', 'BED_DAYS_SHORT', 'bed_days'],
    ['Bảng kê', 'BILLING_EMPTY', 'billing'],
    ['Thẻ BHYT', 'BHYT_EXPIRED', 'billing'],
    ['Chuyên khoa/VTYT', 'SPECIALTY_SUPPLY_MISSING', 'billing'],
    ['Thuốc', 'DRUG_TIMING', 'billing'],
    ['Ra viện', 'DISCHARGE_ADVICE_MISSING', 'discharge'],
    ['Tái khám', 'FOLLOWUP_TIME_MISSING', 'discharge'],
    ['Thông tin nền', 'PROFILE_NAME_MISSING', 'fetch'],
  ])('maps %s to %s', (group, code, expectedTab) => {
    expect(getHchanhIssueTarget({ group, code })?.tab).toBe(expectedTab);
  });

  it('leaves an unknown group without a misleading destination', () => {
    expect(getHchanhIssueTarget({ group:'Khác', code:'UNKNOWN' })).toBeNull();
  });
});
