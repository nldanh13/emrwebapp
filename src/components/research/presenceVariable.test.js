// "Dùng hoạt chất: X" chọn làm biến: mặc định xuất Có/Không, và bước 4 gợi ý dùng làm tiêu chuẩn chọn vào.
import { describe, it, expect } from 'vitest';
import { clinicalInfoForVariable, defaultAggregationFor, enhanceCatalogVariable, isPresenceVariable, matchesCatalogQuery } from './variableCatalogModel.js';
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


describe('biến sinh hiệu lúc vào viện', () => {
  const weight = enhanceCatalogVariable({
    id: 'analysis_ready.admission_weight_kg',
    table: 'analysis_ready',
    table_label: 'Bảng tổng quát',
    name: 'admission_weight_kg',
    label: 'admission_weight_kg',
  }, { key: 'analysis_ready', label: 'Bảng tổng quát' });
  const height = enhanceCatalogVariable({
    id: 'analysis_ready.admission_height_cm',
    table: 'analysis_ready',
    table_label: 'Bảng tổng quát',
    name: 'admission_height_cm',
    label: 'admission_height_cm',
  }, { key: 'analysis_ready', label: 'Bảng tổng quát' });

  it('hiển thị tên tiếng Việt và tìm được bằng từ khóa có dấu hoặc không dấu', () => {
    expect(weight.display_label).toBe('Cân nặng vào viện (kg)');
    expect(height.display_label).toBe('Chiều cao vào viện (cm)');
    expect(matchesCatalogQuery(weight, 'cân nặng')).toBe(true);
    expect(matchesCatalogQuery(height, 'chieu cao')).toBe(true);
  });

  it('xếp cân nặng và chiều cao vào nhóm biến nền', () => {
    expect(weight.role).toBe('baseline');
    expect(height.role).toBe('baseline');
  });
});


describe('danh mục xét nghiệm', () => {
  const lymphocyte = enhanceCatalogVariable({
    id: 'lab_results.virtual.lym',
    table: 'lab_results',
    table_label: 'Xét nghiệm',
    name: 'lab:lymphocyte',
    label: 'LYM',
    virtual_kind: 'lab_test',
    source_filter: { test_name_norm: 'lymphocyte', unit: '10^9/L' },
    lab_group: 'Huyết học',
  }, { key: 'lab_results', label: 'Xét nghiệm' });

  it('dùng nhãn chuẩn có đơn vị nhưng vẫn giữ nguyên khóa và nguồn lọc', () => {
    expect(lymphocyte.display_label).toBe('Lymphocyte tuyệt đối (LYM) (10^9/L)');
    expect(lymphocyte.source_filter.test_name_norm).toBe('lymphocyte');
    expect(lymphocyte.source_filter.unit).toBe('10^9/L');
  });

  it('ghi rõ MONO% và phân biệt kết quả tuyệt đối', () => {
    const monoPercent = enhanceCatalogVariable({
      id: 'lab_results.virtual.mono.percent',
      table: 'lab_results',
      table_label: 'Xét nghiệm',
      name: 'lab:monocyte',
      label: 'MONO%',
      virtual_kind: 'lab_test',
      source_filter: { test_name_norm: 'monocyte', unit: '%', lab_measurement_kind: 'percent' },
      lab_group: 'Huyết học',
    }, { key: 'lab_results', label: 'Xét nghiệm' });
    const monoAbsolute = enhanceCatalogVariable({
      id: 'lab_results.virtual.mono.absolute',
      table: 'lab_results',
      table_label: 'Xét nghiệm',
      name: 'lab:monocyte',
      label: 'MONO',
      virtual_kind: 'lab_test',
      source_filter: { test_name_norm: 'monocyte', unit: '10^9/L', lab_measurement_kind: 'absolute' },
      lab_group: 'Huyết học',
    }, { key: 'lab_results', label: 'Xét nghiệm' });
    expect(monoPercent.display_label).toBe('Monocyte (MONO%)');
    expect(monoAbsolute.display_label).toBe('Monocyte tuyệt đối (MONO) (10^9/L)');
  });

  it('xếp theo nhóm xét nghiệm lấy từ EMR, kể cả tên có dấu tiếng Việt', () => {
    expect(clinicalInfoForVariable(lymphocyte).section).toBe('Xét nghiệm · Huyết học');
    const chemistry = enhanceCatalogVariable({
      id: 'lab_results.virtual.chem',
      table: 'lab_results',
      table_label: 'Xét nghiệm',
      name: 'lab:unmapped_test',
      label: 'Tên xét nghiệm lạ',
      virtual_kind: 'lab_test',
      source_filter: { test_name_norm: 'unmapped_test', unit: 'mmol/L' },
      lab_group: 'Sinh hóa',
    }, { key: 'lab_results', label: 'Xét nghiệm' });
    expect(clinicalInfoForVariable(chemistry).section).toBe('Xét nghiệm · Sinh hóa');
  });
});
