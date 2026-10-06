// "Chưa rõ giờ" là việc phải làm trước (hỏi lại bác sĩ) nên đứng ĐẦU cột, ở cả hai vai trò.
// Lỗi cũ: mục này nằm cuối trang, phải cuộn qua mọi mục mới thấy.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createElement, act } from 'react';
import { createRoot } from 'react-dom/client';
import { DutyReport } from './DutyReport.jsx';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
let host; let root;
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date(2026, 9, 6, 11, 30, 0)); host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host); });
afterEach(() => { act(() => root.unmount()); host.remove(); localStorage.clear(); vi.useRealTimers(); });

const DATE = '06/10/2026'; // Thứ 3, ngày làm
const rows = [
  { id: 'a', date: DATE, time: '08:00', patientName: 'A', room: 'P11', drugName: 'PARACETAMOL', route: 'TTM', quantity: 1, unit: 'túi' },
  { id: 'b', date: DATE, time: '20:00', patientName: 'A', room: 'P11', drugName: 'AMIPAREN', route: 'TTM', quantity: 1, unit: 'túi' },
  { id: 'c', date: DATE, time: '—', noTime: true, patientName: 'B', room: 'P11', drugName: 'VINSOLON', route: 'TMC', quantity: 1, unit: 'ống' },
];

function headings() {
  return [...host.querySelectorAll('h3')].map(h => h.textContent);
}

describe('DutyReport: mục Chưa rõ giờ đứng đầu', () => {
  for (const role of ['work', 'duty']) {
    it(`vai trò ${role === 'work' ? 'Người làm bệnh phòng' : 'Người trực'}`, () => {
      localStorage.setItem('emr_report_role_v1', JSON.stringify(role));
      act(() => root.render(createElement(DutyReport, { date: DATE, rows, nurseState: {} })));
      expect(headings()[0]).toBe('Chưa rõ giờ');
      expect(host.textContent).toContain('VINSOLON');
    });
  }
});

describe('DutyReport: giờ suy từ chữ buổi được ghi rõ', () => {
  it('dòng có timeGuess hiện "giờ theo chữ … trong y lệnh"', () => {
    localStorage.setItem('emr_report_role_v1', JSON.stringify('duty'));
    const guessed = [{ id: 'g', date: DATE, time: '12:00', timeGuess: 'trưa', patientName: 'C', room: 'P11', drugName: 'Permethrine', route: 'Khác', quantity: 1, unit: 'chai' }];
    act(() => root.render(createElement(DutyReport, { date: DATE, rows: guessed, nurseState: {} })));
    expect(host.textContent).toContain('giờ theo chữ "trưa" trong y lệnh');
    expect(headings()).not.toContain('Chưa rõ giờ');
  });
});
