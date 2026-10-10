// Lịch phòng khám: xếp bác sĩ theo ngày (người số 1 có tài khoản EMR là tài khoản phòng khám đăng nhập),
// tự lưu và chỉ gửi clinicSchedule để không ghi đè Lịch điều dưỡng.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createElement, act } from 'react';
import { createRoot } from 'react-dom/client';
import { todayIso, weekdayKeyFromIso } from './nurse/nurseScheduleUtils.js';

const today = todayIso();
const api = {
  getNurseSettings: vi.fn(async () => ({
    roster: ['Nguyễn Thị Lan', 'Trần Văn Bình'],
    schedule: { Default: { admin: [], work: ['Nguyễn Thị Lan'], oncall: [] } },
    clinicSchedule: { Default: { admin: [], work: ['Trần Văn Bình'], oncall: [], doctor: ['Hồ Điền'] } },
  })),
  getClinicDoctorAccounts: vi.fn(async () => ({ doctors: [
    { name: 'Hồ Điền', emr_username: 'hdien', ready: true },
    { name: 'Hoàng Minh Tú', emr_username: 'hmtu', ready: true },
  ] })),
  saveNurseSettings: vi.fn(async () => ({ status: 'ok' })),
};
vi.mock('../api.js', () => api);

const { default: ClinicScheduleTab, clinicNamesFor, setClinicNames } = await import('./ClinicScheduleTab.jsx');
const { scheduledOptionLabel } = await import('./ClinicAccountPicker.jsx');
const { loadClinicConfig } = await import('../utils/clinicLogin.js');

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
let host; let root;
beforeEach(() => { host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host); Object.values(api).forEach(f => f.mockClear()); });
afterEach(() => { act(() => root.unmount()); host.remove(); });
const flush = () => act(async () => { await new Promise(r => setTimeout(r, 0)); });
const chip = (name) => [...host.querySelectorAll('button[aria-pressed]')].find(b => b.textContent.includes(name));

describe('ClinicScheduleTab', () => {
  it('bác sĩ và điều dưỡng tra riêng: ngày chỉ xếp điều dưỡng vẫn lấy bác sĩ theo thứ/mẫu', () => {
    const sched = { days: { [today]: { work: ['A'] } }, [weekdayKeyFromIso(today)]: { doctor: ['BS thứ'] }, Default: { doctor: ['BS mẫu'], work: ['B'] } };
    expect(clinicNamesFor(sched, today, 'doctor')).toEqual({ names: ['BS thứ'], from: 'weekday' });
    expect(clinicNamesFor(sched, today, 'work')).toEqual({ names: ['A'], from: 'day' });
    const next = setClinicNames(sched, today, 'doctor', ['X']);
    expect(next.days[today]).toMatchObject({ work: ['A'], doctor: ['X'] });
    expect(setClinicNames(next, today, 'doctor', []).days[today].doctor).toBeUndefined();
  });

  it('chọn bác sĩ cho hôm nay: tự lưu, chỉ gửi clinicSchedule, giữ thứ tự bấm', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      act(() => root.render(createElement(ClinicScheduleTab, {})));
      await flush();
      expect(host.textContent).toContain('đang lấy theo mẫu mặc định');
      expect(chip('Hồ Điền').getAttribute('aria-pressed')).toBe('true');
      await act(async () => { chip('Hoàng Minh Tú').click(); });
      expect(host.textContent).toContain('Chưa lưu');
      await act(async () => { vi.advanceTimersByTime(500); });
      await flush();
      expect(api.saveNurseSettings).toHaveBeenCalledTimes(1);
      const payload = api.saveNurseSettings.mock.calls[0][0];
      expect(Object.keys(payload)).toEqual(['clinicSchedule']);
      expect(payload.clinicSchedule.days[today].doctor).toEqual(['Hồ Điền', 'Hoàng Minh Tú']);
      expect(payload.clinicSchedule.Default.doctor).toEqual(['Hồ Điền']);
      expect(host.textContent).toContain('Đã tự lưu lúc');
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('Đăng nhập phòng khám theo lịch', () => {
  it('nhãn ghi rõ hôm nay là ai, hoặc chưa xếp', () => {
    expect(scheduledOptionLabel({ names: ['Hồ Điền'], account_name: 'Hồ Điền' })).toContain('hôm nay: Hồ Điền');
    expect(scheduledOptionLabel({ names: ['X'], account_name: '' })).toContain('X chưa có tài khoản EMR');
    expect(scheduledOptionLabel({ names: [], account_name: '' })).toContain('chưa xếp bác sĩ');
  });

  it('mặc định theo lịch; bản lưu cũ đã gõ tên đăng nhập thì giữ gõ tay', () => {
    localStorage.clear();
    expect(loadClinicConfig().accountName).toBe('@lich');
    localStorage.setItem('emr_clinic_monitor_cfg_v1', JSON.stringify({ username: 'cu' }));
    expect(loadClinicConfig().accountName).toBe('');
    localStorage.setItem('emr_clinic_monitor_cfg_v1', JSON.stringify({ username: 'cu', accountName: '@lich' }));
    expect(loadClinicConfig().accountName).toBe('@lich');
    localStorage.clear();
  });
});
