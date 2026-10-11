// Phòng khám: 3 khung (lượt khám, việc cần làm, xin nghỉ ốm) dựng từ danh sách đang theo dõi;
// "Nhập lên cổng BHXH" chuyển sang tab Nghỉ ốm, mục Ngoại trú.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createElement, act } from 'react';
import { createRoot } from 'react-dom/client';

const ROWS = [
  { khambenhid: 'a', ma_bn: '1', ho_ten: 'NGUOI CHO', nam_sinh: '1990', stage: 'cho_kham', case: 'chua_xu_tri', services: [] },
  { khambenhid: 'b', ma_bn: '2', ho_ten: 'NGUOI CO THUOC', nam_sinh: '1985', stage: 'dang_kham', case: 'cho_ve', services: [],
    eligible: true, check: { status: 'ready', drugs: 2 }, has_bhyt: true },
  { khambenhid: 'c', ma_bn: '3', ho_ten: 'NGUOI CHUA THUOC', nam_sinh: '1980', stage: 'dang_kham', case: 'cho_ve', services: [],
    eligible: true, check: { status: 'no_drug', drugs: 0, message: 'Chưa có thuốc — chờ bác sĩ kê đơn rồi mới hoàn tất' }, has_bhyt: true },
  { khambenhid: 'd', ma_bn: '4', ho_ten: 'NGUOI THU THUAT', nam_sinh: '1975', stage: 'dang_lam_dv', case: 'chua_xu_tri', has_bhyt: true,
    services: [{ code: 'TT', label: 'TT', done: 0, total: 1 }], pending_tt: 1, procedure_task: true },
  { khambenhid: 'e', ma_bn: '5', ho_ten: 'NGUOI XONG', nam_sinh: '1970', stage: 'xong', case: 'cho_ve', services: [], has_bhyt: true },
];
let SICK = [];
let HAS_URL = true;
vi.mock('../api.js', () => ({
  getClinicMonitorState: vi.fn(async () => ({ status: 'ok', monitor: { running: true, status: 'running', rows: ROWS, auto_tasks: false } })),
  getClinicSickLeave: vi.fn(async () => ({ status: 'ok', entries: SICK })),
  getClinicEmrDefaults: vi.fn(async () => ({ status: 'ok', has_login_url: HAS_URL })),
  addClinicSickLeave: vi.fn(async (patient) => {
    SICK = [...SICK, { ...patient, key: patient.khambenhid, ngay: new Date().toISOString().slice(0, 10) }];
    return { status: 'ok', entries: SICK };
  }),
  removeClinicSickLeave: vi.fn(async () => ({ status: 'ok', entries: [] })),
  getClinicDoctorAccounts: vi.fn(async () => ({ status: 'ok', accounts: [], scheduled: null })),
  runClinicTasks: vi.fn(async () => ({ status: 'ok', message: 'ok' })),
  setClinicAutoTasks: vi.fn(async () => ({ status: 'ok', message: 'ok' })),
  completeReadyClinicPatients: vi.fn(async () => ({ status: 'ok', message: 'ok' })),
}));
const api = await import('../api.js');
const { default: ClinicTab } = await import('./ClinicTab.jsx');

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
let host; let root;
beforeEach(() => { host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host); });
afterEach(() => { act(() => root.unmount()); host.remove(); });
const flush = async () => { for (let i = 0; i < 6; i += 1) await act(async () => { await Promise.resolve(); }); };
const button = (text) => [...host.querySelectorAll('button')].find(b => b.textContent.includes(text));

describe('Phòng khám: 3 khung', () => {
  it('thống kê, hoàn tất theo thuốc, việc cần làm, nghỉ ốm', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    await act(async () => { root.render(createElement(ClinicTab, { toast: () => {} })); });
    await flush();
    const text = host.textContent;
    expect(text).toContain('Chờ khám1');
    expect(text).toContain('Đang thực hiện3');
    expect(text).toContain('Hoàn tất khám1');
    expect(text).toContain('Có 2 thuốc');
    expect(button('Hoàn tất khám 1 người bệnh').disabled).toBe(false);
    expect(text).toContain('Chưa có thuốc');
    expect(text).toContain('Thủ thuật (1)');
    const d = new Date();
    const today = `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`;
    expect(text).toContain(`Ngày theo dõi: `);
    expect(text).toContain(today);
    expect(text).toContain(`Danh sách khám bệnh ngày ${today}`);
    expect(text).not.toContain('không phải hôm nay');

    await act(async () => { button('Hoàn thành thủ thuật ngay (1)').click(); });
    expect(api.runClinicTasks).toHaveBeenCalledTimes(1);

    const select = host.querySelector('select[aria-label="Chọn người bệnh xin nghỉ ốm"]');
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set;
      setter.call(select, 'b');
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await act(async () => { button('Thêm').click(); });
    await flush();
    expect(api.addClinicSickLeave).toHaveBeenCalledWith(expect.objectContaining({ khambenhid: 'b', ma_bn: '2' }));
    expect(host.textContent).toContain('1 người hôm nay');

    const opened = vi.fn();
    window.addEventListener('emr:open-tab', opened);
    await act(async () => { button('Nhập lên cổng BHXH').click(); });
    window.removeEventListener('emr:open-tab', opened);
    expect(opened.mock.calls[0][0].detail).toEqual({ tab: 'sick-leave', view: 'ngoaitru' });
    expect(sessionStorage.getItem('emr:sick-leave-view')).toBe('ngoaitru');
  });

  it('không hỏi URL khi máy chủ đã khai địa chỉ EMR; chưa khai thì chỉ hỏi địa chỉ đăng nhập', async () => {
    const labels = () => [...host.querySelectorAll('label')].map(l => l.textContent);
    await act(async () => { root.render(createElement(ClinicTab, { toast: () => {} })); });
    await flush();
    await act(async () => { button('Thiết lập').click(); });
    expect(labels().some(t => /URL|Địa chỉ đăng nhập/.test(t))).toBe(false);

    act(() => root.unmount());
    root = createRoot(host);
    HAS_URL = false;
    await act(async () => { root.render(createElement(ClinicTab, { toast: () => {} })); });
    await flush();
    await act(async () => { button('Thiết lập').click(); });
    expect(labels().filter(t => /URL|Địa chỉ đăng nhập/.test(t))).toEqual(['Địa chỉ đăng nhập EMR']);
    HAS_URL = true;
  });
});
