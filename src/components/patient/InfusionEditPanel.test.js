import { describe, expect, it, vi } from 'vitest';
import { createElement, act } from 'react';
import { createRoot } from 'react-dom/client';
import InfusionEditPanel from './InfusionEditPanel.jsx';
import * as api from '../../api.js';

vi.mock('../../api.js', () => ({ updateInfusionItem: vi.fn() }));

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const sample = {
  thuoc: {
    dich_truyen: [
      { ten_thuoc: 'TEST-ONE', tg_bat_dau: '00:06 16/10/2026',
        tg_ket_thuc: '01:13 16/10/2026', gio_dung: '23 giờ',
        the_tich: 100, toc_do: 30, toc_do_inferred: true },
      { ten_thuoc: 'TEST-WITHOUT-HOUR', gio_dung: '', the_tich: 200, toc_do: 20,
        missing_infusion_time: true },
    ],
  },
};

describe('InfusionEditPanel', () => {
  it('separates missing-hour records, flags calculated drip rates and shows full next-day date', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    api.updateInfusionItem.mockClear();
    try {
      await act(async () => {
        root.render(createElement(InfusionEditPanel, {
          patientDay: sample, patientId: 'FAKE001',
          ngayLam: '15/10/2026', toast: () => {},
        }));
      });
      const content = host.textContent;
      expect(content).toContain('Chưa xác định giờ truyền (1)');
      expect(content).toContain('Các mốc truyền đã tính (1)');
      expect(content).toContain('00:06 16/10/2026');
      expect(content).toContain('23 giờ');
      expect(content).toContain('tốc độ phần mềm tự gán');
      expect(content).toContain('khác ngày đang chọn 15/10/2026');
      expect(content).toContain('TEST-WITHOUT-HOUR');
      expect(host.querySelectorAll('input').length).toBe(5);
      expect(host.querySelectorAll('input[type="time"]').length).toBe(1);
      expect(api.updateInfusionItem).not.toHaveBeenCalled();
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  });

  it('bổ sung giờ bắt đầu cho dòng chưa có giờ và gửi đúng giờ + ngày', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    api.updateInfusionItem.mockReset();
    api.updateInfusionItem.mockResolvedValue({ status: 'ok', schedule: { tg_bat_dau: '01:30 16/10/2026' },
      message: 'Đã bổ sung giờ' });
    const onSaved = vi.fn();
    try {
      await act(async () => {
        root.render(createElement(InfusionEditPanel, {
          patientDay: sample, patientId: 'FAKE001', ngayLam: '15/10/2026', toast: () => {}, onSaved,
        }));
      });
      const time = host.querySelector('input[type="time"]');
      const select = host.querySelector('select[aria-label="Ngày bắt đầu truyền cữ 1"]');
      expect([...select.options].map(o => o.value)).toEqual(['15/10/2026', '16/10/2026']);
      const setValue = (el, value) => {
        const proto = el.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
        Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
        el.dispatchEvent(new Event(el.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }));
      };
      await act(async () => { setValue(time, '01:30'); });
      await act(async () => { setValue(select, '16/10/2026'); });
      const btn = [...host.querySelectorAll('button')].find(b => b.textContent.includes('Bổ sung giờ'));
      expect(btn).toBeTruthy();
      await act(async () => { btn.click(); });
      expect(api.updateInfusionItem).toHaveBeenCalledTimes(1);
      const [bn, day, match, updates] = api.updateInfusionItem.mock.calls[0];
      expect([bn, day, match.ten_thuoc]).toEqual(['FAKE001', '15/10/2026', 'TEST-WITHOUT-HOUR']);
      expect(updates).toEqual({ tg_bat_dau: '01:30 16/10/2026' });
      expect(onSaved).toHaveBeenCalled();
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  });

  it('y lệnh x2 không ghi giờ: hiện 2 ô giờ và gửi đủ 2 cữ', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    api.updateInfusionItem.mockReset();
    api.updateInfusionItem.mockResolvedValue({ status: 'ok', schedule: {}, schedules: [{}, {}], message: 'ok' });
    const day = { thuoc: { dich_truyen: [{ ten_thuoc: 'TEST-X2', gio_dung: '', the_tich: 100, toc_do: 30,
      missing_infusion_time: true, raw_usage_line: 'Pha Natriclorid 0.9% 100ml x2 TTM 30g/ph | Thuốc pha: Natri clorid 0,9%' }] } };
    try {
      await act(async () => {
        root.render(createElement(InfusionEditPanel, {
          patientDay: day, patientId: 'FAKE001', ngayLam: '15/10/2026', toast: () => {}, onSaved: () => {},
        }));
      });
      const times = host.querySelectorAll('input[type="time"]');
      expect(times.length).toBe(2);
      expect(host.textContent).toContain('gợi ý 2 cữ');
      const setValue = (el, value) => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, value);
        el.dispatchEvent(new Event('input', { bubbles: true }));
      };
      await act(async () => { setValue(times[0], '08:00'); });
      const btn = () => [...host.querySelectorAll('button')].find(b => b.textContent.includes('Bổ sung giờ'));
      expect(btn().disabled).toBe(true);
      await act(async () => { setValue(times[1], '20:00'); });
      await act(async () => { btn().click(); });
      expect(api.updateInfusionItem.mock.calls[0][3]).toEqual({ tg_bat_dau: ['08:00 15/10/2026', '20:00 15/10/2026'] });
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  });
});
