'use strict';

// Sổ biên bản hội chẩn (SBBHC) cho Kho nghiên cứu: tên cột thô (hchanh_consult.csv), dòng thô từ
// output worker, và các cột consult_* của analysis_ready (một đợt một dòng). Dùng chung cho bước lấy
// dữ liệu (research_source), chuẩn hóa (normalize) và từ điển dữ liệu, để ba nơi không lệch nhau.

// [id ô trên form EMR, nhãn cột thô, cột analysis_ready, mô tả]
const CONSULT_FIELDS = [
  ['ThoiGianHoiChan', 'Thời gian hội chẩn', 'consult_times', 'Thời gian hội chẩn'],
  ['HopTai', 'Họp tại', 'consult_places', 'Nơi họp hội chẩn'],
  ['YeuCau', 'Yêu cầu hội chẩn', 'consult_requests', 'Yêu cầu hội chẩn'],
  ['TomTat', 'Tóm tắt', 'consult_summaries', 'Tóm tắt (ô Tóm tắt của SBBHC)'],
  ['TinhTrang', 'Tình trạng', 'consult_status_text', 'Tình trạng người bệnh lúc hội chẩn'],
  ['ChanDoanTuyenDuoi', 'Chẩn đoán', 'consult_diagnoses', 'Chẩn đoán ghi trong SBBHC'],
  ['TomTatBenhAn', 'Tóm tắt bệnh án', 'consult_case_summaries', 'Tóm tắt bệnh án'],
  ['NguyenNhan', 'Nguyên nhân', 'consult_causes', 'Nguyên nhân'],
  ['HuongDieuTri', 'Hướng điều trị', 'consult_treatments', 'Hướng điều trị'],
  ['ChamSoc', 'Chăm sóc', 'consult_care', 'Chăm sóc'],
  ['KetLuan', 'Kết luận', 'consult_conclusions', 'Kết luận hội chẩn'],
];

const CONSULT_RAW_COLUMNS = ['Mã hồ sơ SBBHC', 'Khoa', 'Ngày tạo phiếu', ...CONSULT_FIELDS.map(f => f[1])];
const CONSULT_SEPARATOR = ' | ';
const CONSULT_COLUMNS = ['consult_count', 'consult_first_time', 'consult_last_time', ...CONSULT_FIELDS.map(f => f[2])];

function text(v) { return String(v ?? '').trim(); }

// Dòng thô hchanh_consult.csv từ output.consult của worker (chỉ phiếu đã hoàn tất, đã đọc được).
function consultRawRows(payload) {
  const rows = Array.isArray(payload?.rows) ? payload.rows : [];
  return rows.map(r => {
    const out = {
      'Mã hồ sơ SBBHC': text(r.hosoid),
      Khoa: text(r.khoa),
      'Ngày tạo phiếu': text(r.ngay_tao),
    };
    for (const [id, label] of CONSULT_FIELDS) out[label] = text(r[id]);
    return out;
  }).filter(r => CONSULT_FIELDS.some(([, label]) => r[label]));
}

// "09:30 12/11/2026", "12/11/2026 09:30", "2026-11-12 09:30" → số để sắp xếp; NaN nếu không đọc được.
function consultTime(row) {
  const s = text(row?.['Thời gian hội chẩn']) || text(row?.['Ngày tạo phiếu']);
  let m = s.match(/(\d{1,2}):(\d{2})\s+(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (m) return Date.UTC(+m[5], +m[4] - 1, +m[3], +m[1], +m[2]);
  m = s.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(\d{1,2}):(\d{2}))?/);
  if (m) return Date.UTC(+m[3], +m[2] - 1, +m[1], +(m[4] || 0), +(m[5] || 0));
  m = s.match(/(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{2}))?/);
  if (m) return Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0));
  return NaN;
}

function fmtTime(t) {
  if (!Number.isFinite(t)) return '';
  const d = new Date(t);
  const p = n => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}

// Các SBBHC của một đợt → cột consult_*: mỗi phiếu một phần, theo thứ tự thời gian, nối " | ".
// Cùng mã hồ sơ (lấy lại nhiều lần) chỉ tính một lần.
function consultFieldsForEncounter(rows) {
  const seen = new Set();
  const list = [];
  for (const r of rows || []) {
    const id = text(r?.['Mã hồ sơ SBBHC']);
    const sig = id || CONSULT_FIELDS.map(([, label]) => text(r?.[label])).join('\u0001');
    if (seen.has(sig)) continue;
    seen.add(sig);
    list.push(r);
  }
  const out = Object.fromEntries(CONSULT_COLUMNS.map(c => [c, '']));
  if (!list.length) return out;
  list.sort((a, b) => {
    const ta = consultTime(a);
    const tb = consultTime(b);
    if (Number.isFinite(ta) && Number.isFinite(tb)) return ta - tb;
    return Number.isFinite(ta) ? -1 : Number.isFinite(tb) ? 1 : 0;
  });
  const times = list.map(consultTime).filter(Number.isFinite);
  out.consult_count = String(list.length);
  out.consult_first_time = times.length ? fmtTime(Math.min(...times)) : '';
  out.consult_last_time = times.length ? fmtTime(Math.max(...times)) : '';
  for (const [, label, column] of CONSULT_FIELDS) {
    const parts = list.map(r => text(r?.[label]).replace(/\s*\|\s*/g, ' / ').replace(/\s+/g, ' '));
    out[column] = parts.some(Boolean) ? parts.join(CONSULT_SEPARATOR) : '';
  }
  return out;
}

module.exports = {
  CONSULT_FIELDS, CONSULT_RAW_COLUMNS, CONSULT_COLUMNS, CONSULT_SEPARATOR,
  consultRawRows, consultFieldsForEncounter, consultTime,
};
