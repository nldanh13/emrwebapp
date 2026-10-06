// Thuốc mới (chưa có trong Danh mục) → mẫu điền sẵn form "Thêm thuốc" từ dữ liệu đã gặp.
const ROUTE_CATEGORY_HINT = { dich_truyen: 'dich_truyen', thuoc_tiem: 'thuoc_tiem', thuoc_uong: 'thuoc_uong' };

export function prefillFromNewDrug(d) {
  const variants = (d?.variants || []).filter(v => v && v !== d.name);
  return {
    canonical: d?.name || '',
    aliases: variants.join(', '),
    active_ingredients: d?.ingredient || '',
    category: ROUTE_CATEGORY_HINT[d?.category] || d?.category || '',
    default_route: d?.route || '',
    default_volume_ml: d?.volume_ml ? String(d.volume_ml) : '',
  };
}

export function newDrugSummary(d) {
  const parts = [`${d.count} lần`];
  if (d.route) parts.push(d.route);
  if (d.form) parts.push(d.form);
  if (d.ingredient) parts.push(`hoạt chất: ${d.ingredient}`);
  if (d.volume_ml) parts.push(`${d.volume_ml} ml`);
  if (d.last_seen) parts.push(`gặp gần nhất ${d.last_seen.split('-').reverse().join('/')}`);
  return parts.join(' · ');
}
