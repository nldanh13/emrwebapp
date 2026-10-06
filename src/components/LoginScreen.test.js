// Màn hình đăng nhập: mặc định tên + mật khẩu; đúng thì vào bằng mã máy chủ trả về; sai thì
// báo câu tiếng Việt của máy chủ; vẫn chuyển được sang mã truy cập.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createElement, act } from 'react';
import { createRoot } from 'react-dom/client';

const login = vi.fn(async () => ({ ok: true }));
vi.mock('../hooks/useAuth.jsx', () => ({ useAuth: () => ({ login }) }));
const loginWithPassword = vi.fn();
vi.mock('../api.js', () => ({ loginWithPassword: (...a) => loginWithPassword(...a) }));
const { default: LoginScreen } = await import('./LoginScreen.jsx');

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
let host; let root;
beforeEach(() => { host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host); login.mockClear(); loginWithPassword.mockReset(); });
afterEach(() => { act(() => root.unmount()); host.remove(); });

const type = (el, value) => {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  setter.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
};
const submit = async () => { await act(async () => { host.querySelector('form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); }); };

describe('LoginScreen', () => {
  it('đúng tên + mật khẩu → đăng nhập bằng mã máy chủ trả về', async () => {
    loginWithPassword.mockResolvedValue({ ok: true, token: 'tok' });
    act(() => root.render(createElement(LoginScreen)));
    act(() => { type(host.querySelector('#login-username'), 'dd'); type(host.querySelector('#login-password'), 'MatKhau#2026'); });
    await submit();
    expect(loginWithPassword).toHaveBeenCalledWith('dd', 'MatKhau#2026');
    expect(login).toHaveBeenCalledWith('tok');
  });

  it('sai → hiện câu báo của máy chủ, không đăng nhập', async () => {
    loginWithPassword.mockResolvedValue({ ok: false, message: 'Tên đăng nhập hoặc mật khẩu không đúng.' });
    act(() => root.render(createElement(LoginScreen)));
    act(() => { type(host.querySelector('#login-username'), 'dd'); type(host.querySelector('#login-password'), 'sai'); });
    await submit();
    expect(host.querySelector('[role="alert"]').textContent).toBe('Tên đăng nhập hoặc mật khẩu không đúng.');
    expect(login).not.toHaveBeenCalled();
  });

  it('chuyển sang mã truy cập', async () => {
    act(() => root.render(createElement(LoginScreen)));
    act(() => { [...host.querySelectorAll('button')].find(b => b.textContent === 'Đăng nhập bằng mã truy cập').click(); });
    expect(host.querySelector('#login-token')).toBeTruthy();
  });
});
