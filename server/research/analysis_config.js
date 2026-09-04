'use strict';

function stripVietnameseMarks(value) {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D');
}

function normalizeDiagnosisRegexPattern(pattern) {
  return stripVietnameseMarks(String(pattern ?? '').trim());
}

function validateRegexPattern(pattern) {
  const raw = String(pattern ?? '').trim();
  if (!raw) throw new Error('Regex không được để trống.');
  if (raw.length > 240) throw new Error('Regex quá dài (tối đa 240 ký tự).');
  // Chặn một số dạng nested quantifier dễ gây catastrophic backtracking.
  if (/(\([^)]*[+*][^)]*\))[+*{]/.test(raw) || /(\.\*){2,}/.test(raw)) {
    throw new Error('Regex có cấu trúc lặp lồng nhau không an toàn.');
  }
  const normalized = normalizeDiagnosisRegexPattern(raw);
  try {
    return { raw, normalized, regex: new RegExp(normalized, 'i') };
  } catch (err) {
    throw new Error(`Regex không hợp lệ: ${String(err?.message || err)}`);
  }
}

function sanitizeCustomFields(rawFields, {
  reservedColumns = [],
  inferenceFields = [],
  strict = true,
} = {}) {
  const reserved = new Set(
    [...reservedColumns, ...inferenceFields]
      .map(value => String(value ?? '').trim().toLowerCase())
      .filter(Boolean)
  );
  const seen = new Set();
  const out = [];
  for (const rawField of Array.isArray(rawFields) ? rawFields : []) {
    if (!rawField) continue;
    const name = String(rawField.name ?? '').trim();
    const pattern = String(rawField.pattern ?? '').trim();
    const label = String(rawField.label || name).trim().slice(0, 160);
    if (!name && !pattern) continue;
    try {
      if (!/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(name)) {
        throw new Error(`Tên trường "${name || '(trống)'}" chỉ được dùng chữ cái ASCII, số và dấu gạch dưới; phải bắt đầu bằng chữ cái.`);
      }
      const key = name.toLowerCase();
      if (reserved.has(key)) throw new Error(`Tên trường "${name}" trùng với cột hệ thống.`);
      if (seen.has(key)) throw new Error(`Tên trường "${name}" bị trùng.`);
      const checked = validateRegexPattern(pattern);
      seen.add(key);
      out.push({ name, pattern: checked.raw, normalized_pattern: checked.normalized, label: label || name });
    } catch (err) {
      if (strict) {
        err.status = 400;
        throw err;
      }
    }
  }
  return out;
}

function evaluateCustomFields(customFields, normalizedDiagnosisText) {
  const target = String(normalizedDiagnosisText ?? '');
  const out = {};
  for (const field of Array.isArray(customFields) ? customFields : []) {
    if (!field?.name || !field?.pattern) continue;
    try {
      const normalizedPattern = field.normalized_pattern || normalizeDiagnosisRegexPattern(field.pattern);
      out[field.name] = new RegExp(normalizedPattern, 'i').test(target) ? '1' : '0';
    } catch (_) {
      out[field.name] = '0';
    }
  }
  return out;
}

module.exports = {
  stripVietnameseMarks,
  normalizeDiagnosisRegexPattern,
  validateRegexPattern,
  sanitizeCustomFields,
  evaluateCustomFields,
};
