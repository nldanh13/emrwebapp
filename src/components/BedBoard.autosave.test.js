// Xếp phòng tự lưu: xếp xong không cần bấm "Lưu xếp phòng"; rời tab khi còn thay đổi thì lưu ngay,
// để tab Lấy dữ liệu thấy phòng vừa xếp.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createElement, act } from 'react';
import { createRoot } from 'react-dom/client';

vi.mock('../api.js', () => ({
  getRaw: vi.fn(async () => [{ 'Mã BN': '1001', 'Họ tên': 'NGUYEN VAN A' }, { 'Mã BN': '1002', 'Họ tên': 'TRAN THI B' }]),
  getBoardData: vi.fn(async () => []),
  saveBoardData: vi.fn(async () => ({ status: 'ok' })),
  getRoomMismatches: vi.fn(async () => ({ mismatches: [] })),
  fixRooms: vi.fn(),
  downloadWardListPdf: vi.fn(),
}));
const api = await import('../api.js');
const { default: BedBoard } = await import('./BedBoard.jsx');

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
let host; let root;
beforeEach(() => { vi.useFakeTimers({ shouldAdvanceTime: true }); host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host); api.saveBoardData.mockClear(); });
afterEach(() => { act(() => root.unmount()); host.remove(); vi.useRealTimers(); });
const flush = async () => { for (let i = 0; i < 5; i += 1) await act(async () => { await Promise.resolve(); }); };

async function assignFirstPatientToP01() {
  await act(async () => { root.render(createElement(BedBoard, { toast: () => {} })); });
  await flush();
  const box = host.querySelector('aside[aria-label="Người bệnh chưa xếp phòng"] input[type="checkbox"]');
  await act(async () => { box.click(); });
  const room = host.querySelector('section[aria-label="Phòng P01"]');
  const btn = [...room.querySelectorAll('button')].find(b => b.textContent.includes('Xếp'));
  await act(async () => { btn.click(); });
}

describe('Xếp phòng tự lưu', () => {
  it('xếp người bệnh vào phòng → tự lưu sau giây lát, không cần bấm Lưu', async () => {
    await assignFirstPatientToP01();
    expect(api.saveBoardData).not.toHaveBeenCalled();
    await act(async () => { vi.advanceTimersByTime(900); });
    await flush();
    expect(api.saveBoardData).toHaveBeenCalledTimes(1);
    const saved = api.saveBoardData.mock.calls[0][0];
    expect(saved.find(r => r['Mã BN'] === '1001').Vi_Tri).toBe('P01');
    expect(host.textContent).toContain('Đã tự lưu lúc');
  });

  it('chuyển sang tab khác trước khi kịp tự lưu → lưu ngay và báo cho tab Lấy dữ liệu', async () => {
    const onSaved = vi.fn();
    window.addEventListener('emr:board-saved', onSaved);
    await assignFirstPatientToP01();
    await act(async () => { window.dispatchEvent(new CustomEvent('emr:tab-active', { detail: 'acquire' })); });
    await flush();
    expect(api.saveBoardData).toHaveBeenCalledTimes(1);
    expect(onSaved).toHaveBeenCalled();
    window.removeEventListener('emr:board-saved', onSaved);
  });
});
