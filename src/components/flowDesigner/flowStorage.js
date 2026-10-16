// Lưu luồng đang thiết kế trên trình duyệt này (tự lưu, docs/UX_RULES.md mục 2.1).
// Kho trình duyệt có thể bị chặn (cửa sổ ẩn danh, đã xóa dữ liệu trang): mọi lần đọc/ghi đều bọc
// try/catch và trả kết quả để giao diện báo rõ, không im lặng mất thao tác.
import { normalizeFlow } from './flowModel.js';

export const FLOW_STORAGE_KEY = 'emr.flowDesigner.v1';

export function loadStoredFlow(storage = globalThis.localStorage) {
  try {
    const raw = storage?.getItem(FLOW_STORAGE_KEY);
    return raw ? normalizeFlow(JSON.parse(raw)) : null;
  } catch {
    return null;
  }
}

export function saveStoredFlow(flow, storage = globalThis.localStorage) {
  try {
    if (!storage) return false;
    storage.setItem(FLOW_STORAGE_KEY, JSON.stringify(flow));
    return true;
  } catch {
    return false;
  }
}

// Nhập từ tệp .json đã xuất: trả { flow } hoặc { error } bằng tiếng Việt.
export function parseFlowFile(text) {
  let data;
  try { data = JSON.parse(String(text || '')); } catch { return { error: 'Tệp không đúng định dạng luồng (.json). Chọn tệp đã xuất từ tab Thiết kế luồng.' }; }
  const flow = normalizeFlow(data);
  return flow ? { flow } : { error: 'Tệp không có màn hình nào. Chọn tệp đã xuất từ tab Thiết kế luồng.' };
}
