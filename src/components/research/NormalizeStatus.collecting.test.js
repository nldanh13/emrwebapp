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

  it('đang thu thập + snapshot normalize bị nguồn thay đổi: chỉ báo chờ tự chuẩn hóa, không dựng thêm khung lỗi chặn', () => {
    const failed = {
      fetch: { pending_normalize: true, last_at: '2026-10-07T12:50:00Z' },
      normalize: { status: 'failed', integrity_status: 'failed_integrity', at: '2026-10-07T12:18:00Z', qa: { blocking: 1 } },
    };
    act(() => root.render(createElement(NormalizeStatus, { pipeline: failed, collecting: true, onNormalize: () => {} })));
    expect(host.textContent).toContain('tự chuẩn hóa');
    expect(host.textContent).not.toContain('lỗi chặn');
    expect(host.textContent).not.toContain('Chuẩn hóa lại');
  });

  it('lỗi chặn ở kiểm tra toàn vẹn: không nói "vẫn là bản cũ" vì bảng đã cập nhật', () => {
    const failed = { normalize: { status: 'failed', integrity_status: 'failed_integrity', at: '2026-10-07T00:17:00Z', qa: { blocking: 1 } } };
    act(() => root.render(createElement(NormalizeStatus, { pipeline: failed, onNormalize: () => {} })));
    expect(host.textContent).toContain('Chuẩn hóa xong nhưng có 1 lỗi chặn');
    expect(host.textContent).not.toContain('vẫn là bản chuẩn hóa thành công trước đó');
  });

  it('chuẩn hóa thật sự lỗi: vẫn báo lỗi và giữ bản cũ', () => {
    act(() => root.render(createElement(NormalizeStatus, { pipeline: { normalize: { status: 'failed' } }, onNormalize: () => {} })));
    expect(host.textContent).toContain('Chuẩn hóa lỗi');
  });
});
