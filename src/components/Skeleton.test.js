// Khung xám lần đầu mở tab (UX_RULES mục 9.7): báo "đang tải" cho trình đọc màn hình, mắt thường
// chỉ thấy khung đúng bố cục — không chữ "Đang tải…", không số lẻ tẻ.
import { describe, it, expect, afterEach } from 'vitest';
import { createElement, act } from 'react';
import { createRoot } from 'react-dom/client';
import { SkeletonScreen, SkeletonTable } from './Skeleton.jsx';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
let host; let root;
afterEach(() => { act(() => root.unmount()); host.remove(); });
const mount = (el) => { host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host); act(() => root.render(el)); };

describe('SkeletonScreen', () => {
  it('có trạng thái bận cho trình đọc màn hình, không hiện chữ hay số', () => {
    mount(createElement(SkeletonScreen, { label: 'Đang tải dữ liệu kiểm hồ sơ', stats: 4, rows: 3, cols: 4 }));
    const busy = host.querySelector('[role="status"][aria-busy="true"]');
    expect(busy.getAttribute('aria-label')).toBe('Đang tải dữ liệu kiểm hồ sơ');
    expect(host.textContent).toBe('');
  });

  it('bảng xám có đúng số dòng (tiêu đề + dữ liệu)', () => {
    mount(createElement(SkeletonTable, { rows: 3, cols: 4 }));
    expect(host.firstChild.children.length).toBe(4);
  });
});
