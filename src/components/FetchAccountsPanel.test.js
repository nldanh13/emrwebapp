// Đọc song song: chọn điều dưỡng/bác sĩ đã lưu thay cho gõ lại tài khoản; chỉ gửi tên người lên máy chủ.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createElement, act } from 'react';
import { createRoot } from 'react-dom/client';

const api = {
  getFetchAccounts: vi.fn(async () => ({ max_parallel: 3, max_parallel_limit: 4, accounts: [
    { id: 'aaaaaa', source: 'manual', name: 'Đọc 1', emr_username: 'doc1', has_password: true, enabled: true, usable: true, note: '' },
  ] })),
  getNurseEmrAccounts: vi.fn(async () => ({ accounts: [
    { name: 'Nguyễn Kim Ngân', emr_username: 'nkngan', emr_password: 'x' },
    { name: 'Lê Thị Chưa', emr_username: '', emr_password: '' },
    { name: 'Hồ Điền', kind: 'doctor', emr_username: 'hdien', emr_password: 'x' },
  ] })),
  saveFetchAccounts: vi.fn(async (body) => ({ max_parallel: 3, max_parallel_limit: 4, accounts: body.accounts.map((a, i) => ({ ...a, id: a.id || `bbbbb${i}`, usable: true, note: '' })) })),
};
vi.mock('../api.js', () => api);

const { default: FetchAccountsPanel, savedPeopleOptions, fetchAccountPayload } = await import('./FetchAccountsPanel.jsx');

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
let host; let root;
beforeEach(() => { host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host); Object.values(api).forEach(f => f.mockClear()); });
afterEach(() => { act(() => root.unmount()); host.remove(); });
const flush = () => act(async () => { await new Promise(r => setTimeout(r, 0)); });
const button = (text) => [...host.querySelectorAll('button')].find(b => b.textContent.trim() === text);
const choose = (select, value) => act(() => {
  Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set.call(select, value);
  select.dispatchEvent(new Event('change', { bubbles: true }));
});

describe('FetchAccountsPanel', () => {
  it('danh sách chọn: điều dưỡng và bác sĩ đã lưu, người thiếu tài khoản không chọn được', () => {
    const o = savedPeopleOptions([{ name: 'B', emr_username: 'b', emr_password: 'x' }, { name: 'A' }, { name: 'BS', kind: 'doctor', emr_username: 'bs', emr_password: 'x' }]);
    expect(o.nurses).toEqual([{ name: 'A', emr_username: '', ready: false }, { name: 'B', emr_username: 'b', ready: true }]);
    expect(o.doctors.map(d => d.name)).toEqual(['BS']);
    expect(fetchAccountPayload({ id: 'x', source: 'saved', name: 'B', emr_username: 'b', emr_password: 'lo', enabled: true })).toEqual({ id: 'x', source: 'saved', name: 'B', enabled: true });
  });

  it('thêm tài khoản đọc bằng cách chọn điều dưỡng: không gõ tài khoản/mật khẩu, chỉ gửi tên', async () => {
    act(() => root.render(createElement(FetchAccountsPanel, {})));
    await flush();
    await act(async () => { button('+ Thêm tài khoản đọc').click(); });
    const selects = host.querySelectorAll('select[aria-label="Chọn tài khoản đọc"]');
    expect(selects.length).toBe(2);
    const opts = [...selects[1].querySelectorAll('option')];
    expect(opts.find(o => o.value === 'Lê Thị Chưa').disabled).toBe(true);
    expect(opts.some(o => o.textContent.startsWith('Hồ Điền · hdien'))).toBe(true);
    choose(selects[1], 'Nguyễn Kim Ngân');
    expect(host.textContent).toContain('nkngan');
    expect(host.textContent).toContain('Dùng mật khẩu đã lưu');
    await act(async () => { button('Lưu').click(); });
    await flush();
    expect(api.saveFetchAccounts).toHaveBeenCalledWith({ max_parallel: 3, accounts: [
      { id: 'aaaaaa', name: 'Đọc 1', emr_username: 'doc1', emr_password: '', enabled: true },
      { id: '', source: 'saved', name: 'Nguyễn Kim Ngân', enabled: true },
    ] });
  });
});
