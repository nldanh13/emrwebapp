// Nhập hàng loạt: nút "Bỏ chọn tất cả" bỏ hết người bệnh để tích lại từng người;
// thay băng chưa lên mã hiện thành cảnh báo bên ngoài.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createElement, act } from 'react';
import { createRoot } from 'react-dom/client';
import InputRoomSelector from './InputRoomSelector.jsx';
import { getPatientNotices } from '../patientStatusNotice.jsx';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
let host; let root;
beforeEach(() => { host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host); });
afterEach(() => { act(() => root.unmount()); host.remove(); });
const button = (text) => [...host.querySelectorAll('button')].find(b => b.textContent.trim() === text);

describe('Phạm vi nhập hàng loạt', () => {
  it('có nút Bỏ chọn tất cả khi đang chọn người bệnh', async () => {
    const onDeselectAll = vi.fn();
    await act(async () => {
      root.render(createElement(InputRoomSelector, { rooms: ['P01'], selectedRooms: ['P01'], selectedPatientCount: 3, onDeselectAll }));
    });
    await act(async () => { button('Bỏ chọn tất cả').click(); });
    expect(onDeselectAll).toHaveBeenCalledTimes(1);
  });

  it('ẩn nút khi chưa chọn ai', async () => {
    await act(async () => {
      root.render(createElement(InputRoomSelector, { rooms: ['P01'], selectedRooms: [], selectedPatientCount: 0, onDeselectAll: () => {} }));
    });
    expect(button('Bỏ chọn tất cả')).toBeUndefined();
  });
});

describe('Cảnh báo thay băng chưa lên mã', () => {
  it('hiện nhãn cảnh báo bên ngoài', () => {
    const notices = getPatientNotices({ dressing_without_dvkt: true });
    expect(notices.map(n => n.label || n.text || n.title).join(' ')).toContain('Thay băng chưa lên mã');
  });
});
