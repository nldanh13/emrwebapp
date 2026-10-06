// Quy cách khác của một thuốc (thể tích chai/túi + tốc độ) ↔ form. Quy cách mặc định là ô "Thể tích
// mặc định"/"Tốc độ mặc định"; danh sách này cho các thể tích khác (vd. Natri clorid 500 ml).
export function presentationsForm(med) {
  return (Array.isArray(med?.quy_cach) ? med.quy_cach : []).map(p => ({ volume_ml: String(p.volume_ml ?? ''), rate: String(p.rate ?? '') }));
}

export function presentationsFromForm(rows) {
  const out = [];
  for (const [i, r] of (rows || []).entries()) {
    const vol = String(r?.volume_ml ?? '').trim().replace(',', '.');
    const rate = String(r?.rate ?? '').trim().replace(',', '.');
    if (!vol && !rate) continue;
    if (!vol || !(Number(vol) > 0)) return { error: `Quy cách ${i + 1}: nhập thể tích (ml).` };
    if (rate && !(Number(rate) > 0)) return { error: `Quy cách ${i + 1}: tốc độ phải là số.` };
    out.push({ volume_ml: Number(vol), ...(rate ? { rate } : {}) });
  }
  return { value: out };
}

// Cột "Thể tích" của bảng: "100 / 500 / 1000".
export function volumesText(med) {
  const vols = [med?.default_volume_ml, ...(med?.quy_cach || []).map(p => p.volume_ml)].filter(v => Number(v) > 0);
  return vols.length ? [...new Set(vols.map(Number))].join(' / ') : '';
}
