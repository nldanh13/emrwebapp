'use strict';

// Repair surgery rows collected from Hành chánh before normalized tables are built.
// Chỉ dùng giá trị explicit đã có trong CSV/Raw JSON; tuyệt đối không suy diễn.
// Mọi lần thay đổi raw đều tạo backup trước và ghi audit để có thể phục hồi/đối chiếu.

const fs = require('fs');
const path = require('path');
const { readCsvTable, writeCsv } = require('./table_io');

const BACKUP_FILE = 'hchanh_surgery.before_auto_repair.csv';
const AUDIT_FILE = 'surgery_raw_repair_audit.jsonl';

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
  // Giá trị hiện có là bằng chứng ưu tiên cao nhất nếu đã có ngày đầy đủ.
  const currentDate = datePart(currentValue);
  const currentClock = timePart(currentValue);
  if (currentDate) return `${currentDate}${currentClock ? ` ${currentClock}` : ''}`;

  // Nếu detail có ngày explicit thì dùng trực tiếp.
  const detailDate = datePart(detailStart);
  const detailClock = timePart(detailStart);
  if (detailDate) return `${detailDate}${detailClock ? ` ${detailClock}` : ''}`;

  // Legacy: cột hiện tại chỉ có giờ, còn item.thoi_gian giữ ngày của dòng PT.
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
    row?.['Chẩn đoán trước mổ'], detail?.chan_doan_truoc_pt,
    detail?.chan_doan_truoc, detail?.chan_doan_truoc_mo,
  );
  out['Chẩn đoán sau mổ'] = first(
    row?.['Chẩn đoán sau mổ'], detail?.chan_doan_sau_pt,
    detail?.chan_doan_sau, detail?.chan_doan_sau_mo,
  );

  // Giữ lại các trường explicit để trace/provenance và normalize về sau.
  out['Bắt đầu phẫu thuật'] = first(row?.['Bắt đầu phẫu thuật'], detail?.bat_dau);
  out['Kết thúc phẫu thuật'] = first(row?.['Kết thúc phẫu thuật'], detail?.ket_thuc);
  out['Đối tượng DV'] = first(row?.['Đối tượng DV'], detail?.doi_tuong_dv);
  out.ICD9 = first(row?.ICD9, detail?.icd9);
  out['ICD10 trước mổ'] = first(row?.['ICD10 trước mổ'], detail?.icd10_truoc_pt);
  out['ICD10 sau mổ'] = first(row?.['ICD10 sau mổ'], detail?.icd10_sau_pt);
  out['Mô tả PPPT'] = first(row?.['Mô tả PPPT'], detail?.mo_ta_pppt);
  out['Trình tự phẫu thuật'] = first(row?.['Trình tự phẫu thuật'], detail?.trinh_tu_phau_thuat);
  out['Phẫu thuật viên chính'] = first(row?.['Phẫu thuật viên chính'], detail?.bs_mo_chinh, detail?.ptv_chinh);
  out['Bác sĩ gây mê chính'] = first(row?.['Bác sĩ gây mê chính'], detail?.gay_me_chinh);
  out['Phụ mổ 1'] = first(row?.['Phụ mổ 1'], detail?.ptv_phu_1);
  out['Phụ mổ 2'] = first(row?.['Phụ mổ 2'], detail?.ptv_phu_2);
  out['Điều dưỡng dụng cụ'] = first(row?.['Điều dưỡng dụng cụ'], detail?.dd_dung_cu);
  out['KTV phụ mê'] = first(row?.['KTV phụ mê'], detail?.ktv_phu_me);
  out['Diễn biến bệnh'] = first(row?.['Diễn biến bệnh'], detail?.dien_bien_benh);
  out['Dặn dò sau PT'] = first(row?.['Dặn dò sau PT'], detail?.dan_do_sau_pt);
  out['Bệnh kèm sau PT'] = first(
    row?.['Bệnh kèm sau PT'],
    Array.isArray(detail?.benh_kem_theo_sau_pt) ? detail.benh_kem_theo_sau_pt.join(' · ') : detail?.benh_kem_theo_sau_pt,
  );
  out['Người hoàn tất'] = first(row?.['Người hoàn tất'], detail?.hoan_tat_text);
  out['Tai biến phẫu thuật'] = first(row?.['Tai biến phẫu thuật'], detail?.tai_bien);
  out['Biến chứng phẫu thuật'] = first(row?.['Biến chứng phẫu thuật'], detail?.bien_chung);
  out['Tình hình phẫu thuật'] = first(row?.['Tình hình phẫu thuật'], detail?.tinh_hinh);
  return out;
}

function rowDiff(before, after) {
  const diff = {};
  const keys = new Set([...Object.keys(before || {}), ...Object.keys(after || {})]);
  for (const key of keys) {
    const a = clean(before?.[key]);
    const b = clean(after?.[key]);
    if (a !== b) diff[key] = { before: a, after: b };
  }
  return diff;
}

function ensureBackup(runDir, filePath) {
  const backupPath = path.join(runDir, BACKUP_FILE);
  if (!fs.existsSync(backupPath)) fs.copyFileSync(filePath, backupPath);
  return backupPath;
}

function appendAudit(runDir, payload) {
  const auditPath = path.join(runDir, AUDIT_FILE);
  fs.appendFileSync(auditPath, `${JSON.stringify(payload)}\n`, 'utf-8');
  return auditPath;
}

function repairRawSurgeryCsv(runDir) {
  const dir = path.resolve(runDir);
  const filePath = path.join(dir, 'hchanh_surgery.csv');
  if (!fs.existsSync(filePath)) return { changed: 0, rows: 0, file: filePath, backup: '', audit: '' };

  const table = readCsvTable(filePath, Number.MAX_SAFE_INTEGER);
  const sourceRows = table.rows || [];
  if (!sourceRows.length) return { changed: 0, rows: 0, file: filePath, backup: '', audit: '' };

  const changes = [];
  const rows = sourceRows.map((row, index) => {
    const repaired = repairSurgeryRow(row);
    const diff = rowDiff(row, repaired);
    if (Object.keys(diff).length) {
      changes.push({
        row_index: index + 2,
        patient_code: first(row?.['Mã BN'], row?.patient_code),
        research_key: first(row?.['Research key'], row?.research_key),
        changes: diff,
      });
    }
    return repaired;
  });

  let backupPath = '';
  let auditPath = '';
  if (changes.length) {
    // Backup phải có trước lần ghi đầu tiên; không bao giờ ghi đè backup này.
    backupPath = ensureBackup(dir, filePath);
    const preferred = [
      ...table.columns,
      'Bắt đầu phẫu thuật', 'Kết thúc phẫu thuật', 'Đối tượng DV', 'ICD9',
      'ICD10 trước mổ', 'ICD10 sau mổ', 'Mô tả PPPT', 'Trình tự phẫu thuật',
      'Phẫu thuật viên chính', 'Bác sĩ gây mê chính', 'Phụ mổ 1', 'Phụ mổ 2',
      'Điều dưỡng dụng cụ', 'KTV phụ mê', 'Diễn biến bệnh', 'Dặn dò sau PT',
      'Bệnh kèm sau PT', 'Người hoàn tất', 'Tai biến phẫu thuật',
      'Biến chứng phẫu thuật', 'Tình hình phẫu thuật',
    ];
    const columns = [...new Set(preferred.filter(Boolean))];
    for (const row of rows) for (const key of Object.keys(row)) if (!columns.includes(key)) columns.push(key);
    writeCsv(filePath, columns, rows);
    auditPath = appendAudit(dir, {
      at: new Date().toISOString(),
      operation: 'repair_raw_surgery_csv',
      source_file: path.basename(filePath),
      backup_file: path.basename(backupPath),
      changed_rows: changes.length,
      changes,
    });
  }
  return { changed: changes.length, rows: rows.length, file: filePath, backup: backupPath, audit: auditPath };
}

module.exports = {
  BACKUP_FILE,
  AUDIT_FILE,
  datePart,
  timePart,
  repairSurgeryTimestamp,
  repairSurgeryRow,
  rowDiff,
  repairRawSurgeryCsv,
};
