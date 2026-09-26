import { stripVN } from './reportBaseUtils.js';
import { detectRouteCode, normalizeRouteCode, routeShort } from '../../config/routes.js';

// Nhãn ngắn dùng trong báo cáo (TTM, TMC, Uống, Khí dung…) theo bảng chuẩn config/routes.json.
function routeFromText(text) {
  const code = detectRouteCode(text);
  return code ? routeShort(code) : '';
}

function routeFromCategory(category) {
  const cat = stripVN(category).toLowerCase().replace(/[_\-.]+/g, ' ');
  if (/thuoc\s*tra|ngung|dung\s*thuoc|stop/.test(cat)) return 'Ngưng/Trả';
  if (/thuoc\s*uong|uong|oral|po/.test(cat)) return routeShort('UONG');
  if (/tdd|duoi\s*da|subcut|sc/.test(cat)) return routeShort('TDD');
  if (/tb|tiem\s*bap|bap|im/.test(cat)) return routeShort('TB');
  if (/tmc|tiem\s*cham|tinh\s*mach\s*cham/.test(cat)) return routeShort('TMC');
  if (/dich\s*truyen|ttm|tiem\s*truyen|truyen/.test(cat)) return routeShort('TTM');
  if (/thuoc\s*tiem|tiem/.test(cat)) return routeShort('TMC');
  if (/hit\s*xit/.test(cat)) return routeShort('HIT_XIT');
  if (/thuoc\s*nho/.test(cat)) return routeShort('NHO_MAT');
  if (/thuoc\s*boi/.test(cat)) return routeShort('BOI');
  if (/thuoc\s*dat/.test(cat)) return routeShort('DAT_HM');
  return '';
}

function routeOf(item, category) {
  // Mã đã chuẩn hoá từ worker (TTM, UONG, KHI_DUNG…) hoặc nhãn cũ (U, IV, Hít/Xịt) dùng trực tiếp.
  const knownCode = normalizeRouteCode(item?.duong_dung);
  if (knownCode) return routeShort(knownCode);
  const explicitRoute = routeFromText(`${item?.duong_dung || ''} ${item?.duong_dung_goc || ''}`);
  if (explicitRoute) return explicitRoute;

  const categoryRoute = routeFromCategory(category);
  const noteRoute = routeFromText(`${item?.ghi_chu || ''} ${item?.note || ''}`);

  // "thuoc_tiem" là nhóm chung; nếu ghi chú nói rõ TTM/TB/TDD/TMC thì lấy ghi chú.
  if ((category === 'thuoc_tiem' || category === 'khac') && noteRoute) return noteRoute;
  if (categoryRoute) return categoryRoute;
  if (noteRoute) return noteRoute;

  return 'Khác';
}

function collectMedicationLists(meds = {}) {
  const orderedKeys = [
    'dich_truyen', 'thuoc_tiem', 'thuoc_uong', 'khac', 'thuoc_tra',
    'thuoc_tmc', 'thuoc_tb', 'thuoc_tdd', 'tiem_bap', 'tiem_duoi_da', 'tiem_mach_cham',
  ];
  const seen = new Set();
  const out = [];

  const add = key => {
    if (!key || seen.has(key)) return;
    seen.add(key);
    const list = meds?.[key];
    if (Array.isArray(list) && list.length) out.push([key, list]);
  };

  orderedKeys.forEach(add);
  Object.keys(meds || {}).forEach(add);
  return out;
}

function routeCounts(rows = []) {
  const counts = new Map();
  for (const row of rows || []) counts.set(row.route || 'Khác', (counts.get(row.route || 'Khác') || 0) + 1);
  return [...counts.entries()]
    .map(([route, count]) => ({ route, count }))
    .sort((a, b) => String(a.route).localeCompare(String(b.route), 'vi'));
}

export {
  routeFromText, routeFromCategory, routeOf, collectMedicationLists, routeCounts,
};
