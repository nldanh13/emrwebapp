function rows(value) { return Array.isArray(value) ? value : []; }
function keyOf(item = {}) { return String(item.code || item.key || item.name || '').trim(); }
function qty(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, number) : 0;
}

function currentExistingByCode(job = {}) {
  const map = new Map();
  for (const item of rows(job.original_supplies)) {
    const key = keyOf(item);
    if (!key) continue;
    const quantity = qty(item.required_quantity ?? item.quantity ?? item.so_luong ?? item.input_quantity);
    map.set(key, (map.get(key) || 0) + quantity);
  }
  for (const item of rows(job.supplies)) {
    const key = keyOf(item);
    if (!key || map.has(key)) continue;
    map.set(key, qty(item.existing_quantity));
  }
  return map;
}

export function existingVtytQuantity(job, code) {
  return currentExistingByCode(job).get(String(code || '').trim()) || 0;
}

function reconcileItem(freshItem, oldItem, currentExisting, syncedAt) {
  const oldStatus = String(oldItem.input_status || 'pending');
  if (oldStatus === 'entered' || String(oldItem.usage_status || '') === 'entered') {
    return { ...freshItem, ...oldItem, usage_status:'entered', input_status:'entered' };
  }

  const baseline = qty(oldItem.existing_quantity);
  const existing = Math.max(baseline, qty(currentExisting));
  const newlyFound = Math.max(0, existing - baseline);
  const intended = qty(oldItem.input_quantity ?? freshItem.input_quantity);
  const remaining = Math.max(0, intended - newlyFound);
  const enteredElsewhere = intended > 0 && newlyFound >= intended;

  return {
    ...freshItem,
    selected: oldItem.selected !== false,
    input_quantity: enteredElsewhere ? intended : remaining,
    existing_quantity: existing,
    manual: oldItem.manual === true || freshItem.manual === true,
    usage_status: enteredElsewhere ? 'entered' : (oldItem.usage_status || freshItem.usage_status || 'planned'),
    input_status: enteredElsewhere ? 'entered' : (oldItem.input_status || freshItem.input_status || 'pending'),
    source_type: oldItem.source_type || freshItem.source_type || 'auto',
    combo_id: oldItem.combo_id || '',
    combo_name: oldItem.combo_name || '',
    ...(enteredElsewhere ? { entered_at: oldItem.entered_at || syncedAt || '' } : {}),
  };
}

export function mergeVtytDraftEdits(previous, fresh) {
  if (!previous || !fresh) return fresh;
  const oldJobs = new Map();
  for (const job of rows(previous.jobs)) {
    oldJobs.set(`${String(job.ma_bn || '').trim()}::${String(job.ngay_lam || '').trim()}`, job);
  }

  const jobs = rows(fresh.jobs).map(job => {
    const jobKey = `${String(job.ma_bn || '').trim()}::${String(job.ngay_lam || '').trim()}`;
    const oldJob = oldJobs.get(jobKey);
    if (!oldJob) return job;
    const existing = currentExistingByCode(job);
    const oldItems = new Map(rows(oldJob.supplies).map(item => [keyOf(item), item]));
    const supplies = rows(job.supplies).map(item => {
      const key = keyOf(item);
      const old = oldItems.get(key);
      if (!old) return item;
      oldItems.delete(key);
      return reconcileItem(item, old, existing.get(key) ?? item.existing_quantity, fresh.updated_at);
    });
    for (const old of oldItems.values()) {
      if (!old?.manual && old?.source_type !== 'combo' && old?.source_type !== 'every_patient') continue;
      const key = keyOf(old);
      supplies.push(reconcileItem(old, old, existing.get(key), fresh.updated_at));
    }
    return { ...job, supplies, reviewed:false };
  });

  return {
    ...fresh,
    jobs,
    patients: rows(fresh.patients).map(patient => ({ ...patient, reviewed:false })),
  };
}
