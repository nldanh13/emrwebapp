'use strict';

// Danh sách mọi trường dữ liệu Kho nghiên cứu lấy được (tab Dữ liệu tổng quát).
//
// Nguồn duy nhất là từ điển dữ liệu (data_dictionary.js): thêm cột/bảng ở đó (CI buộc khớp
// NORMALIZED_COLUMNS) thì trường mới tự hiện ở đây, không phải gõ tay danh sách thứ hai.
// Kèm số dòng đã có giá trị trong kho hiện tại, đọc từ CSV chuẩn hóa (không mở EMR) và
// nhớ theo thời điểm sửa + dung lượng file, nên các lần làm mới trong lúc thu thập gần như không tốn.

const fs = require('fs');
const path = require('path');
const dict = require('./data_dictionary');
const { TREATMENT_COST_COLUMNS } = require('./billing_summary');
const { readCsvFileRows } = require('./csv_reader');

// Số dòng tối đa đọc để đếm ô có giá trị mỗi bảng; bảng lớn hơn thì đếm trên phần đầu và ghi rõ.
const FIELD_COUNT_MAX_ROWS = Math.max(1000, Number(process.env.EMR_FIELD_CATALOG_MAX_ROWS || 100000));

// Cột kỹ thuật (ghép đợt, nguồn, mã băm): vẫn liệt kê nhưng giao diện ẩn mặc định.
const TECHNICAL_COLUMNS = new Set([
  'encounter_id', 'encounter_match_status', 'encounter_match_method', 'encounter_match_reason',
  'source', 'source_type', 'source_quality', 'source_file', 'source_run_id', 'source_input',
  'source_status', 'row_hash',
]);

const COST_COLUMNS = new Set(TREATMENT_COST_COLUMNS);

// Thứ tự và tên nhóm cho người dùng. Bảng có trong từ điển mà chưa có ở đây vẫn hiện (cuối danh sách).
const GROUPS = [
  { key: 'patients', table: 'patients', label: 'Hồ sơ người bệnh', unit: 'người bệnh' },
  { key: 'encounters', table: 'encounters', label: 'Đợt điều trị (vào viện, ra viện, sinh hiệu lúc vào)', unit: 'lượt' },
  { key: 'diagnoses', table: 'diagnoses', label: 'Chẩn đoán', unit: 'dòng' },
  { key: 'surgery_results', table: 'surgery_results', label: 'Phẫu thuật / thủ thuật', unit: 'ca' },
  { key: 'cost', table: 'analysis_ready', label: 'Chi phí điều trị (bảng kê)', unit: 'lượt', only: COST_COLUMNS },
  { key: 'medication_orders', table: 'medication_orders', label: 'Thuốc / y lệnh', unit: 'dòng thuốc' },
  { key: 'medication_day_summary', table: 'medication_day_summary', label: 'Thuốc tổng hợp theo ngày', unit: 'ngày' },
  { key: 'clinical_notes', table: 'clinical_notes', label: 'Diễn biến & y lệnh gốc', unit: 'dòng' },
  { key: 'clinical_events', table: 'clinical_events', label: 'Sự kiện lâm sàng (tách từ diễn biến)', unit: 'sự kiện' },
  { key: 'lab_results', table: 'lab_results', label: 'Xét nghiệm', unit: 'kết quả' },
  { key: 'imaging_results', table: 'imaging_results', label: 'Chẩn đoán hình ảnh (CĐHA)', unit: 'kết quả' },
  { key: 'patient_day', table: 'patient_day', label: 'Hoạt động theo ngày', unit: 'ngày' },
  { key: 'analysis_ready', table: 'analysis_ready', label: 'Bảng phân tích theo lượt (biến tổng hợp)', unit: 'lượt', exclude: COST_COLUMNS },
  { key: 'extract_status', table: 'extract_status', label: 'Tiến độ lấy dữ liệu', unit: 'lượt' },
];

const countCache = new Map();

function fileSignature(filePath) {
  try {
    const st = fs.statSync(filePath);
    return st.isFile() ? `${st.size}:${st.mtimeMs}` : '';
  } catch (_) {
    return '';
  }
}

// { exists, rows, counted_rows, limited, nonempty: { col: n } } cho một file CSV chuẩn hóa.
function countFilledCells(filePath) {
  const signature = fileSignature(filePath);
  if (!signature) return { exists: false, rows: 0, counted_rows: 0, limited: false, nonempty: {} };
  const hit = countCache.get(filePath);
  if (hit && hit.signature === signature) return hit.result;
  const nonempty = {};
  let counted = 0;
  const table = readCsvFileRows(filePath, FIELD_COUNT_MAX_ROWS, {
    onHeader: columns => { for (const name of columns) nonempty[name] = 0; },
    onRow: row => {
      counted += 1;
      for (const name in row) if (row[name]) nonempty[name] = (nonempty[name] || 0) + 1;
    },
  });
  const result = { exists: true, rows: Number(table.count) || 0, counted_rows: counted, limited: Boolean(table.limited), nonempty };
  countCache.set(filePath, { signature, result });
  return result;
}

function fieldFromDefinition(name, def) {
  return {
    name,
    meaning: def.meaning || '',
    type: def.type || '',
    unit: def.unit || '',
    use: def.use || 'allowed',
    identifier: def.identifier || 'none',
    inferred: Boolean(def.inferred),
    technical: TECHNICAL_COLUMNS.has(name),
  };
}

// runDir trống/không có: vẫn trả đủ danh sách trường (để biết hệ thống lấy được gì), không có số đếm.
function buildFieldCatalog(runDir, { tables = dict.TABLES } = {}) {
  const hasRun = Boolean(runDir) && fs.existsSync(runDir);
  const groupDefs = [...GROUPS];
  const listed = new Set(GROUPS.map(g => g.table));
  for (const key of Object.keys(tables)) {
    if (!listed.has(key)) groupDefs.push({ key, table: key, label: key, unit: 'dòng' });
  }
  const groups = [];
  let totalFields = 0;
  let filledFields = 0;
  for (const g of groupDefs) {
    const tableDef = tables[g.table];
    if (!tableDef || !tableDef.columns) continue;
    const counts = hasRun && tableDef.file ? countFilledCells(path.join(runDir, tableDef.file)) : null;
    const fields = Object.entries(tableDef.columns)
      .filter(([name]) => (!g.only || g.only.has(name)) && (!g.exclude || !g.exclude.has(name)))
      .map(([name, def]) => {
        const field = fieldFromDefinition(name, def);
        if (counts && counts.exists) field.filled = Number(counts.nonempty[name] || 0);
        return field;
      });
    if (!fields.length) continue;
    totalFields += fields.length;
    filledFields += fields.filter(f => f.filled > 0).length;
    groups.push({
      key: g.key,
      table: g.table,
      label: g.label,
      unit: g.unit,
      grain: tableDef.grain || '',
      dynamic_columns: g.only ? null : (tableDef.dynamic_columns || null),
      has_file: Boolean(counts && counts.exists),
      rows: counts && counts.exists ? counts.rows : null,
      counted_rows: counts && counts.exists ? counts.counted_rows : null,
      limited: Boolean(counts && counts.limited),
      fields,
    });
  }
  return {
    dictionary_version: dict.DICTIONARY_VERSION,
    run_id: hasRun ? path.basename(runDir) : '',
    count_limit: FIELD_COUNT_MAX_ROWS,
    total_fields: totalFields,
    filled_fields: filledFields,
    groups,
  };
}

module.exports = { buildFieldCatalog, countFilledCells, FIELD_COUNT_MAX_ROWS, TECHNICAL_COLUMNS, GROUPS };
