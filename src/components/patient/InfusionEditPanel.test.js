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
      expect(host.querySelectorAll('input').length).toBe(4);
      expect(api.updateInfusionItem).not.toHaveBeenCalled();
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  });
});
