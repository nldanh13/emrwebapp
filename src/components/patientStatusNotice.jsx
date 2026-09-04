import { C } from '../tokens.js';

function normalizeText(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .toLowerCase();
}

function compactDateTime(value) {
  const s = String(value || '').trim();
  if (!s) return '';
  const m = s.match(/(\d{1,2}:\d{2})\s*(\d{1,2}[/-]\d{1,2}[/-]\d{2,4})?/);
  if (m) return [m[1], m[2]].filter(Boolean).join(' ');
  return s;
}

function eventTime(events, type) {
  const ev = (events || []).find(x => x && x.type === type);
  return compactDateTime(ev?.time_full || ev?.time_label || '');
}


function extractDmy(value) {
  const s = String(value || '').trim();
  const m = s.match(/(\d{1,2})[-/](\d{1,2})[-/](\d{2,4})/);
  if (!m) return '';
  const yy = m[3].length === 2 ? `20${m[3]}` : m[3];
  const dd = String(Number(m[1])).padStart(2, '0');
  const mm = String(Number(m[2])).padStart(2, '0');
  return `${dd}/${mm}/${yy}`;
}

function dmyStamp(value) {
  const dmy = extractDmy(value);
  if (!dmy) return 0;
  const [dd, mm, yyyy] = dmy.split('/').map(Number);
  const dt = new Date(yyyy, mm - 1, dd);
  return Number.isNaN(dt.getTime()) ? 0 : dt.getTime();
}

function latestAdmissionStamp(source = {}) {
  const values = [];
  [
    source.thoi_gian_vao_khoa,
    source.tg_vao,
    source.thoi_gian_vao,
    source.admission_time,
    source['T/G vào'],
    source['Thời gian vào khoa'],
  ].forEach(v => { if (v) values.push(v); });
  const histories = [];
  ['lich_su_khoa_dieu_tri', 'ward_admissions', 'khoa_dieu_tri_history'].forEach(key => {
    if (Array.isArray(source[key])) histories.push(...source[key]);
  });
  histories.forEach(item => {
    if (!item || typeof item !== 'object') return;
    ['thoi_gian_vao_khoa', 'tg_vao', 'ngay_vao', 'time', 'at', 'Ngày vào'].forEach(key => {
      if (item[key]) values.push(item[key]);
    });
  });
  return values.reduce((max, value) => Math.max(max, dmyStamp(value)), 0);
}

function isStaleDischargeForCurrentVisit(source = {}, events = []) {
  const dischargeRaw = eventTime(events, 'discharge')
    || source.ngay_ra_vien_date
    || source.ngay_ra_vien
    || source.NgayRaVien
    || source['Ngày ra viện'];
  const discharge = dmyStamp(dischargeRaw);
  if (!discharge) return false;
  const admission = latestAdmissionStamp(source);
  return Boolean(admission && discharge < admission);
}

function hasPostopText(source = {}) {
  const text = normalizeText([
    source.care_mode,
    source.surgery_out_reason,
    source.chan_doan,
    source.dx,
    source.diagnosis,
    source.ncs?.dien_bien,
    source.ncs?.y_lenh,
    source.nhap_cham_soc?.dien_bien,
    source.nhap_cham_soc?.y_lenh,
  ].filter(Boolean).join(' '));

  return /\b(hau phau|sau mo|hp ngay|vet mo|ctch nhan|pt\s*0?1|gmhs|gay me hoi suc|ket hop xuong|thay khop|noi soi)\b/.test(text)
    || /\bphau thuat\b/.test(text);
}

function dischargeTime(source, events) {
  const fromEvent = eventTime(events, 'discharge');
  if (fromEvent) return fromEvent;

  const full = compactDateTime(source.ngay_ra_vien || source.NgayRaVien || source['Ngày ra viện']);
  if (full) return full;

  const time = String(source.gio_ra_vien || '').trim();
  const date = String(source.ngay_ra_vien_date || source.ngay_lam || '').trim();
  return [time, date].filter(Boolean).join(' ');
}

function mergeSources(patient = {}, activeDay = null) {
  const day = activeDay || {};
  const events = [];
  if (Array.isArray(patient.care_special_events)) events.push(...patient.care_special_events);
  if (Array.isArray(day.care_special_events)) events.push(...day.care_special_events);

  return {
    ...patient,
    ...day,
    xu_tri: day.xu_tri || patient.xu_tri,
    care_mode: day.care_mode || patient.care_mode,
    ngay_ra_vien: day.ngay_ra_vien || patient.ngay_ra_vien,
    gio_ra_vien: day.gio_ra_vien || patient.gio_ra_vien,
    ngay_ra_vien_date: day.ngay_ra_vien_date || patient.ngay_ra_vien_date,
    surgery_out: day.surgery_out ?? patient.surgery_out,
    surgery_out_time: day.surgery_out_time || patient.surgery_out_time,
    surgery_out_reason: day.surgery_out_reason || patient.surgery_out_reason,
    care_special_events: events,
  };
}

function addNotice(list, key, label, detail, bg, color) {
  if (list.some(x => x.key === key)) return;
  list.push({ key, label, detail: String(detail || '').trim(), bg, color });
}

export function getPatientNotices(patient = {}, activeDay = null) {
  const source = mergeSources(patient, activeDay);
  const events = source.care_special_events || [];
  const eventTypes = new Set(events.map(x => x?.type).filter(Boolean));
  const mode = String(source.care_mode || '');
  const statusText = normalizeText([
    source.xu_tri,
    source.trang_thai,
    source.TrangThai,
    source.status_text,
    source.tinh_trang,
    source.surgery_out_reason,
  ].filter(Boolean).join(' '));

  const notices = [];
  const isHospitalTransfer = /\b(chuyen vien|chuyen tuyen|chuyen benh vien)\b/.test(statusText);
  const staleDischarge = isStaleDischargeForCurrentVisit(source, events);

  if (isHospitalTransfer && !staleDischarge) {
    addNotice(notices, 'hospital_transfer', 'Chuyển viện', dischargeTime(source, events), C.purple + '22', C.purple);
  } else if (!staleDischarge && (
    source.ngay_ra_vien || source.gio_ra_vien || source.ra_vien_hom_nay ||
    eventTypes.has('discharge') || mode === 'discharge_day' ||
    /\b(ra vien|xuat vien|cho ve|tu vong)\b/.test(statusText)
  )) {
    addNotice(notices, 'discharge', 'Xuất viện', dischargeTime(source, events), C.amberBg, C.amber);
  }

  if (mode === 'postop_receive_day' || eventTypes.has('postop_receive') || hasPostopText(source)) {
    addNotice(notices, 'postop', 'Hậu phẫu', eventTime(events, 'postop_receive'), C.blueBg, C.blue);
  }

  if (source.surgery_out || mode === 'surgery_out_day' || /\b(di mo|chuyen mo|dang di mo|gmhs|gay me hoi suc)\b/.test(statusText)) {
    addNotice(notices, 'surgery_out', 'Đi mổ', compactDateTime(source.surgery_out_time), C.purple + '22', C.purple);
  }

  if (
    mode === 'admission_transfer_day' ||
    eventTypes.has('ward_receive') ||
    eventTypes.has('interdepartment_receive') ||
    /\b(chuyen khoa|nhan khoa|nhan benh|chuyen den)\b/.test(statusText)
  ) {
    addNotice(notices, 'ward_transfer', 'Chuyển khoa', eventTime(events, 'ward_receive') || eventTime(events, 'interdepartment_receive'), C.greenBg, C.green);
  }

  if (eventTypes.has('clinic_admission')) {
    addNotice(notices, 'admission', 'Nhập viện', eventTime(events, 'clinic_admission'), C.greenBg, C.green);
  }

  return notices;
}

export function PatientNoticePills({ notices = [], compact = false }) {
  if (!Array.isArray(notices) || notices.length === 0) return null;

  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginBottom: compact ? 4 : 6 }}>
      {notices.map(n => (
        <span key={n.key} title={n.detail || n.label} style={{
          display: 'inline-flex', alignItems: 'center', gap: 4,
          maxWidth: compact ? 150 : 260,
          padding: compact ? '1px 6px' : '2px 7px',
          borderRadius: 4,
          fontSize: compact ? 10 : 11,
          fontWeight: 700,
          lineHeight: compact ? '15px' : '17px',
          background: n.bg,
          color: n.color,
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
        }}>
          <span>{n.label}</span>
          {n.detail && <span style={{ opacity: 0.85, fontWeight: 600 }}>{n.detail}</span>}
        </span>
      ))}
    </div>
  );
}
