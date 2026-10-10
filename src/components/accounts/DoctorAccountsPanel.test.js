// Bác sĩ phòng khám: dán nhiều tên + một mật khẩu → máy chủ tạo tài khoản; Phòng khám/Nghỉ ốm chọn
// bác sĩ thì chỉ gửi tên, không gửi tài khoản/mật khẩu gõ tay.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createElement, act } from 'react';
import { createRoot } from 'react-dom/client';

const api = {
  getNurseEmrAccounts: vi.fn(async () => ({ accounts: [
    { name: 'Lan', emr_username: 'lan', emr_password: 'x' },
    { name: 'Hồ Điền', kind: 'doctor', emr_username: 'hdien', emr_password: 'x' },
  ] })),
  addDoctorAccounts: vi.fn(async () => ({ status: 'ok', accounts: [
    { name: 'Hồ Điền', kind: 'doctor', emr_username: 'hdien', emr_password: 'x' },
    { name: 'Hoàng Minh Tú', kind: 'doctor', emr_username: 'hmtu', emr_password: 'p' },
  ] })),
  updateNurseEmrAccount: vi.fn(), removeNurseEmrAccount: vi.fn(),
};
vi.mock('../../api.js', () => api);

const { default: DoctorAccountsPanel, splitDoctorNames } = await import('./DoctorAccountsPanel.jsx');
const { clinicLoginPayload, hasClinicLogin } = await import('../ClinicAccountPicker.jsx');
const { buildNurseAccountRows } = await import('./NurseEmrAccountsPanel.jsx');

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
let host; let root;
beforeEach(() => { host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host); Object.values(api).forEach(f => f.mockClear?.()); });
afterEach(() => { act(() => root.unmount()); host.remove(); });
const flush = () => act(async () => { await new Promise(r => setTimeout(r, 0)); });
const type = (el, value) => act(() => {
  const proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
});

describe('DoctorAccountsPanel', () => {
  it('tách tên dán vào theo dấu phẩy và xuống dòng, bỏ trùng', () => {
    expect(splitDoctorNames('Hồ Điền,  Hoàng Minh Tú\nHồ Điền; Phạm Việt Tân')).toEqual(['Hồ Điền', 'Hoàng Minh Tú', 'Phạm Việt Tân']);
  });

  it('chỉ hiện bác sĩ; bảng điều dưỡng không hiện bác sĩ', async () => {
    act(() => root.render(createElement(DoctorAccountsPanel, {})));
    await flush();
    expect(host.querySelector('input[aria-label="Tài khoản EMR của bác sĩ Hồ Điền"]').value).toBe('hdien');
    expect(host.textContent).not.toContain('Lan');
    expect(buildNurseAccountRows([], [{ name: 'Hồ Điền', kind: 'doctor', emr_username: 'hdien' }])).toEqual([]);
  });

  it('thêm nhiều bác sĩ một lần với một mật khẩu chung', async () => {
    act(() => root.render(createElement(DoctorAccountsPanel, {})));
    await flush();
    type(host.querySelector('textarea[aria-label="Tên các bác sĩ"]'), 'Hồ Điền, Hoàng Minh Tú');
    type(host.querySelector('input[aria-label="Mật khẩu chung cho các bác sĩ vừa thêm"]'), 'p');
    const btn = [...host.querySelectorAll('button')].find(b => b.textContent.includes('Thêm 2 bác sĩ'));
    await act(async () => { btn.click(); });
    await flush();
    expect(api.addDoctorAccounts).toHaveBeenCalledWith({ names: ['Hồ Điền', 'Hoàng Minh Tú'], password: 'p' });
    expect(host.querySelector('input[aria-label="Tài khoản EMR của bác sĩ Hoàng Minh Tú"]').value).toBe('hmtu');
  });
});

describe('Đăng nhập phòng khám', () => {
  it('chọn bác sĩ thì chỉ gửi tên; gõ tay thì cần đủ tài khoản và mật khẩu', () => {
    expect(clinicLoginPayload({ accountName: 'Hồ Điền', username: 'cu', password: 'cu' })).toEqual({ account_name: 'Hồ Điền', username: '', password: '' });
    expect(clinicLoginPayload({ username: ' a ', password: 'b' })).toEqual({ username: 'a', password: 'b' });
    expect(hasClinicLogin({ accountName: 'Hồ Điền' })).toBe(true);
    expect(hasClinicLogin({ username: 'a' })).toBe(false);
  });
});
