'use strict';

const { dedupeBy } = require('./common');
const { normalizeGio, parseHourFromText, resolveHour, formatHourLabel, timelineSortValue } = require('./datetime');
const { mergeRecordGroup } = require('./merge');

function normalizeDoctorTimelineLabel(raw) {
  return String(raw || '').trim()
    .replace(/\bmời\s*bs\b/gi, 'Mời bác sĩ')
    .replace(/\bmời\s*bác\s*sĩ\b/gi, 'Mời bác sĩ')
    .trim() || 'Mời bác sĩ khám';
}

function normalizeTextNoAccent(value) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/\s+/g, ' ')
    .trim();
}

function isRehabServiceName(name) {
  const t = normalizeTextNoAccent(name);
  return /\b(vltl|vat ly tri lieu|tap van dong|tap cac kieu tho|tap tho|keo gian cot song|may keo gian cot song)\b/.test(t);
}

function normalizeRehabTimelineLabel(raw) {
  const s = String(raw || '').trim();
  if (!s) return '';
  return 'VLTL';
}

function buildMedicationSignature(item = {}, baseType = '') {
  const ten   = String(item.ten_hien_thi || item.ten_thuoc || item.hoat_chat || '').trim().toLowerCase();
  const route = String(item.duong_dung   || item.duong_dung_goc || baseType  || '').trim().toLowerCase();
  return `${baseType}|${route}|${ten}`;
}

function parseMedicationOrderHour(item = {}) {
  return parseHourFromText(item.gio_y_lenh || item.thoi_diem_y_lenh || item.order_time || '');
}

function isReserveMedicationItem(item = {}) {
  if (!item || typeof item !== 'object') return false;
  if (item.du_tru === true || item.reserve_order === true || item.is_du_tru === true || item.isReserve === true) return true;
  if (String(item.order_context || item.block_context || '').toLowerCase() === 'du_tru') return true;
  const text = String(item.ghi_chu || item.note || item.raw_text || item.y_lenh || '').toLowerCase();
  return /dự\s*trù/i.test(text) || /\bdu\s*tru\b/i.test(text);
}

function isAddMedicationItem(item = {}) {
  if (!item || typeof item !== 'object') return false;
  if (item.thuoc_them === true || item.add_order === true || item.is_add_order === true || item.isAdded === true) return true;
  if (String(item.order_context || item.block_context || '').toLowerCase() === 'them') return true;
  const text = String(item.ghi_chu || item.note || item.raw_text || item.y_lenh || '').toLowerCase();
  return /^\s*(thêm|them)\s*:?\s*$/im.test(text) || /\b(thêm|them)\s+thuốc\b/i.test(text);
}

function buildReserveMedicationSet(groups = []) {
  const reserve = new Set();
  for (const { list, baseType } of (groups || [])) {
    for (const item of (list || [])) {
      const orderHour = parseMedicationOrderHour(item);
      if (isReserveMedicationItem(item) || (Number.isFinite(orderHour) && orderHour < 7)) {
        reserve.add(buildMedicationSignature(item, baseType));
      }
    }
  }
  return reserve;
}

function buildMedicationTimelineMeta(baseType, item, displayHour, reserveSet = new Set()) {
  const ten       = String(item?.ten_hien_thi || item?.ten_thuoc || item?.hoat_chat || '').trim();
  const prefix    = baseType === 'infus' ? 'TTM' : (baseType === 'tiem' ? 'Tiêm' : 'Uống');
  const sig       = buildMedicationSignature(item, baseType);
  const orderHour = parseMedicationOrderHour(item);
  const adminHour = Number.isFinite(displayHour) ? displayHour : parseHourFromText(item?.tg_bat_dau || item?.gio_dung || '');
  const inReserve = reserveSet.has(sig) || isReserveMedicationItem(item);

  // Y lệnh trước 07:00 hoặc có ghi chú dự trù chỉ dùng để nhận biết thuốc đã được chuẩn bị sẵn.
  // Không hiển thị/ghi thêm chữ "Dự trù" vào timeline hay nội dung chăm sóc.
  if (inReserve) {
    return { type: baseType, label: `${prefix} ${ten}`.trim() };
  }
  // Chỉ hiện "Thêm" khi parser đánh dấu đúng là block thuốc thêm.
  // Không dùng riêng điều kiện giờ y lệnh >= 07:00 vì EMR có thể dự trù lúc 08:00.
  if (isAddMedicationItem(item)) {
    return { type: 'add', label: `Thêm ${prefix} ${ten}`.trim() };
  }
  return { type: baseType, label: `${prefix} ${ten}`.trim() };
}

function buildTimeline(allDichTruyen, allThuocTiem, allThuocUong, allThuocTra, records) {
  const items      = [];
  const reserveSet = buildReserveMedicationSet([
    { list: allDichTruyen, baseType: 'infus' },
    { list: allThuocTiem,  baseType: 'tiem' },
    { list: allThuocUong,  baseType: 'order' },
  ]);

  const pushItem = (t, type, label, detail = null, flag = null) => {
    const lbl = String(label || '').trim();
    if (!lbl) return;
    items.push({ t: String(t || '—').trim() || '—', type, label: lbl, flag, done: false, detail });
  };

  const addMedicationItems = (list, baseType) => {
    for (const item of (list || [])) {
      const rawGio = String(item.tg_bat_dau || item.gio_dung || '').trim();
      const ten    = String(item.ten_hien_thi || item.ten_thuoc || item.hoat_chat || '').trim();
      if (!ten) continue;

      const gioList = (baseType === 'order' || baseType === 'tiem')
        ? rawGio.split(',').map(g => normalizeGio(g.trim())).filter(Boolean)
        : [normalizeGio(rawGio)];

      for (const gio of (gioList.length ? gioList : [''])) {
        const hour = parseHourFromText(gio);
        const meta = buildMedicationTimelineMeta(baseType, item, hour, reserveSet);
        pushItem(gio || '—', meta.type, meta.label, item, item.tu_tuc ? 'TT' : null);
      }
    }
  };

  addMedicationItems(allDichTruyen, 'infus');
  addMedicationItems(allThuocTiem,  'tiem');
  addMedicationItems(allThuocUong,  'order');

  for (const item of (allThuocTra || [])) {
    const ten = String(item.ten_hien_thi || item.ten_thuoc || item.hoat_chat || '').trim();
    if (!ten) continue;
    pushItem('—', 'stop', `Ngưng/Trả ${ten}`, item);
  }

  for (const rec of (records || [])) {
    const merged = mergeRecordGroup(rec, [rec]);
    const yk     = merged.y_lenh_khac  || {};
    const cs     = merged.chi_dinh_khac || {};

    for (const line of (yk.moi_hoi_chan || [])) {
      const hour = resolveHour(line, 8);
      pushItem(formatHourLabel(hour), 'doctor', normalizeDoctorTimelineLabel(line), { raw: line });
    }

    const rehabLabel = normalizeRehabTimelineLabel(cs.vat_ly_tri_lieu || '');
    if (rehabLabel) {
      pushItem(formatHourLabel(resolveHour(cs.vat_ly_tri_lieu, 8)), 'rehab', rehabLabel, { raw: cs.vat_ly_tri_lieu });
    }

    for (const item of (merged.chi_dinh_dvkt || [])) {
      const ten = String(item.ten || '').trim();
      if (!ten) continue;
      if (isRehabServiceName(ten)) {
        pushItem(
          normalizeGio(item.gio) || formatHourLabel(resolveHour(item.gio, 8)),
          'rehab', 'VLTL', item,
        );
        continue;
      }
      pushItem(
        normalizeGio(item.gio) || formatHourLabel(resolveHour(item.gio, 8)),
        'dvkt', `Cận lâm sàng: ${ten}`, item,
      );
    }

    for (const warning of (rec.processing_warnings || [])) {
      const msg = String(warning?.message || warning?.code || '').trim();
      if (!msg) continue;
      pushItem(normalizeGio(warning.gio_y_lenh) || 'Cảnh báo', 'error', `Cảnh báo: ${msg}`, warning);
    }

    for (const unparsed of (rec.unparsed_orders || [])) {
      const ten = String(unparsed?.ten_thuoc || unparsed?.raw || '').trim();
      if (!ten) continue;
      pushItem(normalizeGio(unparsed.gio_y_lenh) || 'Cần xem', 'error', `Chưa phân loại: ${ten}`, unparsed);
    }

    const yl = String(rec.nhap_cham_soc?.y_lenh || '').trim();
    if (yl) pushItem('Y lệnh', 'care', 'Y lệnh chăm sóc', { yl_text: yl });
  }

  return dedupeBy(
    items,
    item => `${String(item.t || '').trim()}|${String(item.type || '').trim()}|${String(item.label || '').trim().toLowerCase()}`,
  ).sort((a, b) => {
    const dt = timelineSortValue(a.t) - timelineSortValue(b.t);
    return dt !== 0 ? dt : String(a.label || '').localeCompare(String(b.label || ''));
  });
}


module.exports = { normalizeDoctorTimelineLabel, normalizeRehabTimelineLabel, isRehabServiceName, buildMedicationSignature, parseMedicationOrderHour, isReserveMedicationItem, buildReserveMedicationSet, buildMedicationTimelineMeta, buildTimeline };
