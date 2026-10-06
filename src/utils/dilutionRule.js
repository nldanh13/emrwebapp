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
  return { value: {
    solvent, ...(volume != null ? { volume_ml: volume } : {}), apply,
    ...(rate != null ? { rate } : {}), ...(note ? { note } : {}),
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
  return text;
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
