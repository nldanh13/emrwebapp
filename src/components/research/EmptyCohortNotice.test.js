// Nghiên cứu 0 mẫu (lưu lỗi lần trước): nút nạp lại danh sách mẫu theo điều kiện đã lưu.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createElement, act } from 'react';
import { createRoot } from 'react-dom/client';

vi.mock('../../api.js', () => ({ importResearchFromArchive: vi.fn(async () => ({ status: 'ok', count: 80 })) }));
const api = await import('../../api.js');
const { EmptyCohortNotice, studyHasSavedSelection } = await import('./EmptyCohortNotice.jsx');

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
let host; let root;
beforeEach(() => { host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host); });
afterEach(() => { act(() => root.unmount()); host.remove(); });

const selection = { conditions: [{ name: 'ingredient:Acid Zoledronic', operator: 'not_empty' }] };

describe('EmptyCohortNotice', () => {
  it('chỉ cho nạp khi nghiên cứu đã lưu điều kiện chọn vào (tránh nạp cả kho)', () => {
    expect(studyHasSavedSelection({ variable_selection: selection })).toBe(true);
    expect(studyHasSavedSelection({ variable_selection: { conditions: [{ exclude: true }] } })).toBe(false);
    expect(studyHasSavedSelection({})).toBe(false);
  });

  it('nghiên cứu 0 mẫu có điều kiện: bấm nạp, gọi API và tải lại', async () => {
    const onImported = vi.fn(async () => {});
    const toast = vi.fn();
    await act(async () => { root.render(createElement(EmptyCohortNotice, { study: { id: 'zol', cohort_count: 0, variable_selection: selection }, onImported, toast })); });
    expect(host.textContent).toContain('chưa có mẫu');
    const btn = [...host.querySelectorAll('button')].find(b => b.textContent.includes('Nạp danh sách mẫu từ kho'));
    await act(async () => { btn.click(); });
    expect(api.importResearchFromArchive).toHaveBeenCalledWith('zol', {});
    expect(onImported).toHaveBeenCalled();
    expect(toast.mock.calls[0][0]).toContain('80 mẫu');
  });

  it('nghiên cứu đã có mẫu thì không hiện; không có điều kiện thì không có nút', async () => {
    await act(async () => { root.render(createElement(EmptyCohortNotice, { study: { id: 'a', cohort_count: 12, variable_selection: selection } })); });
    expect(host.textContent).toBe('');
    await act(async () => { root.render(createElement(EmptyCohortNotice, { study: { id: 'b', cohort_count: 0 } })); });
    expect(host.textContent).toContain('không lưu điều kiện');
    expect(host.querySelector('button')).toBeNull();
  });
});
