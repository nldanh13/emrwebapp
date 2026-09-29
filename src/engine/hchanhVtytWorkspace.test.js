import { describe, expect, it } from 'vitest';
import {
  allocatedByCode, collectionRows, comboAvailability, eligibleInputJobs,
  everyPatientAvailability, infusionSetAudit, missingEveryPatientSupplies,
} from './hchanhVtytWorkspace.js';

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

  it('chỉ bổ sung VTYT chung cho người bệnh còn thiếu', () => {
    const combos = [{ id: 'common', enabled: true, items: [{ code: CODE, name: 'Kim luồn', quantity: 1, every_patient: true }] }];
    const draft = {
      patients: [{ ma_bn: '1' }, { ma_bn: '2' }],
      jobs: [
        { ma_bn: '1', supplies: [{ code: CODE, input_quantity: 1, usage_status: 'planned' }] },
        { ma_bn: '2', supplies: [] },
      ],
    };
    expect(missingEveryPatientSupplies(draft, combos).map(row => row.ma_bn)).toEqual(['2']);
    expect(everyPatientAvailability(draft, combos).ok).toBe(true);
  });

  it('khóa bổ sung VTYT chung nếu tổng nhu cầu vượt tồn', () => {
    const combos = [{ enabled: true, items: [{ code: CODE, name: 'Kim luồn', quantity: 1000, every_patient: true }] }];
    const draft = { patients: [{ ma_bn: '1' }, { ma_bn: '2' }], jobs: [{ ma_bn: '1', supplies: [] }, { ma_bn: '2', supplies: [] }] };
    expect(everyPatientAvailability(draft, combos).ok).toBe(false);
  });

  it('chỉ rõ ngày lệch dây truyền và chấp nhận tổng dư không quá ba', () => {
    const draft = {
      patients:[{ ma_bn:'01', review_mode:'full_episode' }],
      jobs:[
        { ma_bn:'01', ngay_lam:'27/09/2026', original_supplies:[{ code:'VTYT.000004114', quantity:4 }], supplies:[{ code:'VTYT.000004114', required_quantity:3, existing_quantity:4 }] },
        { ma_bn:'01', ngay_lam:'28/09/2026', original_supplies:[{ code:'VTYT.000004114', quantity:2 }], supplies:[{ code:'VTYT.000004114', required_quantity:2, existing_quantity:2 }] },
      ],
    };
    expect(infusionSetAudit(draft, '01')).toMatchObject({ expected:5, actual:6, difference:1, status:'acceptable' });
    expect(infusionSetAudit(draft, '01').mismatches).toEqual([{ date:'27/09/2026', expected:3, actual:4, difference:1 }]);
  });

  it('không chấp nhận thiếu dây truyền', () => {
    const draft = { patients:[{ ma_bn:'01', review_mode:'full_episode' }], jobs:[{
      ma_bn:'01', ngay_lam:'27/09/2026', original_supplies:[{ code:'VTYT.000004114', quantity:2 }],
      supplies:[{ code:'VTYT.000004114', required_quantity:3, existing_quantity:2 }],
    }] };
    expect(infusionSetAudit(draft, '01')).toMatchObject({ difference:-1, status:'missing' });
  });

});
