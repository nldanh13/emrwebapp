import { describe, expect, it } from 'vitest';
import { allocatedByCode, collectionRows, comboAvailability, eligibleInputJobs } from './hchanhVtytWorkspace.js';

const CODE = 'VTYT.000004258';

describe('hchanh VTYT workspace', () => {
  it('không tính dòng đã hủy hoặc đã nhập vào lượng phân bổ', () => {
    const map = allocatedByCode({ jobs: [{ supplies: [
      { code: CODE, input_quantity: 2, selected: true, usage_status: 'used' },
      { code: CODE, input_quantity: 3, selected: true, usage_status: 'cancelled' },
      { code: CODE, input_quantity: 4, selected: true, usage_status: 'entered' },
    ] }] });
    expect(map.get(CODE)).toBe(2);
  });

  it('chỉ đưa vật tư đã sử dụng và chưa nhập vào payload', () => {
    const jobs = eligibleInputJobs({ jobs: [{ ma_bn: '1', supplies: [
      { code: CODE, input_quantity: 1, selected: true, usage_status: 'planned' },
      { code: CODE, input_quantity: 2, selected: true, usage_status: 'used' },
      { code: CODE, input_quantity: 3, selected: true, usage_status: 'used', input_status: 'entered' },
    ] }] });
    expect(jobs).toHaveLength(1);
    expect(jobs[0].supplies).toHaveLength(1);
    expect(jobs[0].supplies[0].input_quantity).toBe(2);
  });

  it('khóa combo khi lượng khả dụng không đủ', () => {
    const combo = { items: [{ code: CODE, quantity: 1558 }] };
    const result = comboAvailability(combo, { jobs: [{ supplies: [{ code: CODE, input_quantity: 1, usage_status: 'used' }] }] });
    expect(result.ok).toBe(false);
    expect(result.details[0].blocked).toBe(true);
  });

  it('tổng hợp danh sách thu thập theo mã vật tư', () => {
    const rows = collectionRows({ jobs: [{ ho_ten: 'A', supplies: [
      { code: CODE, name: 'Kim luồn', input_quantity: 1, selected: true, usage_status: 'planned' },
    ] }, { ho_ten: 'B', supplies: [
      { code: CODE, name: 'Kim luồn', input_quantity: 2, selected: true, usage_status: 'used' },
    ] }] });
    expect(rows[0].quantity).toBe(3);
    expect(rows[0].patients).toEqual(['A', 'B']);
  });
});
