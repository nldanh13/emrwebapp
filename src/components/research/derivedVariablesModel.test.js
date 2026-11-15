import { describe, expect, it } from 'vitest';
import { draftKey, emptyDerived, mergeCopiedDerived, sourceColumnOptions, toDraft } from './derivedVariablesModel.js';

describe('derivedVariablesModel', () => {
  it('cột nguồn: cột chung + biến đã chọn + biến tự định nghĩa đứng trước, không lặp', () => {
    const stats = [
      { id: 'a', output_column: 'can_nang', survey_label: 'Cân nặng' },
      { id: 'derived:bmi', output_column: 'bmi', survey_label: 'BMI' },
      { id: 'b', output_column: 'age', survey_label: 'Tuổi' },
    ];
    const drafts = [{ name: 'bmi', label: 'BMI' }, { name: 'nhom_bmi', label: 'Nhóm BMI' }];
    const first = sourceColumnOptions(stats, drafts, 0).map(o => o.value);
    expect(first).toContain('can_nang');
    expect(first).not.toContain('bmi');
    expect(first.filter(v => v === 'age')).toHaveLength(1);
    expect(sourceColumnOptions(stats, drafts, 1).map(o => o.value)).toContain('bmi');
  });

  it('định nghĩa đã lưu dạng mảng → ô nhập dạng "a; b"', () => {
    const d = toDraft({ name: 'n', label: 'N', kind: 'cut', params: { source: 'age', breaks: [60, 80], labels: ['<60', '60-79', '≥80'] } });
    expect(d.params.breaks).toBe('60; 80');
    expect(d.params.labels).toBe('<60; 60-79; ≥80');
    expect(emptyDerived('keyword_group', 2).params.rules).toHaveLength(1);
  });

  it('chép từ nghiên cứu khác bỏ biến trùng tên', () => {
    const cur = [toDraft({ name: 'bmi', label: 'BMI', kind: 'formula', params: { expression: 'a' } })];
    const r = mergeCopiedDerived(cur, [
      { name: 'bmi', label: 'BMI khác', kind: 'formula', params: { expression: 'b' } },
      { name: 'vas_n1', label: 'VAS N1', kind: 'note_number', params: { keyword: 'VAS', day: 1 } },
    ]);
    expect(r.added).toBe(1);
    expect(r.skipped).toBe(1);
    expect(r.list.map(d => d.name)).toEqual(['bmi', 'vas_n1']);
    expect(draftKey(r.list)).not.toBe(draftKey(cur));
  });
});
