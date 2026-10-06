import { stripVN } from './reportBaseUtils.js';
import { categoryDefaultRoute, detectRouteCode, normalizeRouteCode, routeReportMode, routeShort } from '../../config/routes.js';

// Nhãn ngắn dùng trong báo cáo (TTM, TMC, Uống, Khí dung…) theo bảng chuẩn config/routes.json.
function routeFromText(text) {
  const code = detectRouteCode(text);
  return code ? routeShort(code) : '';
}

// Suy đường dùng từ tên chuyên mục của worker (dich_truyen, thuoc_tmc, tiem_bap…).
function routeFromCategory(category) {
  const cat = stripVN(category).toLowerCase().replace(/[_\-.]+/g, ' ');
  if (/thuoc\s*tra|ngung|dung\s*thuoc|stop/.test(cat)) return 'Ngưng/Trả';
  const code = detectRouteCode(cat) || categoryDefaultRoute(String(category || '').trim());
  return code ? routeShort(code) : '';
}

const ORAL_SOLID = /\b(?:vien|goi|nang|tablets?|capsules?|caps|tab)\b/;

function routeOf(item, category) {
  // Y lệnh ghi rõ dùng ngoài (thoa, bôi, dán, nhỏ, xịt…) thắng nhãn đường dùng/chuyên mục: worker hay
  // xếp kem bôi vào thuốc uống (vd. "Triamcinolone … thoa xong 45ph" bị in là "× 1 viên" uống).
  const nameCode = detectRouteCode(`${item?.ten_thuoc || item?.ten_hien_thi || ''} ${item?.duong_dung_goc || ''} ${item?.ghi_chu || ''}`);
  if (nameCode && routeReportMode(nameCode) === 'hide') return routeShort(nameCode);
  const routed = routeOfInner(item, category);
  // Không rõ đường dùng nhưng là dạng viên/gói/nang → uống (vd. "BISOPROLOL 2.5MG TABLETS").
  if (routed === 'Khác') {
    const form = stripVN(`${item?.dang || item?.don_vi || ''} ${item?.ten_thuoc || item?.ten_hien_thi || ''}`).toLowerCase();
    if (ORAL_SOLID.test(form)) return routeShort('UONG');
  }
  return routed;
}

function routeOfInner(item, category) {
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
