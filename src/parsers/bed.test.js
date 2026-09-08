import { describe, expect, it } from 'vitest';
import { checkCurrentBedTimeline, getCurrentBedFromTimeline } from './bed.js';

function row(overrides = {}) {
  return {
    trang_thai: 'Đang thực hiện',
    is_current: true,
    tu: '08:00 20/07/2026',
    den: '',
    nguoi_chi_dinh: 'Trần Quang Sơn',
    phong: 'Phòng 03',
    phong_norm: 'P03',
    is_ctch_tk_doctor: true,
    expected_doctor_by_room: 'Trần Quang Sơn',
    doctor_matches_room: true,
    ...overrides,
  };
}

describe('getCurrentBedFromTimeline', () => {
  it('prefers an active row over a more recent inactive one', () => {
    const active = row({ tu: '08:00 20/07/2026' });
    const laterInactive = row({ is_current: false, trang_thai: 'Đã chuyển', tu: '09:00 20/07/2026' });
    expect(getCurrentBedFromTimeline([laterInactive, active])).toBe(active);
  });

  it('picks the most recent active row when several are active', () => {
    const earlier = row({ tu: '08:00 20/07/2026' });
    const later = row({ tu: '14:00 20/07/2026' });
    expect(getCurrentBedFromTimeline([earlier, later])).toBe(later);
  });

  it('falls back to the most recent row when none are marked active', () => {
    const earlier = row({ is_current: false, trang_thai: 'Đã chuyển', tu: '08:00 20/07/2026' });
    const later = row({ is_current: false, trang_thai: 'Đã chuyển', tu: '09:00 20/07/2026' });
    expect(getCurrentBedFromTimeline([earlier, later])).toBe(later);
  });

  it('returns null for an empty timeline', () => {
    expect(getCurrentBedFromTimeline([])).toBeNull();
  });
});

describe('checkCurrentBedTimeline', () => {
  it('reports ok with no warnings for a clean current row', () => {
    const result = checkCurrentBedTimeline([row()]);
    expect(result.status).toBe('ok');
    expect(result.warnings).toEqual([]);
  });

  it('warns when the timeline could not be read at all', () => {
    const result = checkCurrentBedTimeline([]);
    expect(result.status).toBe('warning');
    expect(result.warnings).toContain('Không đọc được timeline buồng giường.');
  });

  it('warns when the assigned doctor does not match the room roster', () => {
    const mismatched = row({
      nguoi_chi_dinh: 'Bác sĩ Khác',
      is_ctch_tk_doctor: false,
      doctor_matches_room: false,
    });
    const result = checkCurrentBedTimeline([mismatched]);
    expect(result.status).toBe('warning');
    expect(result.warnings.some(w => w.includes('không nằm trong danh sách bác sĩ CTCH-TK'))).toBe(true);
    expect(result.warnings.some(w => w.includes('bác sĩ phụ trách dự kiến là Trần Quang Sơn'))).toBe(true);
  });

  it('warns when the room could not be identified', () => {
    const noRoom = row({ phong_norm: '' });
    const result = checkCurrentBedTimeline([noRoom]);
    expect(result.warnings).toContain('Không xác định được số phòng từ thông tin buồng giường.');
  });
});
