// Quy tắc pha thuốc trong Danh mục thuốc — cùng mã với máy chủ (server/routes/medication_catalog.js
// normalizeDilution) và worker (worker/processing/medication_catalog.py catalog_dilution_rule).

import { RULE_SOLVENTS, SOLVENT_LABEL as ALL_SOLVENT_LABEL, SOLVENT_SHORT } from '../config/solvents.js';

// Dung môi chọn được — config/solvents.json (một nguồn với worker và máy chủ).
export const DILUTION_SOLVENTS = RULE_SOLVENTS;
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
    dilution_rate: rule?.rate ?? '',
    dilution_note: rule?.note || '',
    dilution_variants: (rule?.variants || []).map(v => ({
      route: v.route || '', dose_min_mg: v.dose_min_mg ?? '', dose_max_mg: v.dose_max_mg ?? '',
      solvent: v.solvent || 'NACL_0.9', volume_ml: v.volume_ml ?? '', rate: v.rate ?? '', note: v.note || '',
    })),
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
  const rawRate = String(form?.dilution_rate ?? '').trim().replace(',', '.');
  const rate = rawRate === '' ? null : Number(rawRate);
  if (rate != null && (!Number.isFinite(rate) || rate <= 0 || rate > 300)) {
    return { error: 'Tốc độ truyền phải là số giọt/phút từ 1 đến 300.' };
  }
  const apply = DILUTION_APPLY.some(([v]) => v === form?.dilution_apply) ? form.dilution_apply : 'always';
  const variants = [];
  for (const [i, v] of (form?.dilution_variants || []).entries()) {
    const num = raw => { const t = String(raw ?? '').trim().replace(',', '.'); return t === '' ? null : Number(t); };
    const row = { solvent: v.solvent || 'NACL_0.9' };
    if (String(v.route || '').trim()) row.route = String(v.route).trim();
    const lo = num(v.dose_min_mg); const hi = num(v.dose_max_mg); const vol = num(v.volume_ml); const r = num(v.rate);
    for (const [key, val, label] of [['dose_min_mg', lo, 'liều từ'], ['dose_max_mg', hi, 'liều đến'], ['volume_ml', vol, 'thể tích'], ['rate', r, 'tốc độ']]) {
      if (val == null) continue;
      if (!Number.isFinite(val) || val <= 0) return { error: `Cách pha ${i + 1}: ${label} phải là số dương.` };
      row[key] = val;
    }
    if (!row.route && lo == null && hi == null) return { error: `Cách pha ${i + 1}: chọn đường dùng hoặc nhập khoảng liều.` };
    if (lo != null && hi != null && lo > hi) return { error: `Cách pha ${i + 1}: "liều từ" lớn hơn "liều đến".` };
    if (String(v.note || '').trim()) row.note = String(v.note).trim();
    variants.push(row);
  }
  return { value: {
    solvent, ...(volume != null ? { volume_ml: volume } : {}), apply,
    ...(rate != null ? { rate } : {}), ...(note ? { note } : {}),
    ...(variants.length ? { variants } : {}),
  } };
}

// Chữ ngắn cho bảng danh mục.
export function dilutionSummary(rule) {
  if (!rule?.solvent || !SOLVENT_LABEL[rule.solvent]) return '';
  if (rule.solvent === 'KHONG_PHA') return SOLVENT_SHORT.KHONG_PHA;
  let text = SOLVENT_LABEL[rule.solvent];
  if (rule.volume_ml) text += ` ${rule.volume_ml} ml`;
  if (rule.rate) text += `, ${rule.rate} giọt/phút`;
  if (rule.apply === 'infusion_only') text += ' · khi truyền';
  if (rule.variants?.length) text += ` · +${rule.variants.length} cách pha`;
  return text;
}

export function emptyVariant() {
  return { route: '', dose_min_mg: '', dose_max_mg: '', solvent: 'NACL_0.9', volume_ml: '', rate: '', note: '' };
}

// Nguồn của quyết định pha (worker ghi 'nguon_pha' lên dòng thuốc; 'source' của quy tắc).
export const SOURCE_LABEL = {
  y_lenh: 'theo y lệnh',
  danh_muc: 'theo Danh mục thuốc',
  luat_san_co: 'theo luật sẵn có',
  tui_cung_gio: 'theo túi Natri clorid cùng giờ',
  mac_dinh: 'mặc định 100 ml (không có dữ kiện)',
};

// Kết quả "Kiểm tra thử" (worker/dilution_check.py) thành câu đọc được.
export function describeCheck(res) {
  if (!res) return [];
  if (res.error) return [res.error];
  const lines = [];
  if (res.moved_to_infusion && res.dung_moi) {
    const solvent = ALL_SOLVENT_LABEL[res.dung_moi === 'SODIUM_0.9' ? 'SODIUM_0.9' : 'NACL_0.9'];
    const vol = res.the_tich ? ` ${Number(res.the_tich)} ml` : '';
    lines.push(`Chuyển sang dịch truyền: pha ${solvent}${vol} (${SOURCE_LABEL[res.nguon_pha] || 'không rõ nguồn'}).`);
    if (res.toc_do) lines.push(`Tốc độ: ${res.toc_do} giọt/phút${res.toc_do_nguon === 'danh_muc' ? ' (theo Danh mục thuốc)' : ''}.`);
  } else if (res.rule?.solvent === 'KHONG_PHA') {
    lines.push('Không pha thêm: giữ nguyên như y lệnh (theo Danh mục thuốc).');
  } else {
    lines.push(`Giữ là thuốc tiêm${res.duong_dung ? ` (${res.duong_dung})` : ''}, không tự gắn dung môi.`);
    if (res.rule?.apply === 'infusion_only') lines.push('Quy tắc chỉ áp dụng khi y lệnh ghi truyền/TTM.');
  }
  if (res.cach_pha) lines.push(`Cách pha được chọn: ${res.cach_pha}.`);
  if (res.can_xac_nhan_pha) lines.push(`⚠ Cần xác nhận cách pha: ${res.ly_do_xac_nhan_pha || 'không chắc chắn'}`);
  if (res.quy_tac_pha) lines.push(`Ghi lên báo cáo: ${res.quy_tac_pha}.`);
  if (res.rule) {
    const who = res.rule_source === 'danh_muc'
      ? `Danh mục thuốc: ${res.rule.canonical || ''}${res.rule.matched_by === 'hoat_chat' ? ' (khớp theo hoạt chất)' : ''}`
      : `luật sẵn có: ${res.rule.keyword || ''}`;
    lines.push(`Quy tắc tìm thấy — ${who}.`);
  } else {
    lines.push('Chưa có quy tắc pha nào cho thuốc này.');
  }
  return lines;
}

// ── Cách pha thực tế (worker/dilution_stats.py) ─────────────────────────────────────────────
const fmt = n => (Number.isInteger(Number(n)) ? String(Number(n)) : String(n));

export function statsForDrug(stats, name) {
  const key = String(name || '').trim().toUpperCase();
  if (!key) return null;
  return (stats?.drugs || []).find(d => String(d.drug || '').toUpperCase() === key) || null;
}

export function observedLabel(o) {
  const parts = [`${ALL_SOLVENT_LABEL[o.solvent] || o.solvent}${o.volume_ml ? ` ${fmt(o.volume_ml)} ml` : ''}`];
  if (o.route) parts.push(o.route);
  if (o.dose_mg != null) parts.push(`liều ${fmt(o.dose_mg)} mg/lần`);
  return parts.join(' · ');
}

// Một cách pha thực tế → dòng "cách pha theo điều kiện" (đúng đường dùng + đúng liều đã gặp).
export function variantFromObserved(o) {
  return {
    ...emptyVariant(),
    route: ['TTM', 'SE'].includes(o.route) ? o.route : '',
    dose_min_mg: o.dose_mg != null ? String(o.dose_mg) : '',
    dose_max_mg: o.dose_mg != null ? String(o.dose_mg) : '',
    solvent: o.solvent || 'NACL_0.9',
    volume_ml: o.volume_ml != null ? String(o.volume_ml) : '',
  };
}
