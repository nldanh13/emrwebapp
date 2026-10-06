// Xuất dữ liệu nghiên cứu: phễu chọn mẫu giải thích số lượt; biến bảng dài mặc định lấy MỘT giá trị
// (gần trước mốc khi có mốc) để file xuất là số, phân tích được ngay.
import { describe, it, expect } from 'vitest';
import { cohortFunnelText } from './StudyStatsView.jsx';
import { aggregationOptions, catalogVariableToSpec, defaultAggregationForStudy, needsAggregationChoice } from './StudyVariableEditor.jsx';

const egfr = { id: 'lab_results.virtual.lab.egfr', table: 'lab_results', name: 'lab:egfr', display_label: 'Độ lọc cầu thận (mL/phút/1.73m²)', type: 'number' };
const age = { id: 'analysis_ready.age', table: 'analysis_ready', name: 'age', display_label: 'Tuổi', type: 'number' };
const zol = { id: 'medication_orders.virtual.active_ingredient.abc', table: 'medication_orders', name: 'ingredient:Acid Zoledronic', display_label: 'Dùng hoạt chất: Acid Zoledronic', virtual_kind: 'active_ingredient' };

describe('phễu chọn mẫu', () => {
  it('86 mẫu → 80 lượt có dữ liệu → điều kiện: còn 77', () => {
    const t = cohortFunnelText(86, [{ label: 'Toàn bộ kho', encounters: 80 }, { label: 'Tuổi ≥ 50', encounters: 77 }]);
    expect(t).toBe('86 mẫu trong danh sách → 80 lượt có dữ liệu → Tuổi ≥ 50: còn 77');
  });
  it('tiêu chuẩn loại trừ ghi rõ "loại"', () => {
    expect(cohortFunnelText(0, [{ label: 'x', encounters: 5 }, { label: 'Có ung thư', encounters: 4, exclude: true }])).toContain('loại Có ung thư: còn 4');
  });
});

describe('cách lấy giá trị của biến', () => {
  it('xét nghiệm: có mốc → gần trước mốc nhất; không mốc → giá trị đầu tiên', () => {
    expect(needsAggregationChoice(egfr)).toBe(true);
    expect(defaultAggregationForStudy(egfr, true)).toBe('closest_before_anchor');
    expect(defaultAggregationForStudy(egfr, false)).toBe('first');
    expect(catalogVariableToSpec(egfr, true).aggregation).toBe('closest_before_anchor');
  });
  it('biến một dòng mỗi lượt và biến có/không: không cần chọn', () => {
    expect(needsAggregationChoice(age)).toBe(false);
    expect(needsAggregationChoice(zol)).toBe(false);
    expect(defaultAggregationForStudy(zol, true)).toBe('any');
  });
  it('chưa đặt mốc thì không đưa lựa chọn theo mốc', () => {
    expect(aggregationOptions(false).map(([k]) => k)).not.toContain('closest_before_anchor');
    expect(aggregationOptions(true).map(([k]) => k)).toContain('closest_before_anchor');
  });
});
