'use strict';

// Chi phí điều trị của một đợt cho Kho nghiên cứu, từ bảng kê chi phí mà worker hchanh_fetch.py
// (fetch_billing, trang chiphichitietdraw) đã lấy. Module thuần, không đọc EMR.
//
// Hai nguồn trên cùng trang bảng kê:
//   - khối "Tổng hợp chi phí" (div#divTongHopChiPhi): 16 ô số EMR tự tính (payload.tong_hop);
//   - các dòng bảng kê (payload.rows): cộng thành tiền để có tổng theo từng khoản.
// Một hàm duy nhất (billingTotalsFromPayload) dùng cho cả dòng thô hchanh_billing.csv và cột
// chi phí của analysis_ready, để số xem trước và số xuất ra luôn giống nhau.

// [khóa trong payload.tong_hop, nhãn trên EMR (= tên cột hchanh_billing.csv), cột analysis_ready]
const BILLING_SUMMARY_FIELDS = Object.freeze([
  ['tong_chi_phi', 'Tổng chi phí', 'cost_total'],
  ['chi_phi_bhyt', 'Chi phí BHYT', 'cost_bhyt'],
  ['bh_tra', 'BH trả', 'cost_insurance_paid'],
  ['cung_chi_tra', 'Cùng chi trả', 'cost_copay'],
  ['tu_tra', 'Tự trả', 'cost_self_pay'],
  ['nguon_khac', 'Nguồn khác', 'cost_other_source'],
  ['chenh_lech', 'Chênh lệch', 'cost_price_difference'],
  ['thuc_thu', 'Thực thu', 'cost_actual_collected'],
  ['tien_tam_ung', 'Tiền tạm ứng', 'cost_advance'],
  ['mien_giam', 'Miễn giảm', 'cost_discount'],
  ['tien_quy_tra', 'Tiền quỹ trả', 'cost_fund_paid'],
  ['that_thu', 'Thất thu', 'cost_uncollected'],
  ['tien_hoan_tra', 'Tiền hoàn trả', 'cost_refunded'],
  ['bien_lai_thu', 'Biên lai thu', 'cost_receipts'],
  ['ghi_no', 'Ghi nợ', 'cost_debt'],
  ['nb_nhan_lai', 'NB nhận lại', 'cost_patient_refund_due'],
].map(([key, label, column]) => Object.freeze({ key, label, column })));

// Tổng tự cộng từ các dòng bảng kê (SL × đơn giá, như worker), theo nhóm đối tượng thanh toán.
const BILLING_ITEMIZED_FIELDS = Object.freeze([
  ['itemized_total', 'Tổng thành tiền bảng kê', 'cost_itemized_total'],
  ['itemized_bhyt', 'Thành tiền đối tượng BHYT', 'cost_itemized_bhyt'],
  ['itemized_self_pay', 'Thành tiền viện phí/tự túc', 'cost_itemized_self_pay'],
  ['itemized_exempt', 'Thành tiền miễn/trong gói', 'cost_itemized_exempt'],
  ['itemized_other', 'Thành tiền chưa phân loại', 'cost_itemized_other'],
  ['item_lines', 'Số dòng bảng kê', 'cost_item_lines'],
].map(([key, label, column]) => Object.freeze({ key, label, column })));

const ALL_FIELDS = Object.freeze([...BILLING_SUMMARY_FIELDS, ...BILLING_ITEMIZED_FIELDS]);
const TREATMENT_COST_COLUMNS = Object.freeze(ALL_FIELDS.map(f => f.column));

function moneyNum(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  const n = Number(String(value ?? '').replace(/[^\d.-]/g, ''));
  return Number.isFinite(n) ? n : 0;
}

function moneyOrNull(value) {
  if (value === undefined || value === null || String(value).trim() === '') return null;
  return Math.round(moneyNum(value));
}

function rowAmount(row) {
  if (row && row.thanh_tien !== undefined && row.thanh_tien !== null && row.thanh_tien !== '') return moneyNum(row.thanh_tien);
  return (moneyNum(row?.sl) || 1) * moneyNum(row?.don_gia);
}

// Trả null khi payload không phải bảng kê đọc được (chưa lấy, lỗi, không có số nào):
// "chưa có số" khác với "0 đồng". Ô EMR không có trên trang để null, không đổi thành 0.
function billingTotalsFromPayload(payload) {
  if (!payload || typeof payload !== 'object') return null;
  const status = String(payload._fetch_status || '').toLowerCase();
  if (status && status !== 'ok') return null;
  const summary = payload.tong_hop && typeof payload.tong_hop === 'object' ? payload.tong_hop : {};
  const rows = Array.isArray(payload.rows) ? payload.rows : [];
  const out = {};
  for (const f of BILLING_SUMMARY_FIELDS) out[f.key] = moneyOrNull(summary[f.key]);
  const hasSummary = BILLING_SUMMARY_FIELDS.some(f => out[f.key] !== null);
  if (!hasSummary && !rows.length) return null;
  if (rows.length) {
    const sum = { itemized_total: 0, itemized_bhyt: 0, itemized_self_pay: 0, itemized_exempt: 0, itemized_other: 0 };
    for (const row of rows) {
      const amount = rowAmount(row);
      const group = String(row?.payment_group || '').toLowerCase();
      if (group === 'bhyt') sum.itemized_bhyt += amount;
      else if (group === 'self_pay') sum.itemized_self_pay += amount;
      else if (group === 'zero') sum.itemized_exempt += amount;
      else sum.itemized_other += amount;
      sum.itemized_total += amount;
    }
    for (const [k, v] of Object.entries(sum)) out[k] = Math.round(v);
    out.item_lines = rows.length;
  } else {
    for (const f of BILLING_ITEMIZED_FIELDS) out[f.key] = null;
  }
  return out;
}

const cellText = v => (v === null || v === undefined ? '' : String(v));

// Cột của dòng thô hchanh_billing.csv (nhãn tiếng Việt như trên EMR).
function billingRawFields(totals) {
  if (!totals) return null;
  return Object.fromEntries(ALL_FIELDS.map(f => [f.label, cellText(totals[f.key])]));
}

// Đọc lại từ một dòng hchanh_billing.csv; null khi dòng không mang số nào.
function billingTotalsFromRawRow(row) {
  if (!row || typeof row !== 'object') return null;
  const out = Object.fromEntries(ALL_FIELDS.map(f => [f.key, moneyOrNull(row[f.label])]));
  return ALL_FIELDS.some(f => out[f.key] !== null) ? out : null;
}

// Cột chi phí của analysis_ready. Ô trống = chưa có số (chưa lấy, EMR không hiện ô đó, hoặc
// các bản bảng kê của cùng đợt không khớp nhau), không phải 0 đồng.
function treatmentCostFields(totals) {
  return Object.fromEntries(ALL_FIELDS.map(f => [f.column, totals ? cellText(totals[f.key]) : '']));
}

function sameTotals(a, b) {
  return ALL_FIELDS.every(f => (a[f.key] ?? null) === (b[f.key] ?? null));
}

// Các dòng chuyển khoa của cùng một đợt dùng lại cùng một bảng kê, nên KHÔNG cộng dồn các dòng
// thô của một đợt. Các bản giống nhau thì dùng một bản; khác nhau thì để trống (conflict), không
// tự chọn số nào là đúng.
function pickEncounterBilling(candidates) {
  const list = (candidates || []).filter(Boolean);
  if (!list.length) return { totals: null, conflict: false };
  return list.every(t => sameTotals(t, list[0])) ? { totals: list[0], conflict: false } : { totals: null, conflict: true };
}

module.exports = {
  BILLING_SUMMARY_FIELDS,
  BILLING_ITEMIZED_FIELDS,
  TREATMENT_COST_COLUMNS,
  billingTotalsFromPayload,
  billingRawFields,
  billingTotalsFromRawRow,
  treatmentCostFields,
  pickEncounterBilling,
};
