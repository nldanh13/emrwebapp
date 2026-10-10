// Thiết lập tài khoản gom mọi thứ về tài khoản: người không phải quản trị chỉ thấy Thiết bị tin cậy;
// quản trị thấy thêm Người dùng Data Hub và Tài khoản EMR (tổng hợp chỗ khai trùng, tài khoản theo
// điều dưỡng chuyển từ Lịch điều dưỡng sang, tự lưu từng người).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createElement, act } from 'react';
import { createRoot } from 'react-dom/client';

const api = {
  getAdminUsers: vi.fn(async () => ({ users: [], file: { mode: 'file' } })),
  createAdminUser: vi.fn(), updateAdminUser: vi.fn(), deleteAdminUser: vi.fn(),
  getFetchAccounts: vi.fn(async () => ({ accounts: [], max_parallel: 2, max_parallel_limit: 4 })),
  saveFetchAccounts: vi.fn(),
  getNurseSettings: vi.fn(async () => ({ roster: ['Nguyễn Thị Lan', 'Trần Văn Bình'] })),
  getNurseEmrAccounts: vi.fn(async () => ({ accounts: [{ name: 'Nguyễn Thị Lan', emr_username: 'lan.nt', emr_password: 'x', signature_file: 'lan.png' }] })),
  saveNurseSettings: vi.fn(async () => ({ status: 'ok' })),
  removeNurseEmrAccount: vi.fn(async () => ({ status: 'ok', accounts: [] })),
  updateNurseEmrAccount: vi.fn(async () => ({ status: 'ok', accounts: [] })),
  getEmrAccountOverview: vi.fn(async () => ({
    shared: { configured: true, username: 'chung', source: 'secrets/secrets.json' },
    hchanh: { configured: false, username: '', source: '' },
    accounts: [{ username: 'lan.nt', duplicate: true, notes: ['Đang khai ở 2 chỗ.'], uses: [
      { use: 'nurse', label: 'Nhập liệu theo lịch', owner: 'Nguyễn Thị Lan' },
      { use: 'read', label: 'Đọc song song', owner: 'Đọc 1' },
    ] }],
    duplicate_count: 1,
    nurses_missing: ['Trần Văn Bình'],
  })),
  getDeviceStatus: vi.fn(async () => ({ trusted: false, any_trusted: false })),
  listDevices: vi.fn(async () => ({ devices: [] })),
};
vi.mock('../api.js', () => api);
vi.mock('../utils/deviceTrust.js', () => ({ ensureDeviceKey: vi.fn(), getDeviceId: vi.fn(async () => ''), setDeviceId: vi.fn() }));
let auth = { user: null, authMode: 'local_only' };
vi.mock('../hooks/useAuth.jsx', () => ({ useAuth: () => auth }));

const { default: AccountSettingsTab } = await import('./AccountSettingsTab.jsx');
const { buildNurseAccountRows } = await import('./accounts/EmrPeoplePanel.jsx');

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
let host; let root;
beforeEach(() => {
  host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host);
  Object.values(api).forEach(f => f.mockClear?.());
  try { localStorage.clear(); } catch { /* jsdom */ }
});
afterEach(() => { act(() => root.unmount()); host.remove(); });
const flush = () => act(async () => { await new Promise(r => setTimeout(r, 0)); });
const radio = (text) => [...host.querySelectorAll('[role="radio"]')].find(b => b.textContent === text);
const visible = () => [...host.children[0].children].filter(el => !el.hidden).map(el => el.textContent).join(' ');

describe('AccountSettingsTab', () => {
  it('người không phải quản trị chỉ thấy Thiết bị tin cậy, không tải danh sách tài khoản', async () => {
    auth = { user: { name: 'Lan', role: 'operator' }, authMode: 'token' };
    act(() => root.render(createElement(AccountSettingsTab, {})));
    await flush();
    expect(radio('Người dùng Data Hub')).toBeUndefined();
    expect(host.textContent).toContain('Bạn đang đăng nhập: Lan');
    expect(host.textContent).toContain('chỉ tài khoản vai trò Quản trị');
    expect(api.getAdminUsers).not.toHaveBeenCalled();
    expect(api.getEmrAccountOverview).not.toHaveBeenCalled();
  });

  it('quản trị: ba mục ở một chỗ; Tài khoản EMR chỉ ra chỗ khai trùng và người chưa có tài khoản', async () => {
    auth = { user: { name: 'QT', role: 'admin' }, authMode: 'token' };
    act(() => root.render(createElement(AccountSettingsTab, {})));
    await flush();
    expect(radio('Người dùng Data Hub').getAttribute('aria-checked')).toBe('true');
    expect(radio('Tài khoản EMR')).toBeTruthy();
    expect(radio('Thiết bị tin cậy')).toBeTruthy();
    await act(async () => { radio('Tài khoản EMR').click(); });
    await flush();
    const text = visible();
    expect(text).toContain('Cần chú ý');
    expect(text).toContain('lan.nt đang khai ở 2 chỗ (Nhập liệu theo lịch: Nguyễn Thị Lan; Đọc song song: Đọc 1)');
    expect(text).toContain('1 điều dưỡng chưa có tài khoản EMR (Trần Văn Bình)');
    expect(api.getFetchAccounts).not.toHaveBeenCalled();
    expect(host.querySelector('input[aria-label="Tài khoản EMR của Trần Văn Bình"]')).toBeTruthy();
  });

  it('sửa tài khoản EMR một điều dưỡng: tự lưu đúng người đó, không gửi cả danh sách', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      auth = { user: null, authMode: 'local_only' };
      localStorage.setItem('emr_account_section_v1', 'emr');
      act(() => root.render(createElement(AccountSettingsTab, {})));
      await flush();
      const input = host.querySelector('input[aria-label="Tài khoản EMR của Trần Văn Bình"]');
      act(() => {
        Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(input, 'binh.tv');
        input.dispatchEvent(new Event('input', { bubbles: true }));
      });
      expect(host.textContent).toContain('Chưa lưu');
      await act(async () => { vi.advanceTimersByTime(900); });
      await flush();
      expect(api.updateNurseEmrAccount).toHaveBeenCalledTimes(1);
      expect(api.updateNurseEmrAccount).toHaveBeenCalledWith('Trần Văn Bình', { emr_username: 'binh.tv' });
      expect(host.textContent).toContain('Đã lưu');
    } finally {
      vi.useRealTimers();
    }
  });

  it('danh sách điều dưỡng: mọi tên trong lịch, cộng người đã có tài khoản mà không còn trong lịch', () => {
    const rows = buildNurseAccountRows(['A'], [{ name: 'B', emr_username: 'b', emr_password: '' }, { name: 'C', signature_file: 'c.png' }]);
    expect(rows.map(r => [r.name, r.inRoster])).toEqual([['A', true], ['B', false]]);
  });
});
