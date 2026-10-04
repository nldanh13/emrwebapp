'use strict';

// Repair surgery rows collected from Hành chánh before normalized tables are built.
// Older/raw payloads may store only a clock time in `Ngày phẫu thuật` even though
// the list row (`item.thoi_gian`) still contains the calendar date. They also use
// worker detail keys such as `chan_doan_truoc` / `chan_doan_sau` that were not
// always propagated into hchanh_surgery.csv. This module repairs only explicit
// values already present in Raw JSON; it never invents a surgery or clinical fact.

const fs = require('fs');
const path = require('path');
const { readCsvTable, writeCsv } = require('./table_io');

function clean(value) {
  return String(value ?? '').trim();
}

function first(...values) {
  for (const value of values) {
    const text = clean(value);
    if (text) return text;
  }
  return '';
}

function parseRawJson(value) {
  const raw = clean(value);
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (_) {
    return {};
  }
}

function datePart(value) {
  const raw = clean(value);
  let m = raw.match(/\b(\d{1,2})[/-](\d{1,2})[/-](\d{4})\b/);
  if (m) return `${m[1].padStart(2, '0')}/${m[2].padStart(2, '0')}/${m[3]}`;
  m = raw.match(/\b(\d{4})-(\d{1,2})-(\d{1,2})\b/);
  if (m) return `${m[3].padStart(2, '0')}/${m[2].padStart(2, '0')}/${m[1]}`;
  return '';
}

function timePart(value) {
  const raw = clean(value);
  const m = raw.match(/\b([01]?\d|2[0-3]):([0-5]\d)(?::([0-5]\d))?\b/);
  if (!m) return '';
  return `${m[1].padStart(2, '0')}:${m[2]}${m[3] ? `:${m[3]}` : ''}`;
}

function repairSurgeryTimestamp(currentValue, itemTime, detailStart) {
  // Giá trị hiện có trong cột chuẩn là bằng chứng ưu tiên cao nhất khi đã có ngày.
  // Không được ghi đè một ngày PT hoàn chỉnh bằng ngày ở dòng danh sách, vì
  // item.thoi_gian có thể là thời điểm hiển thị/ghi nhận của danh sách chứ không
  // phải ngày PT thực tế.
  const currentDate = datePart(currentValue);
  const currentClock = timePart(currentValue);
  if (currentDate) return `${currentDate}${currentClock ? ` ${currentClock}` : ''}`;

  // Nếu detail có ngày rõ ràng thì dùng trực tiếp.
  const detailDate = datePart(detailStart);
  const detailClock = timePart(detailStart);
  if (detailDate) return `${detailDate}${detailClock ? ` ${detailClock}` : ''}`;

  // Chỉ khi cột hiện tại thiếu ngày mới ghép ngày từ dòng danh sách với giờ PT
  // trong detail. Đây là trường hợp legacy `Ngày phẫu thuật = 08:15`.
  const listDate = datePart(itemTime);
  const listClock = timePart(itemTime);
  if (listDate && detailClock) return `${listDate} ${detailClock}`;
  if (listDate) return `${listDate}${listClock ? ` ${listClock}` : ''}`;

  return clean(currentValue);
}

function repairSurgeryRow(row) {
  const item = parseRawJson(row?.['Raw JSON']);
  const detail = item?.detail && typeof item.detail === 'object' ? item.detail : {};
  const out = { ...row };

  out['Ngày phẫu thuật'] = repairSurgeryTimestamp(
    row?.['Ngày phẫu thuật'], item?.thoi_gian,
    first(detail?.bat_dau, detail?.ngay_phau_thuat),
  );
  out['Tên phẫu thuật'] = first(
    row?.['Tên phẫu thuật'], detail?.dich_vu_phau_thuat,
    item?.noi_dung_phau_thuat, detail?.ten_phau_thuat, detail?.phuong_phap_pt,
  );
  out['Phương pháp phẫu thuật'] = first(
    row?.['Phương pháp phẫu thuật'], detail?.phuong_phap_pt,
    detail?.phuong_phap_phau_thuat, detail?.pppt,
  );
  out.PPVC = first(
    row?.PPVC, row?.['Phương pháp vô cảm'], row?.['Vô cảm'],
    detail?.pp_vo_cam, detail?.phuong_phap_vo_cam, detail?.ppvc,
  );
  out['Chẩn đoán trước mổ'] = first(
    row?.['Chẩn đoán trước mổ'], detail?.chan_doan_truoc, detail?.chan_doan_truoc_mo,
  );
  out['Chẩn đoán sau mổ'] = first(
    row?.['Chẩn đoán sau mổ'], detail?.chan_doan_sau, detail?.chan_doan_sau_mo,
  );

  // Preserve explicit detail fields for provenance/future normalized columns.
  out['Bắt đầu phẫu thuật'] = first(row?.['Bắt đầu phẫu thuật'], detail?.bat_dau);
  out['Kết thúc phẫu thuật'] = first(row?.['Kết thúc phẫu thuật'], detail?.ket_thuc);
  out['Tai biến phẫu thuật'] = first(row?.['Tai biến phẫu thuật'], detail?.tai_bien);
  out['Biến chứng phẫu thuật'] = first(row?.['Biến chứng phẫu thuật'], detail?.bien_chung);
  out['Tình hình phẫu thuật'] = first(row?.['Tình hình phẫu thuật'], detail?.tinh_hinh);
  out['Phẫu thuật viên chính'] = first(row?.['Phẫu thuật viên chính'], detail?.ptv_chinh);
  return out;
}

function repairRawSurgeryCsv(runDir) {
  const filePath = path.join(path.resolve(runDir), 'hchanh_surgery.csv');
  if (!fs.existsSync(filePath)) return { changed: 0, rows: 0, file: filePath };

  const table = readCsvTable(filePath, Number.MAX_SAFE_INTEGER);
  const sourceRows = table.rows || [];
  if (!sourceRows.length) return { changed: 0, rows: 0, file: filePath };

  let changed = 0;
  const rows = sourceRows.map(row => {
    const repaired = repairSurgeryRow(row);
    const keys = new Set([...Object.keys(row), ...Object.keys(repaired)]);
    if ([...keys].some(key => clean(row[key]) !== clean(repaired[key]))) changed += 1;
    return repaired;
  });

  if (changed) {
    const preferred = [
      ...table.columns,
      'Bắt đầu phẫu thuật', 'Kết thúc phẫu thuật', 'Tai biến phẫu thuật',
      'Biến chứng phẫu thuật', 'Tình hình phẫu thuật', 'Phẫu thuật viên chính',
    ];
    const columns = [...new Set(preferred.filter(Boolean))];
    for (const row of rows) for (const key of Object.keys(row)) if (!columns.includes(key)) columns.push(key);
    writeCsv(filePath, columns, rows);
  }
  return { changed, rows: rows.length, file: filePath };
}

module.exports = {
  datePart,
  timePart,
  repairSurgeryTimestamp,
  repairSurgeryRow,
  repairRawSurgeryCsv,
};
