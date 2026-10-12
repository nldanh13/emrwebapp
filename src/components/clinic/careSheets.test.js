import { describe, expect, it } from 'vitest';
import {
  bothDone, CLINIC_CARE, rowProblems, rowsToInput, setClinicDienBien, vitalsErrors, WARD_CARE, wardDienBien, wardTime, withSheetDefaults,
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

  it('sinh hiệu phải nhập đủ, không tự điền', () => {
    expect(vitalsErrors(VITALS)).toEqual([]);
    expect(vitalsErrors({ ...VITALS, nhiet_do: '' })).toEqual(['thiếu Nhiệt độ']);
    expect(rowProblems(base())).toContain('thiếu Mạch');
    expect(rowProblems(base({ vitals: VITALS }))).toEqual([]);
    expect(rowProblems(base({ vitals: VITALS, khoa_time_str: '08:30 12/10/2026' }))).toContain('giờ phiếu 2 phải sau T/G vào');
  });

  it('bỏ ca không cần nhập: đã đủ 2 phiếu hoặc người dùng bỏ qua', () => {
    const done = base({ sheets_done: { kham: true, khoa: true } });
    const wardDone = base({ sheets_done: { kham: false, khoa: true } }); // không cần sinh hiệu
    const skipped = base({ vitals: VITALS, skip: true });
    const ready = base({ ma_bn: '2', vitals: VITALS });
    expect(bothDone(done)).toBe(true);
    expect(rowProblems(wardDone)).toEqual([]);
    expect(rowsToInput([done, wardDone, skipped, ready, base()]).map(r => r.ma_bn)).toEqual(['1', '2']);
    expect(rowsToInput([done, wardDone, skipped, ready])).toEqual([wardDone, ready]);
  });
});
