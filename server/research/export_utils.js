'use strict';

const DEFAULT_SENSITIVE_COLUMNS = new Set([
  'Họ tên', 'Ho ten', 'Tên BN', 'Ten BN', 'Mã BN', 'Ma BN', 'MABN', 'Số bệnh án', 'So benh an',
  'Mã vào viện', 'Ma vao vien', 'Mã điều trị', 'Ma dieu tri', 'Điện thoại', 'Dien thoai', 'SĐT', 'SDT',
  'Số CMND', 'So CMND', 'Số CMT', 'So CMT', 'CCCD', 'Địa chỉ', 'Dia chi', 'Ngày sinh', 'Ngay sinh',
  'Số thẻ', 'So the', 'Số thẻ BHYT', 'So the BHYT', 'BHYT', 'Raw JSON',
  'patient_name', 'patient_code', 'birth_date', 'address', 'phone_number', 'citizen_id', 'insurance_card',
  'insurance_subject', 'insurance_type', 'insurance_valid_from', 'insurance_valid_to', 'emr_admission_id', 'emr_treatment_id',
  // Mã nội trú (noitruid) và các URL EMR cũng là định danh: URL chứa noitruid và
  // keyword=<Mã BN>, nên bản "ẩn danh" từng lọt Mã BN qua các cột này.
  'Mã nội trú', 'Ma noi tru', 'noitruid', 'emr_noitru_id', 'URL bác sĩ', 'URL điều dưỡng',
  'record_doctor_url', 'record_nursing_url', 'Số lưu trữ', 'So luu tru', 'so_luu_tru', 'Số điện thoại',
]);

function normalizeHeader(value) {
  return String(value || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/đ/g, 'd')
    .replace(/[^a-z0-9]+/g, '');
}

const DEFAULT_SENSITIVE_KEYS = new Set([...DEFAULT_SENSITIVE_COLUMNS].map(normalizeHeader));

function isSensitiveColumn(column, sensitiveKeys = DEFAULT_SENSITIVE_KEYS) {
  const key = normalizeHeader(column);
  if (!key) return false;
  if (sensitiveKeys.has(key)) return true;
  return /^(patientname|patientcode|hoten|mabn|cccd|socmnd|socmt|dienthoai|sodienthoai|sdt|diachi|ngaysinh|birthdate|address|phonenumber|citizenid|insurance|bhyt|sothe|manoitru|noitru|emrnoitru|soluutru|url)/.test(key)
    || /url$/.test(key);
}

function redactCsvTable(columns, rows, sensitiveColumns = DEFAULT_SENSITIVE_COLUMNS) {
  const sensitiveKeys = new Set([...sensitiveColumns].map(normalizeHeader));
  const keptColumns = (columns || []).filter(col => !isSensitiveColumn(col, sensitiveKeys));
  const keptRows = (rows || []).map(row => {
    const out = {};
    for (const col of keptColumns) out[col] = row?.[col] ?? '';
    return out;
  });
  return { columns: keptColumns, rows: keptRows, removed_columns: (columns || []).filter(col => !keptColumns.includes(col)) };
}

module.exports = { DEFAULT_SENSITIVE_COLUMNS, redactCsvTable, isSensitiveColumn };
