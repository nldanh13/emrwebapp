// Kết quả xét nghiệm trong ngày: hàm thuần dùng chung cho thẻ người bệnh và tab Kết quả XN.
// Dữ liệu từ GET /api/lab-results (server/services/lab_results_store.js).

export const labResultsKey = date => (date ? `lab-results:${date}` : '');

export function patientLabEntry(data, patient) {
  const id = String(patient?.ma_bn || patient?.id || '').trim();
  if (!id || !data || typeof data !== 'object') return null;
  return data.items?.[id] || null;
}

export function labPhieu(entry) {
  return Array.isArray(entry?.phieu) ? entry.phieu : [];
}

// Đếm theo phiếu đã lưu (không tin tom_tat cũ nếu thiếu).
export function labSummary(entry) {
  const phieu = labPhieu(entry);
  const done = phieu.filter(p => p?.hoan_tat);
  const rows = done.flatMap(p => (Array.isArray(p?.ket_qua) ? p.ket_qua : []));
  return {
    total: phieu.length,
    done: done.length,
    pending: phieu.length - done.length,
    values: rows.length,
    abnormal: rows.filter(r => r?.bat_thuong).length,
  };
}

// Chip ngắn trên thẻ người bệnh. null = không hiện gì (chưa đọc, hoặc ngày đó không có XN).
export function labChip(entry) {
  if (!entry) return null;
  if (entry.status === 'error') return { text: 'XN chưa đọc được', tone: 'amber', title: entry.error || 'Chưa đọc được kết quả xét nghiệm' };
  if (entry.status !== 'ok') return null;
  const s = labSummary(entry);
  if (!s.total) return null;
  if (s.abnormal) return { text: `XN ${s.abnormal} bất thường`, tone: 'red', title: `${s.done}/${s.total} phiếu có kết quả, ${s.abnormal} chỉ số ngoài khoảng tham chiếu` };
  if (s.pending) return { text: `XN ${s.done}/${s.total}`, tone: 'amber', title: `${s.pending} phiếu chưa có kết quả` };
  return { text: `XN ${s.done}/${s.total}`, tone: 'green', title: 'Đã có kết quả tất cả phiếu xét nghiệm trong ngày' };
}

export function formatFetchedAt(value) {
  const d = new Date(value || '');
  if (Number.isNaN(d.getTime())) return '';
  const pad = n => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())} ${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}`;
}
