import { getValue, getSelectText } from '../utils/dom.js';
import { normalizeText } from '../utils/text.js';

export function normalizeSurgeryType(value) {
  const s = normalizeText(value);
  if (s.includes('dac biet')) return 'DAC_BIET';
  if (s.includes('loai 1')) return 'LOAI_1';
  if (s.includes('loai 2')) return 'LOAI_2';
  if (s.includes('loai 3')) return 'LOAI_3';
  return '';
}

export function parseSurgeryDetail(root = document) {
  const phanLoaiEl = root.querySelector('#txtPhanLoaiPTTT');
  const loaiRaw = phanLoaiEl?.value?.trim() || phanLoaiEl?.getAttribute('value')?.trim() || '';
  return {
    gio_bat_dau_raw: getValue('#txtBatDauPT', root),
    gio_ket_thuc_raw: getValue('#txtKetThucPT', root),
    ten_dich_vu_phau_thuat: getSelectText('cbbChiDinhMoPT', root),
    doi_tuong_dv: getSelectText('cbbDoiTuongPT', root),
    loai_phau_thuat: loaiRaw,
    loai_phau_thuat_norm: normalizeSurgeryType(loaiRaw),
    loai_phau_thuat_id: phanLoaiEl?.dataset?.id || '',
    phuong_phap_vo_cam: getSelectText('cbbPPGayMePT', root),
    phuong_phap_phau_thuat: getSelectText('cbbPhuongPhapPT', root),
    icd9: getSelectText('cbbICD9', root),
    chan_doan_truoc_pt: getValue('#txtChuanDoanTruocMoPT', root),
    chan_doan_sau_pt: getValue('#txtChuanDoanSauMoPT', root),
    bs_mo_chinh: getSelectText('cbbBacSiPT', root),
    bs_phu_1: getSelectText('cbbBacSiPhuMo1', root),
    gay_me_chinh: getSelectText('cbbBacSiGayMeChinh', root),
  };
}
