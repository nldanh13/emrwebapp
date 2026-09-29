import { describe, expect, it, vi } from 'vitest';
import React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import HchanhVtytBatchPanel from './HchanhVtytBatchPanel.jsx';

vi.mock('../../api.js', () => ({
  getVtytCombos: vi.fn(async () => ({ combos:[] })),
  createVtytCombo: vi.fn(),
  updateVtytCombo: vi.fn(),
  deleteVtytCombo: vi.fn(),
}));

describe('HchanhVtytBatchPanel', () => {
  it('creates the first draft for every patient without manual selection', async () => {
    const onPreview = vi.fn();
    const cards = [
      { ma_bn:'001', ho_ten:'Người bệnh A' },
      { ma_bn:'002', ho_ten:'Người bệnh B' },
    ];
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    try {
      await act(async () => {
        root.render(React.createElement(HchanhVtytBatchPanel, { cards, draft:null, setDraft:() => {}, onPreview }));
      });
      const button = [...container.querySelectorAll('button')].find(node => node.textContent.includes('Tạo danh sách tất cả (2)'));
      expect(button).toBeTruthy();
      expect(container.querySelectorAll('input[type="checkbox"]')).toHaveLength(0);
      await act(async () => { button.click(); });
      expect(onPreview).toHaveBeenCalledWith(cards);
    } finally {
      act(() => root.unmount());
      container.remove();
    }
  });
});

