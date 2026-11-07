// Báo cáo "Y lệnh khác": in nguyên văn ô Y lệnh khác của từng phiếu (txtYLenhKhacThamKham)
// trong ngày, theo phòng → người bệnh → giờ phiếu. Màn xem và bản in dùng chung các hàm này.

function roomOf(patient) {
  return String(patient?.room || patient?.so_phong || patient?.Vi_Tri || '').trim();
}

function compareRoom(a, b) {
  return String(a || '~').localeCompare(String(b || '~'), 'vi', { numeric: true });
}

export function collectOtherOrderRows(patients, date) {
  const rows = [];
  for (const patient of Array.isArray(patients) ? patients : []) {
    const day = patient?.day_map?.[date] || (patient?.ngay_lam === date ? patient : null);
    const items = Array.isArray(day?.y_lenh_khac_goc) ? day.y_lenh_khac_goc : [];
    for (const [idx, item] of items.entries()) {
      const text = String(item?.noi_dung || '').trim();
      if (!text) continue;
      rows.push({
        id: `${patient?.ma_bn || patient?.ho_ten}|${date}|${idx}`,
        room: roomOf(patient),
        patientId: String(patient?.ma_bn || '').trim(),
        patientName: String(patient?.ho_ten || '').trim(),
        time: String(item?.gio_y_lenh || '').trim(),
        doctor: String(item?.bac_si || '').trim(),
        text,
      });
    }
  }
  return rows.sort((a, b) => compareRoom(a.room, b.room)
    || a.patientName.localeCompare(b.patientName, 'vi')
    || (a.time || '99:99').localeCompare(b.time || '99:99'));
}

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

export function buildOtherOrderPrintHtml(rows, date) {
  const body = (rows || []).map(row => `<tr>
<td>${esc(row.room)}</td>
<td><b>${esc(row.patientName)}</b><br><span class="sub">${esc(row.patientId)}</span></td>
<td>${esc(row.time)}<br><span class="sub">${esc(row.doctor)}</span></td>
<td class="text">${esc(row.text)}</td>
</tr>`).join('\n');
  return `<!doctype html>
<html lang="vi"><head><meta charset="utf-8"><title>Y lệnh khác ${esc(date)}</title>
<style>
@page { size: A4; margin: 12mm; }
body { font-family: "Times New Roman", serif; font-size: 12pt; color: #000; margin: 0; }
h1 { font-size: 15pt; text-align: center; margin: 0 0 8px; }
table { width: 100%; border-collapse: collapse; }
th, td { border: 1px solid #000; padding: 4px 6px; vertical-align: top; text-align: left; }
th { background: #eee; }
tr { page-break-inside: avoid; }
.text { white-space: pre-wrap; }
.sub { font-size: 10pt; }
</style></head><body>
<h1>Y LỆNH KHÁC NGÀY ${esc(date)}</h1>
<table><thead><tr><th style="width:9%">Phòng</th><th style="width:22%">Người bệnh</th><th style="width:16%">Giờ / Bác sĩ</th><th>Y lệnh khác</th></tr></thead>
<tbody>
${body}
</tbody></table>
</body></html>`;
}
