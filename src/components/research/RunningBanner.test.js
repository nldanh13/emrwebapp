// Ảnh người dùng 05/10/2026: "Đang thu thập tự động… (cập nhật 5185 giây trước) · Máy chủ xác nhận
// vẫn đang chạy" — câu thông báo chỉ ghi lúc bắt đầu nên số giây tăng mãi, trông như treo.
// Dải phải hiện ca đang lấy + tuổi tiến độ thật, đọc được ("x phút trước"), không lặp câu.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createElement, act } from 'react';
import { createRoot } from 'react-dom/client';
import { RunningBanner, formatAgo, STALE_PROGRESS_SECONDS } from './RunningBanner.jsx';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
let host; let root;
beforeEach(() => { host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host); });
afterEach(() => { act(() => root.unmount()); host.remove(); });

const iso = (secondsAgo) => new Date(Date.now() - secondsAgo * 1000).toISOString();
const render = (item) => act(() => root.render(createElement(RunningBanner, {
  running: [{ scope_key: 'archive', label: 'Thu thập tự động', since: iso(5185), ...item }],
  scopeName: () => 'Kho dữ liệu gốc', onOpen: () => {}, onCancel: () => {},
})));

describe('formatAgo', () => {
  it('đọc được bằng giây/phút/giờ', () => {
    expect(formatAgo(5)).toBe('5 giây trước');
    expect(formatAgo(125)).toBe('2 phút trước');
    expect(formatAgo(5185)).toBe('1 giờ 26 phút trước');
  });
});

describe('RunningBanner', () => {
  it('hiện ca đang lấy và tuổi của tiến độ thật, không dùng tuổi câu thông báo lúc bắt đầu', () => {
    render({
      task: { message: 'Đang thu thập tự động.', heartbeat_at: iso(5185) },
      progress: { ho_ten: 'KHƯU THÚY LOAN', ma_bn: '26038748', step: 'Đang lấy Y lệnh', updated_at: iso(4) },
    });
    const t = host.textContent;
    expect(t).toContain('Đang lấy: KHƯU THÚY LOAN (26038748) — Đang lấy Y lệnh');
    expect(t).toContain('tiến độ cập nhật 4 giây trước');
    expect(t).not.toMatch(/5185|backend/);
    expect((t.match(/chuyển/g) || []).length).toBe(1);
    expect(host.querySelector('[role="alert"]')).toBeNull();
  });

  it('quá lâu không có tiến độ mới thì cảnh báo kèm việc cần làm', () => {
    render({ progress: { ho_ten: 'A', ma_bn: '1', step: 'Đang lấy Hồ sơ', updated_at: iso(STALE_PROGRESS_SECONDS + 60) } });
    const alert = host.querySelector('[role="alert"]');
    expect(alert.textContent).toContain('không có tiến độ mới');
    expect(alert.textContent).toContain('Dừng');
  });
});
