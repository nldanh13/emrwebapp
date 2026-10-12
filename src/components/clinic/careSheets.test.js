import { describe, expect, it } from 'vitest';
import {
  bothDone, CLINIC_CARE, inputPayloadRows, rowProblems, rowsToInput, setClinicDienBien, vitalsErrors, WARD_CARE, wardDienBien, wardTime, withSheetDefaults,
} from './careSheets.js';

const DB = 'Phòng khám Chấn thương chỉnh hình - Thần kinh nhận\nNgười bệnh tỉnh';
const VITALS = { mach: '80', nhiet_do: '37', huyet_ap: '120/80', nhip_tho: '20' };
const base = (over = {}) => ({ ...withSheetDefaults({ ma_bn: '1', care_time_str: '08:49 12/10/2026', can_input: true }, DB), ...over });

describe('careSheets', () => {
  it('2 phiếu mặc định: phiếu 1 Khám bệnh chuyển, phiếu 2 Khoa nhận sau 15 phút', () => {
    const r = base();
    expect(r.cham_soc).toBe(CLINIC_CARE);
    expect(CLINIC_CARE.split('\n')).toEqual(['Kính chuyển Khoa Chấn Thương chỉnh hình - Thần kinh nhận', 'Hồ sơ']);
    expect(r.cham_soc_khoa).toBe(WARD_CARE);
    expect(r.khoa_time_str).toBe('09:04 12/10/2026');
    expect(r.dien_bien_khoa).toBe('Khoa Chấn Thương chỉnh hình - Thần kinh nhận\nNgười bệnh tỉnh');
    expect(wardTime('23:50 12/10/2026')).toBe('00:05 13/10/2026');
  });

  it('diễn biến phiếu 2 theo phiếu 1 cho tới khi người dùng tự sửa', () => {
    let r = setClinicDienBien(base(), `${DB}\nĐau gối phải`);
    expect(r.dien_bien_khoa).toBe(wardDienBien(`${DB}\nĐau gối phải`));
    r = { ...r, dien_bien_khoa: 'Khoa nhận riêng' };
    expect(setClinicDienBien(r, DB).dien_bien_khoa).toBe('Khoa nhận riêng');
  });

  it('sinh hiệu: ô trống điền như phiếu chăm sóc thường, ô đã gõ phải đúng dạng', () => {
    expect(vitalsErrors({})).toEqual([]);
    expect(vitalsErrors(VITALS)).toEqual([]);
    expect(vitalsErrors({ ...VITALS, mach: '8' })).toEqual(['Mạch "8" không hợp lệ']);
    expect(rowProblems(base())).toEqual([]);
    expect(rowProblems(base({ khoa_time_str: '08:30 12/10/2026' }))).toContain('giờ phiếu 2 phải sau T/G vào');
  });

  it('bỏ ca không cần nhập: đã đủ 2 phiếu hoặc người dùng bỏ qua', () => {
    const done = base({ sheets_done: { kham: true, khoa: true } });
    const wardDone = base({ sheets_done: { kham: false, khoa: true } }); // không cần sinh hiệu
    const skipped = base({ vitals: VITALS, skip: true });
    const ready = base({ ma_bn: '2', vitals: VITALS });
    expect(bothDone(done)).toBe(true);
    expect(rowProblems(wardDone)).toEqual([]);
    const bad = base({ ma_bn: '3', vitals: { ...VITALS, huyet_ap: '120' } });
    expect(rowsToInput([done, wardDone, skipped, ready, bad])).toEqual([wardDone, ready]);
  });

  it('thiếu tài khoản EMR của người lập phiếu chưa xong thì không nhập', () => {
    const r = base({ dieu_duong: 'ĐD A', nguoi_nhan: 'ĐD Trực', thieu_tai_khoan: ['ĐD Trực'] });
    expect(rowProblems(r)).toEqual(['tài khoản EMR của ĐD Trực']);
    expect(rowProblems({ ...r, sheets_done: { kham: false, khoa: true } })).toEqual([]);
    expect(rowsToInput([r])).toEqual([]);
  });

  it('bước nhập gửi đủ người đã kiểm tra lúc tìm (mã kiểm tra khớp), người không nhập thì nhap=false', () => {
    const done = base({ ma_bn: '1', sheets_done: { kham: true, khoa: true } });
    const skipped = base({ ma_bn: '2', skip: true });
    const ready = base({ ma_bn: '3' });
    const noLink = base({ ma_bn: '4', can_input: false });
    const sent = inputPayloadRows([done, skipped, ready, noLink]);
    expect(sent.map(r => [r.ma_bn, r.nhap])).toEqual([['1', false], ['2', false], ['3', true]]);
    expect(sent.every(r => r.saved_for_input)).toBe(true);
  });
});
