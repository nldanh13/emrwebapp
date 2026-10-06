// Bảng thiết bị tin cậy: máy chưa đăng ký → nút đăng ký; chờ duyệt → nhập mã 8 số; đã tin cậy →
// báo rõ, và nhớ đăng nhập.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createElement, act } from 'react';
import { createRoot } from 'react-dom/client';

const api = {
  getDeviceStatus: vi.fn(), listDevices: vi.fn(async () => ({ devices: [] })),
  registerDevice: vi.fn(), approveDevice: vi.fn(), revokeDevice: vi.fn(), rememberAuthOnTrustedDevice: vi.fn(),
};
vi.mock('../api.js', () => api);
let localId = '';
vi.mock('../utils/deviceTrust.js', () => ({
  ensureDeviceKey: vi.fn(async () => ({ kty: 'EC', crv: 'P-256', x: 'x', y: 'y' })),
  getDeviceId: vi.fn(async () => localId),
  setDeviceId: vi.fn(async (id) => { localId = id; }),
}));
const { default: DeviceTrustPanel } = await import('./DeviceTrustPanel.jsx');

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
let host; let root;
beforeEach(() => { host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host); localId = ''; Object.values(api).forEach(f => f.mockClear?.()); });
afterEach(() => { act(() => root.unmount()); host.remove(); });
const flush = () => act(async () => { await new Promise(r => setTimeout(r, 0)); });
const button = (text) => [...host.querySelectorAll('button')].find(b => b.textContent.includes(text));

describe('DeviceTrustPanel', () => {
  it('chưa đăng ký → đăng ký thiết bị này', async () => {
    api.getDeviceStatus.mockResolvedValue({ trusted: false, any_trusted: false });
    api.registerDevice.mockResolvedValue({ device: { id: 'd1', status: 'pending', name: 'Máy tính' } });
    act(() => root.render(createElement(DeviceTrustPanel, {})));
    await flush();
    await act(async () => { button('Đăng ký thiết bị này').click(); });
    await flush();
    expect(api.registerDevice).toHaveBeenCalled();
    expect(localId).toBe('d1');
  });

  it('chờ duyệt → nhập mã 8 số → tin cậy và nhớ đăng nhập', async () => {
    localId = 'd1';
    api.getDeviceStatus.mockResolvedValue({ trusted: false, any_trusted: false });
    api.listDevices.mockResolvedValue({ devices: [{ id: 'd1', name: 'Điện thoại', status: 'pending', created_at: '2026-10-06T01:00:00Z' }] });
    api.approveDevice.mockResolvedValue({ device: { id: 'd1', status: 'trusted' } });
    act(() => root.render(createElement(DeviceTrustPanel, {})));
    await flush();
    const input = host.querySelector('input[aria-label="Mã xác nhận 8 số"]');
    act(() => {
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(input, '12345678');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => { button('Xác nhận').click(); });
    await flush();
    expect(api.approveDevice).toHaveBeenCalledWith('d1', '12345678');
    expect(api.rememberAuthOnTrustedDevice).toHaveBeenCalledWith(true);
  });

  it('đã tin cậy → báo rõ thiết bị này', async () => {
    localId = 'd1';
    api.getDeviceStatus.mockResolvedValue({ trusted: true, device: { id: 'd1', name: 'Điện thoại', status: 'trusted' } });
    api.listDevices.mockResolvedValue({ devices: [{ id: 'd1', name: 'Điện thoại', status: 'trusted', created_at: '2026-10-06T01:00:00Z' }] });
    act(() => root.render(createElement(DeviceTrustPanel, {})));
    await flush();
    expect(host.textContent).toContain('Thiết bị này: Điện thoại');
    expect(host.textContent).toContain('(máy này)');
  });
});
