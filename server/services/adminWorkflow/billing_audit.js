'use strict';

const { ISSUE_GROUPS } = require('./constants');
const { safeArray, asObject, normText, makeIssue, toNumber } = require('./common');
const { moneyNumber } = require('./business_helpers');

function collectBillingRows(records) {
  const rows = [];
  const add = (item, source, record) => {
    if (!item) return;
    if (typeof item === 'string') {
      const name = item.trim();
      if (name) rows.push({ name, source, raw: item, date: record?.date || record?.ngay_lam || '' });
      return;
    }
    if (typeof item === 'object') {
      const name = String(item.name || item.ten || item.ten_dich_vu || item.noi_dung || item.service_name || item.label || item.raw_text || item.raw || '').trim();
      if (!name) return;
      rows.push({
        ...item,
        name,
        source: item.source || source,
        date: item.date || item.ngay || record?.ngay_lam || record?.date || '',
      });
    }
  };

  for (const record of safeArray(records)) {
    const src = asObject(record);
    for (const key of ['bang_ke', 'bang_ke_chi_phi', 'billing', 'billing_rows', 'chi_phi_rows', 'cost_rows', 'fee_rows', 'vien_phi', 'dich_vu_chi_phi']) {
      const value = src[key];
      if (Array.isArray(value)) value.forEach(item => add(item, key, src));
      else if (value && typeof value === 'object') {
        for (const sub of Object.values(value)) {
          if (Array.isArray(sub)) sub.forEach(item => add(item, key, src));
          else add(sub, key, src);
        }
      }
    }
  }
  return rows;
}

function paymentText(row) {
  return normText([
    row.payment, row.thanh_toan, row.doi_tuong_thanh_toan, row.nhom_thanh_toan,
    row.bhyt, row.BHYT, row.ty_le_bhyt, row.ti_le_bhyt, row.muc_huong,
    row.note, row.ghi_chu, row.source, row.raw, row.raw_text, row.name,
  ].join(' '));
}

function categorizeBillingRow(row) {
  const text = paymentText(row);
  if (/tt0|tu tuc|tu tra|ngoai bhyt|khong bhyt|khong thanh toan|dich vu|thu phi/.test(text)) return 'self_pay';
  if (/bhyt|bao hiem|muc huong|80\s*%|95\s*%|100\s*%|dong chi tra|cung chi tra/.test(text)) return 'bhyt';
  if (/mien|khong thu|0\s*d/.test(text)) return 'zero';
  return 'unknown';
}

function rowAmount(row) {
  for (const key of ['amount', 'thanh_tien', 'tong_tien', 'so_tien', 'cost', 'price', 'don_gia']) {
    if (row[key] !== undefined && row[key] !== null && String(row[key]).trim() !== '') {
      const qty = toNumber(row.qty ?? row.quantity ?? row.so_luong, 1);
      const amount = moneyNumber(row[key]);
      if (key === 'don_gia' && qty > 0) return amount * qty;
      return amount;
    }
  }
  return 0;
}

function buildBillingAudit({ records, services, drugs }) {
  const explicitRows = collectBillingRows(records);
  const fallbackRows = explicitRows.length ? [] : [
    ...safeArray(services).map(s => ({ name: s.name, source: s.source || 'service', raw: s.raw_text || s.raw || '' })),
    ...safeArray(drugs).map(d => ({ name: d.name, source: d.category || d.routeLabel || 'drug', raw: d.raw_text || d.raw || '' })),
  ];
  const sourceType = explicitRows.length ? 'billing_table' : 'fallback_orders';
  const rows = (explicitRows.length ? explicitRows : fallbackRows).map((row, idx) => {
    const paymentGroup = categorizeBillingRow(row);
    const amount = rowAmount(row);
    return {
      id: `${sourceType}-${idx}`,
      name: row.name,
      source: row.source || '',
      date: row.date || '',
      paymentGroup,
      amount,
      rawPayment: paymentText(row),
      raw: row.raw || row.raw_text || '',
    };
  });

  const groups = {
    bhyt: rows.filter(r => r.paymentGroup === 'bhyt'),
    selfPay: rows.filter(r => r.paymentGroup === 'self_pay'),
    zero: rows.filter(r => r.paymentGroup === 'zero'),
    unknown: rows.filter(r => r.paymentGroup === 'unknown'),
  };
  const sum = list => list.reduce((acc, row) => acc + (Number(row.amount) || 0), 0);
  const summary = {
    sourceType,
    rowsCount: rows.length,
    bhytCount: groups.bhyt.length,
    selfPayCount: groups.selfPay.length,
    zeroCount: groups.zero.length,
    unknownCount: groups.unknown.length,
    totalAmount: sum(rows),
    bhytAmount: sum(groups.bhyt),
    selfPayAmount: sum(groups.selfPay),
    unknownAmount: sum(groups.unknown),
  };

  const issues = [];
  if (!explicitRows.length) {
    issues.push(makeIssue({
      group: ISSUE_GROUPS.COST,
      severity: 'warn',
      code: 'BILLING_TABLE_NOT_CAPTURED',
      title: 'Chưa có bảng kê chi phí chi tiết để bóc tách BHYT/tự túc',
      detail: 'Hệ thống đang suy luận từ y lệnh/DVKT; cần quét hoặc nạp bảng kê trước khi in.',
      action: 'Mở Bảng kê trên EMR để worker đọc lại chi tiết từng dòng chi phí.',
    }));
  }
  if (summary.selfPayCount > 0) {
    issues.push(makeIssue({
      group: ISSUE_GROUPS.COST,
      severity: 'warn',
      code: 'SELF_PAY_LINES_PRESENT',
      title: `Có ${summary.selfPayCount} dòng thu phí tự túc/TT0`,
      detail: groups.selfPay.slice(0, 5).map(r => r.name).join(' · '),
      action: 'Tách rõ trên bảng kê và phiếu công khai; không gộp nhầm vào nhóm BHYT.',
    }));
  }
  if (explicitRows.length && summary.unknownCount > 0) {
    issues.push(makeIssue({
      group: ISSUE_GROUPS.COST,
      severity: 'warn',
      code: 'UNKNOWN_PAYMENT_LINES',
      title: `Có ${summary.unknownCount} dòng chưa rõ BHYT hay tự túc`,
      detail: groups.unknown.slice(0, 5).map(r => r.name).join(' · '),
      action: 'Bổ sung/đối chiếu đối tượng thanh toán từng dòng trước khi in.',
    }));
  }

  return { rows, groups, summary, issues };
}

module.exports = { collectBillingRows, categorizeBillingRow, buildBillingAudit };
