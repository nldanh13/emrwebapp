function displayDrugName(item) {
  // Lấy rộng hơn để không mất các dòng thuốc có cấu trúc lạ từ dữ liệu cũ.
  const candidates = [
    item?.ten_chuan, item?.ten_hien_thi, item?.ten_thuoc, item?.hoat_chat,
    item?.ten, item?.name, item?.label, item?.text, item?.noi_dung, item?.raw,
  ];
  const base = String(candidates.find(v => String(v || '').trim()) || '').trim();
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

function quantityOf(item, category, hour) {
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
  return total != null ? total : 1;
}

function unitOf(item, category, route = '') {
  const u = String(item?.dang || item?.don_vi || item?.unit || '').trim();
  if (u) return u.toLowerCase();
  if (route === 'TTM' || category === 'dich_truyen') return 'chai';
  if (route === 'Uống' || category === 'thuoc_uong') return 'viên';
  if (route === 'TMC' || route === 'TB' || route === 'TDD') return 'ống';
  return '';
}

function categoryLabel(category) {
  const key = String(category || '').trim();
  const labels = {
    dich_truyen: 'Dịch truyền',
    thuoc_tiem: 'Thuốc tiêm',
    thuoc_uong: 'Thuốc uống',
    khac: 'Khác',
    thuoc_tra: 'Ngưng/Trả',
    thuoc_tmc: 'TMC',
    thuoc_tb: 'TB',
    thuoc_tdd: 'TDD',
  };
  return labels[key] || key || 'Không rõ nhóm';
}

export {
  displayDrugName, numericValue, quantityOf, unitOf, categoryLabel,
};
