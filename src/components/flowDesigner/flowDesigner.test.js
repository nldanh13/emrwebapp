// Tab Thiết kế luồng: mô hình dữ liệu, tự lưu, chạy thử bấm qua luồng.
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { createElement, act } from 'react';
import { createRoot } from 'react-dom/client';
import FlowDesignerTab from './FlowDesignerTab.jsx';
import {
  addElement, addScreen, checkFlow, createSampleFlow, flowLinks, moveElement, normalizeFlow, removeScreen, updateElement,
} from './flowModel.js';
import { FLOW_STORAGE_KEY, loadStoredFlow, parseFlowFile, saveStoredFlow } from './flowStorage.js';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

describe('flowModel', () => {
  it('luồng mẫu đi được từ Đăng nhập tới mọi màn hình, không có cảnh báo', () => {
    const flow = createSampleFlow();
    expect(flow.screens.map(s => s.name)).toEqual(['Đăng nhập', 'Trang chính', 'Danh sách phòng khám', 'Danh sách điều trị nội trú']);
    expect(checkFlow(flow)).toEqual([]);
    expect(flowLinks(flow).filter(l => l.from === 'sc_home').map(l => l.to)).toEqual(['sc_clinic', 'sc_inpatient']);
  });

  it('xóa màn hình thì gỡ nối các ô trỏ tới nó và chuyển màn hình bắt đầu', () => {
    const flow = removeScreen(createSampleFlow(), 'sc_login');
    expect(flow.startId).toBe('sc_home');
    const home = removeScreen(createSampleFlow(), 'sc_home');
    expect(flowLinks(home).some(l => l.to === 'sc_home')).toBe(false);
  });

  it('không xóa màn hình cuối cùng', () => {
    const one = normalizeFlow({ screens: [{ id: 'a', name: 'A' }] });
    expect(removeScreen(one, 'a')).toBe(one);
  });

  it('báo màn hình chưa có ô dẫn tới', () => {
    const { flow } = addScreen(createSampleFlow(), 'Báo cáo');
    expect(checkFlow(flow)).toEqual(['Màn hình "Báo cáo" chưa có ô nào dẫn tới từ "Đăng nhập".']);
  });

  it('thêm, sửa, đổi chỗ ô; ô không nối được thì bỏ đích', () => {
    let { flow, elementId } = addElement(createSampleFlow(), 'sc_home', 'button');
    flow = updateElement(flow, 'sc_home', elementId, { label: 'Đăng xuất', target: 'sc_login' });
    let home = flow.screens.find(s => s.id === 'sc_home');
    expect(home.elements.at(-1)).toMatchObject({ label: 'Đăng xuất', target: 'sc_login' });
    flow = moveElement(flow, 'sc_home', elementId, -1);
    home = flow.screens.find(s => s.id === 'sc_home');
    expect(home.elements.at(-2).id).toBe(elementId);
    flow = updateElement(flow, 'sc_home', elementId, { type: 'input' });
    expect(flow.screens.find(s => s.id === 'sc_home').elements.find(e => e.id === elementId).target).toBe('');
  });

  it('dữ liệu hỏng thì bỏ qua, không ném lỗi', () => {
    expect(normalizeFlow(null)).toBeNull();
    expect(normalizeFlow({ screens: [] })).toBeNull();
    const f = normalizeFlow({ startId: 'zz', screens: [{ id: 'a', elements: [{ type: 'lạ', target: 'b' }] }, { id: 'a' }] });
    expect(f.screens).toHaveLength(1);
    expect(f.startId).toBe('a');
    expect(f.screens[0].elements[0]).toMatchObject({ type: 'heading', target: '' });
  });
});

describe('flowStorage', () => {
  it('lưu rồi đọc lại đúng luồng; kho bị chặn thì báo không lưu được', () => {
    const mem = new Map();
    const storage = { getItem: k => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, v) };
    const flow = createSampleFlow();
    expect(saveStoredFlow(flow, storage)).toBe(true);
    expect(loadStoredFlow(storage)).toEqual(flow);
    const blocked = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); } };
    expect(saveStoredFlow(flow, blocked)).toBe(false);
    expect(loadStoredFlow(blocked)).toBeNull();
  });

  it('tệp nhập sai định dạng thì báo lỗi tiếng Việt', () => {
    expect(parseFlowFile('không phải json').error).toContain('không đúng định dạng');
    expect(parseFlowFile('{"screens":[]}').error).toContain('không có màn hình');
    expect(parseFlowFile(JSON.stringify(createSampleFlow())).flow.screens).toHaveLength(4);
  });
});

describe('FlowDesignerTab', () => {
  let host; let root;
  beforeEach(() => { localStorage.clear(); vi.useFakeTimers(); });
  afterEach(() => { act(() => root.unmount()); host.remove(); vi.useRealTimers(); });
  const mount = () => { host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host); act(() => root.render(createElement(FlowDesignerTab, { toast: vi.fn() }))); };
  const click = el => act(() => { el.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
  const button = text => [...host.querySelectorAll('button')].find(b => b.textContent.trim() === text);

  it('chạy thử: Đăng nhập → Trang chính → Danh sách điều trị nội trú, quay lại được', () => {
    mount();
    click(host.querySelector('[role="radio"]:nth-child(2)'));
    expect(host.querySelector('h2').textContent).toBe('Đăng nhập');
    click(button('Đăng nhập'));
    expect(host.querySelector('h2').textContent).toBe('Trang chính');
    click([...host.querySelectorAll('button')].find(b => b.textContent.startsWith('Danh sách điều trị nội trú')));
    expect(host.querySelector('h2').textContent).toBe('Danh sách điều trị nội trú');
    expect(host.textContent).toContain('Tên người bệnh');
    click(button('Quay lại'));
    expect(host.querySelector('h2').textContent).toBe('Trang chính');
  });

  it('thêm màn hình thì tự lưu và hiện "Đã tự lưu"', () => {
    mount();
    click(button('Thêm'));
    expect(host.textContent).toContain('đang chờ tự lưu');
    act(() => { vi.advanceTimersByTime(1000); });
    expect(host.textContent).toContain('Đã tự lưu lúc');
    expect(JSON.parse(localStorage.getItem(FLOW_STORAGE_KEY)).screens).toHaveLength(5);
  });
});
