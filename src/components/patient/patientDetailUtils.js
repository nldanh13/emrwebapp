export function normalizeGio(raw) {
  const s = String(raw || '').trim();
  if (!s) return '';
  const m1 = s.match(/(\d{1,2}):(\d{2})/);
  if (m1) return `${m1[1].padStart(2, '0')}:${m1[2]}`;
  const m2 = s.match(/(\d{1,2})[hH](\d{2})/);
  if (m2) return `${m2[1].padStart(2, '0')}:${m2[2]}`;
  const m3 = s.match(/^(\d{1,2})\s*gi[ờo]/i);
  if (m3) return `${m3[1].padStart(2, '0')}:00`;
  return s;
}

export function parseCheDoAn(s) {
  if (!s) return { cap: '', diet_code: '', diet_name: '' };
  const parts  = s.split('-').map(x => x.trim());
  const capMatch = s.match(/CS(C?I{1,3}C?)/i);
  const capNum = capMatch ? capMatch[1].replace(/[^I]/gi,'').length : 0;
  return {
    cap:       capNum ? `Cấp ${capNum}` : '',
    diet_code: parts[0] || '',
    diet_name: parts[1] || '',
  };
}

export function parseHourFromRaw(raw) {
  const s = String(raw || '').trim();
  if (!s) return null;
  const n = normalizeGio(s);
  const m = n.match(/^(\d{2}):(\d{2})$/);
  if (m) return Number(m[1]);
  const m2 = s.match(/\b(\d{1,2})\s*gi[ờo]\b/i) || s.match(/\b(\d{1,2})h(?:\d{2})?\b/i);
  return m2 ? Number(m2[1]) : null;
}

export function buildTimelineFromThuoc(thuoc) {
  if (!thuoc) return [];
  const items = [];
  const sig = (item, type) => `${type}|${String(item?.duong_dung || item?.duong_dung_goc || '').trim().toLowerCase()}|${String(item?.ten_hien_thi || item?.ten_thuoc || item?.hoat_chat || '').trim().toLowerCase()}`;
  const orderHour = item => parseHourFromRaw(item?.gio_y_lenh || item?.thoi_diem_y_lenh || item?.order_time || '');
  const isReserveItem = item => {
    if (!item || typeof item !== 'object') return false;
    if (item.du_tru === true || item.reserve_order === true || item.is_du_tru === true || item.isReserve === true) return true;
  if (String(item.order_context || item.block_context || '').toLowerCase() === 'du_tru') return true;
    const text = String(item.ghi_chu || item.note || item.raw_text || item.y_lenh || '').toLowerCase();
    return /dự\s*trù/i.test(text) || /\bdu\s*tru\b/i.test(text);
  };
  const isAddItem = item => {
    if (!item || typeof item !== 'object') return false;
    if (item.thuoc_them === true || item.add_order === true || item.is_add_order === true || item.isAdded === true) return true;
    if (String(item.order_context || item.block_context || '').toLowerCase() === 'them') return true;
    const text = String(item.ghi_chu || item.note || item.raw_text || item.y_lenh || '').toLowerCase();
    return /^\s*(thêm|them)\s*:?\s*$/im.test(text) || /\b(thêm|them)\s+thuốc\b/i.test(text);
  };
  const reserveSet = new Set();
  for (const [list, type] of [[thuoc.dich_truyen,'infus'], [thuoc.thuoc_tiem,'tiem'], [thuoc.thuoc_uong,'order']]) {
    for (const item of (list || [])) {
      const h = orderHour(item);
      if (isReserveItem(item) || (Number.isFinite(h) && h < 7)) reserveSet.add(sig(item, type));
    }
  }
  const addItems = (list, type) => {
    for (const item of (list || [])) {
      const rawGio = String(item.tg_bat_dau || item.gio_dung || '').trim();
      const ten = String(item.ten_hien_thi || item.ten_thuoc || item.hoat_chat || '').trim();
      if (!ten) continue;
      const prefix = type === 'infus' ? 'TTM' : type === 'tiem' ? 'Tiêm' : 'Uống';
      const flag = item.tu_tuc ? 'TT' : null;
      const gios = (type === 'order' || type === 'tiem')
        ? rawGio.split(',').map(g => normalizeGio(g.trim())).filter(Boolean)
        : [normalizeGio(rawGio)];
      for (const gio of (gios.length ? gios : [''])) {
        const adminHour = parseHourFromRaw(gio);
        const oh = orderHour(item);
        let entryType = type;
        let label = `${prefix} ${ten}`.trim();
        const belongs = reserveSet.has(sig(item, type)) || isReserveItem(item);
        // Thuốc đã có y lệnh trước 07:00 hoặc có ghi chú dự trù chỉ dùng làm dấu hiệu nhận biết nội bộ.
        // Không thêm chữ "Dự trù" vào timeline; chỉ đánh dấu "Thêm" khi y lệnh sau 07:00
        // và không trùng thuốc đã được chuẩn bị trước đó.
        // Chỉ hiện "Thêm" khi parser đánh dấu đúng là block thuốc thêm.
        // Không dùng riêng điều kiện giờ y lệnh >= 07:00 vì EMR có thể dự trù lúc 08:00.
        if (!belongs && isAddItem(item)) {
          entryType = 'add';
          label = `Thêm ${prefix} ${ten}`.trim();
        }
        items.push({ t: gio || '—', type: entryType, label, flag, done: false, detail: item });
      }
    }
  };
  addItems(thuoc.dich_truyen, 'infus');
  addItems(thuoc.thuoc_tiem, 'tiem');
  addItems(thuoc.thuoc_uong, 'order');
  for (const item of (thuoc.thuoc_tra || [])) {
    const ten = String(item.ten_hien_thi || item.ten_thuoc || item.hoat_chat || '').trim();
    if (!ten) continue;
    items.push({ t: '—', type: 'stop', label: `Ngưng/Trả ${ten}`, flag: null, done: false, detail: item });
  }
  return items.sort((a, b) => a.t.localeCompare(b.t));
}
