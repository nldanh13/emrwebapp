// Phân loại thuốc trong Danh mục cho bộ lọc + cảnh báo "có thể sai" (thuần dữ liệu, có test).

const SOLVENT_SUFFIX = /\+\s*(natri\s*cl?orid|natri\s*chlorid|sodium\s*chlorid|nacl|glucose|dextrose|n[uư][oớ]c\s*c[aấ]t)/i;

function normKey(text) {
  return String(text || '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/gi, 'D').toUpperCase()
    .replace(/SODIUM\s+CHLORIDE/g, 'NATRI CLORID').replace(/[^A-Z0-9]+/g, ' ').trim();
}

const volumeOf = item => Number(item?.default_volume_ml) || 0;

export function isInjectable(item, routeCategoryOf = () => '') {
  return ['thuoc_tiem', 'dich_truyen'].includes(item?.category) || ['thuoc_tiem', 'dich_truyen'].includes(routeCategoryOf(item?.default_route || ''));
}

// Chai/túi truyền pha sẵn (dịch truyền ≥ 50 ml, không phải mục "thuốc + dung môi"): không cần quy tắc pha.
export function isReadyToInfuse(item) {
  return item?.category === 'dich_truyen' && volumeOf(item) >= 50 && !SOLVENT_SUFFIX.test(String(item?.canonical || ''));
}

export function hasIngredient(item) {
  return Boolean((item?.active_ingredients || []).length || String(item?.active_ingredient || '').trim());
}

// Các điểm nghi sai của một thuốc (câu tiếng Việt, nói rõ nên làm gì).
export function catalogIssues(item, all = []) {
  const out = [];
  const name = String(item?.canonical || '');
  if (SOLVENT_SUFFIX.test(name)) out.push('Mục cũ "thuốc + dung môi" — bấm "Xem và dọn" phía trên để gộp về thuốc gốc.');
  const vol = volumeOf(item);
  if (item?.category === 'dich_truyen' && vol > 0 && vol < 50) {
    out.push(`Xếp "Dịch truyền" nhưng thể tích ${vol} ml — có phải thuốc tiêm? Nếu pha truyền thì đặt quy tắc pha.`);
  }
  const key = normKey(name);
  const twin = (all || []).find(o => o !== item && o?.canonical && normKey(o.canonical) === key);
  if (twin) out.push(`Trùng với "${twin.canonical}" — gộp thành một thuốc: thêm tên vào "Tên khác", thể tích khác vào "Quy cách khác".`);
  return out;
}

export function filterCatalog(items, filter, { hasRule = () => false, routeCategoryOf = () => '' } = {}) {
  switch (filter) {
    case 'has_rule': return items.filter(hasRule);
    case 'no_rule': return items.filter(i => !hasRule(i) && isInjectable(i, routeCategoryOf) && !isReadyToInfuse(i));
    case 'no_ingredient': return items.filter(i => !hasIngredient(i));
    case 'issues': return items.filter(i => catalogIssues(i, items).length);
    default: return items;
  }
}
