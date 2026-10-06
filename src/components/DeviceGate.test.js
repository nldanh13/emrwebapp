// Cổng thiết bị: máy chủ bắt buộc thiết bị tin cậy mà máy này chưa tin cậy → chỉ trang đăng ký,
// không mở app; đã tin cậy hoặc máy chủ không bắt buộc → vào app. Bị thu hồi giữa phiên → chặn.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createElement, act } from 'react';
import { createRoot } from 'react-dom/client';

const getDeviceStatus = vi.fn();
vi.mock('../api.js', () => ({ getDeviceStatus: (...a) => getDeviceStatus(...a) }));
vi.mock('../hooks/useAuth.jsx', () => ({ useAuth: () => ({ user: { role: 'operator' }, logout: vi.fn() }) }));
vi.mock('./DeviceTrustPanel.jsx', () => ({ default: () => createElement('div', null, 'BẢNG THIẾT BỊ') }));
const { default: DeviceGate } = await import('./DeviceGate.jsx');

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
let host; let root;
beforeEach(() => { host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host); });
afterEach(() => { act(() => root.unmount()); host.remove(); });
const flush = () => act(async () => { await new Promise(r => setTimeout(r, 0)); });
const render = () => act(() => root.render(createElement(DeviceGate, null, createElement('div', null, 'APP'))));

describe('DeviceGate', () => {
  it('bắt buộc + chưa tin cậy → trang đăng ký, không có app', async () => {
    getDeviceStatus.mockResolvedValue({ require_trusted: true, trusted: false });
    render(); await flush();
    expect(host.textContent).toContain('Thiết bị này chưa được tin cậy');
    expect(host.textContent).toContain('BẢNG THIẾT BỊ');
    expect(host.textContent).not.toContain('APP');
  });

  it('đã tin cậy, hoặc máy chủ không bắt buộc → vào app', async () => {
    getDeviceStatus.mockResolvedValue({ require_trusted: true, trusted: true });
    render(); await flush();
    expect(host.textContent).toBe('APP');
    act(() => root.unmount()); root = createRoot(host);
    getDeviceStatus.mockResolvedValue({ require_trusted: false, trusted: false });
    render(); await flush();
    expect(host.textContent).toBe('APP');
  });

  it('bị thu hồi giữa phiên (máy chủ trả 403) → chặn ngay', async () => {
    getDeviceStatus.mockResolvedValue({ require_trusted: true, trusted: true });
    render(); await flush();
    act(() => { window.dispatchEvent(new CustomEvent('emr:device-untrusted')); });
    expect(host.textContent).toContain('Thiết bị này chưa được tin cậy');
  });
});
