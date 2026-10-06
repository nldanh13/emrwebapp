import { describe, it, expect } from 'vitest';
import { dilutionForm, dilutionFromForm, dilutionSummary } from './dilutionRule.js';

describe('quy tắc pha thuốc (form ↔ dữ liệu)', () => {
  it('để trống → xoá quy tắc', () => {
    expect(dilutionFromForm(dilutionForm(null))).toEqual({ value: null });
  });
  it('khứ hồi giữ nguyên', () => {
    const rule = { solvent: 'NACL_0.9', volume_ml: 100, apply: 'infusion_only', note: 'Truyền ≥ 60 phút' };
    expect(dilutionFromForm(dilutionForm(rule))).toEqual({ value: rule });
  });
  it('Không pha bỏ thể tích', () => {
    expect(dilutionFromForm({ dilution_solvent: 'KHONG_PHA', dilution_volume_ml: '100' })).toEqual({ value: { solvent: 'KHONG_PHA' } });
  });
  it('thể tích sai → lỗi tiếng Việt', () => {
    expect(dilutionFromForm({ dilution_solvent: 'GLUCOSE_5', dilution_volume_ml: 'abc' }).error).toMatch(/từ 1 đến 1000/);
  });
  it('chữ tóm tắt cho bảng', () => {
    expect(dilutionSummary({ solvent: 'NACL_0.9', volume_ml: 100, apply: 'always' })).toBe('Natri clorid 0.9% 100 ml');
    expect(dilutionSummary({ solvent: 'GLUCOSE_5', volume_ml: 250, apply: 'infusion_only' })).toBe('Glucose 5% 250 ml · khi truyền');
    expect(dilutionSummary({ solvent: 'KHONG_PHA' })).toBe('Không pha');
    expect(dilutionSummary(undefined)).toBe('');
  });
});
