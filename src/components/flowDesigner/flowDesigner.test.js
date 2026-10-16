// Tab Thiết kế luồng: mô hình dữ liệu, tự lưu, chạy thử bấm qua luồng.
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { createElement, act } from 'react';
import { createRoot } from 'react-dom/client';
import FlowDesignerTab from './FlowDesignerTab.jsx';
import {
  addElement, addScreen, checkFlow, createSampleFlow, flowLinks, moveElement, normalizeFlow, removeScreen, screenSteps, updateElement,
} from './flowModel.js';
import { createFullAppFlow } from './appFlowSpec.js';
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

describe('luồng đầy đủ Data Hub', () => {
  const full = createFullAppFlow();
  it('mọi màn hình đi tới được từ Đăng nhập, không ô nào nối vào màn hình không có', () => {
    expect(full.startId).toBe('login');
    expect(checkFlow(full)).toEqual([]);
  });
  it('mọi tab trên menu đều có màn hình, mỗi màn hình đều ghi các bước và có ô', () => {
    const names = full.screens.map(s => s.name);
    for (const tab of ['Lấy dữ liệu', 'Xếp phòng', 'Nhập bệnh phòng', 'Ký tên ĐD HSBA', 'Lịch làm việc', 'Báo cáo ca trực',
      'Kiểm HSBA', 'Nhập VTYT', 'Trả HSBA', 'Nghỉ ốm', 'Phòng khám', 'Mẫu thủ thuật – PT', 'Người bệnh & tái khám',
      'Kho nghiên cứu', 'Danh mục VTYT', 'Danh mục thuốc', 'Kiểm tra cấu trúc EMR', 'Thiết lập tài khoản']) {
      expect(names).toContain(tab);
    }
    for (const s of full.screens) {
      expect(screenSteps(s).length, s.name).toBeGreaterThan(0);
      expect(s.elements.length, s.name).toBeGreaterThan(0);
      expect(s.group, s.name).not.toBe('');
    }
    const ids = full.screens.flatMap(s => s.elements.map(e => e.id));
    expect(new Set(ids).size).toBe(ids.length);
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

  const tile = text => [...host.querySelectorAll('button')].find(b => b.textContent.startsWith(text));
  const title = () => host.querySelector('h2').textContent;

  it('mở lần đầu là luồng đầy đủ; chạy thử Đăng nhập → Trang chính → Nhập bệnh phòng, có các bước, quay lại được', () => {
    mount();
    click(button('Chạy thử'));
    expect(title()).toBe('Đăng nhập Data Hub');
    expect(host.querySelector('[aria-label="Các bước ở màn hình này"] ol').children.length).toBeGreaterThan(2);
    click(button('Đăng nhập'));
    expect(title()).toBe('Trang chính');
    click(tile('Nhập bệnh phòng'));
    expect(title()).toBe('Nhập bệnh phòng');
    expect(host.textContent).toContain('Bấm thì: Chọn phạm vi rồi tiền kiểm.');
    click(button('Nhập hàng loạt'));
    expect(title()).toBe('Phạm vi nhập hàng loạt');
    click(button('Quay lại'));
    expect(title()).toBe('Nhập bệnh phòng');
  });

  it('mở tab là Sơ đồ: Đăng nhập → nút Đăng nhập → Trang chính → ô Nhập bệnh phòng → nút Nhập hàng loạt', () => {
    mount();
    const tree = host.querySelector('[aria-label="Sơ đồ luồng"]');
    expect(tree).not.toBeNull();
    const login = tree.querySelector('#flow-tree-login');
    expect(login.open).toBe(true);
    const home = login.querySelector('#flow-tree-home');
    expect(home).not.toBeNull();
    const ward = home.querySelector('#flow-tree-ward');
    expect(ward.textContent).toContain('Nhập hàng loạt');
    expect(ward.querySelector('#flow-tree-ward_scope')).not.toBeNull();
    // Màn hình chỉ bung một lần; chỗ khác dẫn tới thì ghi "đã có ở nhánh khác".
    expect(tree.querySelectorAll('#flow-tree-home').length).toBe(1);
    expect(tree.textContent).toContain('(đã có ở nhánh khác)');
    click(button('Mở hết'));
    expect([...tree.querySelectorAll('details')].every(d => d.open)).toBe(true);
  });

  it('nạp lại luồng đầy đủ sau khi luồng đã bị đổi', () => {
    localStorage.setItem(FLOW_STORAGE_KEY, JSON.stringify(createSampleFlow()));
    mount();
    expect(host.textContent).not.toContain('Kiểm HSBA');
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    click(button('Nạp luồng đầy đủ'));
    expect(host.textContent).toContain('Kiểm HSBA');
  });

  it('thêm màn hình thì tự lưu và hiện "Đã tự lưu"', () => {
    mount();
    click(button('Thiết kế'));
    click(button('Thêm'));
    expect(host.textContent).toContain('đang chờ tự lưu');
    act(() => { vi.advanceTimersByTime(1000); });
    expect(host.textContent).toContain('Đã tự lưu lúc');
    expect(JSON.parse(localStorage.getItem(FLOW_STORAGE_KEY)).screens).toHaveLength(createFullAppFlow().screens.length + 1);
  });
});
