import { stripVN } from './reportBaseUtils.js';

function routeFromText(text) {
  const raw = stripVN(text).toLowerCase();
  const compact = ` ${raw.replace(/[_\-.]+/g, ' ').replace(/\s+/g, ' ')} `;

  // Thứ tự ưu tiên rất quan trọng:
  // TDD/TB/TMC phải được nhận trước TTM, vì nhiều dòng ghi chú có chữ "truyền"/"pha"
  // nhưng đường dùng thật vẫn là tiêm dưới da/tiêm bắp/tiêm mạch chậm.
  if (/\b(uong|po|oral)\b/.test(compact)) return 'Uống';
  if (/\btdd\b|\bsc\b|\bsubcut\b|duoi\s*da|tiem\s*duoi\s*da|duong\s*duoi\s*da/.test(compact)) return 'TDD';
  if (/\btb\b|\bim\b|intramuscular|tiem\s*bap|duong\s*bap|\bbap\b/.test(compact)) return 'TB';
  if (/\btmc\b|tinh\s*mach\s*cham|tiem\s*mach\s*cham|tiem\s*tm\s*cham|tiem\s*cham|duong\s*tinh\s*mach\s*cham/.test(compact)) return 'TMC';
  if (/\bttm\b|truyen\s*tinh\s*mach|tiem\s*truyen|truyen|giot\s*\/?\s*phut|ml\s*\/?\s*h|bom\s*tiem\s*dien/.test(compact)) return 'TTM';
  if (/\btm\b|\biv\b|tinh\s*mach|duong\s*tinh\s*mach/.test(compact)) return 'TMC';
  return '';
}

function routeFromCategory(category) {
  const cat = stripVN(category).toLowerCase().replace(/[_\-.]+/g, ' ');
  if (/thuoc\s*tra|ngung|dung\s*thuoc|stop/.test(cat)) return 'Ngưng/Trả';
  if (/thuoc\s*uong|uong|oral|po/.test(cat)) return 'Uống';
  if (/tdd|duoi\s*da|subcut|sc/.test(cat)) return 'TDD';
  if (/tb|tiem\s*bap|bap|im/.test(cat)) return 'TB';
  if (/tmc|tiem\s*cham|tinh\s*mach\s*cham/.test(cat)) return 'TMC';
  if (/dich\s*truyen|ttm|tiem\s*truyen|truyen/.test(cat)) return 'TTM';
  if (/thuoc\s*tiem|tiem/.test(cat)) return 'TMC';
  return '';
}

function routeOf(item, category) {
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
