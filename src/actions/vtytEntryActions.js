import { RUN_MODES } from '../config/constants.js';
import { setSelectValue, setValue, wait } from '../utils/dom.js';

function requireExecute(mode, action) {
  if (mode !== RUN_MODES.EXECUTE) {
    return { blocked: true, status: 'preview_only', message: `Không thực hiện ${action}; cần mode = RUN_MODES.EXECUTE.` };
  }
  return { blocked: false };
}

export function setVTYTOrderSearchRange({ from, to }, root = document) {
  const okFrom = setValue('#dtTuNgayYL', from, root);
  const okTo = setValue('#dtDenNgayYL', to, root);
  return { status: okFrom && okTo ? 'ok' : 'warning', from, to };
}

export function searchVTYTOrders({ mode = RUN_MODES.PREVIEW } = {}, root = document) {
  const gate = requireExecute(mode, 'bấm Tìm kiếm y lệnh VTYT');
  if (gate.blocked) return gate;
  const btn = root.querySelector('#btnTimKiem');
  if (btn) btn.click();
  else if (typeof window.DrawDSYLenh === 'function') window.DrawDSYLenh();
  else return { status: 'error', message: 'Không tìm thấy nút Tìm kiếm hoặc hàm DrawDSYLenh.' };
  return { status: 'ok' };
}

export function checkYLenhForVTYT(yLenhId, { mode = RUN_MODES.PREVIEW } = {}, root = document) {
  const gate = requireExecute(mode, 'tick checkbox y lệnh');
  if (gate.blocked) return gate;
  const checkbox = root.querySelector(`.chkYlenh[value="${yLenhId}"]`);
  if (!checkbox) return { status: 'error', message: 'Không tìm thấy checkbox y lệnh.' };
  if (!checkbox.checked) checkbox.click();
  return { status: 'ok', y_lenh_id: yLenhId };
}

export function selectLoaiKeDuTru({ mode = RUN_MODES.PREVIEW } = {}, root = document) {
  const gate = requireExecute(mode, 'chọn Loại kê = Dự trù');
  if (gate.blocked) return gate;
  const ok = setSelectValue('#txtLoaiKe', '3', root);
  if (typeof window.changeLoaiDD === 'function') window.changeLoaiDD('3');
  return { status: ok ? 'ok' : 'error', loai_ke: 'Dự trù' };
}

export function checkNguoiBenhTuTra({ mode = RUN_MODES.PREVIEW } = {}, root = document) {
  const gate = requireExecute(mode, 'tick Tự trả ngoài BHYT');
  if (gate.blocked) return gate;
  const el = root.querySelector('#ckboxNguoiBenhTT');
  if (!el) return { status: 'error', message: 'Không tìm thấy #ckboxNguoiBenhTT.' };
  if (window.$ && typeof window.$(el).iCheck === 'function') window.$(el).iCheck('check');
  else (el.closest('.icheckbox_square-green') || el).click();
  return { status: 'ok' };
}

export async function selectVTYTItem(keyword, { mode = RUN_MODES.PREVIEW } = {}, root = document) {
  const gate = requireExecute(mode, `chọn vật tư ${keyword}`);
  if (gate.blocked) return gate;
  const select2Box = root.querySelector('#select2-txtHang-container');
  if (!select2Box) return { status: 'error', message: 'Không tìm thấy ô Thuốc/VTYT.' };
  select2Box.click();
  await wait(300);
  const searchInput = root.querySelector('.select2-container--open .select2-search__field') || document.querySelector('.select2-container--open .select2-search__field');
  if (!searchInput) return { status: 'error', message: 'Không tìm thấy ô tìm kiếm Select2.' };
  searchInput.value = keyword;
  searchInput.dispatchEvent(new Event('input', { bubbles: true }));
  await wait(500);
  const options = Array.from(document.querySelectorAll('#select2-txtHang-results .select2-results__option'));
  const matched = options.find((option) => option.innerText.toLowerCase().includes(String(keyword).toLowerCase()));
  if (!matched) return { status: 'not_found', message: `Không tìm thấy vật tư: ${keyword}` };
  matched.click();
  return { status: 'ok', selected: matched.innerText.replace(/\s+/g, ' ').trim() };
}

export function setVTYTQuantityAndAdd(quantity, { mode = RUN_MODES.PREVIEW } = {}, root = document) {
  const gate = requireExecute(mode, `nhập số lượng ${quantity} và bấm Thêm`);
  if (gate.blocked) return gate;
  const qtyInput = root.querySelector('#txtSoLuong');
  if (!qtyInput) return { status: 'error', message: 'Không tìm thấy #txtSoLuong.' };
  qtyInput.value = String(quantity);
  qtyInput.dispatchEvent(new Event('input', { bubbles: true }));
  qtyInput.dispatchEvent(new Event('change', { bubbles: true }));
  const addBtn = root.querySelector('#btnThemVatTuThuong');
  if (!addBtn || addBtn.disabled) return { status: 'error', message: 'Nút Thêm chưa sẵn sàng.' };
  addBtn.click();
  return { status: 'ok', quantity };
}

export async function addOneVTYTItem({ searchKeyword, quantity }, { mode = RUN_MODES.PREVIEW } = {}, root = document) {
  const selected = await selectVTYTItem(searchKeyword, { mode }, root);
  if (selected.status !== 'ok') return selected;
  const added = setVTYTQuantityAndAdd(quantity, { mode }, root);
  return { ...added, item: selected.selected };
}

export function confirmVTYTEntry({ mode = RUN_MODES.PREVIEW } = {}, root = document) {
  const gate = requireExecute(mode, 'bấm Xác nhận VTYT');
  if (gate.blocked) return gate;
  const btn = Array.from(root.querySelectorAll('button')).find((x) => x.innerText.trim() === 'Xác nhận' && x.getAttribute('onclick')?.includes('OnXacNhan'));
  if (!btn) return { status: 'error', message: 'Không tìm thấy nút Xác nhận.' };
  btn.click();
  return { status: 'ok' };
}
