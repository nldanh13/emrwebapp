// Lịch làm việc: một màn cho lịch điều dưỡng khoa và lịch phòng khám. Mở lên là tuần này, chọn sẵn hôm
// nay (không nhảy về ngày cũ nhất đã lưu); bảng tuần cho thấy tổng quan; sửa một ngày thì tự lưu cả hai lịch.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createElement, act } from 'react';
import { createRoot } from 'react-dom/client';
import { addDaysIso, formatDmy, todayIso, weekdayKeyFromIso } from './nurse/nurseScheduleUtils.js';

const today = todayIso();
const api = {
  getNurseSettings: vi.fn(async () => ({
    roster: ['Nguyễn Thị Lan', 'Trần Văn Bình'],
    schedule: { days: { '2026-07-03': { admin: ['Nguyễn Thị Lan'], work: [], oncall: [] } }, Default: { admin: [], work: ['Nguyễn Thị Lan'], oncall: [] } },
    clinicSchedule: { Default: { admin: [], work: ['Trần Văn Bình'], oncall: [], doctor: ['Hồ Điền'] } },
    available_dates: ['2026-07-03'],
  })),
  getClinicDoctorAccounts: vi.fn(async () => ({ doctors: [
    { name: 'Hồ Điền', emr_username: 'hdien', ready: true },
    { name: 'Hoàng Minh Tú', emr_username: 'hmtu', ready: true },
  ] })),
  getNurseEmrAccounts: vi.fn(async () => ({ accounts: [] })),
  saveNurseSettings: vi.fn(async () => ({ status: 'ok' })),
};
vi.mock('../api.js', () => api);
vi.mock('../hooks/useAuth.jsx', () => ({ useAuth: () => ({ user: null }) }));
vi.mock('../hooks/useIsMobile.js', () => ({ default: () => false }));

const { default: NurseTab } = await import('./NurseTab.jsx');
const { clinicNamesFor, setClinicNames, nurseDayFor, weekStartIso } = await import('./nurse/clinicSchedule.js');
const { scheduledOptionLabel } = await import('./ClinicAccountPicker.jsx');
const { loadClinicConfig } = await import('../utils/clinicLogin.js');

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
let host; let root;
beforeEach(() => { host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host); Object.values(api).forEach(f => f.mockClear()); });
afterEach(() => { act(() => root.unmount()); host.remove(); });
const flush = () => act(async () => { await new Promise(r => setTimeout(r, 0)); });
const chip = (name) => [...host.querySelectorAll('button[aria-pressed]')].find(b => b.textContent.includes(name));
const button = (text) => [...host.querySelectorAll('button')].find(b => b.textContent.trim() === text);

describe('quy tắc tra lịch', () => {
  it('phòng khám: bác sĩ và điều dưỡng tra riêng; ngày chỉ xếp điều dưỡng vẫn lấy bác sĩ theo thứ/mẫu', () => {
    const sched = { days: { [today]: { work: ['A'] } }, [weekdayKeyFromIso(today)]: { doctor: ['BS thứ'] }, Default: { doctor: ['BS mẫu'], work: ['B'] } };
    expect(clinicNamesFor(sched, today, 'doctor')).toEqual({ names: ['BS thứ'], from: 'weekday' });
    expect(clinicNamesFor(sched, today, 'work')).toEqual({ names: ['A'], from: 'day' });
    const next = setClinicNames(sched, today, 'doctor', ['X']);
    expect(next.days[today]).toMatchObject({ work: ['A'], doctor: ['X'] });
    expect(setClinicNames(next, today, 'doctor', []).days[today].doctor).toBeUndefined();
  });

  it('điều dưỡng khoa: cả ngày theo mẫu khi ngày đó trống; tuần bắt đầu thứ Hai', () => {
    expect(nurseDayFor({ Default: { work: ['L'] } }, today)).toMatchObject({ day: { work: ['L'] }, from: 'default' });
    expect(nurseDayFor({ days: { [today]: { oncall: ['B'] } }, Default: { work: ['L'] } }, today)).toMatchObject({ day: { work: [], oncall: ['B'] }, from: 'day' });
    expect(weekStartIso('2026-10-10')).toBe('2026-10-05');
    expect(weekStartIso('2026-10-05')).toBe('2026-10-05');
    expect(weekStartIso('2026-10-11')).toBe('2026-10-05');
  });
});

describe('NurseTab (Lịch làm việc)', () => {
  it('mở lên là tuần này, chọn sẵn hôm nay; không nhảy về ngày cũ đã lưu', async () => {
    act(() => root.render(createElement(NurseTab, {})));
    await flush();
    expect(host.querySelector('h2').textContent).toContain(`${formatDmy(today)} (hôm nay)`);
    const headers = [...host.querySelectorAll('table[aria-label="Lịch tuần"] thead button')];
    expect(headers).toHaveLength(7);
    expect(headers.find(b => b.getAttribute('aria-current') === 'date').getAttribute('aria-label')).toContain(formatDmy(today));
    expect(host.textContent).not.toContain('03/07');
    // Tổng quan: bác sĩ, điều dưỡng phòng khám lấy theo mẫu hiện ngay trong bảng tuần.
    const table = host.querySelector('table[aria-label="Lịch tuần"]');
    expect(table.textContent).toContain('BS phòng khám');
    expect(table.textContent).toContain('Hồ Điền');
    expect(table.textContent).toContain('Trần Văn Bình');
  });

  it('sửa ngày đang chọn: tự lưu cả lịch khoa và lịch phòng khám', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      act(() => root.render(createElement(NurseTab, {})));
      await flush();
      await act(async () => { chip('Hoàng Minh Tú').click(); });
      expect(host.textContent).toContain('Chưa lưu');
      await act(async () => { vi.advanceTimersByTime(500); });
      await flush();
      expect(api.saveNurseSettings).toHaveBeenCalledTimes(1);
      const payload = api.saveNurseSettings.mock.calls[0][0];
      expect(Object.keys(payload).sort()).toEqual(['clinicSchedule', 'roster', 'schedule']);
      expect(payload.clinicSchedule.days[today].doctor).toEqual(['Hồ Điền', 'Hoàng Minh Tú']);
      expect(payload.clinicSchedule.Default.doctor).toEqual(['Hồ Điền']);
      expect(payload.schedule.days['2026-07-03'].admin).toEqual(['Nguyễn Thị Lan']);
      expect(host.textContent).toContain('Đã tự lưu');
    } finally {
      vi.useRealTimers();
    }
  });

  it('Tuần sau / Hôm nay chuyển tuần và giữ cùng thứ', async () => {
    act(() => root.render(createElement(NurseTab, {})));
    await flush();
    await act(async () => { host.querySelector('button[aria-label="Tuần sau"]').click(); });
    expect(host.querySelector('h2').textContent).toContain(formatDmy(addDaysIso(today, 7)));
    await act(async () => { button('Hôm nay').click(); });
    expect(host.querySelector('h2').textContent).toContain('(hôm nay)');
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
    localStorage.clear();
  });
});
