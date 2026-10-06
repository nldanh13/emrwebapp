import { describe, it, expect } from 'vitest';
import BUILTIN from '../../config/medication_builtin.json' with { type: 'json' };
import { builtinSections, fillEmptyFields } from './medicationBuiltin.js';


describe('mục Sẵn có của Danh mục thuốc', () => {
  const sections = builtinSections(BUILTIN);
  const byId = Object.fromEntries(sections.map(s => [s.id, s]));

  it('hiện đủ các nhóm kiến thức sẵn có', () => {
    expect(Object.keys(byId)).toEqual(['luat_pha', 'the_tich', 'hoat_chat', 'dung_moi_di_kem', 'ten_hien_thi']);
  });
  it('luật pha chép thành quy tắc pha; Tramadol chỉ khi truyền', () => {
    const vanco = byId.luat_pha.rows.find(r => r.label === 'VANCOMYCIN');
    expect(vanco.prefill).toMatchObject({ canonical: 'VANCOMYCIN', dilution_solvent: 'NACL_0.9', dilution_volume_ml: '100', dilution_apply: 'always' });
    expect(byId.luat_pha.rows.find(r => r.label === 'TRAMADOL').prefill.dilution_apply).toBe('infusion_only');
    expect(byId.luat_pha.rows.find(r => r.label === 'COLISTIN').prefill.dilution_volume_ml).toBe('50');
  });
  it('thể tích, hoạt chất, dung môi đi kèm, tên hiển thị', () => {
    expect(byId.the_tich.rows.find(r => r.label === 'LINEZOLID').prefill).toEqual({ canonical: 'LINEZOLID', default_volume_ml: '300' });
    expect(byId.the_tich.rows.find(r => r.label === 'NATRI CLORID 100').prefill.canonical).toBe('NATRI CLORID 100');
    expect(byId.hoat_chat.rows[0].prefill).toEqual({ canonical: 'VECMID', active_ingredients: 'VANCOMYCIN' });
    expect(byId.dung_moi_di_kem.rows[0].prefill.co_dung_moi_di_kem).toBe(true);
    const para = byId.ten_hien_thi.rows.find(r => r.label === 'Paracetamol');
    expect(para.prefill.ten_hien_thi).toBe('Paracetamol');
    expect(para.prefill.aliases).toContain('THERMODOL');
  });
  it('dữ liệu rỗng không lỗi', () => expect(builtinSections(null)).toEqual([]));
});

describe('bổ sung vào thuốc đã có', () => {
  it('chỉ điền ô trống, không đổi tên và quy tắc đã đặt', () => {
    const form = { canonical: 'VANCOMYCIN', default_volume_ml: 100, dilution_solvent: '', dilution_volume_ml: '', dilution_apply: 'always' };
    const out = fillEmptyFields(form, { canonical: 'X', dilution_solvent: 'NACL_0.9', dilution_volume_ml: '100' });
    expect(out).toMatchObject({ canonical: 'VANCOMYCIN', default_volume_ml: 100, dilution_solvent: 'NACL_0.9', dilution_volume_ml: '100' });
    const kept = fillEmptyFields({ dilution_solvent: 'GLUCOSE_5', dilution_volume_ml: '' }, { dilution_solvent: 'NACL_0.9', dilution_volume_ml: '100' });
    expect(kept).toEqual({ dilution_solvent: 'GLUCOSE_5', dilution_volume_ml: '' });
  });
});
