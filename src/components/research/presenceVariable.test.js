// "Dùng hoạt chất: X" chọn làm biến: mặc định xuất Có/Không, và bước 4 gợi ý dùng làm tiêu chuẩn chọn vào.
import { describe, it, expect } from 'vitest';
import { defaultAggregationFor, isPresenceVariable } from './variableCatalogModel.js';
import { readinessItems } from './studyReadiness.jsx';
import { describeStats } from './researchStats.jsx';

const zol = { id: 'medication_orders.virtual.active_ingredient.abc', name: 'ingredient:Acid Zoledronic', display_label: 'Dùng hoạt chất: Acid Zoledronic', virtual_kind: 'active_ingredient', table: 'medication_orders' };
const summary = { total: 3016, cohort: { patients: 1389 }, variables: [{ survey_label: 'Dùng hoạt chất: Acid Zoledronic', fill_rate: 100, aggregation: 'any' }] };

describe('biến có/không', () => {
  it('mặc định "Có / không" cho biến dẫn xuất kiểu dùng thuốc/hoạt chất, giữ "Liệt kê" cho biến thường', () => {
    expect(isPresenceVariable(zol)).toBe(true);
    expect(defaultAggregationFor(zol)).toBe('any');
    expect(defaultAggregationFor({ virtual_kind: 'lab_item' })).toBe('list');
    expect(defaultAggregationFor({ name: 'age' })).toBe('list');
  });

  it('chưa có tiêu chuẩn chọn vào mà đã chọn "Dùng hoạt chất" làm biến → gợi ý một nút dùng làm tiêu chuẩn chọn vào', () => {
    const items = readinessItems({ summary, roleOf: () => '', presenceVariables: [zol] });
    const fix = items.find(i => i.fix);
    expect(fix.status).toBe('bad');
    expect(fix.text).toContain('Dùng hoạt chất: Acid Zoledronic');
    expect(fix.fix).toEqual({ kind: 'include_condition', variable: zol, label: 'Dùng làm tiêu chuẩn chọn vào' });
    const withCondition = readinessItems({ summary, roleOf: () => '', conditions: [{ variable_id: zol.id }], presenceVariables: [] });
    expect(withCondition.some(i => i.fix)).toBe(false);
  });

  it('đo lường của biến Có/Không ghi rõ số lượt có và không', () => {
    const stats = { n: 3016, kind: 'category', top: [{ value: '0', count: 2936, pct: 97.3 }, { value: '1', count: 80, pct: 2.7 }] };
    const text = describeStats(stats, { aggregation: 'any' });
    expect(text).toMatch(/^Có \(1\): 80 lượt, 2,7% · Không \(0\): 2\.936 lượt, 97,3%$/);
  });
});
