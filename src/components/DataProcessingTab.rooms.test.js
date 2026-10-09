// Lấy dữ liệu: phòng vừa xếp (tự lưu ở tab Xếp phòng) hiện ngay để chọn, không mất phòng đang chọn
// khi màn hình cập nhật ngầm.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createElement, act } from 'react';
import { createRoot } from 'react-dom/client';

let BOARD = [{ 'Mã BN': '1001', 'Họ tên': 'A', Vi_Tri: 'P01' }];
vi.mock('../api.js', () => ({
  getRaw: vi.fn(async () => [{ 'Mã BN': '1001' }, { 'Mã BN': '1002' }]),
  getBoardData: vi.fn(async () => BOARD),
  getDataInfo: vi.fn(async () => ({ raw: { exists: true } })),
  getDataSessions: vi.fn(async () => ({ sessions: [] })),
  getEmrBridgeStatus: vi.fn(async () => ({ bridge: { enabled: false, helpers: [] } })),
}));
const api = await import('../api.js');
const { default: DataProcessingTab } = await import('./DataProcessingTab.jsx');

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
let host; let root;
beforeEach(() => { host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host); });
afterEach(() => { act(() => root.unmount()); host.remove(); });
const flush = async () => { for (let i = 0; i < 5; i += 1) await act(async () => { await Promise.resolve(); }); };
const roomLabels = () => [...new Set([...host.querySelectorAll('label')].map(l => l.textContent.trim()).filter(t => /^P\d+/.test(t)))];

describe('Lấy dữ liệu: chọn phòng', () => {
  it('phòng vừa lưu ở Xếp phòng hiện ngay; phòng đang chọn được giữ khi cập nhật', async () => {
    await act(async () => { root.render(createElement(DataProcessingTab, { toast: () => {}, workDateRange: { from: '2026-10-05', to: '2026-10-05' } })); });
    await flush();
    const chooseRooms = [...host.querySelectorAll('button, [role="radio"]')].find(b => b.textContent.trim() === 'Chọn phòng');
    await act(async () => { chooseRooms.click(); });
    expect(roomLabels()).toEqual(['P01']);
    await act(async () => { host.querySelector('label input[type="checkbox"]').click(); });

    BOARD = [{ 'Mã BN': '1001', Vi_Tri: 'P01' }, { 'Mã BN': '1002', Vi_Tri: 'P05' }];
    await act(async () => { window.dispatchEvent(new CustomEvent('emr:board-saved')); });
    await flush();
    expect(api.getBoardData).toHaveBeenCalledTimes(2);
    expect(roomLabels()).toEqual(['P01', 'P05']);
    expect(host.textContent).toContain('1 phòng đã chọn');
  });
});
