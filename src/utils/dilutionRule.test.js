import { describe, it, expect } from 'vitest';
import { describeCheck, dilutionForm, dilutionFromForm, dilutionSummary } from './dilutionRule.js';

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

describe('kiểm tra thử', () => {
  it('chuyển dịch truyền theo danh mục, có tốc độ', () => {
    const lines = describeCheck({
      moved_to_infusion: true, dung_moi: 'NACL_0.9', the_tich: 250, nguon_pha: 'danh_muc', toc_do: '40', toc_do_nguon: 'danh_muc',
      rule: { solvent: 'NACL_0.9', canonical: 'VECMID', matched_by: 'hoat_chat' }, rule_source: 'danh_muc',
    });
    expect(lines[0]).toBe('Chuyển sang dịch truyền: pha Natri clorid 0.9% 250 ml (theo Danh mục thuốc).');
    expect(lines[1]).toBe('Tốc độ: 40 giọt/phút (theo Danh mục thuốc).');
    expect(lines.at(-1)).toMatch(/VECMID \(khớp theo hoạt chất\)/);
  });
  it('không có quy tắc', () => {
    expect(describeCheck({ moved_to_infusion: false, duong_dung: '', rule: null })).toEqual([
      'Giữ là thuốc tiêm, không tự gắn dung môi.', 'Chưa có quy tắc pha nào cho thuốc này.',
    ]);
  });
  it('tốc độ trong form', () => {
    expect(dilutionFromForm({ dilution_solvent: 'NACL_0.9', dilution_rate: '500' }).error).toMatch(/giọt\/phút/);
    expect(dilutionSummary({ solvent: 'NACL_0.9', volume_ml: 100, rate: 40 })).toBe('Natri clorid 0.9% 100 ml, 40 giọt/phút');
  });
});

describe('nhiều cách pha trong form', () => {
  it('khứ hồi và kiểm điều kiện', () => {
    const rule = { solvent: 'NACL_0.9', volume_ml: 100, apply: 'always', variants: [
      { route: 'SE', solvent: 'NACL_0.9', volume_ml: 50 },
      { dose_min_mg: 501, solvent: 'NACL_0.9', volume_ml: 200 },
    ] };
    expect(dilutionFromForm(dilutionForm(rule))).toEqual({ value: rule });
    expect(dilutionSummary(rule)).toBe('Natri clorid 0.9% 100 ml · +2 cách pha');
    const bad = dilutionForm(rule);
    bad.dilution_variants.push({ route: '', dose_min_mg: '', dose_max_mg: '', solvent: 'NACL_0.9', volume_ml: '50' });
    expect(dilutionFromForm(bad).error).toMatch(/Cách pha 3: chọn đường dùng hoặc nhập khoảng liều/);
  });
  it('kiểm tra thử ghi cách pha và lý do cần xác nhận', () => {
    const lines = describeCheck({ moved_to_infusion: true, dung_moi: 'NACL_0.9', the_tich: 100, nguon_pha: 'danh_muc',
      cach_pha: 'liều ≥ 501 mg → Natri clorid 0.9% 200 ml', can_xac_nhan_pha: true, ly_do_xac_nhan_pha: 'Y lệnh không ghi rõ liều mỗi lần.',
      rule: { solvent: 'NACL_0.9', canonical: 'VANCOMYCIN' }, rule_source: 'danh_muc' });
    expect(lines).toContain('Cách pha được chọn: liều ≥ 501 mg → Natri clorid 0.9% 200 ml.');
    expect(lines).toContain('⚠ Cần xác nhận cách pha: Y lệnh không ghi rõ liều mỗi lần.');
  });
});

import { observedLabel, statsForDrug, variantFromObserved } from './dilutionRule.js';

describe('cách pha thực tế', () => {
  const stats = { drugs: [{ drug: 'VANCOMYCIN', total: 40, observed: [
    { solvent: 'NACL_0.9', volume_ml: 200, route: 'TTM', dose_mg: 1000, count: 34 },
    { solvent: 'NACL_0.9', volume_ml: 100, route: 'TMC', dose_mg: null, count: 5 },
  ] }] };
  it('tìm theo tên chuẩn, nhãn đọc được', () => {
    const s = statsForDrug(stats, 'vancomycin');
    expect(s.total).toBe(40);
    expect(observedLabel(s.observed[0])).toBe('Natri clorid 0.9% 200 ml · TTM · liều 1000 mg/lần');
    expect(statsForDrug(stats, 'X')).toBeNull();
  });
  it('thành cách pha theo điều kiện', () => {
    expect(variantFromObserved(stats.drugs[0].observed[0])).toMatchObject({ route: 'TTM', dose_min_mg: '1000', dose_max_mg: '1000', volume_ml: '200' });
    expect(variantFromObserved(stats.drugs[0].observed[1])).toMatchObject({ route: '', dose_min_mg: '', volume_ml: '100' });
  });
});
