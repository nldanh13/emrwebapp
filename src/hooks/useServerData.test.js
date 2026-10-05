// Kho dữ liệu dùng chung (UX_RULES mục 9): nhiều khung cùng khóa chỉ gọi máy chủ một lần và đổi
// cùng lúc; sự kiện máy chủ (invalidate) tải lại đúng khóa đang hiện; lỗi thì giữ bản cũ.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createElement, act } from 'react';
import { createRoot } from 'react-dom/client';
import { useServerData, invalidate, __resetServerData } from './useServerData.js';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
let host; let root;
beforeEach(() => { __resetServerData(); host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host); });
afterEach(() => { act(() => root.unmount()); host.remove(); });

const flush = () => act(async () => { await new Promise(r => setTimeout(r, 0)); });

function View({ k, fetcher, id }) {
  const q = useServerData(k, fetcher);
  return createElement('span', { 'data-id': id }, q.loading ? 'loading' : `${q.data?.n ?? '-'}${q.error ? '!' : ''}`);
}

describe('useServerData', () => {
  it('hai khung cùng khóa: một lần gọi, cùng số liệu', async () => {
    let calls = 0;
    const fetcher = async () => { calls += 1; return { n: 7 }; };
    act(() => root.render(createElement('div', null,
      createElement(View, { k: 'research:archive:x', fetcher, id: 'a' }),
      createElement(View, { k: 'research:archive:x', fetcher, id: 'b' }))));
    expect(host.textContent).toBe('loadingloading');
    await flush();
    expect(calls).toBe(1);
    expect(host.textContent).toBe('77');
  });

  it('invalidate theo tiền tố tải lại khóa đang hiện; lỗi thì giữ bản cũ', async () => {
    let n = 1; let fail = false;
    const fetcher = async () => { if (fail) throw new Error('mất mạng'); return { n: n++ }; };
    act(() => root.render(createElement(View, { k: 'research:archive:y', fetcher, id: 'a' })));
    await flush();
    expect(host.textContent).toBe('1');
    await act(() => invalidate('research:archive:'));
    expect(host.textContent).toBe('2');
    fail = true;
    await act(() => invalidate('research:archive:'));
    expect(host.textContent).toBe('2!');
    await act(() => invalidate('research:other:'));
    expect(host.textContent).toBe('2!');
  });
});
