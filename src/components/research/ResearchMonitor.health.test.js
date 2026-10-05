// Bảng "Đánh giá dữ liệu" chỉ hiển thị mô hình màn hình từ máy chủ: hai phần Đủ / Chính xác,
// mỗi con số có "Cần làm"; bấm "Xem danh sách" mới hiện lượt; lần đầu chưa có số thì hiện khung
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
  parts: [{ key: 'xn', label: 'Xét nghiệm', total: 4, done: 1, failed: 1 }],
  plan: { max_attempts: 3 },
  rows: [
    { key: 'a', research_code: 'NC3', patient_name: 'LỖI', state: 'error', missing: 'Xét nghiệm', reason: 'Xét nghiệm: Hết thời gian chờ EMR' },
    { key: 'b', research_code: 'NC2', patient_name: 'THIẾU', state: 'missing', missing: 'Y lệnh', reason: '' },
    { key: 'c', research_code: 'NC4', patient_name: 'GHÉP', state: 'unmatched', missing: '', reason: 'Thời điểm vào viện khớp nhiều lượt' },
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

  it('hai phần Đủ / Chính xác; các nhóm cộng lại đúng tổng; mỗi con số cần xử lý có "Cần làm"', () => {
    act(() => root.render(createElement(ResearchOperationDashboard, { screen })));
    const t = host.textContent;
    expect(t).toContain('1. Đủ dữ liệu: 1/5 lượt (20%)');
    expect(t).toContain('2. Chính xác');
    for (const label of ['Còn thiếu', 'Lỗi, sẽ tự thử lại', 'Chờ người xem', 'Chưa ghép chắc']) expect(t).toContain(label);
    expect(t).toContain('Cần làm:');
    expect(t).toContain('Ngày vào/ra viện ở tương lai: 1');
    expect(t).toContain('số liệu lúc');
    expect(t).not.toContain('Hết thời gian chờ EMR');
  });

  it('bấm "Xem danh sách" ở "Lỗi, sẽ tự thử lại" thì chỉ hiện lượt lỗi kèm lý do', () => {
    act(() => root.render(createElement(ResearchOperationDashboard, { screen })));
    const errorBtn = [...host.querySelectorAll('button')]
      .filter(b => b.textContent === 'Xem danh sách')
      .find(b => b.closest('div').parentElement.textContent.includes('Lỗi, sẽ tự thử lại'));
    act(() => errorBtn.click());
    expect(host.textContent).toContain('Xét nghiệm: Hết thời gian chờ EMR');
    expect(host.textContent).not.toContain('THIẾU');
  });
});
