import { describe, it, expect } from 'vitest';
import { auditVerdictLabel, groupAuditItems, auditProgress, formatAccuracy } from './auditSampleModel.js';

describe('auditSampleModel', () => {
  it('nhãn tiếng Việt cho kết quả kiểm', () => {
    expect(auditVerdictLabel('dung')).toBe('Đúng');
    expect(auditVerdictLabel('sai')).toBe('Sai');
    expect(auditVerdictLabel('khong_chac')).toBe('Không chắc');
  });

  it('nhóm mục theo thứ tự: mốc đợt, XN, CĐHA, thuốc, PT, dòng không gắn; bỏ nhóm trống', () => {
    const groups = groupAuditItems([{ id: 'u', group: 'unassigned' }, { id: 'a', group: 'encounter' }, { id: 'l', group: 'labs' }]);
    expect(groups.map(g => g.group)).toEqual(['encounter', 'labs', 'unassigned']);
  });

  it('tiến độ một ca và trạng thái xong', () => {
    expect(auditProgress({ items: [{ verdict: 'dung' }, { verdict: 'sai' }, { verdict: '' }] })).toEqual({ total: 3, reviewed: 2, sai: 1, done: false });
    expect(auditProgress({ items: [{ verdict: 'dung' }] }).done).toBe(true);
  });

  it('tỉ lệ đạt kèm khoảng tin cậy, chưa kiểm thì hiện gạch', () => {
    expect(formatAccuracy({ accuracy: 0.95, ci95: { low: 0.751, high: 0.999 } })).toBe('95,0% (75,1%–99,9%)');
    expect(formatAccuracy({ accuracy: null })).toBe('—');
  });
});
