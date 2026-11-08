// Báo cáo "Danh sách người bệnh": Ngày vào viện, Họ tên người bệnh, Ghi chú (để trống ghi tay),
// xếp theo ngày giờ vào. Màn xem và bản in dùng chung các hàm này.
import { formatPersonName } from '../../utils/personName.js';

// Ưu tiên ngày vào viện nếu dữ liệu có; không có thì dùng mốc T/G vào của danh sách nội trú.
const ADMISSION_KEYS = [
  'ngay_vao_vien', 'Ngày vào viện',
  'thoi_gian_vao_khoa', 'tg_vao', 'T/G vào', 'thoi_gian_vao', 'admission_time',
];

function pad2(value) {
  return String(Number(value)).padStart(2, '0');
}

function validDate(d, m, y) {
  const dt = new Date(Date.UTC(y, m - 1, d));
  return y >= 2000 && y <= 2200 && dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

// Nhận "08:25 29-04-2026", "29/04/2026 08:25", "2026-04-29 08:25", "29/04/2026".
export function parseAdmission(value) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (!text) return null;
  let d; let m; let y;
  let match = text.match(/(?:^|\D)(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})(?:\D|$)/);
  if (match) { [d, m, y] = [Number(match[1]), Number(match[2]), Number(match[3])]; }
  else {
    match = text.match(/(?:^|\D)(\d{4})[/.-](\d{1,2})[/.-](\d{1,2})(?:\D|$)/);
    if (!match) return null;
    [y, m, d] = [Number(match[1]), Number(match[2]), Number(match[3])];
  }
  if (!validDate(d, m, y)) return null;
  const rest = text.replace(match[0], ' ');
  const tm = rest.match(/(?:^|\D)(\d{1,2}):(\d{2})(?::\d{2})?(?:\D|$)/);
  const hh = tm && Number(tm[1]) < 24 && Number(tm[2]) < 60 ? Number(tm[1]) : null;
  const mi = hh === null ? null : Number(tm[2]);
  return {
    date: `${pad2(d)}/${pad2(m)}/${y}`,
    time: hh === null ? '' : `${pad2(hh)}:${pad2(mi)}`,
    sortKey: `${y}${pad2(m)}${pad2(d)}${hh === null ? '9999' : `${pad2(hh)}${pad2(mi)}`}`,
  };
}

function admissionOf(patient, date) {
  const day = patient?.day_map?.[date] || {};
  for (const source of [day, patient]) {
    for (const key of ADMISSION_KEYS) {
      const parsed = parseAdmission(source?.[key]);
      if (parsed) return parsed;
    }
  }
  return null;
}

export function collectAdmissionRows(patients, date) {
  const rows = [];
  const seen = new Set();
  for (const patient of Array.isArray(patients) ? patients : []) {
    const patientId = String(patient?.ma_bn || patient?.['Mã BN'] || '').trim();
    const patientName = formatPersonName(patient?.ho_ten || patient?.['Họ tên'], '');
    if (!patientId && !patientName) continue;
    const key = patientId || patientName;
    if (seen.has(key)) continue;
    seen.add(key);
    const admission = admissionOf(patient, date);
    rows.push({
      id: key,
      patientId,
      patientName: patientName || patientId,
      admissionDate: admission?.date || '',
      admissionTime: admission?.time || '',
      sortKey: admission?.sortKey || '',
    });
  }
  // Ngày vào sớm nhất lên đầu; người bệnh chưa có ngày vào xếp cuối để dễ thấy.
  return rows.sort((a, b) => {
    if (a.sortKey !== b.sortKey) {
      if (!a.sortKey) return 1;
      if (!b.sortKey) return -1;
      return a.sortKey < b.sortKey ? -1 : 1;
    }
    return a.patientName.localeCompare(b.patientName, 'vi');
  });
}

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

export function buildAdmissionListPrintHtml(rows, date) {
  const list = rows || [];
  const body = list.map((row, idx) => `<tr>
<td class="stt">${idx + 1}</td>
<td class="date">${esc(row.admissionDate || '—')}${row.admissionTime ? `<br><span class="sub">${esc(row.admissionTime)}</span>` : ''}</td>
<td class="name">${esc(row.patientName)}</td>
<td class="note"></td>
</tr>`).join('\n');
  return `<!doctype html>
<html lang="vi"><head><meta charset="utf-8"><title>Danh sách người bệnh ${esc(date)}</title>
<style>
@page { size: A4; margin: 12mm; }
body { font-family: "Times New Roman", serif; font-size: 13pt; color: #000; margin: 0; }
h1 { font-size: 15pt; text-align: center; margin: 0 0 2px; }
.meta { text-align: center; font-size: 11pt; margin: 0 0 8px; }
table { width: 100%; border-collapse: collapse; }
thead { display: table-header-group; }
th, td { border: 1px solid #000; padding: 4px 6px; vertical-align: top; text-align: left; }
th { background: #eee; }
tr { page-break-inside: avoid; }
td { height: 9mm; }
.stt { text-align: center; }
.name { font-weight: bold; }
.sub { font-size: 10pt; }
</style></head><body>
<h1>DANH SÁCH NGƯỜI BỆNH</h1>
<div class="meta">Ngày ${esc(date)} · Tổng số: ${list.length} người bệnh</div>
<table><thead><tr><th style="width:7%">STT</th><th style="width:18%">Ngày vào viện</th><th style="width:35%">Họ tên người bệnh</th><th>Ghi chú</th></tr></thead>
<tbody>
${body}
</tbody></table>
</body></html>`;
}
