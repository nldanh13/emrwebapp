// server/services/hchanh/discharge_qa.js
// QA hồ sơ ra viện — config-driven, đọc rule từ config/hchanh/qa_rules.json.
// CLS lấy từ billing.rows (không cần fetch riêng).

'use strict';

const fs   = require('fs');
const path = require('path');

function safeArray(v)   { return Array.isArray(v) ? v : []; }
function text(v, fb='') { return String(v ?? '').replace(/\s+/g, ' ').trim() || fb; }
function normText(v) {
  return String(v ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd').replace(/Đ/g, 'D').toLowerCase().replace(/\s+/g, ' ').trim();
}

function makeIssue({ group, severity, code, title, detail='', action='Kiểm tra lại trên EMR.', owner='Điều dưỡng hành chánh', evidence='' }) {
  return {
    id: code, code: text(code),
    group: text(group, 'Hành chánh'),
    severity: ['error','warn','info'].includes(severity) ? severity : 'warn',
    title: text(title), detail: text(detail),
    action: text(action), owner: text(owner), evidence: text(evidence),
  };
}

// ── Load config ───────────────────────────────────────────────────────────────

let _cache = null, _cacheTime = 0;
function loadQaRules() {
  const now = Date.now();
  if (_cache && now - _cacheTime < 30000) return _cache;
  try {
    const p = path.join(__dirname, '..', '..', '..', 'config', 'hchanh', 'qa_rules.json');
    if (fs.existsSync(p)) { _cache = JSON.parse(fs.readFileSync(p, 'utf-8')); _cacheTime = now; return _cache; }
  } catch (e) { console.warn('[QA] Không đọc qa_rules.json:', e.message); }
  return {};
}

// ── Trích xuất CLS từ billing ─────────────────────────────────────────────────
// Từ billing.rows: lọc nhóm CDHA, XN, Thăm dò chức năng — chỉ xét dòng BHYT.

function extractClsFromBilling(billing) {
  const CLS_LOAI = ['chẩn đoán hình ảnh', 'xét nghiệm', 'thăm dò chức năng',
                    'giải phẫu bệnh', 'vi sinh', 'tinh dịch đồ', 'cận lâm sàng'];
  const rows = safeArray(billing?.rows);
  return rows.filter(r => {
    const loai = normText(r.loai_yc || '');
    return CLS_LOAI.some(k => loai.includes(normText(k)));
  }).map(r => ({
    name:    text(r.name),
    loai_yc: text(r.loai_yc),
    pg:      r.payment_group || 'unknown',
    don_gia: Number(r.don_gia || 0),
  }));
}

// ── Kiểm profile ─────────────────────────────────────────────────────────────

function checkProfile(profile) {
  const issues = [];
  if (!profile) return [makeIssue({ group:'Thông tin nền', severity:'error', code:'PROFILE_NOT_FETCHED',
    title:'Chưa lấy thông tin nền bệnh nhân', action:'Bấm "Lấy dữ liệu ra viện".' })];
  if (!text(profile.ho_ten))
    issues.push(makeIssue({ group:'Thông tin nền', severity:'warn', code:'PROFILE_NAME_MISSING',
      title:'Thiếu họ tên người bệnh' }));
  if (!text(profile.bhyt_code) && !profile.tu_tuc)
    issues.push(makeIssue({ group:'BHYT', severity:'warn', code:'BHYT_CODE_MISSING',
      title:'Chưa thấy mã thẻ BHYT / đối tượng thanh toán',
      action:'Kiểm tra thẻ BHYT trên EMR.', owner:'Điều dưỡng hành chánh/viện phí' }));
  return issues;
}

// ── Kiểm giấy ra viện ────────────────────────────────────────────────────────

function checkDischarge(discharge, profile, rules = {}) {
  const issues = [];
  const cfg = rules.discharge_paper_rules || {};

  if (!discharge) return [makeIssue({ group:'Ra viện', severity:'error', code:'DISCHARGE_NOT_FETCHED',
    title:'Chưa lấy dữ liệu ra viện', action:'Bấm "Lấy đủ ra viện".' })];

  // Xử trí: dùng tinh_trang_ra (đã có) hoặc xu_tri
  const xu_tri = text(discharge.xu_tri || discharge.tinh_trang_ra);
  if (cfg.require_xu_tri !== false && !xu_tri)
    issues.push(makeIssue({ group:'Ra viện', severity:'error', code:'DISCHARGE_DISPOSITION_MISSING',
      title:'Thiếu xử trí / tình trạng ra viện',
      action:'Bác sĩ cập nhật tình trạng ra viện trên EMR.', owner:'Bác sĩ điều trị' }));

  // Ngày ra: ưu tiên từ profile (lblNgayRaVien), fallback discharge.ngay_ra
  const ngay_ra = text(profile?.ngay_ra_vien || discharge.ngay_ra || discharge.raw_time);
  if (cfg.require_ngay_gio_ra !== false && !ngay_ra)
    issues.push(makeIssue({ group:'Ra viện', severity:'error', code:'DISCHARGE_DATETIME_MISSING',
      title:'Thiếu ngày/giờ ra viện', action:'Bác sĩ bổ sung ngày giờ ra viện.', owner:'Bác sĩ điều trị' }));

  // Chẩn đoán chính ra viện
  const cd_chinh = text(discharge.chan_doan_chinh || discharge.chan_doan_ra);
  if (cfg.require_chan_doan_ra !== false && !cd_chinh)
    issues.push(makeIssue({ group:'Ra viện', severity:'warn', code:'DISCHARGE_DIAGNOSIS_MISSING',
      title:'Chưa có chẩn đoán chính ra viện',
      action:'Bác sĩ bổ sung chẩn đoán chính ICD10.', owner:'Bác sĩ điều trị' }));

  // Kết quả điều trị
  if (cfg.require_ket_qua && !text(discharge.ket_qua))
    issues.push(makeIssue({ group:'Ra viện', severity:'warn', code:'DISCHARGE_OUTCOME_MISSING',
      title:'Chưa có kết quả điều trị', action:'Bác sĩ ghi kết quả (khỏi/đỡ/...).', owner:'Bác sĩ điều trị' }));

  // Hẹn tái khám
  if (text(discharge.hen_tai_kham) === 'Hẹn khám') {
    if (!text(discharge.tg_hen_kham))
      issues.push(makeIssue({ group:'Tái khám', severity:'error', code:'FOLLOWUP_TIME_MISSING',
        title:'Chọn "Hẹn khám" nhưng chưa điền thời gian hẹn',
        action:'Bác sĩ bổ sung ngày giờ hẹn tái khám.', owner:'Bác sĩ điều trị' }));
    if (!text(discharge.phong_kham))
      issues.push(makeIssue({ group:'Tái khám', severity:'error', code:'FOLLOWUP_ROOM_MISSING',
        title:'Chọn "Hẹn khám" nhưng chưa chọn phòng khám',
        action:'Bác sĩ chọn phòng khám tái khám.', owner:'Bác sĩ điều trị' }));
  }

  // Nghỉ NGT sau ĐT
  const so_ngay_ngt = Number(discharge.so_ngay_nghi_ngt || 0);
  if (so_ngay_ngt > 0) {
    if (discharge.ngay_bd_nghi_ngt && !discharge.ngay_kt_nghi_ngt)
      issues.push(makeIssue({ group:'Nghỉ NGT', severity:'warn', code:'NGT_END_DATE_MISSING',
        title:'Có ngày bắt đầu nghỉ NGT nhưng thiếu ngày kết thúc',
        action:'Bác sĩ bổ sung ngày kết thúc nghỉ NGT.', owner:'Bác sĩ điều trị' }));
  }

  return issues;
}

// ── Kiểm ngày giường ─────────────────────────────────────────────────────────

function parseVNDateTime(value) {
  const raw = text(value);
  if (!raw) return null;

  // ISO nội bộ: 2026-05-21T10:54:00 hoặc 2026-05-21 10:54
  const iso = raw.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T\s](\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
  if (iso) {
    const yy = Number(iso[1]);
    const mo = Number(iso[2]);
    const dd = Number(iso[3]);
    const hh = Number(iso[4] || 0);
    const mm = Number(iso[5] || 0);
    const ss = Number(iso[6] || 0);
    if (yy && mo && dd) return new Date(Date.UTC(yy, mo - 1, dd, hh, mm, ss, 0));
  }

  // Nhận: "00:42 16-05-2026", "13:00 01/06/2026", "21/05/2026", "... (Thứ 2)"
  const m = raw.match(/(?:(\d{1,2}):(\d{2})\s*)?(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})/);
  if (!m) return null;
  const hh = Number(m[1] || 0);
  const mm = Number(m[2] || 0);
  const dd = Number(m[3]);
  const mo = Number(m[4]);
  const yy = Number(m[5]);
  if (!dd || !mo || !yy) return null;
  return new Date(Date.UTC(yy, mo - 1, dd, hh, mm, 0, 0));
}

function firstParsedDateTime(values) {
  for (const v of safeArray(values)) {
    const d = parseVNDateTime(v);
    if (d) return d;
  }
  return null;
}

function dateOnlyUTC(d) {
  if (!(d instanceof Date) || Number.isNaN(d.getTime())) return null;
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

function addDaysUTC(d, days) {
  const x = dateOnlyUTC(d);
  if (!x) return null;
  x.setUTCDate(x.getUTCDate() + Number(days || 0));
  return x;
}

function diffDaysUTC(a, b) {
  const da = dateOnlyUTC(a), db = dateOnlyUTC(b);
  if (!da || !db) return 0;
  return Math.round((db.getTime() - da.getTime()) / 86400000);
}

function dateKeyUTC(d) {
  const x = dateOnlyUTC(d);
  if (!x) return '';
  const y = x.getUTCFullYear();
  const m = String(x.getUTCMonth() + 1).padStart(2, '0');
  const day = String(x.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function fmtDateUTC(d) {
  const x = dateOnlyUTC(d);
  if (!x) return '';
  return `${String(x.getUTCDate()).padStart(2, '0')}/${String(x.getUTCMonth() + 1).padStart(2, '0')}/${x.getUTCFullYear()}`;
}

function fmtDateTimeUTC(d) {
  if (!(d instanceof Date) || Number.isNaN(d.getTime())) return '';
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')} ${String(d.getUTCDate()).padStart(2, '0')}/${String(d.getUTCMonth() + 1).padStart(2, '0')}/${d.getUTCFullYear()}`;
}

function addMinutesUTC(d, minutes) {
  if (!(d instanceof Date) || Number.isNaN(d.getTime())) return null;
  return new Date(d.getTime() + Number(minutes || 0) * 60000);
}

function addExactDaysUTC(d, days) {
  if (!(d instanceof Date) || Number.isNaN(d.getTime())) return null;
  return new Date(d.getTime() + Number(days || 0) * 86400000);
}

function minDateUTC(...items) {
  const vals = items.filter(d => d instanceof Date && !Number.isNaN(d.getTime()));
  if (!vals.length) return null;
  return vals.reduce((a, b) => a.getTime() <= b.getTime() ? a : b);
}

function maxDateUTC(...items) {
  const vals = items.filter(d => d instanceof Date && !Number.isNaN(d.getTime()));
  if (!vals.length) return null;
  return vals.reduce((a, b) => a.getTime() >= b.getTime() ? a : b);
}

function positiveInterval(start, end) {
  return start instanceof Date && end instanceof Date && !Number.isNaN(start.getTime()) && !Number.isNaN(end.getTime()) && end.getTime() > start.getTime();
}

function intervalOverlapMs(aStart, aEnd, bStart, bEnd) {
  const st = Math.max(aStart?.getTime?.() ?? NaN, bStart?.getTime?.() ?? NaN);
  const en = Math.min(aEnd?.getTime?.() ?? NaN, bEnd?.getTime?.() ?? NaN);
  return Number.isFinite(st) && Number.isFinite(en) ? Math.max(0, en - st) : 0;
}

function intervalIncludesInstant(itv, instant) {
  return itv?.start instanceof Date && itv?.end instanceof Date && instant instanceof Date &&
    itv.start.getTime() <= instant.getTime() && instant.getTime() < itv.end.getTime();
}

function fmtIntervalUTC(start, endExclusive) {
  if (!positiveInterval(start, endExclusive)) return '';
  const displayEnd = addMinutesUTC(endExclusive, -1) || endExclusive;
  return `${fmtDateTimeUTC(start)} → ${fmtDateTimeUTC(displayEnd)}`;
}

function fmtDateKey(key) {
  const m = String(key || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : text(key);
}

function isSameOrAfterDate(a, b) { return dateOnlyUTC(a)?.getTime() >= dateOnlyUTC(b)?.getTime(); }
function isBeforeDate(a, b) { return dateOnlyUTC(a)?.getTime() < dateOnlyUTC(b)?.getTime(); }

function shouldCountDischargeDay(discharge = {}) {
  const blob = normText([
    discharge.xu_tri,
    discharge.tinh_trang_ra,
    discharge.ket_qua,
    discharge.ly_do_cho_ve,
  ].filter(Boolean).join(' '));
  // Thông thường: ngày ra không tính. Một số trường hợp đặc biệt mới cộng ngày ra.
  return blob.includes('tu vong') || blob.includes('chuyen vien') || blob.includes('tien luong nang') || blob.includes('xin ve');
}

const BED_CLASS = Object.freeze({
  noi2:   { key:'noi2',   label:'Giường Nội khoa loại 2', short:'Nội 2',   kind:'internal' },
  noi1:   { key:'noi1',   label:'Giường Nội khoa loại 1', short:'Nội 1',   kind:'internal' },
  noi3:   { key:'noi3',   label:'Giường Nội khoa loại 3', short:'Nội 3',   kind:'internal' },
  ngoai1: { key:'ngoai1', label:'Giường Ngoại khoa loại 1', short:'Ngoại 1', kind:'surgery' },
  ngoai2: { key:'ngoai2', label:'Giường Ngoại khoa loại 2', short:'Ngoại 2', kind:'surgery' },
  ngoai3: { key:'ngoai3', label:'Giường Ngoại khoa loại 3', short:'Ngoại 3', kind:'surgery' },
  ngoai4: { key:'ngoai4', label:'Giường Ngoại khoa loại 4', short:'Ngoại 4', kind:'surgery' },
  other:  { key:'other',  label:'Giường khác/chưa nhận diện', short:'Khác', kind:'other' },
});

function classifyBedText(value) {
  const s = normText(value);
  if (!s) return BED_CLASS.other;
  // Ưu tiên tên dịch vụ ở đầu chuỗi. Ví dụ tên giường Nội khoa nhưng tên khoa có chữ "Ngoại CTCH".
  if (/giuong\s+noi\s+khoa\s+loai\s+1/.test(s) || /noi\s+khoa\s+loai\s+i(\b|\s)/.test(s)) return BED_CLASS.noi1;
  if (/giuong\s+noi\s+khoa\s+loai\s+2/.test(s) || /noi\s+khoa\s+loai\s+ii(\b|\s)/.test(s)) return BED_CLASS.noi2;
  if (/giuong\s+noi\s+khoa\s+loai\s+3/.test(s) || /noi\s+khoa\s+loai\s+iii(\b|\s)/.test(s)) return BED_CLASS.noi3;
  if (/giuong\s+ngoai\s+khoa\s+loai\s+1/.test(s) || /ngoai\s+khoa\s+loai\s+i(\b|\s)/.test(s)) return BED_CLASS.ngoai1;
  if (/giuong\s+ngoai\s+khoa\s+loai\s+2/.test(s) || /ngoai\s+khoa\s+loai\s+ii(\b|\s)/.test(s)) return BED_CLASS.ngoai2;
  if (/giuong\s+ngoai\s+khoa\s+loai\s+3/.test(s) || /ngoai\s+khoa\s+loai\s+iii(\b|\s)/.test(s)) return BED_CLASS.ngoai3;
  if (/giuong\s+ngoai\s+khoa\s+loai\s+4/.test(s) || /ngoai\s+khoa\s+loai\s+iv(\b|\s)/.test(s)) return BED_CLASS.ngoai4;
  const servicePart = s.split('|')[0].split(' - khoa ')[0];
  const isNgoai = servicePart.includes('ngoai khoa') || servicePart.includes('ngoai');
  const isNoi = servicePart.includes('noi khoa') || servicePart.includes('noi');
  if (isNgoai && (servicePart.includes('loai 1') || servicePart.includes('loai i'))) return BED_CLASS.ngoai1;
  if (isNgoai && (servicePart.includes('loai 2') || servicePart.includes('loai ii'))) return BED_CLASS.ngoai2;
  if (isNgoai && (servicePart.includes('loai 3') || servicePart.includes('loai iii'))) return BED_CLASS.ngoai3;
  if (isNgoai && (servicePart.includes('loai 4') || servicePart.includes('loai iv'))) return BED_CLASS.ngoai4;
  if (isNoi && (servicePart.includes('loai 1') || servicePart.includes('loai i'))) return BED_CLASS.noi1;
  if (isNoi && (servicePart.includes('loai 2') || servicePart.includes('loai ii'))) return BED_CLASS.noi2;
  if (isNoi && (servicePart.includes('loai 3') || servicePart.includes('loai iii'))) return BED_CLASS.noi3;
  return BED_CLASS.other;
}

function surgeryClassToBedClass(className) {
  const s = normText(className);
  if (!s) return null;
  // Theo nhóm ngày giường sau PT: đặc biệt/loại I → Ngoại 1; loại II → Ngoại 2; loại III → Ngoại 3.
  if (s.includes('dac biet') || s.includes('loai 1') || s.includes('loai i')) return BED_CLASS.ngoai1;
  if (s.includes('loai 2') || s.includes('loai ii')) return BED_CLASS.ngoai2;
  if (s.includes('loai 3') || s.includes('loai iii')) return BED_CLASS.ngoai3;
  if (s.includes('loai 4') || s.includes('loai iv')) return BED_CLASS.ngoai4;
  return null;
}

function dateFromSurgeryRow(row) {
  // Ưu tiên ngày trong danh sách PT. Một số màn hình chi tiết có thể giữ thời gian popup/field khác gây lệch.
  return parseVNDateTime(row?.thoi_gian)
      || parseVNDateTime(row?.ngay)
      || parseVNDateTime(row?.tg_ylenh)
      || parseVNDateTime(row?.detail?.ngay)
      || parseVNDateTime(row?.detail?.bat_dau)
      || parseVNDateTime(row?.bat_dau);
}

function findPostopWardDate(surgery, surgeryDate, admissionDate, dischargeEndExclusive) {
  const wards = safeArray(surgery?.postop_ward_admissions).concat(safeArray(surgery?.ward_admissions));
  const candidates = [];
  for (const w of wards) {
    const d = firstParsedDateTime([w?.ngay_vao_iso, w?.ngay_vao, w?.time, w?.text]);
    if (!d) continue;
    const khoa = normText(w?.ten_khoa || w?.khoa || '');
    const isSurgicalWard = khoa.includes('chan thuong') || khoa.includes('ngoai') || khoa.includes('chinh hinh');
    const isAfterSurgeryDay = surgeryDate ? !isBeforeDate(d, surgeryDate) : true;
    const isAfterAdmission = admissionDate ? !isBeforeDate(d, admissionDate) : true;
    const isBeforeDischarge = dischargeEndExclusive ? isBeforeDate(d, dischargeEndExclusive) : true;
    if (isSurgicalWard && isAfterSurgeryDay && isAfterAdmission && isBeforeDischarge) candidates.push(d);
  }
  candidates.sort((a, b) => a.getTime() - b.getTime());
  return candidates[0] || surgeryDate || null;
}

function getPrimarySurgery(surgery, admissionDate, dischargeEndExclusive) {
  const surgeries = safeArray(surgery?.surgeries);
  if (!surgeries.length) return null;
  const ranked = surgeries.map(r => ({ row: r, date: dateFromSurgeryRow(r) }))
    .filter(x => x.date)
    .filter(x => (!admissionDate || !isBeforeDate(x.date, admissionDate)) && (!dischargeEndExclusive || isBeforeDate(x.date, dischargeEndExclusive)))
    .sort((a, b) => a.date.getTime() - b.date.getTime());
  const chosen = ranked[0] || { row: surgeries[0], date: dateFromSurgeryRow(surgeries[0]) };
  const className = text(chosen.row?.phan_loai_pt || chosen.row?.detail?.phan_loai_pt || chosen.row?.class || chosen.row?.loai);
  const bedClass = surgeryClassToBedClass(className) || BED_CLASS.ngoai1;
  return { row: chosen.row, date: chosen.date, className, bedClass };
}

function extractRowDate(row) {
  return parseVNDateTime(row?.tu) || parseVNDateTime(row?.tg_ylenh) || parseVNDateTime(row?.ngay) || parseVNDateTime(row?.den);
}

function isCanceledBedRow(row) {
  return normText(row?.trang_thai).includes('huy');
}

function rowToBedClass(row) {
  return classifyBedText([row?.mo_ta, row?.dich_vu_giuong, row?.ten_giuong, row?.giuong, row?.name].filter(Boolean).join(' '));
}

function normalizeBedRowEnd(start, parsedEnd) {
  if (!start || !parsedEnd) return null;
  let end = addMinutesUTC(parsedEnd, 1); // UI hiển thị đến 23:59 là hết phút 23:59, nên so sánh dạng [start, end)
  if (!positiveInterval(start, end)) end = addDaysUTC(start, 1);
  return end;
}

function bedRowInterval(row) {
  const start = parseVNDateTime(row?.tu) || parseVNDateTime(row?.tg_ylenh) || parseVNDateTime(row?.ngay);
  const parsedEnd = parseVNDateTime(row?.den) || start;
  const end = normalizeBedRowEnd(start, parsedEnd);
  if (!positiveInterval(start, end)) return null;
  return { start, end };
}

function extractRowDate(row) {
  const itv = bedRowInterval(row);
  return itv?.start || parseVNDateTime(row?.tu) || parseVNDateTime(row?.tg_ylenh) || parseVNDateTime(row?.ngay) || parseVNDateTime(row?.den);
}

function isCanceledBedRow(row) {
  return normText(row?.trang_thai).includes('huy');
}

function buildActualBedIntervals(rows) {
  return safeArray(rows).filter(r => r && !isCanceledBedRow(r)).map((row, index) => {
    const itv = bedRowInterval(row);
    if (!itv) return null;
    const cls = rowToBedClass(row);
    return {
      index,
      row,
      start: itv.start,
      end: itv.end,
      key: cls.key,
      label: cls.label,
      short: cls.short,
      range_datetime: fmtIntervalUTC(itv.start, itv.end),
    };
  }).filter(Boolean).sort((a, b) => a.start.getTime() - b.start.getTime());
}

function summarizeRowsByBedClass(rows) {
  const summary = {};
  const byDate = {};
  const intervals = buildActualBedIntervals(rows);
  for (const itv of intervals) {
    const days = Math.max(1, Number(itv.row?.so_ngay || itv.row?.sl || 1) || 1);
    if (!summary[itv.key]) summary[itv.key] = { key: itv.key, label: itv.label, short: itv.short, days: 0 };
    summary[itv.key].days += days;
    byDate[dateKeyUTC(itv.start)] = { key: itv.key, label: itv.label, short: itv.short, row: itv.row, range_datetime: itv.range_datetime };
  }
  return { summary, byDate, intervals };
}

function inferInternalBedClass(rows, beforeDate) {
  const counts = {};
  const beforeMs = beforeDate instanceof Date ? beforeDate.getTime() : null;
  for (const itv of buildActualBedIntervals(rows)) {
    if (beforeMs && itv.start.getTime() >= beforeMs) continue;
    const cls = BED_CLASS[itv.key] || BED_CLASS.other;
    if (cls.kind !== 'internal') continue;
    counts[cls.key] = (counts[cls.key] || 0) + (Number(itv.row?.so_ngay || 1) || 1);
  }
  const best = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
  return best ? BED_CLASS[best[0]] : BED_CLASS.noi2;
}

function buildExpectedBedIntervals({ admitAt, billableEnd, postopStart, surgicalBedClass, internalBedClass }) {
  const intervals = [];
  if (!positiveInterval(admitAt, billableEnd)) return intervals;

  const push = (start, end, cls, reason) => {
    if (!cls || !positiveInterval(start, end)) return;
    const prev = intervals[intervals.length - 1];
    if (prev && prev.key === cls.key && prev.end.getTime() === start.getTime()) {
      prev.end = end;
      prev.range_datetime = fmtIntervalUTC(prev.start, prev.end);
      return;
    }
    intervals.push({
      start, end, key: cls.key, label: cls.label, short: cls.short, kind: cls.kind,
      reason: text(reason), range_datetime: fmtIntervalUTC(start, end),
    });
  };

  if (!postopStart || !surgicalBedClass || postopStart.getTime() >= billableEnd.getTime()) {
    push(admitAt, billableEnd, internalBedClass, 'Không có mốc hậu phẫu trong khoảng điều trị tính tiền.');
    return intervals;
  }

  const surgicalStart = maxDateUTC(admitAt, postopStart);
  const surgicalEnd = minDateUTC(addExactDaysUTC(postopStart, 10), billableEnd);
  push(admitAt, surgicalStart, internalBedClass, 'Trước mốc nhận khoa sau phẫu thuật.');
  push(surgicalStart, surgicalEnd, surgicalBedClass, 'Sau phẫu thuật, tối đa 10 ngày theo giờ phút mốc hậu phẫu.');
  push(surgicalEnd, billableEnd, internalBedClass, 'Sau giới hạn 10 ngày hậu phẫu, quay lại giường nội khoa.');
  return intervals;
}

function classAtInstant(intervals, instant) {
  return safeArray(intervals).find(itv => intervalIncludesInstant(itv, instant)) || null;
}

function dominantClassForSlice(intervals, sliceStart, sliceEnd) {
  const totals = {};
  for (const itv of safeArray(intervals)) {
    const ms = intervalOverlapMs(sliceStart, sliceEnd, itv.start, itv.end);
    if (ms <= 0) continue;
    if (!totals[itv.key]) totals[itv.key] = { key: itv.key, label: itv.label, short: itv.short, ms: 0 };
    totals[itv.key].ms += ms;
  }
  return Object.values(totals).sort((a, b) => b.ms - a.ms)[0] || null;
}

function buildExpectedDayPlan(admitAt, billableEnd, expectedIntervals) {
  const dayPlan = [];
  if (!positiveInterval(admitAt, billableEnd)) return dayPlan;
  for (let d = dateOnlyUTC(admitAt); d && d.getTime() < billableEnd.getTime(); d = addDaysUTC(d, 1)) {
    const dayStart = d;
    const dayEnd = addDaysUTC(d, 1);
    const sliceStart = maxDateUTC(dayStart, admitAt);
    const sliceEnd = minDateUTC(dayEnd, billableEnd);
    if (!positiveInterval(sliceStart, sliceEnd)) continue;
    const dom = dominantClassForSlice(expectedIntervals, sliceStart, sliceEnd);
    if (!dom) continue;
    dayPlan.push({
      date: dayStart,
      key: dom.key,
      label: dom.label,
      short: dom.short,
      slice_start: sliceStart,
      slice_end: sliceEnd,
      range_datetime: fmtIntervalUTC(sliceStart, sliceEnd),
      dominant_minutes: Math.round(dom.ms / 60000),
      partial: sliceStart.getTime() !== dayStart.getTime() || sliceEnd.getTime() !== dayEnd.getTime(),
    });
  }
  return dayPlan;
}

function compressDayPlan(dayPlan) {
  const periods = [];
  for (const d of dayPlan) {
    const prev = periods[periods.length - 1];
    if (prev && prev.key === d.key && diffDaysUTC(prev.endExclusive, d.date) === 0) {
      prev.endExclusive = addDaysUTC(d.date, 1);
      prev.days += 1;
      prev.exact_end = d.slice_end;
    } else {
      periods.push({
        key: d.key,
        label: d.label,
        short: d.short,
        start: d.date,
        endExclusive: addDaysUTC(d.date, 1),
        exact_start: d.slice_start,
        exact_end: d.slice_end,
        days: 1,
      });
    }
  }
  return periods.map(p => ({
    ...p,
    from: fmtDateUTC(p.start),
    to: fmtDateUTC(addDaysUTC(p.endExclusive, -1)),
    range: `${fmtDateUTC(p.start)} → ${fmtDateUTC(addDaysUTC(p.endExclusive, -1))}`,
    range_datetime: fmtIntervalUTC(p.exact_start, p.exact_end),
  }));
}

function compressExpectedIntervals(intervals) {
  return safeArray(intervals).map(itv => ({
    key: itv.key,
    label: itv.label,
    short: itv.short,
    from_datetime: fmtDateTimeUTC(itv.start),
    to_datetime: fmtDateTimeUTC(addMinutesUTC(itv.end, -1) || itv.end),
    range_datetime: fmtIntervalUTC(itv.start, itv.end),
    minutes: Math.round((itv.end.getTime() - itv.start.getTime()) / 60000),
    reason: itv.reason || '',
  }));
}

function intervalType(exp, act) {
  if (!exp && act) return 'extra';
  if (exp && !act) return 'missing';
  if (exp && act && exp.key !== act.key) return 'wrong_type';
  return '';
}

function buildMismatchIntervals(expectedIntervals, actualIntervals) {
  const times = [];
  const add = d => { if (d instanceof Date && !Number.isNaN(d.getTime())) times.push(d.getTime()); };
  for (const itv of safeArray(expectedIntervals)) { add(itv.start); add(itv.end); }
  for (const itv of safeArray(actualIntervals)) { add(itv.start); add(itv.end); }
  const boundaries = [...new Set(times)].sort((a, b) => a - b).map(ms => new Date(ms));
  const pieces = [];
  for (let i = 0; i < boundaries.length - 1; i += 1) {
    const start = boundaries[i];
    const end = boundaries[i + 1];
    if (!positiveInterval(start, end)) continue;
    const mid = new Date(start.getTime() + Math.max(1, Math.floor((end.getTime() - start.getTime()) / 2)));
    const exp = classAtInstant(expectedIntervals, mid);
    const act = classAtInstant(actualIntervals, mid);
    const type = intervalType(exp, act);
    if (!type) continue;
    const prev = pieces[pieces.length - 1];
    const expectedKey = exp?.key || '';
    const actualKey = act?.key || '';
    if (prev && prev.type === type && prev.expected_key === expectedKey && prev.actual_key === actualKey && prev.end.getTime() === start.getTime()) {
      prev.end = end;
      prev.minutes = Math.round((prev.end.getTime() - prev.start.getTime()) / 60000);
      prev.range_datetime = fmtIntervalUTC(prev.start, prev.end);
      prev.to_datetime = fmtDateTimeUTC(addMinutesUTC(prev.end, -1) || prev.end);
    } else {
      pieces.push({
        type,
        start,
        end,
        from_datetime: fmtDateTimeUTC(start),
        to_datetime: fmtDateTimeUTC(addMinutesUTC(end, -1) || end),
        range_datetime: fmtIntervalUTC(start, end),
        expected_key: expectedKey,
        actual_key: actualKey,
        expected: exp?.label || 'Không tính ngày giường',
        actual: act?.label || 'Chưa có dòng giường',
        minutes: Math.round((end.getTime() - start.getTime()) / 60000),
      });
    }
  }
  return pieces;
}
function buildPriceMapFromBilling(billing) {
  const prices = {};
  const actual = { total: 0, rows: 0, summary: {} };
  for (const r of safeArray(billing?.rows)) {
    const blob = [r.loai_yc, r.ma_dv, r.name].filter(Boolean).join(' ');
    if (!normText(blob).includes('ngay giuong') && !/^G\./i.test(text(r.ma_dv))) continue;
    const cls = classifyBedText(r.name || blob);
    const qty = Number(r.sl || r.so_luong || 1) || 1;
    const unit = Number(r.don_gia || 0) || 0;
    const amount = Number(r.thanh_tien || 0) || (unit * qty);
    if (unit > 0 && !prices[cls.key]) prices[cls.key] = unit;
    if (!actual.summary[cls.key]) actual.summary[cls.key] = { key: cls.key, label: cls.label, days: 0, amount: 0, unit_price: unit };
    actual.summary[cls.key].days += qty;
    actual.summary[cls.key].amount += amount;
    actual.total += amount;
    actual.rows += 1;
  }
  return { prices, actual };
}

function buildBedDaysReview({ profile, discharge, bed_days, surgery, billing }) {
  if (!bed_days) return { status:'unknown', reason:'Chưa có dữ liệu ngày giường.' };

  const admitAt = parseVNDateTime(profile?.ngay_vao_vien || profile?.ngay_vao || discharge?.ngay_vao);
  const dischargeAt = parseVNDateTime(profile?.ngay_ra_vien || profile?.ngay_ra || discharge?.raw_time || discharge?.ngay_ra);
  if (!admitAt || !dischargeAt) {
    return { status:'unknown', reason:'Thiếu ngày giờ vào hoặc ngày giờ ra nên chưa tính được ngày giường chuẩn.' };
  }

  const admissionDate = dateOnlyUTC(admitAt);
  const dischargeDate = dateOnlyUTC(dischargeAt);
  const countDischargeDay = shouldCountDischargeDay(discharge || {});
  const billableEnd = countDischargeDay ? addDaysUTC(dischargeDate, 1) : dischargeDate;
  const expectedTotal = Math.max(0, diffDaysUTC(admissionDate, billableEnd));

  const primarySurgery = getPrimarySurgery(surgery, admissionDate, billableEnd);
  const postopStartRaw = primarySurgery ? findPostopWardDate(surgery, primarySurgery.date, admitAt, billableEnd) : null;
  const surgicalBedClass = primarySurgery?.bedClass || null;
  const internalBedClass = inferInternalBedClass(bed_days.rows, postopStartRaw || billableEnd);

  const expectedIntervals = buildExpectedBedIntervals({
    admitAt,
    billableEnd,
    postopStart: postopStartRaw,
    surgicalBedClass,
    internalBedClass,
  });
  const dayPlan = buildExpectedDayPlan(admitAt, billableEnd, expectedIntervals);

  const expectedSummary = {};
  const expectedByDate = {};
  for (const d of dayPlan) {
    if (!expectedSummary[d.key]) expectedSummary[d.key] = { key:d.key, label:d.label, short:d.short, days:0 };
    expectedSummary[d.key].days += 1;
    expectedByDate[dateKeyUTC(d.date)] = { key:d.key, label:d.label, short:d.short, range_datetime:d.range_datetime };
  }

  const actual = summarizeRowsByBedClass(bed_days.rows);
  const actualTotal = Number(bed_days.so_ngay_tinh || 0) || Object.values(actual.summary).reduce((sum, x) => sum + Number(x.days || 0), 0);

  const differences = [];
  const keys = [...new Set([...Object.keys(expectedSummary), ...Object.keys(actual.summary)])];
  for (const key of keys) {
    const exp = Number(expectedSummary[key]?.days || 0);
    const act = Number(actual.summary[key]?.days || 0);
    if (exp !== act) {
      const cls = BED_CLASS[key] || { label: expectedSummary[key]?.label || actual.summary[key]?.label || key };
      differences.push({ key, label: cls.label, expected: exp, actual: act, delta: act - exp });
    }
  }

  const mismatchIntervals = buildMismatchIntervals(expectedIntervals, actual.intervals);
  const mismatchDates = mismatchIntervals.map(x => ({
    date: dateKeyUTC(x.start),
    expected: x.expected,
    actual: x.actual,
    type: x.type,
    range_datetime: x.range_datetime,
  }));

  const { prices, actual: billingActual } = buildPriceMapFromBilling(billing);
  const expectedAmount = Object.values(expectedSummary).reduce((sum, x) => sum + Number(x.days || 0) * Number(prices[x.key] || 0), 0);
  const actualAmount = billingActual.total || 0;

  const periods = compressDayPlan(dayPlan);
  const exactIntervals = compressExpectedIntervals(expectedIntervals);
  const postopEnd = postopStartRaw ? addExactDaysUTC(postopStartRaw, 10) : null;

  const suggestions = [];
  suggestions.push(`Mốc tính theo giờ phút: vào viện ${fmtDateTimeUTC(admitAt)}; ra viện ${fmtDateTimeUTC(dischargeAt)}${countDischargeDay ? ' (có tính ngày ra)' : ' (không tính ngày ra)'}.`);
  if (postopStartRaw && surgicalBedClass) {
    suggestions.push(`Mốc hậu phẫu ${fmtDateTimeUTC(postopStartRaw)}; giới hạn 10 ngày hậu phẫu đến ${fmtDateTimeUTC(postopEnd)}; sau mốc này quay về ${internalBedClass.label}.`);
  }
  if (actualTotal !== expectedTotal) {
    suggestions.push(`Tổng ngày giường dự kiến ${expectedTotal}, hiện đang tính ${actualTotal}.`);
  }
  for (const d of differences) {
    if (d.delta > 0) suggestions.push(`${d.label}: dư ${d.delta} ngày.`);
    if (d.delta < 0) suggestions.push(`${d.label}: thiếu ${Math.abs(d.delta)} ngày.`);
  }
  if (mismatchIntervals.length) {
    suggestions.push(`Khoảng giờ cần sửa: ${mismatchIntervals.slice(0, 5).map(x => `${x.range_datetime}: đang ${x.actual} → nên ${x.expected}`).join('; ')}${mismatchIntervals.length > 5 ? `; +${mismatchIntervals.length - 5} khoảng khác` : ''}.`);
  }
  if (periods.length) {
    suggestions.push(`Gợi ý tính tiền theo ngày: ${periods.map(p => `${p.range}: ${p.days} ngày ${p.label}`).join('; ')}.`);
  }
  if (expectedAmount && actualAmount && expectedAmount !== actualAmount) {
    suggestions.push(`Tiền giường ước tính theo bảng kê: hiện ${actualAmount.toLocaleString('vi-VN')}đ, dự kiến ${expectedAmount.toLocaleString('vi-VN')}đ, chênh ${(actualAmount - expectedAmount).toLocaleString('vi-VN')}đ.`);
  }

  const ok = actualTotal === expectedTotal && differences.length === 0 && mismatchIntervals.length === 0;
  return {
    status: ok ? 'ok' : 'mismatch',
    admission_date: fmtDateUTC(admissionDate),
    admission_datetime: fmtDateTimeUTC(admitAt),
    discharge_date: fmtDateUTC(dischargeDate),
    discharge_datetime: fmtDateTimeUTC(dischargeAt),
    billable_until_datetime: fmtDateTimeUTC(billableEnd),
    count_discharge_day: countDischargeDay,
    expected_total: expectedTotal,
    actual_total: actualTotal,
    expected_summary: Object.values(expectedSummary),
    actual_summary: Object.values(actual.summary),
    exact_intervals: exactIntervals,
    periods,
    differences,
    mismatch_dates: mismatchDates,
    mismatch_intervals: mismatchIntervals.map(x => ({
      type: x.type,
      from_datetime: x.from_datetime,
      to_datetime: x.to_datetime,
      range_datetime: x.range_datetime,
      expected: x.expected,
      actual: x.actual,
      minutes: x.minutes,
    })),
    surgery: primarySurgery ? {
      date: primarySurgery.date ? fmtDateTimeUTC(primarySurgery.date) : '',
      class_name: primarySurgery.className,
      postop_start: postopStartRaw ? fmtDateUTC(postopStartRaw) : '',
      postop_start_datetime: postopStartRaw ? fmtDateTimeUTC(postopStartRaw) : '',
      postop_end_datetime: postopEnd ? fmtDateTimeUTC(postopEnd) : '',
      surgical_bed: surgicalBedClass?.label || '',
      internal_bed: internalBedClass?.label || '',
      max_surgical_days: 10,
    } : null,
    amount: {
      actual: actualAmount || null,
      expected: expectedAmount || null,
      diff: (actualAmount && expectedAmount) ? actualAmount - expectedAmount : null,
    },
    suggestions,
  };
}

function checkBedDays(bed_days, rules = {}, review = null) {
  const issues = [];
  const cfg = rules.bed_days_rules || {};
  if (cfg.enabled === false) return issues;

  if (!bed_days) return [makeIssue({ group:'Tiền giường', severity:'warn', code:'BED_DAYS_NOT_FETCHED',
    title:'Chưa lấy dữ liệu ngày giường', action:'Bấm "Lấy ngày giường".' })];

  // Ưu tiên so với ngày giường chuẩn tính từ ngày vào/ra + mốc hậu phẫu.
  // Không dùng so_ngay_thuc thô nếu đã có review vì parser cũ có thể đọc sai thành 1 ngày.
  if (review && review.status === 'mismatch') {
    const detail = safeArray(review.suggestions).join(' ');
    issues.push(makeIssue({
      group:'Tiền giường',
      severity:'error',
      code:'BED_DAYS_NEEDS_ADJUSTMENT',
      title:`Ngày giường chưa khớp quy tắc: dự kiến ${review.expected_total} ngày, hiện ${review.actual_total} ngày`,
      detail,
      action:'Mở Buồng giường → Sửa thông tin, tách/đổi loại giường theo gợi ý từng khoảng ngày.',
      owner:'Điều dưỡng hành chánh/viện phí',
      evidence:`expected=${review.expected_total}, actual=${review.actual_total}`,
    }));
    return issues;
  }

  if (review && review.status === 'ok') return issues;

  // Fallback cũ khi chưa đủ dữ liệu ngày vào/ra hoặc phẫu thuật để tính chuẩn.
  const billed = Number(bed_days.so_ngay_tinh || 0);
  const actual = Number(bed_days.so_ngay_thuc || 0);
  const err_thr  = Number(cfg.error_under_threshold ?? 1);
  const warn_thr = Number(cfg.warn_over_threshold   ?? 1);

  if (billed > 0 && actual > 0) {
    if (actual - billed >= err_thr)
      issues.push(makeIssue({ group:'Tiền giường', severity:'error', code:'BED_DAYS_SHORT',
        title:`Thiếu ${actual - billed} ngày giường (tính ${billed}, thực tế ${actual})`,
        detail:`Bác sĩ cần bổ sung ${actual - billed} ngày giường còn thiếu.`,
        action:`Bổ sung ${actual - billed} ngày giường trên EMR.`, owner:'Bác sĩ điều trị',
        evidence:`billed=${billed}, actual=${actual}` }));
    else if (billed - actual >= warn_thr)
      issues.push(makeIssue({ group:'Tiền giường', severity:'warn', code:'BED_DAYS_OVER',
        title:`Số ngày giường tính (${billed}) nhiều hơn thực tế (${actual})`,
        action:'Kiểm tra lại ngày vào/ra và buồng giường.' }));
  }
  for (const w of safeArray(bed_days.warnings))
    issues.push(makeIssue({ group:'Tiền giường', severity:'warn', code:'BED_DAYS_WARNING',
      title:'Cảnh báo buồng giường', detail: text(w) }));
  return issues;
}

// ── Kiểm bảng kê ─────────────────────────────────────────────────────────────

function checkBilling(billing, rules = {}) {
  const issues = [];
  const cfg = rules.billing_rules || {};

  if (!billing) {
    if (cfg.require_billing_table !== false)
      return [makeIssue({ group:'Bảng kê', severity:'error', code:'BILLING_NOT_FETCHED',
        title:'Chưa lấy bảng kê chi phí', action:'Bấm "Lấy bảng kê".',
        owner:'Điều dưỡng hành chánh/viện phí' })];
    return issues;
  }
  const rows = safeArray(billing.rows);
  if (!rows.length)
    issues.push(makeIssue({ group:'Bảng kê', severity:'warn', code:'BILLING_EMPTY',
      title:'Bảng kê không có dòng chi phí nào', owner:'Điều dưỡng hành chánh/viện phí' }));
  else {
    const unknown = rows.filter(r => r.payment_group === 'unknown');
    const thr = Number(cfg.warn_unknown_payment_count ?? 1);
    if (unknown.length >= thr)
      issues.push(makeIssue({ group:'Bảng kê', severity:'warn', code:'BILLING_UNKNOWN_PAYMENT',
        title:`${unknown.length} dòng chưa rõ đối tượng thanh toán`,
        detail: unknown.slice(0,5).map(r=>r.name).join(' · '),
        action:'Kiểm tra đối tượng thanh toán từng dòng.', owner:'Điều dưỡng hành chánh/viện phí' }));
  }
  return issues;
}

// ── Kiểm CLS từ billing ↔ chẩn đoán ─────────────────────────────────────────
// Chỉ cờ lên nếu CLS đó dùng BHYT (bhyt) — Viện phí không cần kiểm.

function checkClsDiagnosis(billing, discharge, rules = {}) {
  const issues = [];
  if (!billing || !discharge) return issues;

  const cls_rules = safeArray(rules.cls_diagnosis_rules).filter(r => r.enabled !== false);
  const cls_rows  = extractClsFromBilling(billing);

  // Chuỗi tất cả tên CLS dùng BHYT để match rule
  const cls_bhyt_text = cls_rows
    .filter(r => r.pg === 'bhyt')
    .map(r => normText(r.name))
    .join(' ');

  // Toàn bộ chẩn đoán: chính + kèm + vào khoa
  const cd_texts = [
    discharge.chan_doan_chinh,
    discharge.chan_doan_ra,
    ...(safeArray(discharge.benh_kem).map(b => b)),
    ...(safeArray(discharge.chan_doan_vao_list).map(c => c.ten || '')),
  ].map(normText).join(' ');

  for (const rule of cls_rules) {
    const has_cls = safeArray(rule.cls_keywords).some(k => cls_bhyt_text.includes(normText(k)));
    if (!has_cls) continue;
    const has_dx  = safeArray(rule.dx_keywords).some(k => cd_texts.includes(normText(k)));
    if (!has_dx) {
      const matched_cls = cls_rows.find(r =>
        r.pg === 'bhyt' &&
        safeArray(rule.cls_keywords).some(k => normText(r.name).includes(normText(k)))
      );
      issues.push(makeIssue({
        group: 'CLS/Chẩn đoán', severity: rule.severity || 'warn', code: rule.code,
        title: rule.title, detail: rule.detail || '',
        action: rule.action || 'Bác sĩ bổ sung chẩn đoán phù hợp.',
        owner: rule.owner || 'Bác sĩ điều trị',
        evidence: matched_cls ? `${matched_cls.name} (BHYT)` : '',
      }));
    }
  }
  return issues;
}

// ── Kiểm rule chuyên khoa ─────────────────────────────────────────────────────

function checkSpecialtyRules(profile, discharge, billing, rules = {}) {
  const issues = [];
  const specialty_cfg = rules.specialty_rules || {};
  const dept_text   = normText([profile?.khoa, discharge?.chan_doan_chinh].join(' '));
  const dx_text     = normText([
    discharge?.chan_doan_chinh,
    ...(safeArray(discharge?.benh_kem)),
    ...(safeArray(discharge?.chan_doan_vao_list).map(c => c.ten || '')),
  ].join(' '));
  const supply_text = normText(safeArray(billing?.rows).map(r => r.name || '').join(' '));
  const cls_rows    = extractClsFromBilling(billing);
  const cls_bhyt_text = cls_rows.filter(r => r.pg === 'bhyt').map(r => normText(r.name)).join(' ');

  for (const [, spec] of Object.entries(specialty_cfg)) {
    if (!spec.enabled) continue;
    const dept_match = safeArray(spec.dept_keywords).some(k => dept_text.includes(normText(k)));
    if (!dept_match) continue;

    for (const rule of safeArray(spec.rules)) {
      if (!rule.enabled) continue;
      if (rule.dx_keywords && rule.required_cls_keywords) {
        const has_dx  = safeArray(rule.dx_keywords).some(k => dx_text.includes(normText(k)));
        if (!has_dx) continue;
        const has_cls = safeArray(rule.required_cls_keywords).some(k => cls_bhyt_text.includes(normText(k)));
        if (!has_cls) issues.push(makeIssue({ group:'Chuyên khoa', severity: rule.severity||'warn',
          code: rule.code, title: rule.title, detail: rule.detail||'',
          action: rule.action||'Kiểm tra lại hồ sơ.', owner: rule.owner||'Bác sĩ điều trị' }));
      }
      if (rule.dx_keywords && rule.required_supply_keywords) {
        const has_dx     = safeArray(rule.dx_keywords).some(k => dx_text.includes(normText(k)));
        if (!has_dx) continue;
        const has_supply = safeArray(rule.required_supply_keywords).some(k => supply_text.includes(normText(k)));
        if (!has_supply) issues.push(makeIssue({ group:'Chuyên khoa/VTYT', severity: rule.severity||'warn',
          code: rule.code, title: rule.title, detail: rule.detail||'',
          action: rule.action||'Kiểm tra vật tư.', owner: rule.owner||'Điều dưỡng phụ trách VTYT' }));
      }
    }
  }
  return issues;
}

// ── Kiểm giấy tờ kèm theo ────────────────────────────────────────────────────

function checkDocuments(documents) {
  const issues = [];

  if (!documents) {
    return [makeIssue({ group:'Giấy tờ kèm theo', severity:'warn', code:'DOCUMENTS_NOT_FETCHED',
      title:'Chưa lấy danh sách giấy tờ kèm theo',
      action:'Bấm "Lấy dữ liệu ra viện" để fetch giấy tờ kèm theo.' })];
  }

  const chua_ht = safeArray(documents.chua_ht_rows);
  if (chua_ht.length > 0) {
    const detail = chua_ht.slice(0, 3)
      .map(r => `${r.loai_phieu} (${r.ngay_tao} - ${r.nguoi_tao})`)
      .join('; ');
    issues.push(makeIssue({
      group:    'Giấy tờ kèm theo',
      severity: 'error',
      code:     'DOCUMENTS_INCOMPLETE',
      title:    `${chua_ht.length} giấy tờ kèm theo chưa hoàn tất`,
      detail:   detail + (chua_ht.length > 3 ? ` (+${chua_ht.length - 3} phiếu khác)` : ''),
      action:   'Bác sĩ/điều dưỡng mở từng phiếu → điền thông tin → bấm "Hoàn tất". Nếu phiếu rỗng thì bấm "Xóa".',
      owner:    'Bác sĩ điều trị',
      evidence: `chua_hoan_tat=${documents.chua_hoan_tat}/${documents.total}`,
    }));
  }

  return issues;
}

// ── Kiểm lịch sử y lệnh ──────────────────────────────────────────────────────

function checkOrderHistory(order_history) {
  const issues = [];

  if (!order_history) {
    return [makeIssue({ group:'Y lệnh', severity:'warn', code:'ORDER_HISTORY_NOT_FETCHED',
      title:'Chưa lấy lịch sử y lệnh',
      action:'Bấm "Lấy dữ liệu ra viện" để fetch lịch sử y lệnh.' })];
  }

  // 1. Y lệnh chưa hoàn tất
  const incomplete = safeArray(order_history.incomplete_rows);
  if (incomplete.length > 0) {
    // Tách riêng y lệnh ngày ra viện (quan trọng hơn — thường là thuốc ra viện)
    const discharge_date = text(order_history._discharge_date || '');
    const inc_discharge = discharge_date
      ? incomplete.filter(r => text(r.ngay).includes(discharge_date.replace(/\d{4}/, '').trim()) ||
                                text(r.tg_ylenh).includes(discharge_date))
      : [];
    const inc_other = inc_discharge.length ? incomplete.filter(r => !inc_discharge.includes(r)) : incomplete;

    if (inc_discharge.length > 0) {
      const detail = inc_discharge.map(r => `Phiếu ${r.so_phieu} (${r.tg_ylenh}) - ${r.ten_y_lenh || r.dien_bien || ''} - ${r.incomplete_detail || r.kq_text || ''} - BS: ${r.bac_si || ''}`).join('; ');
      issues.push(makeIssue({
        group: 'Y lệnh', severity: 'error', code: 'ORDER_DISCHARGE_DAY_INCOMPLETE',
        title: `${inc_discharge.length} y lệnh ngày ra viện chưa hoàn tất (có thể là thuốc ra viện)`,
        detail,
        action: 'Điều dưỡng hoàn tất y lệnh ngày ra viện — thường là đơn thuốc mang về.',
        owner: 'Điều dưỡng điều trị',
        evidence: `incomplete_on_discharge_day=${inc_discharge.length}`,
      }));
    }

    if (inc_other.length > 0) {
      const detail = inc_other.slice(0, 3)
        .map(r => `Phiếu ${r.so_phieu} (${r.tg_ylenh}) - ${r.ten_y_lenh || r.dien_bien || ''} - ${r.incomplete_detail || r.kq_text || ''} - BS: ${r.bac_si || ''}`)
        .join('; ');
      issues.push(makeIssue({
        group: 'Y lệnh', severity: 'error', code: 'ORDER_INCOMPLETE',
        title: `${inc_other.length} y lệnh chưa hoàn tất`,
        detail: detail + (inc_other.length > 3 ? ` (+${inc_other.length - 3} y lệnh khác)` : ''),
        action: 'Điều dưỡng hoàn tất các y lệnh còn tồn đọng trước khi ra viện.',
        owner: 'Điều dưỡng điều trị',
        evidence: `incomplete=${order_history.incomplete}/${order_history.total}`,
      }));
    }
  }

  // 2. Y lệnh có thời gian SAU ngày ra viện
  const after = safeArray(order_history.after_discharge_rows);
  if (after.length > 0) {
    const detail = after.slice(0, 3)
      .map(r => `Phiếu ${r.so_phieu} (${r.tg_ylenh})`)
      .join('; ');
    issues.push(makeIssue({
      group:    'Y lệnh',
      severity: 'error',
      code:     'ORDER_AFTER_DISCHARGE',
      title:    `${after.length} y lệnh có thời gian sau ngày ra viện`,
      detail:   detail,
      action:   'Bác sĩ kiểm tra và điều chỉnh thời gian y lệnh cho phù hợp.',
      owner:    'Bác sĩ điều trị',
      evidence: `after_discharge=${order_history.after_discharge}`,
    }));
  }

  return issues;
}

// ── Main runner ───────────────────────────────────────────────────────────────

function runDischargeQA_Hchanh({ ma_bn, meta, data }) {
  const { profile, discharge, billing, bed_days, surgery, order_history, documents } = data || {};
  const scope = meta?.scope_default || 'daily';
  if (scope !== 'discharge')
    return { issues: [], qa: { required:false, status:'not_required', canPrint:false } };

  const rules = loadQaRules();
  const bedDaysReview = buildBedDaysReview({ profile, discharge, bed_days, surgery, billing });

  const issues = [
    ...checkProfile(profile),
    ...checkDischarge(discharge, profile, rules),
    ...checkBedDays(bed_days, rules, bedDaysReview),
    ...checkBilling(billing, rules),
    ...checkClsDiagnosis(billing, discharge, rules),
    ...checkSpecialtyRules(profile, discharge, billing, rules),
    ...checkOrderHistory(order_history),
  ];

  const seen = new Set();
  const deduped = issues.filter(i => {
    const key = `${i.code}|${i.detail}`;
    if (seen.has(key)) return false;
    seen.add(key); return true;
  });

  const errors   = deduped.filter(i => i.severity === 'error').length;
  const warnings = deduped.filter(i => i.severity === 'warn').length;
  const status   = errors ? 'error' : warnings ? 'warn' : 'ok';

  return {
    issues: deduped,
    qa: {
      required: true, status, canPrint: status === 'ok',
      errorCount: errors, warnCount: warnings,
      summary: status === 'ok' ? 'Đủ điều kiện in/chốt hồ sơ.'
        : `Còn ${errors} lỗi và ${warnings} cảnh báo cần xử lý.`,
      bed_days_review: bedDaysReview,
    },
  };
}

module.exports = { runDischargeQA_Hchanh, loadQaRules, extractClsFromBilling };
