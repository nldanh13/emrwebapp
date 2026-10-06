import { describe, it, expect } from 'vitest';
import { presentationsForm, presentationsFromForm, volumesText } from './presentations.js';

describe('quy cách khác', () => {
  it('khứ hồi và bỏ dòng trống', () => {
    const med = { default_volume_ml: 100, quy_cach: [{ volume_ml: 500, rate: '40' }] };
    expect(presentationsFromForm([...presentationsForm(med), { volume_ml: '', rate: '' }])).toEqual({ value: [{ volume_ml: 500, rate: '40' }] });
    expect(volumesText(med)).toBe('100 / 500');
  });
  it('thiếu thể tích → lỗi tiếng Việt', () => {
    expect(presentationsFromForm([{ volume_ml: '', rate: '40' }]).error).toMatch(/Quy cách 1: nhập thể tích/);
  });
});
