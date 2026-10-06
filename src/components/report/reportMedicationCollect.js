import { GROUP_ORDER, routePriority, stripVN, timeToMinutes, extractTimes } from './reportBaseUtils.js';
import { routeOf, collectMedicationLists } from './reportRouteUtils.js';
import { displayDrugName, quantityOf, unitOf, categoryLabel } from './reportMedicationBasics.js';
import { groupOf, rowMinutes, markSeparatedHours } from './reportMedicationFlags.js';
import { routeReportMode } from '../../config/routes.js';
import { SOLVENT_LABEL } from '../../config/solvents.js';



function normalizeDmyToken(value) {
  const text = String(value || '').trim();
  const m = text.match(/(?:^|\D)(\d{1,2})[\/-](\d{1,2})[\/-](\d{4})(?:\D|$)/);
  if (!m) return '';
  const day = Number(m[1]);
  const month = Number(m[2]);
  const year = Number(m[3]);
  const dt = new Date(Date.UTC(year, month - 1, day));
  if (dt.getUTCFullYear() !== year || dt.getUTCMonth() !== month - 1 || dt.getUTCDate() !== day) return '';
  return `${String(day).padStart(2, '0')}/${String(month).padStart(2, '0')}/${year}`;
}

function clockMinutesFrom(value) {
  const text = String(value || '').trim();
  if (!text) return null;
  const m = text.match(/(?:^|\D)(\d{1,2})(?::(\d{2})|h(\d{2})?|\s*gi[ờo](?:\s*(\d{2}))?)(?:\D|$)/i);
  if (!m) return null;
  const hour = Number(m[1]);
  const minute = Number(m[2] ?? m[3] ?? m[4] ?? 0);
  if (!Number.isInteger(hour) || !Number.isInteger(minute) || hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
  return hour * 60 + minute;
}

function hasDischargeMarker(source) {
  if (!source || typeof source !== 'object') return false;
  const text = stripVN([
    source.care_mode,
    source.xu_tri,
    source.disposition,
    source.status_text,
  ].filter(Boolean).join(' ')).toLowerCase();
  return Boolean(
    source.ra_vien_hom_nay
    || String(source.gio_ra_vien || '').trim()
    || String(source.ngay_ra_vien || '').trim()
    || /\b(?:ra|xuat)\s*vien\b|\bcho\s*ve\b/.test(text)
  );
}

function dischargeEventCutoff(events, selectedDate, allowDateFallback = false) {
  for (const event of Array.isArray(events) ? events : []) {
    if (!event || typeof event !== 'object') continue;
    const type = stripVN(event.type || '').toLowerCase();
    const label = stripVN([event.label, event.text, event.note, event.title, event.name, event.xu_tri, event.disposition].filter(Boolean).join(' ')).toLowerCase();
    if (type !== 'discharge' && !/\b(?:ra|xuat)\s*vien\b|\bcho\s*ve\b/.test(label)) continue;
    const rawValues = [event.datetime, event.at, event.timestamp, event.time, event.ngay_ra_vien, event.discharge_time, event.ngay, event.date];
    const eventDate = rawValues.map(normalizeDmyToken).find(Boolean) || (allowDateFallback ? selectedDate : '');
    if (eventDate !== selectedDate) continue;
    const minutes = rawValues.map(clockMinutesFrom).find(v => v != null);
    if (minutes != null) return minutes;
  }
  return null;
}

/**
 * Giờ ra viện của đúng ngày đang xem, tính theo phút từ 00:00.
 * Chỉ dùng để cắt các cữ thuốc SAU thời điểm người bệnh rời khoa.
 */
function dischargeCutoffMinutes(patient, bundle, selectedDate) {
  const cleanDate = normalizeDmyToken(selectedDate) || String(selectedDate || '').trim();
  if (!cleanDate) return null;

  const sources = [bundle, patient].filter(Boolean);
  for (let index = 0; index < sources.length; index += 1) {
    const source = sources[index];
    const explicitDate = [
      source.ngay_ra_vien_date,
      source.ngay_ra_vien,
      source.discharge_date,
      source.discharge_time,
      source.raw_discharge_time,
      source['Ngày ra viện'],
      source['Thời gian ra viện'],
    ].map(normalizeDmyToken).find(Boolean) || '';

    const minutes = [
      source.gio_ra_vien,
      source.ngay_ra_vien,
      source.discharge_time,
      source.raw_discharge_time,
      source['Giờ ra viện'],
      source['Ngày ra viện'],
      source['Thời gian ra viện'],
    ].map(clockMinutesFrom).find(v => v != null);

    if (explicitDate === cleanDate && minutes != null) return minutes;

    // day_map của ngày đang xem được phép suy ngày từ key hiện tại khi worker chỉ
    // có gio_ra_vien; cấp patient chỉ fallback khi có marker ra viện rõ ràng.
    if (!explicitDate && minutes != null && hasDischargeMarker(source)) {
      if (index === 0 || String(patient?.ngay_lam || '').trim() === cleanDate) return minutes;
    }

    const eventMinutes = dischargeEventCutoff(source.care_special_events, cleanDate, index === 0);
    if (eventMinutes != null) return eventMinutes;
  }
  return null;
}

function isMedicationMomentAllowed(tm, selectedDate, cutoffMinutes) {
  if (cutoffMinutes == null || !tm || tm.noTime) return true;
  const rowDate = normalizeDmyToken(tm.date) || String(tm.date || '').trim();
  const selected = normalizeDmyToken(selectedDate) || String(selectedDate || '').trim();
  if (rowDate !== selected) return false; // cữ rạng sáng hôm sau chắc chắn sau khi đã ra viện.
  const minutes = timeToMinutes(tm.time);
  if (minutes == null) return true;
  return minutes <= cutoffMinutes;
}

function shouldHideFromDutyReport(item, category, route) {
  // Chỉ ẩn thuốc ngưng/trả — còn thuốc uống giờ hiển thị trong card BN.
  const cat = stripVN(category).toLowerCase();
  if (/thuoc\s*tra|ngung|stop/.test(cat) && route === 'Ngưng/Trả') return false; // giữ lại để hiện
  // Bôi, xịt, nhỏ, dán, đặt, ngậm: không cần trên báo cáo ca trực (config/routes.json report="hide").
  return route !== 'Ngưng/Trả' && routeReportMode(route) === 'hide';
}

// Chỉ NaCl/Sodium là mã worker ghi vào dung_moi khi pha truyền — tên lấy từ config/solvents.json.
const SOLVENT_CODE_TEXT = { 'NACL_0.9': SOLVENT_LABEL['NACL_0.9'], 'SODIUM_0.9': SOLVENT_LABEL['SODIUM_0.9'] };

// Chữ "pha …" hiện cạnh tên thuốc (màn hình và phiếu in dùng chung): mã dung môi của worker → tên
// đọc được, kèm thể tích pha; tên thuốc đã ghi "+ Natri clorid 0.9%" thì chỉ ghi thể tích. Thể tích
// không do y lệnh ghi (nguon_pha của worker) thì nói rõ nguồn để người chuẩn bị thuốc đối chiếu.
// Không có dung môi từ y lệnh → quy tắc pha của Danh mục thuốc.
const SOURCE_NOTE = { danh_muc: 'theo danh mục', luat_san_co: 'theo luật sẵn có', mac_dinh: 'mặc định, hỏi lại y lệnh' };

function mixTextOf(item, drugName = '') {
  const raw = String(item?.dung_moi || item?.pha_voi || item?.mix_with || '').trim();
  if (raw) {
    const solvent = SOLVENT_CODE_TEXT[raw] || raw;
    const vol = SOLVENT_CODE_TEXT[raw] ? Number(item?.tui_dich_truyen_ml || item?.the_tich || 0) : 0;
    const volText = vol > 0 ? `${vol} ml` : '';
    const base = normDrug(drugName).includes(normDrug(solvent)) ? volText : [solvent, volText].filter(Boolean).join(' ');
    const note = SOURCE_NOTE[item?.nguon_pha];
    return base && note ? `${base} (${note})` : base;
  }
  const rule = String(item?.quy_tac_pha || '').trim();
  return /^pha\s/i.test(rule) ? rule.replace(/^pha\s+/i, '') : '';
}

function collectDrugRows(patients, selectedDate) {
  const rows = [];
  const pushList = (patient, bundle, category, list) => {
    const dischargeCutoff = dischargeCutoffMinutes(patient, bundle, selectedDate);
    for (const item of list || []) {
      const times = extractTimes(item, bundle.date || selectedDate);
      const route = routeOf(item, category);
      if (shouldHideFromDutyReport(item, category, route)) continue;
      const unit = unitOf(item, category, route);
      const doseCount = times.filter(t => !t.noTime && t.time).length || 1;
      for (const tm of times) {
        if (!tm.time) continue;
        if (!isMedicationMomentAllowed(tm, selectedDate, dischargeCutoff)) continue;
        const row = {
          id: `${patient.ma_bn}|${bundle.date}|${category}|${displayDrugName(item)}|${route}|${tm.date}|${tm.time}|${rows.length}`,
          room: String(patient.so_phong || '').trim() || '—',
          patientName: String(patient.ho_ten || '').trim() || '—',
          patientId: String(patient.ma_bn || '').trim(),
          drugName: displayDrugName(item),
          route,
          time: tm.time,
          date: tm.date || bundle.date || selectedDate,
          timeText: tm.noTime ? 'Chưa rõ giờ' : `${tm.time}${tm.date && tm.date !== selectedDate ? ` ${tm.date}` : ''}${tm.guessFrom ? ` (theo chữ "${tm.guessFrom}")` : ''}`,
          // Giờ suy từ chữ buổi trong y lệnh (sáng/trưa/chiều/tối), không phải giờ bác sĩ ghi.
          timeGuess: tm.guessFrom || '',
          hour: tm.hour,
          noTime: Boolean(tm.noTime),
          quantity: quantityOf(item, category, tm.hour, doseCount),
          unit,
          note: String(item.duong_dung_goc || item.ghi_chu || item.note || '').trim(),
          mixWith: mixTextOf(item, displayDrugName(item)),
          tuTuc: Boolean(item.tu_tuc),
          category,
          dischargeCutoffMinutes: dischargeCutoff,
        };
        row.timeGroup = groupOf(row, selectedDate);
        rows.push(row);
      }
    }
  };

  for (const patient of patients || []) {
    const bundle = patient?.day_map?.[selectedDate] || (patient?.ngay_lam === selectedDate ? patient : null);
    if (!bundle) continue;
    const meds = bundle.thuoc || {};
    for (const [category, list] of collectMedicationLists(meds)) {
      pushList(patient, bundle, category, list);
    }
  }

  markSeparatedHours(rows);
  flagDuplicateRows(rows);

  return rows.sort((a, b) => {
    const g = (GROUP_ORDER[a.timeGroup] || 99) - (GROUP_ORDER[b.timeGroup] || 99);
    if (g) return g;
    const t = (timeToMinutes(a.time) ?? 9999) - (timeToMinutes(b.time) ?? 9999);
    if (t) return t;
    return String(a.room || '').localeCompare(String(b.room || ''), 'vi', { numeric: true })
      || String(a.patientName || '').localeCompare(String(b.patientName || ''), 'vi')
      || String(a.drugName || '').localeCompare(String(b.drugName || ''), 'vi');
  });
}

function collectOralDispenseData(patients, selectedDate) {
  const patientMap = new Map();

  for (const patient of patients || []) {
    const bundle = patient?.day_map?.[selectedDate] || (patient?.ngay_lam === selectedDate ? patient : null);
    if (!bundle) continue;
    const meds = bundle.thuoc || {};
    const dischargeCutoff = dischargeCutoffMinutes(patient, bundle, selectedDate);

    for (const [category, list] of collectMedicationLists(meds)) {
      for (const item of list || []) {
        const route = routeOf(item, category);
        if (routeReportMode(route) !== 'daily') continue;

        const pid = String(patient.ma_bn || '').trim();
        if (!patientMap.has(pid)) {
          patientMap.set(pid, {
            room: String(patient.so_phong || '').trim() || '—',
            patientName: String(patient.ho_ten || '').trim() || '—',
            patientId: pid,
            drugs: new Map(),
          });
        }

        const pData = patientMap.get(pid);
        const drugName = displayDrugName(item);
        const drugKey = `${drugName.toLowerCase()}|${category}`;

        if (!pData.drugs.has(drugKey)) {
          const times = extractTimes(item, selectedDate);
          const validTimes = times
            .filter(t => !t.noTime && isMedicationMomentAllowed(t, selectedDate, dischargeCutoff))
            .map(t => t.time)
            .filter(Boolean)
            .sort();
          if (!validTimes.length && dischargeCutoff != null) continue;
          const qtyPerDose = quantityOf(item, category, null, times.filter(t => !t.noTime && t.time).length || 1);
          const unit = unitOf(item, category, route);
          const note = String(item.ghi_chu || item.note || '').trim();
          pData.drugs.set(drugKey, {
            drugName,
            unit,
            qtyPerDose,
            times: validTimes,
            totalQty: qtyPerDose * (validTimes.length || 1),
            note,
            tuTuc: Boolean(item.tu_tuc),
          });
        }
      }
    }
  }

  return [...patientMap.values()]
    .filter(p => p.drugs.size > 0)
    .sort((a, b) =>
      String(a.room).localeCompare(String(b.room), 'vi', { numeric: true }) ||
      String(a.patientName).localeCompare(String(b.patientName), 'vi')
    );
}


// Nhận diện thuốc có thể trùng để người làm hỏi lại, KHÔNG tự bỏ dòng nào (bỏ nhầm = sót thuốc):
// - cùng người, cùng ngày, cùng tên: dòng "chưa rõ giờ" ghi duplicateOf = các cữ đã có giờ;
// - cùng người, cùng giờ, cùng đường dùng, cùng hoạt chất (từ đầu của tên) → possibleDuplicate.
const SOLVENT_FIRST = new Set(['NATRI', 'SODIUM', 'GLUCOSE', 'NUOC', 'RINGER', 'DEXTROSE']);
const normDrug = (name) => stripVN(String(name || '')).toUpperCase().replace(/[^A-Z0-9]+/g, ' ').trim();
const firstToken = (name) => (normDrug(name).split(' ').find(t => /[A-Z]{5,}/.test(t)) || '');

function flagDuplicateRows(rows) {
  const timedByName = new Map();
  for (const row of rows) {
    if (row.noTime) continue;
    const key = `${row.patientId || row.patientName}|${row.date}|${normDrug(row.drugName)}`;
    if (!timedByName.has(key)) timedByName.set(key, []);
    timedByName.get(key).push(row.time);
  }
  const sameSlot = new Map();
  for (const row of rows) {
    if (row.noTime) {
      const times = timedByName.get(`${row.patientId || row.patientName}|${row.date}|${normDrug(row.drugName)}`);
      if (times?.length) row.duplicateOf = [...new Set(times)].sort().join(', ');
      continue;
    }
    const tok = firstToken(row.drugName);
    if (!tok || SOLVENT_FIRST.has(tok)) continue;
    const key = `${row.patientId || row.patientName}|${row.date}|${row.time}|${row.route}|${tok}`;
    if (!sameSlot.has(key)) sameSlot.set(key, []);
    sameSlot.get(key).push(row);
  }
  for (const list of sameSlot.values()) {
    if (list.length > 1) for (const row of list) row.possibleDuplicate = true;
  }
  return rows;
}

function summarize(rows) {
  const map = new Map();
  for (const row of rows) {
    const key = `${row.drugName.toLowerCase()}|${row.route}|${row.unit}`;
    if (!map.has(key)) {
      map.set(key, {
        drugName: row.drugName,
        route: row.route,
        unit: row.unit,
        quantity: 0,
        patients: new Set(),
        times: new Set(),
      });
    }
    const item = map.get(key);
    item.quantity += Number(row.quantity || 0);
    item.patients.add(row.patientId || row.patientName);
    item.times.add(row.time);
  }
  return [...map.values()]
    .map(x => ({ ...x, patientCount: x.patients.size, timesText: [...x.times].sort().join(', ') }))
    .sort((a, b) => String(a.drugName).localeCompare(String(b.drugName), 'vi'));
}

function comparePrepRows(a, b) {
  const rp = routePriority(a.route) - routePriority(b.route);
  if (rp) return rp;
  const t = rowMinutes(a) - rowMinutes(b);
  if (t) return t;
  return String(a.drugName || '').localeCompare(String(b.drugName || ''), 'vi');
}

function groupRowsByPatient(rows) {
  const map = new Map();
  for (const row of rows || []) {
    const key = `${row.room}|${row.patientId || row.patientName}`;
    if (!map.has(key)) {
      map.set(key, { room: row.room, patientName: row.patientName, patientId: row.patientId, rows: [] });
    }
    map.get(key).rows.push(row);
  }
  return [...map.values()]
    .map(g => ({ ...g, rows: [...g.rows].sort(comparePrepRows) }))
    .sort((a, b) => String(a.room || '').localeCompare(String(b.room || ''), 'vi', { numeric: true })
      || String(a.patientName || '').localeCompare(String(b.patientName || ''), 'vi'));
}


function countRowsByCategory(rows) {
  const map = new Map();
  for (const row of rows || []) {
    const label = categoryLabel(row.category);
    map.set(label, (map.get(label) || 0) + 1);
  }
  return [...map.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'vi'));
}

export {
  mixTextOf,
  normalizeDmyToken, clockMinutesFrom, dischargeCutoffMinutes, isMedicationMomentAllowed,
  shouldHideFromDutyReport, collectDrugRows, collectOralDispenseData, summarize, flagDuplicateRows,
  comparePrepRows, groupRowsByPatient, countRowsByCategory,
};
