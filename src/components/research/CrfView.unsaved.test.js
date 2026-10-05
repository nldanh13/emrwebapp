// Phiếu nhập tay: đang nhập mà chọn Mã NC khác → tự lưu phiếu đang nhập trước khi chuyển (trước đây mất).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createElement, act } from 'react';
import { createRoot } from 'react-dom/client';

const CRF = {
  status: 'ok',
  form: { fields: [{ id: 'chieu_cao', label: 'Chiều cao', type: 'number', section: 'Nền' }], timepoints: [], updated_at: 'x' },
  samples: [
    { research_code: 'NC0001', values: {}, timepoints: {}, auto_values: {} },
    { research_code: 'NC0002', values: {}, timepoints: {}, auto_values: {} },
  ],
};
vi.mock('../../api.js', () => ({
  getResearchStudyCrf: vi.fn(async () => CRF),
  saveResearchStudyCrfEntry: vi.fn(async () => ({ status: 'ok', message: 'Đã lưu.' })),
}));
const api = await import('../../api.js');
const { CrfView } = await import('./CrfView.jsx');

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
let host; let root;
beforeEach(() => { host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host); });
afterEach(() => { act(() => root.unmount()); host.remove(); });
const flush = async () => { for (let i = 0; i < 6; i += 1) await act(async () => { await Promise.resolve(); }); };
const setInput = async (el, value) => {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  await act(async () => { setter.call(el, value); el.dispatchEvent(new Event('input', { bubbles: true })); });
};

describe('Phiếu nhập tay: không mất phần đang nhập', () => {
  it('nhập dở rồi chọn Mã NC khác → tự lưu phiếu cũ, báo "Chưa lưu" trước đó', async () => {
    await act(async () => { root.render(createElement(CrfView, { study: { id: 's1' }, toast: () => {} })); });
    await flush();
    await setInput(host.querySelector('input[aria-label="Chiều cao"]'), '155');
    expect(host.textContent).toContain('Chưa lưu');
    const nc2 = [...host.querySelectorAll('button')].find(b => b.textContent.startsWith('NC0002'));
    await act(async () => { nc2.click(); });
    await flush();
    expect(api.saveResearchStudyCrfEntry).toHaveBeenCalledWith('s1', 'NC0001', expect.objectContaining({ values: expect.objectContaining({ chieu_cao: '155' }) }));
  });
});
