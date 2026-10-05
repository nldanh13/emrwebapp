// Bảng theo dõi Kho nghiên cứu hiện hai phần Đủ / Chính xác; mỗi con số có "Cần làm";
// bấm "Xem danh sách" mới hiện lượt liên quan; "Chưa ghép" chỉ còn trong Chi tiết kỹ thuật.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createElement, act } from 'react';
import { createRoot } from 'react-dom/client';
import { ResearchOperationDashboard } from './ResearchMonitor.jsx';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
let host; let root;
beforeEach(() => { host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host); });
afterEach(() => { act(() => root.unmount()); host.remove(); });

const snapshot = {
  exists: true,
  total: 4,
  counts: { done: 1, missing: 1, waiting: 0, error: 1, running: 1 },
  modules: [{ key: 'xn_cdha', label: 'XN & CĐHA', total: 4, done: 1 }],
  unmatched_progress: 553,
  rows: [
    { key: 'a', sample: 'NC3', research_code: 'NC3', patient_name: 'LỖI', state: 'error', missing: 'XN & CĐHA', last_error: 'Không mở được hồ sơ' },
    { key: 'b', sample: 'NC2', research_code: 'NC2', patient_name: 'THIẾU', state: 'missing', missing: 'Y lệnh' },
  ],
  qa: { blocking: [], warnings: [], review_count: 1, review_by_issue: { future_date: 1 }, review: [{ research_code: 'NC9', issue: 'future_date', detail: 'Ngày ở tương lai' }] },
};

describe('ResearchOperationDashboard', () => {
  it('hai phần Đủ / Chính xác, mỗi con số cần xử lý có "Cần làm"', () => {
    act(() => root.render(createElement(ResearchOperationDashboard, { snapshot })));
    const t = host.textContent;
    expect(t).toContain('1. Đủ dữ liệu: 1/4 lượt (25%)');
    expect(t).toContain('2. Chính xác');
    expect(t).toContain('Cần làm:');
    expect(t).toContain('Ngày vào/ra viện ở tương lai: 1');
    // Không còn bảng lượt hiện sẵn; "Chưa ghép" chỉ nằm trong chi tiết kỹ thuật.
    expect(t).not.toContain('Không mở được hồ sơ');
    expect(host.querySelector('details').textContent).toContain('553 mục tiến độ');
  });

  it('bấm "Xem danh sách" ở Lấy bị lỗi thì chỉ hiện lượt lỗi kèm lý do', () => {
    act(() => root.render(createElement(ResearchOperationDashboard, { snapshot })));
    const buttons = [...host.querySelectorAll('button')].filter(b => b.textContent === 'Xem danh sách');
    const errorBtn = buttons.find(b => b.closest('div').parentElement.textContent.includes('Lấy bị lỗi'));
    act(() => errorBtn.click());
    expect(host.textContent).toContain('Không mở được hồ sơ');
    expect(host.textContent).not.toContain('THIẾU');
  });
});
