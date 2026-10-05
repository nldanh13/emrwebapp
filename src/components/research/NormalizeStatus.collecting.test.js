// Ảnh người dùng: đang thu thập (đủ 10%) mà khung vàng to giục "Chuẩn hóa ngay" — chuẩn hóa lúc
// này thì vài phút sau lại cũ; thu thập xong máy đã tự chuẩn hóa.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createElement, act } from 'react';
import { createRoot } from 'react-dom/client';
import { NormalizeStatus } from './NormalizeStatus.jsx';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
let host; let root;
beforeEach(() => { host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host); });
afterEach(() => { act(() => root.unmount()); host.remove(); });

const pipeline = { fetch: { pending_normalize: true, last_at: '2026-10-05T09:49:00Z' }, normalize: { at: '2026-10-04T19:14:00Z', duration_ms: 94000 } };

describe('NormalizeStatus', () => {
  it('đang thu thập: báo sẽ tự chuẩn hóa, không có nút Chuẩn hóa ngay', () => {
    act(() => root.render(createElement(NormalizeStatus, { pipeline, collecting: true, onNormalize: () => {} })));
    expect(host.textContent).toContain('tự chuẩn hóa');
    expect(host.textContent).not.toContain('Chuẩn hóa ngay');
  });

  it('không thu thập: vẫn nhắc và có nút Chuẩn hóa ngay', () => {
    act(() => root.render(createElement(NormalizeStatus, { pipeline, collecting: false, onNormalize: () => {} })));
    expect(host.textContent).toContain('Chuẩn hóa ngay');
  });
});
