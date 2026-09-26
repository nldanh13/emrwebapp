// MODEL ĐƯỜNG DÙNG DUY NHẤT phía giao diện.
// Dữ liệu: config/routes.json (worker Python và máy chủ Node đọc cùng file) + phần
// người dùng tự cài (config/routes.custom.json), nạp qua /api/routes khi mở app.
// Logic: src/config/routeModelCore.cjs (máy chủ Node dùng cùng file).

import BASE_TABLE from '../../config/routes.json' with { type: 'json' };
import core from './routeModelCore.cjs';

let current = core.createRouteModel(core.mergeRouteTable(BASE_TABLE, { routes: [] }));
const listeners = new Set();

// Áp bảng đã gộp do máy chủ trả về (GET/PUT /api/routes).
export function applyRouteTable(table) {
  if (!table || !Array.isArray(table.routes) || !Array.isArray(table.rules)) return;
  current = core.createRouteModel(table);
  listeners.forEach(fn => fn());
}

export function subscribeRouteModel(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

// Nạp phần tự cài từ máy chủ (loader = api.getRouteTable); lỗi mạng thì giữ bảng chuẩn.
export async function loadRouteCustomizations(loader) {
  try {
    const data = await loader();
    if (data?.status === 'ok') applyRouteTable(data.table);
    return data;
  } catch {
    return null;
  }
}

export const keywordPattern = core.keywordPattern;
export const getRouteTable = () => current.ROUTE_TABLE;
export const getRoutes = () => current.ROUTES;
export const getCategories = () => current.CATEGORIES;
export const normalizeRouteCode = (...a) => current.normalizeRouteCode(...a);
export const detectRouteCode = (...a) => current.detectRouteCode(...a);
export const mentionedRoutes = (...a) => current.mentionedRoutes(...a);
export const routeInfo = (...a) => current.routeInfo(...a);
export const routeShort = (...a) => current.routeShort(...a);
export const routeReportMode = (...a) => current.routeReportMode(...a);
export const routeCategory = (...a) => current.routeCategory(...a);
export const categoryLabel = (...a) => current.categoryLabel(...a);
export const categoryDefaultRoute = (...a) => current.categoryDefaultRoute(...a);
export const routeCodeOfItem = (...a) => current.routeCodeOfItem(...a);

// Model thử (chưa lưu) để xem trước kết quả nhận diện khi đang sửa phần tự cài.
export function previewRouteModel(custom) {
  return core.createRouteModel(core.mergeRouteTable(BASE_TABLE, custom || { routes: [] }));
}

export const getBaseRouteTable = () => BASE_TABLE;
