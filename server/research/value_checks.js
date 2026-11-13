'use strict';

// Rà giá trị lạ trong file "Biến đã chọn" trước khi xuất: chỉ báo, không tự sửa hay bỏ giá trị nào.
// Mỗi giá trị lạ một dòng: Mã NC (giả danh), cột, nhãn biến, giá trị, lý do. Không có Mã BN/họ tên,
// và bỏ qua hẳn biến định danh (ngày sinh, số điện thoại...) để không lộ giá trị của chúng.
//
// Quy tắc:
// - Cột nền: tuổi ngoài 0–120, năm sinh vô lý, số ngày nằm viện âm hoặc trên 365, ngày ra trước
//   ngày vào, ngày vào/ra ở tương lai.
// - Biến dạng số: ô không đọc được thành số trong cột gần như toàn số; giá trị khác xa phần còn
//   lại (ngoài Q1 − 3×IQR … Q3 + 3×IQR, cần ít nhất 20 giá trị). Quy tắc này bắt được phần lớn
//   trường hợp nhập nhầm đơn vị (mmol/L với mg/dL) hay gõ thừa số 0.
// - Biến dạng ngày: ngày ở tương lai hoặc trước năm 1900.

const { isSensitiveColumn } = require('./export_utils');

const STRICT_NUMBER = /^[-+]?\d+(?:[.,]\d+)?$/;
const MIN_VALUES_FOR_OUTLIER = 20;
const OUTLIER_IQR_FACTOR = 3;
const VALUE_ISSUE_LIMIT = 2000;

function text(v) { return String(v ?? '').trim(); }
function num(v) { return Number(text(v).replace(',', '.')); }
function fmtNum(n) { return Number.isFinite(n) ? String(Number(n.toFixed(2))) : ''; }

function parseDate(raw) {
  const s = text(raw);
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return Date.UTC(+m[1], +m[2] - 1, +m[3]);
  m = s.match(/(?:^|\s)(\d{1,2})[/-](\d{1,2})[/-](\d{4})/);
  if (m) return Date.UTC(+m[3], +m[2] - 1, +m[1]);
  return NaN;
}

function quantile(sorted, q) {
  if (!sorted.length) return NaN;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

function variableKind(variable, values) {
  const aggregation = String(variable?.aggregation || 'list').toLowerCase();
  if (aggregation === 'any') return 'category';
  if (['count', 'min', 'max', 'mean'].includes(aggregation)) return 'number';
  const type = String(variable?.type || '').toLowerCase();
  if (type === 'date' || type === 'datetime') return 'date';
  const filled = values.filter(Boolean);
  const numeric = filled.filter(v => STRICT_NUMBER.test(v)).length;
  if (filled.length && numeric / filled.length >= 0.8) return 'number';
  return 'other';
}

function todayUtc(now = new Date()) {
  return Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
}

/**
 * rows: các dòng của file "Biến đã chọn".
 * variables: manifest.variables (có output_column, survey_label/label, type, aggregation).
 */
function checkSelectedValues(rows, variables, { now = new Date(), limit = VALUE_ISSUE_LIMIT } = {}) {
  const list = Array.isArray(rows) ? rows : [];
  const issues = [];
  const today = todayUtc(now);
  const year = now.getFullYear();
  const add = (row, column, label, value, reason) => {
    issues.push({ research_code: text(row?.research_code), column, label, value: text(value).slice(0, 80), reason });
  };

  for (const row of list) {
    const age = text(row?.age);
    if (age && STRICT_NUMBER.test(age) && (num(age) < 0 || num(age) > 120)) add(row, 'age', 'Tuổi lúc vào viện', age, 'Tuổi ngoài khoảng 0–120');
    const by = text(row?.birth_year);
    if (by && STRICT_NUMBER.test(by) && (num(by) < 1900 || num(by) > year)) add(row, 'birth_year', 'Năm sinh', by, `Năm sinh ngoài khoảng 1900–${year}`);
    const stay = text(row?.hospital_stay_days);
    if (stay && STRICT_NUMBER.test(stay)) {
      if (num(stay) < 0) add(row, 'hospital_stay_days', 'Số ngày nằm viện', stay, 'Số ngày nằm viện âm');
      else if (num(stay) > 365) add(row, 'hospital_stay_days', 'Số ngày nằm viện', stay, 'Nằm viện trên 365 ngày');
    }
    const admit = parseDate(row?.admission_date);
    const discharge = parseDate(row?.discharge_date);
    if (Number.isFinite(admit) && Number.isFinite(discharge) && discharge < admit) {
      add(row, 'discharge_date', 'Ngày ra viện', row.discharge_date, `Ngày ra trước ngày vào (${text(row.admission_date)})`);
    }
    if (Number.isFinite(admit) && admit > today) add(row, 'admission_date', 'Ngày vào viện', row.admission_date, 'Ngày ở tương lai');
    if (Number.isFinite(discharge) && discharge > today) add(row, 'discharge_date', 'Ngày ra viện', row.discharge_date, 'Ngày ở tương lai');
  }

  for (const variable of Array.isArray(variables) ? variables : []) {
    const col = variable?.output_column;
    if (!col) continue;
    // Biến định danh (ngày sinh, số điện thoại...) không bao giờ đưa giá trị ra danh sách này.
    if ([variable.name, col, variable.label].some(x => x && isSensitiveColumn(x))) continue;
    const label = variable.survey_label || variable.label || variable.name || col;
    const values = list.map(r => text(r?.[col]));
    const kind = variableKind(variable, values);
    if (kind === 'number') {
      const nums = values.filter(v => STRICT_NUMBER.test(v)).map(num).sort((a, b) => a - b);
      let lowFence = -Infinity;
      let highFence = Infinity;
      let range = '';
      if (nums.length >= MIN_VALUES_FOR_OUTLIER) {
        const q1 = quantile(nums, 0.25);
        const q3 = quantile(nums, 0.75);
        const iqr = q3 - q1;
        if (iqr > 0) {
          lowFence = q1 - OUTLIER_IQR_FACTOR * iqr;
          highFence = q3 + OUTLIER_IQR_FACTOR * iqr;
          range = `${fmtNum(q1)}–${fmtNum(q3)}`;
        }
      }
      list.forEach((row, i) => {
        const v = values[i];
        if (!v) return;
        if (!STRICT_NUMBER.test(v)) { add(row, col, label, v, /;/.test(v) ? 'Nhiều giá trị trong một ô' : 'Không đọc được thành số'); return; }
        const n = num(v);
        if (n < lowFence || n > highFence) add(row, col, label, v, `Khác xa phần còn lại (phần lớn từ ${range})`);
      });
    } else if (kind === 'date') {
      list.forEach((row, i) => {
        const t = parseDate(values[i]);
        if (!Number.isFinite(t)) return;
        if (t > today) add(row, col, label, values[i], 'Ngày ở tương lai');
        else if (t < Date.UTC(1900, 0, 1)) add(row, col, label, values[i], 'Ngày trước năm 1900');
      });
    }
  }

  issues.sort((a, b) => a.research_code.localeCompare(b.research_code, 'vi', { numeric: true }) || a.label.localeCompare(b.label, 'vi'));
  const byLabel = new Map();
  for (const issue of issues) byLabel.set(issue.label, (byLabel.get(issue.label) || 0) + 1);
  return {
    total: issues.length,
    cases: new Set(issues.map(i => i.research_code)).size,
    by_variable: [...byLabel.entries()].map(([label, count]) => ({ label, count })).sort((a, b) => b.count - a.count),
    issues: issues.slice(0, limit),
  };
}

module.exports = { checkSelectedValues, VALUE_ISSUE_LIMIT };
