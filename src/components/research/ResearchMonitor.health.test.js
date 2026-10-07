// Bảng "Đánh giá dữ liệu" chỉ hiển thị mô hình màn hình từ máy chủ: ba trạng thái hành động
// Sẵn sàng / Máy xử lý / Cần bạn kiểm tra + một phần QA riêng; bấm "Xem danh sách" mới hiện lượt; lần đầu chưa có số thì hiện khung
// xám (skeleton) thay vì hiện từng ô một (UX_RULES mục 9).
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createElement, act } from 'react';
import { createRoot } from 'react-dom/client';
import { ResearchOperationDashboard } from './ResearchMonitor.jsx';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
let host; let root;
beforeEach(() => { host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host); });
afterEach(() => { act(() => root.unmount()); host.remove(); });

const screen = {
  generated_at: '2026-10-05T10:00:00Z',
  total: 5,
  counts: { done: 1, missing: 1, error: 1, waiting: 1, unmatched: 1 },
  user_counts: { ready: 1, automatic: 2, manual: 2 },
  parts: [{ key: 'xn', label: 'Xét nghiệm', total: 4, done: 1, failed: 1 }],
  plan: { max_attempts: 3 },
  rows: [
    { key: 'a', research_code: 'NC3', patient_name: 'LỖI', state: 'error', user_state: 'automatic', missing: 'Xét nghiệm', reason: 'Xét nghiệm: Hết thời gian chờ EMR' },
    { key: 'b', research_code: 'NC2', patient_name: 'THIẾU', state: 'missing', user_state: 'automatic', missing: 'Y lệnh', reason: 'Y lệnh: Chưa lấy' },
    { key: 'c', research_code: 'NC4', patient_name: 'GHÉP', state: 'unmatched', user_state: 'manual', missing: '', reason: 'Thời điểm vào viện khớp nhiều lượt' },
  ],
  qa: { blocking: [], warnings: [], review_count: 1, review_by_issue: { future_date: 1 }, review: [{ research_code: 'NC9', issue: 'future_date', detail: 'Ngày ở tương lai' }] },
  task: { stopped: null, last_task: null },
};

describe('ResearchOperationDashboard', () => {
  it('lần đầu chưa có số liệu: hiện khung xám, không hiện số lẻ tẻ', () => {
    act(() => root.render(createElement(ResearchOperationDashboard, { screen: null })));
    expect(host.querySelector('[aria-busy="true"]')).toBeTruthy();
    expect(host.textContent).not.toMatch(/\d/);
  });

  it('màn chính chỉ hiện ba trạng thái thống nhất + kiểm tra chất lượng', () => {
    act(() => root.render(createElement(ResearchOperationDashboard, { screen })));
    const t = host.textContent;
    expect(t).toContain('1. Trạng thái dữ liệu · 1/5 lượt sẵn sàng (20%)');
    expect(t).toContain('2. Kiểm tra chất lượng');
    for (const label of ['Sẵn sàng', 'Chờ máy xử lý', 'Cần bạn kiểm tra']) expect(t).toContain(label);
    expect(t).toContain('Cần làm:');
    expect(t).toContain('Ngày vào/ra viện ở tương lai: 1');
    expect(t).toContain('số liệu lúc');
    expect(t).not.toContain('Hết thời gian chờ EMR');
  });

  it('bấm "Xem danh sách" ở "Máy xử lý" thì gom phần thiếu và lỗi tự thử, không trộn nhóm cần người', () => {
    act(() => root.render(createElement(ResearchOperationDashboard, { screen })));
    const automaticBtn = [...host.querySelectorAll('button')]
      .filter(b => b.textContent === 'Xem danh sách')
      .find(b => b.closest('div').parentElement.textContent.includes('Chờ máy xử lý'));
    act(() => automaticBtn.click());
    expect(host.textContent).toContain('Xét nghiệm: Hết thời gian chờ EMR');
    expect(host.textContent).toContain('Y lệnh: Chưa lấy');
    expect(host.textContent).toContain('LỖI');
    expect(host.textContent).toContain('THIẾU');
    expect(host.textContent).not.toContain('GHÉP');
  });

  it('nút làm mới có chữ; ghi chú chuẩn hóa bằng tiếng Việt; ngày giờ một định dạng', () => {
    const withNotes = {
      ...screen,
      generated_at: '2026-10-05T14:14:00',
      qa: { ...screen.qa, generated_at: '2026-10-05T14:16:38', warnings: [
        { code: 'child_outside_encounter', table: 'lab_results', count: 5296, message: 'lab_results: 5296 dòng … (is_within_encounter = 0).' },
      ] },
    };
    act(() => root.render(createElement(ResearchOperationDashboard, { screen: withNotes, onRefresh: () => {} })));
    const t = host.textContent;
    expect(t).toContain('Làm mới số liệu');
    expect(t).not.toContain('↻');
    expect(t).toContain('Xét nghiệm 5.296');
    expect(t).not.toMatch(/lab_results|is_within_encounter/);
    expect(t).toContain('số liệu lúc 14:14 05/10/2026');
    expect(t).toContain('kiểm tra lúc 14:16 05/10/2026');
  });
});
