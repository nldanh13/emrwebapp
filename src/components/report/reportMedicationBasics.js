import { getCategories, categoryLabel as modelCategoryLabel, detectRouteCode, routeCategory, routeReportMode, routeShort } from '../../config/routes.js';
const QUANTITY_ONLY = /^\(?\s*[\d.,]+\s*(?:ống|ong|lọ|lo|chai|túi|tui|viên|vien|gói|goi|ml|ampoule)\s*\)?$/i;

function displayDrugName(item) {
  // Lấy rộng hơn để không mất các dòng thuốc có cấu trúc lạ từ dữ liệu cũ.
  const candidates = [
    item?.ten_chuan, item?.ten_hien_thi, item?.ten_thuoc, item?.hoat_chat,
    item?.ten, item?.name, item?.label, item?.text, item?.noi_dung, item?.raw,
  ];
  // Một số dòng worker tách nhầm: tên chỉ còn phần số lượng "(1 ống)" → bỏ qua, lấy trường kế tiếp.
  const base = String(candidates.find(v => String(v || '').trim() && !QUANTITY_ONLY.test(String(v).trim())) || '').trim();
  if (!base) return 'Chưa rõ tên thuốc';

  // Bỏ tiền tố (TT) text — badge trong cột Thuốc đã hiển thị rồi
  const name = base
    .replace(/^\(\s*TT\s*\)\s*/i, '')
    .replace(/\s+\d+\s*(?:túi|lọ|ống|chai|viên)\s*$/i, '')
    .replace(/([\d.]+\s*(?:mg|mcg|g|mmol|ui|iu))\/\d+\s*ml\b/gi, '$1')
    .trim();
  return name ? name.charAt(0).toUpperCase() + name.slice(1) : 'Chưa rõ tên thuốc';
}

function numericValue(raw) {
  if (raw == null || raw === '') return null;
  const s = String(raw).trim().replace(',', '.');
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

// Liều MỖI LẦN của một cữ. so_luong của worker là TỔNG trong ngày (worker chỉ tự chia cho thuốc tiêm,
// ghi vào so_lo_moi_lan); bản cũ coi tổng là liều mỗi lần rồi nhân số cữ → thuốc uống 2 viên/ngày
// chia 2 cữ hiện "× 4 viên". timesCount = số cữ có giờ của y lệnh.
function quantityOf(item, category, hour, timesCount = 1) {
  const byHour = item?.so_luong_moi_gio || item?.so_luong_theo_gio;
  if (hour != null && hour !== '' && byHour && typeof byHour === 'object') {
    const hourKeys = [String(Number(hour)), String(hour).padStart(2, '0'), `${String(hour).padStart(2, '0')}:00`];
    for (const key of hourKeys) {
      const v = numericValue(byHour[key]);
      if (v != null) return v;
    }
  }

  const perUse = numericValue(item?.so_lo_moi_lan || item?.so_luong_moi_lan || item?.lieu_moi_lan);
  if (perUse != null) return perUse;

  // Với dịch truyền/TTM, mỗi dòng giờ thường tương ứng 1 chai/túi. Tránh cộng nhầm tổng x3 vào từng cữ.
  if (category === 'dich_truyen') return 1;

  const total = numericValue(item?.so_luong);
  if (total == null) return 1;
  const n = Math.max(1, Number(timesCount) || 1);
  if (n > 1) {
    const per = total / n;
    // Chia hết (kể cả nửa viên) mới là tổng ngày; không chia được thì giữ nguyên (đã là liều mỗi lần).
    if (per > 0 && Number.isInteger(per * 2)) return per;
  }
  return total;
}

const CONTAINER_WORDS = ['chai', 'lọ', 'ống', 'túi', 'viên', 'gói'];

function unitOf(item, category, route = '') {
  let u = String(item?.dang || item?.don_vi || item?.unit || '').trim().toLowerCase();
  // Chữ mẫu "chai/lọ/ống/túi" (không phải đơn vị thật): lấy đơn vị ghi trong tên, vd. "(1 lọ)".
  if (u.includes('/') && u.split('/').filter(x => CONTAINER_WORDS.includes(x.trim())).length > 1) {
    const name = String(item?.ten_thuoc || item?.ten_hien_thi || item?.ten_chuan || '').toLowerCase();
    const m = name.match(/\(\s*[\d.,]+\s*(chai|lọ|ống|túi|viên|gói)\s*\)/);
    u = m ? m[1] : u.split('/')[0].trim();
  }
  if (u) return u;
  const routeCat = routeCategory(route);
  if (routeCat === 'dich_truyen' || category === 'dich_truyen') return 'chai';
  if (routeReportMode(route) === 'daily' || category === 'thuoc_uong') return 'viên';
  if (routeCat === 'thuoc_tiem') return 'ống';
  return '';
}

function categoryLabel(category) {
  const key = String(category || '').trim();
  if (!key) return 'Không rõ nhóm';
  if (key === 'thuoc_tra') return 'Ngưng/Trả';
  // Nhóm con của worker (thuoc_tmc, tiem_bap…) → nhãn đường dùng; còn lại theo config/routes.json.
  const known = getCategories().some(c => c.code === key);
  if (!known) {
    const code = detectRouteCode(key.replace(/_/g, ' '));
    if (code) return routeShort(code);
  }
  return modelCategoryLabel(key);
}

export {
  displayDrugName, numericValue, quantityOf, unitOf, categoryLabel,
};
