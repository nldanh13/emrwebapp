// Truyền máu trên Phiếu bàn giao ca.
//
// Truyền máu do chính người làm theo dõi từ đầu đến cuối, KHÔNG bàn giao cho ca khác. Vì vậy các
// dòng chế phẩm máu và xét nghiệm đi kèm (định nhóm máu, phản ứng hòa hợp) được tách khỏi "Chưa rõ
// giờ", "Cữ trong ca" và "Bàn giao ca trực", gom theo người bệnh vào mục "Truyền máu". Người làm
// nhập giờ bắt đầu và kết thúc, màn hình tự tạo các mốc chăm sóc theo mẫu
// "Phần II. Theo dõi truyền máu lâm sàng".
//
// Màn hình, nút "Sao chép chăm sóc" và phiếu in dùng chung buildTransfusionTimeline.

import { stripVN } from './reportBaseUtils.js';

const DAY = 24 * 60;
// Mốc đo trước truyền: 10 phút trước giờ bắt đầu.
export const PRE_CHECK_MINUTES = 10;
// Mốc đầu sau khi bắt đầu: 15 phút; sau đó mỗi giờ một lần đến khi kết thúc.
export const FIRST_CHECK_MINUTES = 15;
export const HOURLY_MINUTES = 60;
// Chưa nhập giờ kết thúc: chỉ dựng các mốc trong 4 giờ (một đơn vị máu truyền không quá 4 giờ).
export const MAX_DURATION_MINUTES = 4 * 60;

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
  return `${date}|${String(row?.patientId || row?.patientName || '').trim()}`;
}

// Gom dòng truyền máu theo người bệnh. Người bệnh có y lệnh chế phẩm máu thì có phiếu theo dõi;
// người bệnh chỉ có xét nghiệm (chưa có chế phẩm) vẫn hiện để không mất dòng nào.
export function groupTransfusions(rows = [], date) {
  const map = new Map();
  for (const row of rows) {
    const kind = bloodKind(row);
    if (!kind) continue;
    const key = transfusionKey(date, row);
    if (!map.has(key)) {
      map.set(key, {
        key,
        room: String(row.room || '—').trim() || '—',
        patientName: row.patientName,
        patientId: row.patientId || '',
        products: [],
        tests: [],
      });
    }
    const group = map.get(key);
    const list = kind === 'product' ? group.products : group.tests;
    if (!list.some(r => r.drugName === row.drugName)) list.push(row);
  }
  return [...map.values()]
    .sort((a, b) => a.room.localeCompare(b.room, 'vi', { numeric: true }) || String(a.patientName).localeCompare(String(b.patientName), 'vi'));
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

/**
 * Các mốc chăm sóc của một lần truyền máu.
 * @param {string} start giờ bắt đầu "HH:MM"
 * @param {string} [end] giờ kết thúc "HH:MM"; nhỏ hơn giờ bắt đầu = sang ngày hôm sau
 * @returns {{ slots: Array, endMissing: boolean }} mỗi mốc: { key, time, dayOffset, kind, dienBien[], chamSoc[] }
 */
export function buildTransfusionTimeline(start, end) {
  const s = parseClock(start);
  if (s == null) return { slots: [], endMissing: true };
  let e = parseClock(end);
  if (e != null && e <= s) e += DAY;
  const limit = e ?? s + MAX_DURATION_MINUTES;
  const slot = (key, abs, kind, dienBien, chamSoc) => ({
    key, time: formatClock(abs), dayOffset: Math.floor(abs / DAY), minutes: abs, kind, dienBien, chamSoc,
  });
  const slots = [
    slot('pre', s - PRE_CHECK_MINUTES, 'pre',
      ['Người bệnh tỉnh', 'Tiếp xúc tốt', 'Da niêm nhợt'],
      ['Thử phản ứng thuận hợp tại giường', 'Lấy dấu hiệu sinh tồn', 'Trình Bs']),
    slot('start', s, 'start', ['Người bệnh tỉnh'], ['Bắt đầu truyền máu']),
  ];
  const check = ['Chưa xảy ra phản ứng lạ', 'Lấy dấu hiệu sinh tồn'];
  if (s + FIRST_CHECK_MINUTES < limit) slots.push(slot('m15', s + FIRST_CHECK_MINUTES, 'check', ['Người bệnh tỉnh'], check));
  for (let k = 1; s + k * HOURLY_MINUTES < limit; k += 1) {
    slots.push(slot(`h${k}`, s + k * HOURLY_MINUTES, 'check', ['Người bệnh tỉnh'], check));
  }
  if (e != null) slots.push(slot('end', e, 'end', ['Người bệnh tỉnh'], ['Kết thúc truyền máu', 'Lấy dấu hiệu sinh tồn']));
  return { slots, endMissing: e == null };
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
  const { slots } = buildTransfusionTimeline(form.start, form.end);
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
    return `<tr><td class="t">${esc(slot.time)}</td><td>${esc(c.rate)}</td><td>${esc(c.skin)}</td><td>${esc(c.resp)}</td><td>${esc(c.pulse)}</td><td>${esc(c.bp)}</td><td>${esc(c.temp)}</td><td class="note">${esc(String(c.note ?? '').trim() || slotNoteText(slot))}</td></tr>`;
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
