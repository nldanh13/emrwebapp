// Mục "Gắn hoạt chất" trong Danh mục thuốc: hiện tên thuốc trong kho chưa có hoạt chất,
// chọn nhiều tên rồi gắn một hoạt chất (react-dom trực tiếp, API giả).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createElement, act } from 'react';
import { createRoot } from 'react-dom/client';

const INVENTORY = {
  status: 'ok', run_id: 'r1', unmapped_encounters: 7,
  counts: { total: 3, mapped: 1, catalog_no_ingredient: 1, not_in_catalog: 1 },
  items: [
    { key: 'osteozol', name: 'Osteozol', variants: ['Osteozol 5mg/100ml 1 chai'], rows: 9, encounters: 5, patients: 4, status: 'not_in_catalog', active_ingredients: [], catalog_keys: [] },
    { key: 'zometa', name: 'Zometa', variants: ['Zometa 4mg'], rows: 3, encounters: 2, patients: 2, status: 'catalog_no_ingredient', active_ingredients: [], catalog_keys: ['ZOMETA 4MG'] },
    { key: 'aclasta', name: 'Aclasta', variants: ['Aclasta 5mg'], rows: 20, encounters: 12, patients: 10, status: 'mapped', active_ingredients: ['Acid Zoledronic'], catalog_keys: ['ACLASTA'] },
  ],
};

vi.mock('../api.js', () => ({
  getArchiveDrugNames: vi.fn(async () => INVENTORY),
  assignMedicationIngredient: vi.fn(async () => ({ status: 'ok', changes: [{ action: 'create', canonical: 'Osteozol' }, { action: 'update', canonical: 'ZOMETA 4MG' }] })),
}));

const api = await import('../api.js');
const { default: DrugNameIngredientPanel } = await import('./DrugNameIngredientPanel.jsx');

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
let host;
let root;
beforeEach(() => { host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host); });
afterEach(() => { act(() => root.unmount()); host.remove(); });

const flush = async () => { await act(async () => { await Promise.resolve(); await Promise.resolve(); }); };
const setInput = (el, value) => {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  setter.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
};

describe('DrugNameIngredientPanel', () => {
  it('mặc định hiện tên chưa gắn hoạt chất, chọn nhiều tên rồi gắn một hoạt chất', async () => {
    const onChanged = vi.fn(async () => {});
    await act(async () => { root.render(createElement(DrugNameIngredientPanel, { medications: [{ canonical: 'ACLASTA', active_ingredients: ['Acid Zoledronic'] }], onChanged })); });
    await flush();
    const text = host.textContent;
    expect(text).toContain('Osteozol');
    expect(text).toContain('Zometa');
    expect(text).not.toContain('Aclasta 5mg'); // đã gắn → ẩn ở bộ lọc mặc định
    expect(text).toContain('chưa');
    expect(host.querySelector('#known-active-ingredients option').value).toBe('Acid Zoledronic');

    await act(async () => { host.querySelector('input[aria-label="Chọn tất cả tên đang hiện"]').click(); });
    await act(async () => { setInput(host.querySelector('input[aria-label="Hoạt chất cần gắn"]'), 'Acid Zoledronic'); });
    const button = [...host.querySelectorAll('button')].find(b => b.textContent === 'Gắn hoạt chất');
    expect(button.disabled).toBe(false);
    await act(async () => { button.click(); });
    await flush();
    expect(api.assignMedicationIngredient).toHaveBeenCalledWith({
      active_ingredient: 'Acid Zoledronic',
      items: [{ name: 'Osteozol', catalog_keys: [] }, { name: 'Zometa', catalog_keys: ['ZOMETA 4MG'] }],
    });
    expect(onChanged).toHaveBeenCalled();
    expect(host.textContent).toContain('Dùng hoạt chất: Acid Zoledronic');
  });
});
