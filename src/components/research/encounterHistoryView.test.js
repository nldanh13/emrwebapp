import { describe, expect, it } from 'vitest';
import { needsPeriodColumn, pivotLabRows, shortWhen, surgeryTimeRange, surgeryIcd, matchReasonLabel } from './encounterHistoryView.js';

describe('thẻ đợt điều trị gọn', () => {
  it('xét nghiệm thành bảng chỉ số × thời điểm', () => {
    const rows = [
      { lab_datetime: '2026-07-06 08:47', test_name_raw: 'WBC', result_raw: '7.54', unit: '10^9/L' },
      { lab_datetime: '2026-07-06 08:47', test_name_raw: 'HGB', result_raw: '14.4', unit: 'g/dL' },
      { lab_datetime: '2026-07-08 06:00', test_name_raw: 'WBC', result_raw: '9.1', unit: '10^9/L' },
    ];
    const p = pivotLabRows(rows);
    expect(p.columns.map(c => c.label)).toEqual(['06/07 08:47', '08/07 06:00']);
    expect(p.rows).toHaveLength(2);
    const wbc = p.rows.find(r => r.name === 'WBC');
    expect(wbc.values['2026-07-06 08:47']).toBe('7.54');
    expect(wbc.values['2026-07-08 06:00']).toBe('9.1');
  });

  it('chỉ hiện cột Giai đoạn khi có dòng ngoài đợt', () => {
    expect(needsPeriodColumn([{ encounter_match_method: 'event_date_range' }])).toBe(false);
    expect(needsPeriodColumn([{ encounter_match_method: 'pre_admission' }])).toBe(true);
    const p = pivotLabRows([{ lab_datetime: '2026-07-01 07:00', test_name_raw: 'CRP', result_raw: '5', encounter_match_method: 'pre_admission' }]);
    expect(p.columns[0].outside).toBe(true);
  });

  it('thời gian mổ, ICD và lý do chưa ghép đọc được', () => {
    expect(shortWhen('2026-01-15')).toBe('15/01');
    expect(surgeryTimeRange({ surgery_datetime: '2026-01-15 13:30', surgery_end_datetime: '2026-01-15 14:40' })).toBe('15/01 13:30 – 14:40');
    expect(surgeryTimeRange({ surgery_date: '2026-10-05' })).toBe('05/10 (chưa rõ giờ)');
    expect(surgeryIcd({ preop_icd10: 'A41', postop_icd10: 'A41' })).toBe('A41');
    expect(surgeryIcd({ preop_icd10: 'A41', postop_icd10: 'T81' })).toBe('A41 → T81');
    expect(matchReasonLabel('encounter_match_outside_time')).toBe('thời gian nằm ngoài mọi đợt đã có');
  });
});
