// Truyền máu trên Phiếu bàn giao ca.
//
// Truyền máu do chính người làm theo dõi từ đầu đến cuối, KHÔNG bàn giao cho ca khác. Vì vậy các
// dòng chế phẩm máu và xét nghiệm đi kèm (định nhóm máu, phản ứng hòa hợp) được tách khỏi "Chưa rõ
// giờ", "Cữ trong ca" và "Bàn giao ca trực", gom theo người bệnh vào mục "Truyền máu". Người làm
// nhập giờ bắt đầu và kết thúc, màn hình tự tạo các mốc chăm sóc theo mẫu
// "Phần II. Theo dõi truyền máu lâm sàng".
//
// Màn hình, nút "Sao chép chăm sóc" và phiếu in dùng chung buildTransfusionTimeline.

import { parseDmy, stripVN } from './reportBaseUtils.js';

import CARE from '../../../config/blood_transfusion_care.json' with { type: 'json' };

const DAY = 24 * 60;
// Thời gian truyền mặc định (phút): giờ ngừng truyền tự tính = giờ bắt đầu + chừng này.
export const DURATION_MINUTES = Number(CARE.duration_minutes) || 153;
export const CARE_SLOTS = CARE.slots;
export const STORAGE_KEY = 'emr_report_blood_transfusion_v1';
const KEEP_DAYS = 14;

const PRODUCT_RE = /\bkhoi\s+(?:hong\s+cau|tieu\s+cau|bach\s+cau)\b|\bhong\s+cau\s+(?:lang|rua|loc)\b|\bhuyet\s+tuong\b|\btua\s+lanh\b|\bmau\s+toan\s+phan\b/;
const TEST_RE = /\bdinh\s+nhom\s+mau\b|\bphan\s+ung\s+(?:hoa|thuan)\s+hop\b|\bphan\s+ung\s+cheo\b/;

function textOf(row) {
  return stripVN(String(row?.drugName || '')).toLowerCase().replace(/đ/g, 'd');
}

// 'product' = chế phẩm máu cần truyền; 'test' = xét nghiệm trước truyền; '' = không liên quan.
export function bloodKind(row) {
  const t = textOf(row);
  if (PRODUCT_RE.test(t)) return 'product';
  if (TEST_RE.test(t)) return 'test';
  return '';
}

export function isBloodRow(row) {
  return bloodKind(row) !== '';
}

export function transfusionKey(date, row) {
  return formKey(date, row?.patientId || row?.patientName);
}

// Người bệnh có dự trù khối hồng cầu trong y lệnh (worker: chi_dinh_khac.truyen_mau → cs_extra), kể
// cả khi danh sách thuốc không có dòng chế phẩm máu.
export function flaggedTransfusionPatients(patients = [], date) {
  const out = [];
  for (const p of patients || []) {
    const day = p?.day_map?.[date] || (p?.ngay_lam === date ? p : null);
    const info = day?.cs_extra?.truyen_mau || day?.chi_dinh_khac?.truyen_mau;
    if (!info?.co_truyen_mau) continue;
    out.push({
      patientId: String(p.ma_bn || '').trim(),
      patientName: String(p.ho_ten || '').trim() || '—',
      room: String(day?.so_phong || p.so_phong || '').trim() || '—',
    });
  }
  return out;
}

// Gom theo người bệnh: dòng chế phẩm máu, xét nghiệm đi kèm, và người bệnh có dự trù máu trong y lệnh.
// Người bệnh chỉ có xét nghiệm (chưa có chế phẩm) vẫn hiện để không mất dòng nào.
export function groupTransfusions(rows = [], date, flagged = []) {
  const map = new Map();
  const ensure = (src) => {
    const key = transfusionKey(date, src);
    if (!map.has(key)) {
      map.set(key, {
        key,
        room: String(src.room || '—').trim() || '—',
        patientName: src.patientName,
        patientId: src.patientId || '',
        products: [],
        tests: [],
        reserved: false,
      });
    }
    return map.get(key);
  };
  for (const row of rows) {
    const kind = bloodKind(row);
    if (!kind) continue;
    const group = ensure(row);
    const list = kind === 'product' ? group.products : group.tests;
    if (!list.some(r => r.drugName === row.drugName)) list.push(row);
  }
  for (const p of flagged || []) {
    if (!p?.patientId && !p?.patientName) continue;
    ensure(p).reserved = true;
  }
  return [...map.values()]
    .sort((a, b) => a.room.localeCompare(b.room, 'vi', { numeric: true }) || String(a.patientName).localeCompare(String(b.patientName), 'vi'));
}

// Trạng thái của một người bệnh trong ngày: 'reserve' = mới dự trù máu, chưa truyền (không lập phiếu
// chăm sóc truyền máu); 'transfuse' = có truyền, theo giờ bắt đầu. Phiếu cũ có giờ bắt đầu = đang truyền.
export function statusOf(form = {}) {
  if (form.status === 'reserve' || form.status === 'transfuse') return form.status;
  return form.start ? 'transfuse' : 'reserve';
}

export function parseClock(value) {
  const m = String(value || '').trim().match(/^(\d{1,2})\s*[:hH]\s*(\d{2})?$/);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2] || 0);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

export function formatClock(minutes) {
  const m = ((minutes % DAY) + DAY) % DAY;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

function kindOf(key) {
  if (key === 'pre' || key === 'start' || key === 'end') return key;
  return 'check';
}

/**
 * Các mốc chăm sóc của một lần truyền máu theo mẫu config/blood_transfusion_care.json
 * (worker/input_care.py dùng cùng mẫu khi nhập chăm sóc vào EMR).
 * @param {string} start giờ bắt đầu truyền "HH:MM"
 * @returns {Array} mỗi mốc: { key, time, dayOffset, minutes, kind, label, dienBien[], chamSoc[], needsVitals }
 */
export function buildTransfusionTimeline(start) {
  const s = parseClock(start);
  if (s == null) return [];
  return CARE_SLOTS.map(slot => {
    const abs = s + Number(slot.offset_minutes || 0);
    return {
      key: slot.key,
      time: formatClock(abs),
      dayOffset: Math.floor(abs / DAY),
      minutes: abs,
      kind: kindOf(slot.key),
      label: slot.label,
      dienBien: [...slot.dien_bien],
      chamSoc: [...slot.cham_soc],
      needsVitals: Boolean(slot.needs_vitals),
    };
  });
}

export function endTimeOf(start) {
  const s = parseClock(start);
  return s == null ? '' : formatClock(s + DURATION_MINUTES);
}

export function durationText(minutes = DURATION_MINUTES) {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return [h ? `${h} giờ` : '', m ? `${m} phút` : ''].filter(Boolean).join(' ');
}

// Số sinh hiệu mặc định của một mốc: cố định theo người bệnh + ngày + giờ bắt đầu + mốc, để bảng
// trên màn hình, phiếu in và phiếu chăm sóc nhập vào EMR ra CÙNG một số (không random mỗi lần mở).
// Dải số giống mặc định của worker (care_form_actions.dien_thong_tin). Người làm sửa được trong bảng.
function hash32(text) {
  let h = 0x811c9dc5;
  for (const ch of String(text)) {
    h ^= ch.codePointAt(0);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

export function defaultVitals(seed) {
  const cfg = CARE.default_vitals || {};
  const h = hash32(seed);
  const min = Number(cfg.mach_min ?? 75);
  const max = Number(cfg.mach_max ?? 85);
  const bpList = Array.isArray(cfg.huyet_ap) && cfg.huyet_ap.length ? cfg.huyet_ap : ['120/80'];
  return {
    resp: String(cfg.nhip_tho ?? '20'),
    pulse: String(min + (h % (max - min + 1))),
    bp: bpList[(h >>> 8) % bpList.length],
    temp: String(cfg.nhiet_do ?? '37'),
  };
}

export const VITAL_KEYS = ['resp', 'pulse', 'bp', 'temp'];

// Giá trị hiện trong một ô: người làm đã gõ thì lấy chữ đó, chưa gõ thì số mặc định (chỉ mốc có
// lấy dấu hiệu sinh tồn). Màn hình, phiếu in và dữ liệu gửi nhập EMR đều đi qua hàm này.
export function slotValues(slot, cells = {}, seedBase = '') {
  const c = cells?.[slot.key] || {};
  const defaults = slot.needsVitals ? defaultVitals(`${seedBase}|${slot.key}`) : {};
  const out = { rate: c.rate ?? '', skin: c.skin ?? '' };
  for (const k of VITAL_KEYS) out[k] = c[k] ?? defaults[k] ?? '';
  return out;
}

export function seedBaseOf(date, patientId, start) {
  return `${String(patientId || '').trim()}|${date}|${start}`;
}

// ── Lưu trên máy (localStorage), dùng chung cho Phiếu bàn giao ca và Nhập chăm sóc ───────────

export function formKey(date, patientId) {
  return `${date}|${String(patientId || '').trim()}`;
}

export function readTransfusionForms() {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || '') || {}; } catch { return {}; }
}

export function writeTransfusionForms(forms) {
  // Bỏ phiếu cũ hơn KEEP_DAYS ngày để bộ nhớ trình duyệt không phình mãi.
  const cutoff = Date.now() - KEEP_DAYS * 86400000;
  const kept = Object.fromEntries(Object.entries(forms || {}).filter(([key]) => {
    const d = parseDmy(key.split('|')[0]);
    return !d || d.getTime() >= cutoff;
  }));
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(kept)); return true; } catch { return false; }
}

export const SAVED_EVENT = 'emr:blood-transfusion-saved';

// Giờ bắt đầu nhập ở Nhập chăm sóc → bảng ở Phiếu bàn giao ca hiện cùng giờ (và ngược lại).
export function saveTransfusionStart(date, patientId, start) {
  const forms = readTransfusionForms();
  const key = formKey(date, patientId);
  forms[key] = { ...(forms[key] || {}), start, status: 'transfuse' };
  const ok = writeTransfusionForms(forms);
  try { window.dispatchEvent(new CustomEvent(SAVED_EVENT)); } catch { /* không có window (test node) */ }
  return ok;
}

// Sinh hiệu theo từng mốc để worker nhập đúng số đang hiện trên bảng:
// { pre: { nhip_tho, nhiet_do, mach, huyet_ap }, m15: {...}, ... } (chỉ mốc cần sinh hiệu).
export function entryVitalsFor(date, patientId, start, forms = readTransfusionForms()) {
  const cells = forms?.[formKey(date, patientId)]?.cells || {};
  const out = {};
  for (const slot of buildTransfusionTimeline(start)) {
    if (!slot.needsVitals) continue;
    const v = slotValues(slot, cells, seedBaseOf(date, patientId, start));
    out[slot.key] = { nhip_tho: v.resp, nhiet_do: v.temp, mach: v.pulse, huyet_ap: v.bp };
  }
  return out;
}

// Chữ "Những diễn biến khác" mặc định của một mốc (người làm sửa được).
export function slotNoteText(slot) {
  if (slot.kind === 'pre') return `${slot.dienBien.join(', ')}. ${slot.chamSoc.join(', ')}`;
  return `${slot.dienBien.join(', ')} -> ${slot.chamSoc.join(', ')}`;
}

// Đoạn chăm sóc để dán vào phiếu chăm sóc, đúng thứ tự khoa vẫn ghi.
export function buildCareText(slots, cells = {}) {
  const out = [];
  for (const slot of slots) {
    const note = String(cells?.[slot.key]?.note ?? '').trim();
    if (slot.kind === 'pre' && !note) {
      out.push(`${slot.time}`, 'Diễn biến:', ...slot.dienBien, 'Chăm sóc:', ...slot.chamSoc);
    } else {
      out.push(slot.time, note || slotNoteText(slot));
    }
  }
  return out.join('\n');
}

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

const dots = (value, width = '30mm') => (String(value || '').trim()
  ? `<b>${esc(value)}</b>`
  : `<span class="dots" style="width:${width}"></span>`);

// Phiếu in "Phần II. Theo dõi truyền máu lâm sàng" theo mẫu giấy của khoa.
export function buildTransfusionPrintHtml(group, form = {}, date = '') {
  const slots = buildTransfusionTimeline(form.start);
  const seedBase = seedBaseOf(date, group.patientId || group.patientName, form.start);
  const [dd, mm, yyyy] = String(date || '').split('/');
  const dayText = (abs, time) => {
    if (!time) return `giờ${dots('', '14mm')} ngày${dots('', '10mm')} tháng${dots('', '10mm')} năm 20${dots('', '8mm')}`;
    const d = new Date(Number(yyyy), Number(mm) - 1, Number(dd) + Math.floor(abs / DAY));
    const ok = !Number.isNaN(d.getTime());
    return `<b>${esc(time)}</b> giờ, ngày <b>${ok ? String(d.getDate()).padStart(2, '0') : ''}</b> tháng <b>${ok ? String(d.getMonth() + 1).padStart(2, '0') : ''}</b> năm <b>${ok ? d.getFullYear() : ''}</b>`;
  };
  const startSlot = slots.find(x => x.kind === 'start');
  const endSlot = slots.find(x => x.kind === 'end');
  const cells = form.cells || {};
  const body = slots.map(slot => {
    const c = cells[slot.key] || {};
    const v = slotValues(slot, cells, seedBase);
    return `<tr><td class="t">${esc(slot.time)}</td><td>${esc(v.rate)}</td><td>${esc(v.skin)}</td><td>${esc(v.resp)}</td><td>${esc(v.pulse)}</td><td>${esc(v.bp)}</td><td>${esc(v.temp)}</td><td class="note">${esc(String(c.note ?? '').trim() || slotNoteText(slot))}</td></tr>`;
  }).join('\n');
  const products = group.products.map(r => r.drugName).join('; ');
  return `<!doctype html>
<html lang="vi"><head><meta charset="utf-8"><title>Theo dõi truyền máu ${esc(group.room)}</title>
<style>
@page { size: A4; margin: 14mm; }
body { font-family: "Times New Roman", serif; font-size: 13pt; color: #000; margin: 0; }
h1 { font-size: 14pt; text-align: center; margin: 0 0 8px; }
p { margin: 3px 0; }
.dots { display: inline-block; border-bottom: 1px dotted #000; height: 1em; }
table { width: 100%; border-collapse: collapse; margin: 8px 0; }
th, td { border: 1px solid #000; padding: 3px 5px; vertical-align: top; font-size: 12pt; }
th { font-weight: bold; text-align: center; }
td { height: 9mm; }
td.t { text-align: center; white-space: nowrap; }
td.note { width: 34%; }
tr { page-break-inside: avoid; }
.sign { display: flex; justify-content: space-between; margin-top: 14px; font-weight: bold; padding: 0 12mm; }
</style></head><body>
<h1>PHẦN II. THEO DÕI TRUYỀN MÁU LÂM SÀNG</h1>
<p>Người bệnh: <b>${esc(group.patientName)}</b> · Phòng <b>${esc(group.room)}</b>${products ? ` · ${esc(products)}` : ''}</p>
<p>Lần truyền máu thứ: ${dots(form.lanThu, '20mm')}</p>
<p>Định nhóm đơn vị máu, chế phẩm: ${dots(form.nhomDonVi, '22mm')} Định nhóm người nhận: ${dots(form.nhomNguoiNhan, '22mm')} Phản ứng chéo tại giường: ${dots(form.phanUngCheo, '22mm')}</p>
<p>Bắt đầu truyền hồi: ${dayText(startSlot?.minutes ?? 0, startSlot?.time)}</p>
<table><thead><tr><th>Thời gian</th><th>Tốc độ truyền (giọt/ph)</th><th>Màu sắc da, niêm mạc</th><th>Nhịp thở (l/phút)</th><th>Mạch (l/phút)</th><th>Huyết áp (mmHg)</th><th>Thân nhiệt (°C)</th><th>Những diễn biến khác</th></tr></thead>
<tbody>
${body}
</tbody></table>
<p>Ngừng truyền hồi: ${dayText(endSlot?.minutes ?? 0, endSlot?.time)}</p>
<p>Số lượng máu thực tế đã truyền: ${dots(form.soLuongMl, '30mm')} ml</p>
<p>Nhận xét quá trình truyền máu: ${dots(form.nhanXet, '110mm')}</p>
<div class="sign"><span>BÁC SỸ ĐIỀU TRỊ</span><span>ĐIỀU DƯỠNG TRUYỀN MÁU</span></div>
</body></html>`;
}
