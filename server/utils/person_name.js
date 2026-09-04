'use strict';

/**
 * Chuẩn hóa tên người bệnh trước khi trả dữ liệu cho giao diện.
 *
 * EMR đôi khi ghép thông tin phòng vào sau tên, ví dụ:
 *   "ĐOÀN THỊ VÂN - PM: PHÒNG PHẪU THUẬT"
 * Hàm này chỉ bỏ phần hậu tố phòng; không thay đổi dấu, hoa/thường của tên.
 */
function cleanPersonName(value) {
  if (typeof value !== 'string') return value;

  const normalized = value
    .replace(/\u00a0/g, ' ')
    .replace(/[\r\n]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (!normalized) return '';

  // Chỉ xóa khi PM: xuất hiện như một hậu tố độc lập của tên.
  // Hỗ trợ dấu gạch ngang thường, en dash, em dash và khoảng trắng không đều.
  const cleaned = normalized
    .replace(/\s*(?:[-–—]\s*)PM\s*:\s*.*$/iu, '')
    .trim();

  return cleaned || normalized;
}

const PATIENT_NAME_KEYS = new Set([
  'ho_ten',
  'ho_va_ten',
  'hoten',
  'patient_name',
  'patientname',
  'ten_bn',
  'ten_benh_nhan',
  'ten_nguoi_benh',
  'excel_ho_ten',
  'full_name',
]);

const PATIENT_ID_KEYS = new Set([
  'ma_bn',
  'ma_benh_nhan',
  'patient_id',
  'patientid',
  'noitruid',
]);

function normalizeFieldKey(key) {
  return String(key || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/gi, 'd')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function isPatientNameField(key) {
  return PATIENT_NAME_KEYS.has(normalizeFieldKey(key));
}

/**
 * Duyệt dữ liệu JSON và chuẩn hóa mọi trường được xác định là tên người bệnh.
 * Thay đổi object tại chỗ để tránh sao chép các payload hồ sơ lớn.
 */
function sanitizePatientNameFields(value, seen = new WeakSet(), depth = 0) {
  if (!value || typeof value !== 'object' || depth > 40) return value;
  if (seen.has(value)) return value;
  seen.add(value);

  if (Array.isArray(value)) {
    for (const item of value) sanitizePatientNameFields(item, seen, depth + 1);
    return value;
  }

  const keys = Object.keys(value);
  const patientContext = keys.some(key => PATIENT_ID_KEYS.has(normalizeFieldKey(key)));

  for (const [key, child] of Object.entries(value)) {
    const normalizedKey = normalizeFieldKey(key);
    const isContextName = patientContext && (normalizedKey === 'ten' || normalizedKey === 'name');
    if ((isPatientNameField(key) || isContextName) && typeof child === 'string') {
      try { value[key] = cleanPersonName(child); } catch (_) {}
      continue;
    }
    if (child && typeof child === 'object') {
      sanitizePatientNameFields(child, seen, depth + 1);
    }
  }
  return value;
}

/** Express middleware: áp dụng quy tắc tên cho toàn bộ JSON API. */
function patientNameResponseMiddleware(_req, res, next) {
  const originalJson = res.json.bind(res);
  res.json = (body) => {
    try {
      return originalJson(sanitizePatientNameFields(body));
    } catch (_) {
      return originalJson(body);
    }
  };
  next();
}

module.exports = {
  cleanPersonName,
  isPatientNameField,
  sanitizePatientNameFields,
  patientNameResponseMiddleware,
};
