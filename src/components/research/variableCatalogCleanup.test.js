import { describe, expect, it } from 'vitest';
import { browsableCatalogVariables, enhanceCatalogVariable, isSearchOnlyVariable } from './variableCatalogModel.js';

// Ảnh 15/11/2026: nhóm Phẫu thuật/thủ thuật 158 biến, nhiều tên tiếng Anh (Encounter Match Method,
// Primary Surgeon, Cost Copay…), biến lặp 100%/73%, XN hòa hợp truyền máu lẫn vào Phẫu thuật.
const v = (table, name, extra = {}) => enhanceCatalogVariable({ id: `${table}.${name}`, table, name, label: name, ...extra }, { key: table, label: table });

describe('dọn danh mục biến', () => {
  it('tên cột tiếng Anh hiện tiếng Việt', () => {
    expect(v('surgery_results', 'surgery_class').display_label).toBe('Phân loại phẫu thuật');
    expect(v('analysis_ready', 'cost_copay').display_label).toBe('BHYT chi trả');
    expect(v('analysis_ready', 'consult_count').display_label).toBe('Số lần hội chẩn');
    expect(v('surgery_results', 'postop_comorbidities').display_label).toBe('Bệnh kèm sau phẫu thuật');
  });

  it('ẩn cột kỹ thuật và tên nhân viên y tế', () => {
    for (const name of ['encounter_match_method', 'encounter_match_status', 'is_within_encounter', 'source', 'surgery_time_source', 'surgery_date_ref', 'parser_confidence']) {
      expect(v('surgery_results', name).technical_or_identity, name).toBe(true);
    }
    for (const name of ['primary_surgeon', 'assistant_surgeon_1', 'scrub_nurse', 'anesthesia_technician', 'completed_by', 'primary_anesthesiologist']) {
      expect(v('surgery_results', name).technical_or_identity, name).toBe(true);
    }
    expect(v('surgery_results', 'surgery_method').technical_or_identity).toBe(false);
  });

  it('chi phí, hội chẩn có nhóm riêng; cột chung của bảng XN không vào Phẫu thuật', () => {
    expect(v('analysis_ready', 'cost_actual_collected').clinical_group_key).toBe('cost');
    expect(v('analysis_ready', 'consult_conclusions').clinical_group_key).toBe('consult');
    expect(v('lab_results', 'days_from_surgery').clinical_group_key).toBe('lab');
    const crossmatch = v('lab_results', 'lab:phan_ung_hoa_hop', { label: 'Phản ứng hòa hợp có sử dụng kháng globulin người (kỹ thuật Scangel)', virtual_kind: 'lab_test' });
    expect(crossmatch.clinical_group_key).toBe('lab');
  });

  it('cùng nhãn ở hai bảng ghi rõ phạm vi; biến từng tên mổ chỉ hiện khi tìm', () => {
    const list = browsableCatalogVariables([
      v('analysis_ready', 'surgery_date'),
      v('surgery_results', 'surgery_date'),
      v('surgery_results', 'primary_surgeon'),
      v('surgery_results', 'procedure:Thay khớp háng', { label: 'Phẫu thuật/TT: Thay khớp háng', virtual_kind: 'procedure_item' }),
    ]);
    const labels = list.map(x => x.display_label);
    expect(labels).toContain('Ngày phẫu thuật (theo đợt)');
    expect(labels).toContain('Ngày phẫu thuật (từng ca mổ)');
    expect(labels.some(l => /Phẫu thuật viên/.test(l))).toBe(false);
    expect(list.filter(isSearchOnlyVariable)).toHaveLength(1);
  });
});
