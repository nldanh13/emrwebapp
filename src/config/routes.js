// MODEL ĐƯỜNG DÙNG DUY NHẤT phía giao diện.
// Dữ liệu: config/routes.json (worker Python và máy chủ Node đọc cùng file).
// Logic: src/config/routeModelCore.cjs (máy chủ Node dùng cùng file).
// Muốn thêm/sửa đường dùng, từ khoá nhận diện hay chuyên mục: chỉ sửa config/routes.json.

import ROUTE_TABLE from '../../config/routes.json' with { type: 'json' };
import core from './routeModelCore.cjs';

const model = core.createRouteModel(ROUTE_TABLE);

export { ROUTE_TABLE };
export const {
  ROUTES,
  CATEGORIES,
  normalizeRouteCode,
  detectRouteCode,
  mentionedRoutes,
  routeInfo,
  routeShort,
  routeReportMode,
  routeCategory,
  categoryLabel,
  categoryDefaultRoute,
  routeCodeOfItem,
} = model;
