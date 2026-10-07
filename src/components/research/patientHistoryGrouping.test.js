import { describe, expect, it } from 'vitest';
import { groupLabRows, groupImagingRows, labGroupLabel, imagingGroupLabel } from './patientHistoryGrouping.js';

describe('patient history clinical grouping', () => {
  it('groups common hematology, coagulation, electrolytes and biochemistry indices', () => {
    const rows = [
      { test_name_raw: 'WBC', test_name_norm: 'wbc' },
      { test_name_raw: 'HGB', test_name_norm: 'hemoglobin' },
      { test_name_raw: 'MCV', test_name_norm: 'mcv' },
      { test_name_raw: 'PLT', test_name_norm: 'platelet' },
      { test_name_raw: 'PT%', test_name_norm: 'pt' },
      { test_name_raw: 'INR', test_name_norm: 'inr' },
      { test_name_raw: 'APTT', test_name_norm: 'aptt' },
      { test_name_raw: 'Điện giải đồ (Na+, K+, Cl-) Na+', test_name_norm: 'dien_giai_do_na_k_cl_na' },
      { test_name_raw: 'Creatinin Huyết thanh', test_name_norm: 'creatinine' },
      { test_name_raw: 'Glucose Huyết thanh', test_name_norm: 'glucose' },
      { test_name_raw: 'AST (GOT)', test_name_norm: 'ast' },
    ];

    expect(labGroupLabel(rows[0])).toBe('Huyết học');
    expect(labGroupLabel(rows[4])).toBe('Đông máu');
    expect(labGroupLabel(rows[7])).toBe('Điện giải');
    expect(labGroupLabel(rows[8])).toBe('Sinh hóa');

    const groups = groupLabRows(rows);
    expect(groups.map(g => [g.label, g.rows.length])).toEqual([
      ['Huyết học', 4],
      ['Đông máu', 3],
      ['Điện giải', 1],
      ['Sinh hóa', 3],
    ]);
  });

  it('prefers the explicit EMR lab group when it is meaningful', () => {
    expect(labGroupLabel({
      lab_group: 'Sinh hóa',
      test_name_raw: 'Một chỉ số lạ',
      test_name_norm: 'mot_chi_so_la',
    })).toBe('Sinh hóa');
  });

  it('groups radiology by modality and keeps x-ray services together', () => {
    const rows = [
      { modality: 'X-quang', service_name_raw: 'Chụp X-quang cột sống thắt lưng thẳng nghiêng' },
      { service_name_raw: 'Chụp X-quang ngực thẳng' },
      { modality: 'Siêu âm', service_name_raw: 'Siêu âm Doppler tim' },
      { service_name_raw: 'Chụp cộng hưởng từ cột sống thắt lưng' },
      { service_name_raw: 'Điện tim thường' },
    ];

    expect(imagingGroupLabel(rows[0])).toBe('X-quang');
    expect(imagingGroupLabel(rows[1])).toBe('X-quang');
    expect(imagingGroupLabel(rows[2])).toBe('Siêu âm');
    expect(imagingGroupLabel(rows[3])).toBe('MRI');
    expect(imagingGroupLabel(rows[4])).toBe('Điện tim / thăm dò chức năng');

    const groups = groupImagingRows(rows);
    expect(groups.map(g => [g.label, g.rows.length])).toEqual([
      ['X-quang', 2],
      ['MRI', 1],
      ['Siêu âm', 1],
      ['Điện tim / thăm dò chức năng', 1],
    ]);
    expect(groups.reduce((n, g) => n + g.rows.length, 0)).toBe(rows.length);
  });
});
