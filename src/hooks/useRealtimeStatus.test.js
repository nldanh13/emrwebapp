// Máy chủ báo "màn hình X đổi" qua kênh sự kiện: chỉ màn hình đúng khóa tải lại (UX_RULES mục 9).
import { describe, it, expect, afterEach } from 'vitest';
import { createElement, act } from 'react';
import { createRoot } from 'react-dom/client';
import { useScreenChanged, useRealtimeConnected } from './useRealtimeStatus.js';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
let host; let root;
afterEach(() => { if (root) act(() => root.unmount()); host?.remove(); root = null; });

function mount(el) {
  host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host);
  act(() => root.render(el));
}

describe('useScreenChanged', () => {
  it('chỉ gọi khi đúng khóa màn hình', () => {
    const calls = [];
    function View() { useScreenChanged('clinic-monitor', d => calls.push(d.key)); return null; }
    mount(createElement(View));
    act(() => {
      window.dispatchEvent(new CustomEvent('emr:screen-changed', { detail: { key: 'hchanh-dashboard' } }));
      window.dispatchEvent(new CustomEvent('emr:screen-changed', { detail: { key: 'clinic-monitor' } }));
    });
    expect(calls).toEqual(['clinic-monitor']);
  });
});

describe('useRealtimeConnected', () => {
  it('theo trạng thái kênh sự kiện: nối thì true, mất nối thì false (hẹn giờ dự phòng chạy lại)', () => {
    function View() { return createElement('span', null, useRealtimeConnected() ? 'on' : 'off'); }
    mount(createElement(View));
    act(() => window.dispatchEvent(new CustomEvent('emr:realtime-status', { detail: { connected: true } })));
    expect(host.textContent).toBe('on');
    act(() => window.dispatchEvent(new CustomEvent('emr:realtime-status', { detail: { connected: false } })));
    expect(host.textContent).toBe('off');
  });
});
