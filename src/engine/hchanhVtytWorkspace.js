import { HCHANH_VTYT_ITEMS } from '../config/hchanhLists.js';

export const VTYT_USAGE_STATUS = Object.freeze({
  planned: 'Dự kiến',
  collected: 'Đã thu thập',
  used: 'Đã sử dụng',
  cancelled: 'Đã hủy',
  entered: 'Đã nhập EMR',
  error: 'Nhập lỗi',
});

export function safeQty(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, parsed) : 0;
}

export function catalogItem(code) {
  const wanted = String(code || '').trim();
  return HCHANH_VTYT_ITEMS.find(item => String(item.code || '').trim() === wanted) || null;
}

export function stockOf(code) {
  const item = catalogItem(code);
  return item && Number.isFinite(Number(item.stock)) ? Math.max(0, Number(item.stock)) : null;
}

export function isActiveSupply(item = {}) {
  const status = String(item.usage_status || 'planned');
  return item.selected !== false && !['cancelled', 'entered'].includes(status) && safeQty(item.input_quantity) > 0;
}

export function allocatedByCode(draft = {}) {
  const out = new Map();
  for (const job of Array.isArray(draft?.jobs) ? draft.jobs : []) {
    for (const item of Array.isArray(job?.supplies) ? job.supplies : []) {
      if (!isActiveSupply(item)) continue;
      const code = String(item.code || '').trim();
      if (!code) continue;
      out.set(code, (out.get(code) || 0) + safeQty(item.input_quantity));
    }
  }
  return out;
}

export function comboAvailability(combo = {}, draft = {}, multiplier = 1) {
  const allocated = allocatedByCode(draft);
  const details = (Array.isArray(combo?.items) ? combo.items : []).map(row => {
    const code = String(row.code || '').trim();
    const stock = stockOf(code);
    const planned = allocated.get(code) || 0;
    const needed = safeQty(row.quantity || 1) * Math.max(1, safeQty(multiplier));
    const available = stock == null ? null : Math.max(0, stock - planned);
    return {
      ...row,
      code,
      stock,
      planned,
      needed,
      available,
      blocked: stock == null || available < needed,
      reason: stock == null ? 'Chưa xác định tồn kho' : (available < needed ? `Chỉ còn khả dụng ${available}` : ''),
    };
  });
  return { ok: details.length > 0 && details.every(row => !row.blocked), details };
}

export function collectionRows(draft = {}) {
  const map = new Map();
  for (const job of Array.isArray(draft?.jobs) ? draft.jobs : []) {
    for (const item of Array.isArray(job?.supplies) ? job.supplies : []) {
      if (!isActiveSupply(item)) continue;
      const code = String(item.code || '').trim();
      if (!code) continue;
      const row = map.get(code) || {
        code,
        name: item.name || code,
        quantity: 0,
        patients: new Set(),
        stock: stockOf(code),
      };
      row.quantity += safeQty(item.input_quantity);
      if (job.ho_ten || job.ma_bn) row.patients.add(job.ho_ten || job.ma_bn);
      map.set(code, row);
    }
  }
  return [...map.values()].map(row => ({
    ...row,
    patients: [...row.patients],
    remaining: row.stock == null ? null : row.stock - row.quantity,
    blocked: row.stock == null || row.stock < row.quantity,
  })).sort((a, b) => a.name.localeCompare(b.name, 'vi'));
}

export function eligibleInputJobs(draft = {}) {
  return (Array.isArray(draft?.jobs) ? draft.jobs : []).map(job => ({
    ...job,
    supplies: (Array.isArray(job?.supplies) ? job.supplies : []).filter(item => (
      item.selected !== false
      && String(item.usage_status || '') === 'used'
      && String(item.input_status || '') !== 'entered'
      && safeQty(item.input_quantity) > 0
      && stockOf(item.code) != null
      && stockOf(item.code) > 0
    )),
  })).filter(job => job.supplies.length > 0);
}

