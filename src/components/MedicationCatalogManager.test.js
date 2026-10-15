import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';

vi.mock('../api.js', () => ({
  getMedicationCatalog: vi.fn(async () => ({ medications: [
    { canonical: 'NEFOPAM MEDISOL 20MG/2ML', key: 'NEFOPAM MEDISOL 20MG/2ML',
      preparation: { dosage_form: 'solution', strength: '20mg/2ml', original_volume_ml: 2 },
      category: 'thuoc_tiem', routes: ['TMC', 'TTM'], active_ingredients: ['Nefopam Hydroclorid'],
      dilution: { solvent: 'NACL_0.9', apply: 'infusion_only' } },
  ] })),
  checkMedicationDilution: vi.fn(async () => ({ catalog: {}, builtin: [] })),
  getNewDrugs: vi.fn(async () => ({ drugs: [], pending: 0 })),
  getMedicationBuiltin: vi.fn(async () => ({ builtin: {} })),
  getCatalogCleanup: vi.fn(async () => ({ plan: [] })),
  createMedicationCatalog: vi.fn(),
  updateMedicationCatalog: vi.fn(),
  deleteMedicationCatalog: vi.fn(),
}));

const api = await import('../api.js');
const { default: MedicationCatalogManager } = await import('./MedicationCatalogManager.jsx');

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let host; let root;
const flush = async () => {
  for (let i = 0; i < 6; i++) await act(async () => { await Promise.resolve(); });
};
const radio = label => [...host.querySelectorAll('button[role="radio"]')].find(b => b.textContent === label);
const click = async el => {
  expect(el).toBeTruthy();
  await act(async () => { el.click(); });
  await flush();
};
const enter = async (input, value) => {
  await act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await flush();
};

beforeEach(() => {
  for (const f of Object.values(api)) f?.mockClear?.();
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); });

async function open() {
  await act(async () => { root.render(createElement(MedicationCatalogManager)); });
  await flush();
}

describe('Danh mục thuốc – luồng thống nhất', () => {
  it('mặc định chỉ hiện danh mục đang dùng, bảng 5 cột; không tải nguồn và công cụ nền', async () => {
    await open();
    expect(radio('Thuốc đã cấu hình')?.getAttribute('aria-checked')).toBe('true');
    expect(radio('Tìm & thêm thuốc')).toBeTruthy();
    expect(radio('Công cụ')).toBeTruthy();
    expect(host.textContent).toContain('NEFOPAM MEDISOL 20MG/2ML');
    expect(host.querySelectorAll('th')).toHaveLength(5);
    expect(host.textContent).not.toContain('185 mã thuốc tham khảo');
    expect(api.getMedicationCatalog).toHaveBeenCalledTimes(1);
    expect(api.getNewDrugs).not.toHaveBeenCalled();
    expect(api.getMedicationBuiltin).not.toHaveBeenCalled();
    expect(api.getCatalogCleanup).not.toHaveBeenCalled();
  });

  it('nguồn tham khảo chỉ xem, không tự lưu hoặc xóa thuốc cấu hình', async () => {
    await open();
    await click(radio('Tìm & thêm thuốc'));
    expect(host.textContent).toContain('185 mã thuốc tham khảo');
    expect(host.textContent).not.toContain('Thể tích truyền');
    expect(api.createMedicationCatalog).not.toHaveBeenCalled();
    await click(radio('Chưa nhận diện'));
    expect(api.getNewDrugs).toHaveBeenCalledTimes(1);
    await click(radio('Kiến thức sẵn có'));
    expect(api.getMedicationBuiltin).toHaveBeenCalledTimes(1);
    await click(radio('Danh mục bệnh viện'));
    expect(host.textContent).toContain('185 mã thuốc tham khảo');
    expect(api.getCatalogCleanup).not.toHaveBeenCalled();
    expect(api.createMedicationCatalog).not.toHaveBeenCalled();
  });

  it('tạo cấu hình từ danh mục BV là thao tác rõ ràng, chưa bấm Lưu thì không ghi', async () => {
    await open();
    await click(radio('Tìm & thêm thuốc'));
    await enter(host.querySelector('input[aria-label="Tìm danh mục thuốc bệnh viện"]'), '26.328.357');
    expect(host.textContent).toContain('Mizapenem 0,5g');
    await click([...host.querySelectorAll('button')].find(b => b.textContent === 'Tạo cấu hình'));
    expect(host.textContent).toContain('Mã thuốc BV:');
    expect(host.textContent).toContain('26.328.357');
    expect(host.textContent).toContain('Thông tin chế phẩm — không phải thể tích truyền');
    expect(api.createMedicationCatalog).not.toHaveBeenCalled();
    await click([...host.querySelectorAll('button')].find(b => b.textContent === 'Hủy'));
    expect(api.createMedicationCatalog).not.toHaveBeenCalled();
  });

  it('dọn trùng chỉ tải khi mở công cụ; chưa xác nhận không sửa danh mục', async () => {
    await open();
    await click(radio('Công cụ'));
    expect(api.getCatalogCleanup).not.toHaveBeenCalled();
    await click(radio('Dọn trùng'));
    expect(api.getCatalogCleanup).toHaveBeenCalledTimes(1);
    expect(host.textContent).toContain('Không thấy mục trùng');
    expect(api.deleteMedicationCatalog).not.toHaveBeenCalled();
    expect(api.updateMedicationCatalog).not.toHaveBeenCalled();
  });
});
