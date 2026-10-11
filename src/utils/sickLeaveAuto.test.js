import { describe, expect, it } from 'vitest';
import { countGroups, listByDoc, recordGroup, runSummaryLines } from './sickLeaveAuto.js';

// Dữ liệu giả.
const rec = (id, over = {}) => ({
  id, doc_type: 'GRV03', source_file: 'EMR-phieu', patient_name: `BN ${id}`, status: 'pending',
  ready: true, issues: [], fields: {}, ...over,
});

describe('recordGroup', () => {
  it('đặt thẻ DN chờ hỏi lên trước, tách không nghỉ và đã nhập', () => {
    expect(recordGroup(rec(1, { ready: false, fields: { hoi_nghi_om: 'can_hoi' } }))).toBe('hoi');
    expect(recordGroup(rec(2, { fields: { hoi_nghi_om: 'khong' }, ready: false }))).toBe('bo');
    expect(recordGroup(rec(3, { status: 'success' }))).toBe('xong');
    expect(recordGroup(rec(4, { status: 'error' }))).toBe('loi');
    expect(recordGroup(rec(5, { ready: false, issues: ['Thiếu khoa'] }))).toBe('loi');
    expect(recordGroup(rec(6))).toBe('cho');
  });
});

describe('listByDoc', () => {
  it('chỉ lấy hồ sơ đọc từ EMR đúng loại giấy, việc cần làm lên trước', () => {
    const list = listByDoc([
      rec(1, { status: 'success' }),
      rec(2, { ready: false, fields: { hoi_nghi_om: 'can_hoi' } }),
      rec(3, { doc_type: 'BHXH07' }),
      rec(4, { source_file: 'file.xlsx' }),
    ], 'GRV03');
    expect(list.map(r => r.id)).toEqual([2, 1]);
    expect(countGroups(list)).toEqual({ hoi: 1, loi: 0, cho: 0, xong: 1, bo: 0 });
  });
});

describe('runSummaryLines', () => {
  it('tóm tắt lượt chạy bằng câu tiếng Việt', () => {
    expect(runSummaryLines({ results: {
      clinic: { skipped: 'Danh sách khám trên EMR chỉ quét được ngày hôm nay.' },
      discharge: { scanned: 5, working_age: 3, found: 2, ask_sick_leave: 1 },
      submit: { count: 1, success: 1, error: 0 },
    } })).toEqual([
      'Phòng khám: Danh sách khám trên EMR chỉ quét được ngày hôm nay.',
      'Ra viện: 5 ca, 3 ca tuổi lao động, đọc được 2 giấy, 1 ca thẻ DN cần hỏi',
      'Nhập cổng: 1/1 hồ sơ thành công',
    ]);
    expect(runSummaryLines({ results: { clinic: { error: 'EMR chậm' } } })).toEqual(['Phòng khám: lỗi, EMR chậm']);
    expect(runSummaryLines(null)).toEqual([]);
  });
});
