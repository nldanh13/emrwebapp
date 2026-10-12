// Phòng khám: các khung (lượt khám, việc cần làm) dựng từ danh sách đang theo dõi.
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
let HAS_URL = true;
let EXTRA = {};
vi.mock('../api.js', () => ({
  getClinicMonitorState: vi.fn(async () => ({ status: 'ok', monitor: { running: true, status: 'running', rows: ROWS, auto_tasks: false, ...EXTRA } })),
  setClinicListDate: vi.fn(async (date) => ({ status: 'ok', list_date: date, message: 'ok' })),
  getClinicEmrDefaults: vi.fn(async () => ({ status: 'ok', has_login_url: HAS_URL })),
  getClinicDoctorAccounts: vi.fn(async () => ({ status: 'ok', accounts: [], scheduled: null })),
  runClinicTasks: vi.fn(async () => ({ status: 'ok', message: 'ok' })),
  setClinicAutoTasks: vi.fn(async () => ({ status: 'ok', message: 'ok' })),
  completeReadyClinicPatients: vi.fn(async () => ({ status: 'ok', message: 'ok' })),
  downloadClinicTrace: vi.fn(async () => ({ blob: new Blob(['{}']), filename: 'clinic_trace_20261012.jsonl' })),
}));
const api = await import('../api.js');
const { default: ClinicTab } = await import('./ClinicTab.jsx');
const { __resetServerData } = await import('../hooks/useServerData.js');

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
let host; let root;
beforeEach(() => { host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host); });
afterEach(() => { act(() => root.unmount()); host.remove(); });
const flush = async () => { for (let i = 0; i < 6; i += 1) await act(async () => { await Promise.resolve(); }); };
const button = (text) => [...host.querySelectorAll('button')].find(b => b.textContent.includes(text));

describe('Phòng khám: các khung', () => {
  it('thống kê, hoàn tất theo thuốc, việc cần làm', async () => {
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

    // Xin nghỉ ốm đã chuyển hẳn sang tab Nghỉ ốm (quét tự động), Phòng khám không còn khung này.
    expect(host.querySelector('select[aria-label="Chọn người bệnh xin nghỉ ốm"]')).toBeNull();
    expect(button('Nhập lên cổng BHXH')).toBeUndefined();
  });

  it('Hoàn tất cuối ngày gửi lệnh hoàn tất cả người chưa có thuốc; khung nhập chăm sóc nhập viện luôn có', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    __resetServerData();
    await act(async () => { root.render(createElement(ClinicTab, { toast: () => {} })); });
    await flush();
    await act(async () => { button('Hoàn tất cuối ngày').click(); });
    await flush();
    expect(api.completeReadyClinicPatients).toHaveBeenLastCalledWith(true);
    expect(button('Tìm người nhập viện')).toBeTruthy();
  });

  it('Tải nhật ký quét tải file nhật ký của worker', async () => {
    URL.createObjectURL = vi.fn(() => 'blob:x');
    URL.revokeObjectURL = vi.fn();
    __resetServerData();
    await act(async () => { root.render(createElement(ClinicTab, { toast: () => {} })); });
    await flush();
    await act(async () => { button('Tải nhật ký quét').click(); });
    await flush();
    expect(api.downloadClinicTrace).toHaveBeenCalledTimes(1);
    expect(URL.createObjectURL).toHaveBeenCalled();
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

  it('chọn ngày đã qua thì xem lại, chỉ đọc; bấm Hôm nay để quay lại', async () => {
    EXTRA = { list_date: '2020-01-03', read_only: true };
    __resetServerData();
    await act(async () => { root.render(createElement(ClinicTab, { toast: () => {} })); });
    await flush();
    const text = host.textContent;
    expect(text).toContain('Ngày theo dõi: Thứ sáu, 03/01/2020 (xem lại, chỉ đọc)');
    expect(text).toContain('Lượt khám ngày 03/01/2020');
    expect(text).toContain('Đang xem lại danh sách ngày 03/01/2020');
    expect(host.querySelector('input[type="date"]').value).toBe('2020-01-03');
    expect(button('Hoàn tất khám 1 người bệnh').disabled).toBe(true);
    expect(button('Hoàn thành thủ thuật ngay').disabled).toBe(true);

    const input = host.querySelector('input[type="date"]');
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, '2020-01-02');
      input.dispatchEvent(new Event('change', { bubbles: true }));
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(api.setClinicListDate).toHaveBeenLastCalledWith('2020-01-02');
    await act(async () => { button('Hôm nay').click(); });
    expect(api.setClinicListDate).toHaveBeenLastCalledWith('');
    EXTRA = {};
  });
});
