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

export function everyPatientRequirements(combos = []) {
  const map = new Map();
  for (const combo of Array.isArray(combos) ? combos : []) {
    if (combo?.enabled === false) continue;
    for (const item of Array.isArray(combo?.items) ? combo.items : []) {
      if (item?.every_patient !== true) continue;
      const code = String(item.code || '').trim();
      if (!code) continue;
      const current = map.get(code);
      const quantity = Math.max(1, safeQty(item.quantity || 1));
      map.set(code, {
        code,
        name: item.name || catalogItem(code)?.name || code,
        quantity: Math.max(quantity, safeQty(current?.quantity)),
        combo_id: combo.id || '',
        combo_name: combo.name || 'VTYT chung',
      });
    }
  }
  return [...map.values()];
}

export function missingEveryPatientSupplies(draft = {}, combos = []) {
  const requirements = everyPatientRequirements(combos);
  const jobs = Array.isArray(draft?.jobs) ? draft.jobs : [];
  const missing = [];
  for (const patient of Array.isArray(draft?.patients) ? draft.patients : []) {
    const patientJobs = jobs.filter(job => String(job.ma_bn || '') === String(patient.ma_bn || ''));
    for (const requirement of requirements) {
      const present = patientJobs.reduce((sum, job) => sum + (Array.isArray(job.supplies) ? job.supplies : [])
        .filter(item => String(item.code || '').trim() === requirement.code && isActiveSupply(item))
        .reduce((itemSum, item) => itemSum + safeQty(item.input_quantity), 0), 0);
      const missingQuantity = Math.max(0, requirement.quantity - present);
      if (missingQuantity > 0) missing.push({
        ...requirement,
        ma_bn: String(patient.ma_bn || ''),
        ho_ten: patient.ho_ten || '',
        missing_quantity: missingQuantity,
      });
    }
  }
  return missing;
}

export function everyPatientAvailability(draft = {}, combos = []) {
  const allocated = allocatedByCode(draft);
  const missing = missingEveryPatientSupplies(draft, combos);
  const neededByCode = new Map();
  for (const row of missing) neededByCode.set(row.code, (neededByCode.get(row.code) || 0) + row.missing_quantity);
  const details = [...neededByCode.entries()].map(([code, needed]) => {
    const stock = stockOf(code);
    const available = stock == null ? null : Math.max(0, stock - (allocated.get(code) || 0));
    return {
      code,
      name: catalogItem(code)?.name || missing.find(row => row.code === code)?.name || code,
      needed,
      available,
      blocked: stock == null || available < needed,
    };
  });
  return { ok: missing.length > 0 && details.every(row => !row.blocked), missing, details };
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

function normalized(value) {
  return String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd').replace(/Đ/g, 'D').toLowerCase().replace(/\s+/g, ' ').trim();
}

function isInfusionSet(item = {}) {
  const code = String(item.code || item.key || '').trim();
  const name = normalized(item.name || item.searchKeyword || '');
  return ['VTYT.000004109', 'VTYT.000004114'].includes(code) || name.includes('day truyen dich');
}

function itemQuantity(item = {}) {
  return safeQty(item.required_quantity ?? item.quantity ?? item.so_luong ?? item.existing_quantity);
}

export function infusionSetAudit(draft = {}, patientId = '', tolerance = 3) {
  const id = String(patientId || '').trim();
  const patient = (Array.isArray(draft?.patients) ? draft.patients : []).find(row => String(row.ma_bn || '').trim() === id);
  const jobs = (Array.isArray(draft?.jobs) ? draft.jobs : []).filter(job => String(job.ma_bn || '').trim() === id);
  const days = jobs.map(job => {
    const planned = (Array.isArray(job.supplies) ? job.supplies : []).filter(isInfusionSet);
    const original = (Array.isArray(job.original_supplies) ? job.original_supplies : []).filter(isInfusionSet);
    const expected = planned.reduce((sum, item) => sum + safeQty(item.required_quantity), 0);
    const actual = original.length
      ? original.reduce((sum, item) => sum + itemQuantity(item), 0)
      : planned.reduce((sum, item) => sum + safeQty(item.existing_quantity), 0);
    const difference = actual - expected;
    return { date:job.ngay_lam || '', expected, actual, difference };
  }).filter(row => row.expected > 0 || row.actual > 0);
  const expected = days.reduce((sum, row) => sum + row.expected, 0);
  const actual = days.reduce((sum, row) => sum + row.actual, 0);
  const difference = actual - expected;
  const status = difference < 0 ? 'missing' : (difference <= tolerance ? 'acceptable' : 'excess');
  return {
    patient,
    full_episode: patient?.review_mode === 'full_episode',
    expected,
    actual,
    difference,
    tolerance,
    status,
    days,
    mismatches: days.filter(row => row.difference !== 0),
  };
}
