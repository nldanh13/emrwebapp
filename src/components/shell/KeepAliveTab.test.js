// Giữ tab khi chuyển tab: không dựng lại (giữ state), tab ẩn không vẽ lại khi App cập nhật,
// quay lại tab thì gọi useOnTabReturn và nhận props mới.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createElement as h, act, useState } from 'react';
import { createRoot } from 'react-dom/client';
import KeepAliveTab from './KeepAliveTab.jsx';
import { useOnTabReturn, useTabActive } from '../../hooks/useTabActivity.js';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
let host; let root;
beforeEach(() => { host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host); });
afterEach(() => { act(() => root.unmount()); host.remove(); });

const stats = { mounts: 0, renders: 0, returns: 0 };
function Screen({ label }) {
  const [typed] = useState(() => { stats.mounts += 1; return 'đang nhập dở'; });
  stats.renders += 1;
  const active = useTabActive();
  useOnTabReturn(() => { stats.returns += 1; });
  return h('p', null, `${label} · ${typed} · ${active ? 'hiện' : 'ẩn'}`);
}
const app = (tab, tick) => h('div', null,
  h(KeepAliveTab, { id: 'a', active: tab === 'a' }, h(Screen, { label: `A${tick}` })),
  h(KeepAliveTab, { id: 'b', active: tab === 'b' }, h('p', null, 'B')));

describe('KeepAliveTab', () => {
  it('chuyển tab không dựng lại; tab ẩn không vẽ lại; quay lại thì cập nhật', async () => {
    Object.assign(stats, { mounts: 0, renders: 0, returns: 0 });
    await act(async () => { root.render(app('a', 1)); });
    expect(host.textContent).toContain('A1 · đang nhập dở · hiện');
    await act(async () => { root.render(app('b', 1)); });
    const rendersAfterLeave = stats.renders;
    expect(host.querySelector('[data-tab="a"]').style.display).toBe('none');
    expect(host.textContent).toContain('ẩn');
    await act(async () => { root.render(app('b', 2)); });
    await act(async () => { root.render(app('b', 3)); });
    expect(stats.renders).toBe(rendersAfterLeave);
    await act(async () => { root.render(app('a', 4)); });
    expect(stats.mounts).toBe(1);
    expect(stats.returns).toBe(1);
    expect(host.textContent).toContain('A4 · đang nhập dở · hiện');
  });
});
