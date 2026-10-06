// Quy tắc pha thuốc trong Danh mục thuốc — cùng mã với máy chủ (server/routes/medication_catalog.js
// normalizeDilution) và worker (worker/processing/medication_catalog.py catalog_dilution_rule).

export const DILUTION_SOLVENTS = [
  ['NACL_0.9', 'Natri clorid 0.9%'],
  ['GLUCOSE_5', 'Glucose 5%'],
  ['NUOC_CAT', 'Nước cất pha tiêm'],
  ['KHONG_PHA', 'Không pha (chai/túi pha sẵn)'],
];
const SOLVENT_LABEL = Object.fromEntries(DILUTION_SOLVENTS);

export const DILUTION_APPLY = [
  ['always', 'Luôn pha truyền'],
  ['infusion_only', 'Chỉ khi y lệnh ghi truyền'],
];

export function dilutionForm(rule) {
  return {
    dilution_solvent: rule?.solvent || '',
    dilution_volume_ml: rule?.volume_ml ?? '',
    dilution_apply: rule?.apply || 'always',
    dilution_note: rule?.note || '',
  };
}

// Form → dữ liệu gửi máy chủ. Trả { value } hoặc { error } (câu tiếng Việt).
export function dilutionFromForm(form) {
  const solvent = String(form?.dilution_solvent || '').trim();
  if (!solvent) return { value: null };
  if (!SOLVENT_LABEL[solvent]) return { error: 'Dung môi pha không hợp lệ.' };
  const note = String(form?.dilution_note || '').trim();
  if (solvent === 'KHONG_PHA') return { value: { solvent, ...(note ? { note } : {}) } };
  const rawVol = String(form?.dilution_volume_ml ?? '').trim().replace(',', '.');
  const volume = rawVol === '' ? null : Number(rawVol);
  if (volume != null && (!Number.isFinite(volume) || volume <= 0 || volume > 1000)) {
    return { error: 'Thể tích pha phải là số ml từ 1 đến 1000.' };
  }
  const apply = DILUTION_APPLY.some(([v]) => v === form?.dilution_apply) ? form.dilution_apply : 'always';
  return { value: { solvent, ...(volume != null ? { volume_ml: volume } : {}), apply, ...(note ? { note } : {}) } };
}

// Chữ ngắn cho bảng danh mục.
export function dilutionSummary(rule) {
  if (!rule?.solvent || !SOLVENT_LABEL[rule.solvent]) return '';
  if (rule.solvent === 'KHONG_PHA') return 'Không pha';
  let text = SOLVENT_LABEL[rule.solvent];
  if (rule.volume_ml) text += ` ${rule.volume_ml} ml`;
  if (rule.apply === 'infusion_only') text += ' · khi truyền';
  return text;
}
