'use strict';

const path = require('path');
const crypto = require('crypto');
const { readJsonSafe, writeJsonAtomic } = require('../../utils/file');

const STORE_VERSION = 2;
const TIME_ZONE = 'Asia/Ho_Chi_Minh';
const BATCH_STATUSES = new Set(['preparing', 'submitted']);

function nowIso() {
  return new Date().toISOString();
}

function todayInVietnam(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const map = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return `${map.year}-${map.month}-${map.day}`;
}

function normalizeDate(value) {
  const text = String(value || '').trim();
  const m = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return '';
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const d = new Date(Date.UTC(year, month - 1, day));
  if (d.getUTCFullYear() !== year || d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) return '';
  return text;
}

function cleanText(value, max = 500) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function normalizeAliases(values) {
  const list = Array.isArray(values) ? values : [values];
  return [...new Set(list.map(value => cleanText(value, 500)).filter(Boolean))];
}

function normalizeSnapshot(snapshot = {}) {
  const src = snapshot && typeof snapshot === 'object' && !Array.isArray(snapshot) ? snapshot : {};
  return {
    ho_ten: cleanText(src.ho_ten || src.name, 300),
    ma_bn: cleanText(src.ma_bn || src.patient_id, 100),
    so_luu_tru: cleanText(src.so_luu_tru || src.storage, 200),
    so_luu_tru_in: cleanText(src.so_luu_tru_in || src.storage_print, 100),
    storage_kind: cleanText(src.storage_kind, 30).toUpperCase(),
    admission_date: cleanText(src.admission_date || src.ngay_vao_vien, 100),
    discharge_date: cleanText(src.discharge_date || src.ngay_ra_vien, 100),
    xq: Number(src.xq || src.so_xq || 0) || 0,
    ct: Number(src.ct || src.so_ct || 0) || 0,
    mri: Number(src.mri || src.so_mri || 0) || 0,
  };
}

function mergeSnapshotMissingFields(existingSnapshot = {}, incomingSnapshot = {}) {
  const existing = normalizeSnapshot(existingSnapshot);
  const incoming = normalizeSnapshot(incomingSnapshot);
  const merged = { ...existing };
  for (const key of ['ho_ten', 'ma_bn', 'so_luu_tru', 'so_luu_tru_in', 'storage_kind', 'admission_date', 'discharge_date']) {
    if (!merged[key] && incoming[key]) merged[key] = incoming[key];
  }
  // Snapshot là dữ liệu lịch sử tại thời điểm xếp/nộp. Không ghi đè số cũ bằng 0
  // khi dữ liệu hiện tại tạm thời chưa tải được; chỉ bổ sung khi trước đó chưa có.
  for (const key of ['xq', 'ct', 'mri']) {
    if (!Number(merged[key] || 0) && Number(incoming[key] || 0)) merged[key] = Number(incoming[key] || 0);
  }
  return merged;
}

function emptyStore() {
  return {
    version: STORE_VERSION,
    updated_at: null,
    batches: {},
    events: [],
  };
}

function normalizeItem(item = {}) {
  const recordId = cleanText(item.record_id || item.case_key || item.id, 500);
  return {
    id: cleanText(item.id, 200) || `item_${crypto.randomUUID()}`,
    record_id: recordId,
    aliases: normalizeAliases([recordId, ...(Array.isArray(item.aliases) ? item.aliases : []), ...(Array.isArray(item.source_case_keys) ? item.source_case_keys : [])]),
    status: ['active', 'returned', 'removed'].includes(item.status) ? item.status : 'active',
    added_at: item.added_at || nowIso(),
    returned_at: item.returned_at || null,
    removed_at: item.removed_at || null,
    return_note: cleanText(item.return_note, 1000),
    previous_attempt_id: cleanText(item.previous_attempt_id, 200),
    previous_submission_date: normalizeDate(item.previous_submission_date),
    snapshot: normalizeSnapshot(item.snapshot || item),
  };
}

function inferLegacyBatchStatus(batch, submissionDate) {
  const explicit = cleanText(batch.status || batch.batch_status, 30).toLowerCase();
  if (BATCH_STATUSES.has(explicit)) return explicit;

  // Bản cũ không có trạng thái đợt. Giữ nguyên ý nghĩa dữ liệu lịch sử:
  // - đã từng xuất danh sách: xem là đã nộp theo cơ chế cũ;
  // - ngày đã qua: xem là đợt lịch sử đã nộp;
  // - hôm nay hoặc tương lai chưa xuất: để ở trạng thái chuẩn bị, người dùng tự chốt.
  if (batch.submitted_at || batch.finalized_at || batch.exported_at) return 'submitted';
  if (submissionDate && submissionDate < todayInVietnam()) return 'submitted';
  return 'preparing';
}

function normalizeBatch(batch = {}, fallbackDate = '') {
  const submissionDate = normalizeDate(batch.submission_date || batch.date || fallbackDate);
  const rawItems = Array.isArray(batch.items) ? batch.items : Object.values(batch.items || {});
  const items = rawItems.map(normalizeItem);
  const status = inferLegacyBatchStatus(batch, submissionDate);
  const visibleCount = items.filter(item => item.status !== 'removed').length;
  return {
    id: cleanText(batch.id, 100) || submissionDate,
    submission_date: submissionDate,
    status,
    created_at: batch.created_at || nowIso(),
    updated_at: batch.updated_at || batch.created_at || nowIso(),
    submitted_at: batch.submitted_at || batch.finalized_at || (status === 'submitted' ? batch.exported_at || null : null),
    submitted_count: Number(batch.submitted_count || batch.finalized_count || (status === 'submitted' ? visibleCount : 0)) || 0,
    submitted_note: cleanText(batch.submitted_note || batch.finalized_note, 1000),
    exported_at: batch.exported_at || null,
    export_count: Number(batch.export_count || 0) || 0,
    items,
  };
}

function normalizeStore(raw) {
  const store = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : emptyStore();
  const batches = {};
  for (const [key, value] of Object.entries(store.batches || {})) {
    const batch = normalizeBatch(value, key);
    if (batch.submission_date) batches[batch.submission_date] = batch;
  }
  return {
    version: STORE_VERSION,
    updated_at: store.updated_at || null,
    batches,
    events: Array.isArray(store.events) ? store.events.filter(Boolean).slice(-20000) : [],
  };
}

function storePath(recordsDir) {
  return path.join(recordsDir, 'records_check_submissions.json');
}

function readStore(recordsDir) {
  return normalizeStore(readJsonSafe(storePath(recordsDir), null));
}

function writeStore(recordsDir, input) {
  const store = normalizeStore(input);
  store.updated_at = nowIso();
  writeJsonAtomic(storePath(recordsDir), store);
  return store;
}

function aliasesIntersect(left, right) {
  const set = new Set(normalizeAliases(left));
  return normalizeAliases(right).some(alias => set.has(alias));
}

function appendEvent(store, event) {
  store.events = Array.isArray(store.events) ? store.events : [];
  store.events.push({
    id: `evt_${crypto.randomUUID()}`,
    at: nowIso(),
    ...event,
  });
  if (store.events.length > 20000) store.events = store.events.slice(-20000);
}

function allItems(store) {
  const out = [];
  for (const batch of Object.values(store.batches || {})) {
    for (const item of batch.items || []) out.push({ batch, item });
  }
  return out;
}

function activeAttemptFor(store, aliases) {
  return allItems(store).find(({ item }) => item.status === 'active' && aliasesIntersect(item.aliases, aliases)) || null;
}

function latestReturnedAttemptFor(store, aliases) {
  return allItems(store)
    .filter(({ item }) => item.status === 'returned' && aliasesIntersect(item.aliases, aliases))
    .sort((a, b) => String(b.item.returned_at || b.item.added_at).localeCompare(String(a.item.returned_at || a.item.added_at)))[0] || null;
}

function effectiveItemStatus(item, batch) {
  if (item.status === 'returned') return 'returned';
  if (item.status === 'removed') return 'removed';
  return batch.status === 'submitted' ? 'submitted' : 'preparing';
}

function canAddToBatch(batch) {
  return Boolean(batch && batch.status === 'preparing');
}

function canRemoveFromBatch(batch) {
  return Boolean(batch && batch.status === 'preparing');
}

function canSubmitBatch(batch) {
  return Boolean(batch && batch.status === 'preparing' && (batch.items || []).some(item => item.status === 'active'));
}

function canMarkReturned(batch) {
  return Boolean(batch && batch.status === 'submitted');
}

function buildDashboard(recordsDir) {
  const store = readStore(recordsDir);
  const today = todayInVietnam();
  const batches = Object.values(store.batches || {})
    .map(batch => {
      const items = (batch.items || []).map(item => ({
        ...item,
        effective_status: effectiveItemStatus(item, batch),
      }));
      const visible = items.filter(item => item.status !== 'removed');
      return {
        ...batch,
        batch_status: batch.status,
        items,
        locked: batch.status === 'submitted',
        can_add: canAddToBatch(batch),
        can_remove: canRemoveFromBatch(batch),
        can_submit: canSubmitBatch(batch),
        can_mark_returned: canMarkReturned(batch),
        counts: {
          total: visible.length,
          preparing: visible.filter(item => item.effective_status === 'preparing').length,
          scheduled: visible.filter(item => item.effective_status === 'preparing').length,
          submitted: visible.filter(item => item.effective_status === 'submitted').length,
          returned: visible.filter(item => item.effective_status === 'returned').length,
          removed: items.filter(item => item.effective_status === 'removed').length,
        },
      };
    })
    .sort((a, b) => b.submission_date.localeCompare(a.submission_date));

  const activeAliases = [];
  for (const batch of batches) {
    for (const item of batch.items) {
      if (item.status === 'active') activeAliases.push(...item.aliases);
    }
  }

  return {
    status: 'ok',
    version: STORE_VERSION,
    today,
    updated_at: store.updated_at,
    batches,
    active_aliases: normalizeAliases(activeAliases),
    events: [...store.events].sort((a, b) => String(b.at || '').localeCompare(String(a.at || ''))).slice(0, 2000),
  };
}

function addRecords(recordsDir, submissionDateInput, records, checkedAliases = []) {
  const submissionDate = normalizeDate(submissionDateInput);
  if (!submissionDate) throw new Error('Ngày nộp hồ sơ không hợp lệ.');
  const list = Array.isArray(records) ? records : [];
  if (!list.length) throw new Error('Chưa chọn hồ sơ để thêm vào ngày nộp.');

  const checkedSet = new Set(normalizeAliases(checkedAliases));
  const store = readStore(recordsDir);
  const existingBatch = store.batches[submissionDate];
  if (existingBatch && !canAddToBatch(existingBatch)) {
    throw new Error(`Đợt nộp ngày ${submissionDate} đã chốt. Hãy chọn ngày khác để nộp các hồ sơ mới.`);
  }
  const batch = existingBatch || normalizeBatch({
    id: submissionDate,
    submission_date: submissionDate,
    status: 'preparing',
    items: [],
  }, submissionDate);
  store.batches[submissionDate] = batch;
  const added = [];
  const skipped = [];

  for (const raw of list) {
    if (!raw || typeof raw !== 'object') continue;
    const recordId = cleanText(raw.record_id || raw.case_key, 500);
    const aliases = normalizeAliases([recordId, ...(raw.aliases || []), ...(raw.source_case_keys || [])]);
    if (!recordId || !aliases.length) {
      skipped.push({ record_id: recordId, reason: 'invalid' });
      continue;
    }
    if (!aliases.some(alias => checkedSet.has(alias))) {
      skipped.push({ record_id: recordId, reason: 'not_checked' });
      continue;
    }
    const active = activeAttemptFor(store, aliases);
    if (active) {
      skipped.push({ record_id: recordId, reason: 'already_active', submission_date: active.batch.submission_date });
      continue;
    }
    const previous = latestReturnedAttemptFor(store, aliases);
    const item = normalizeItem({
      id: `item_${crypto.randomUUID()}`,
      record_id: recordId,
      aliases,
      status: 'active',
      added_at: nowIso(),
      previous_attempt_id: previous?.item?.id || '',
      previous_submission_date: previous?.batch?.submission_date || '',
      snapshot: raw.snapshot || raw,
    });
    batch.items.push(item);
    added.push(item);
    appendEvent(store, {
      type: previous ? 'resubmitted' : 'added',
      batch_id: submissionDate,
      submission_date: submissionDate,
      item_id: item.id,
      record_id: item.record_id,
      snapshot: item.snapshot,
      previous_submission_date: item.previous_submission_date || '',
    });
  }

  batch.updated_at = nowIso();
  store.batches[submissionDate] = batch;
  writeStore(recordsDir, store);
  return { dashboard: buildDashboard(recordsDir), added, skipped };
}

function submitBatch(recordsDir, batchIdInput, note = '') {
  const batchId = normalizeDate(batchIdInput);
  if (!batchId) throw new Error('Ngày nộp hồ sơ không hợp lệ.');
  const store = readStore(recordsDir);
  const batch = store.batches[batchId];
  if (!batch) throw new Error('Không tìm thấy ngày nộp hồ sơ.');

  if (batch.status === 'submitted') {
    return {
      dashboard: buildDashboard(recordsDir),
      batch,
      count: Number(batch.submitted_count || 0),
      already_submitted: true,
    };
  }

  const activeItems = (batch.items || []).filter(item => item.status === 'active');
  if (!activeItems.length) throw new Error('Ngày nộp này chưa có hồ sơ để chốt.');

  batch.status = 'submitted';
  batch.submitted_at = nowIso();
  batch.submitted_count = activeItems.length;
  batch.submitted_note = cleanText(note, 1000);
  batch.updated_at = batch.submitted_at;
  appendEvent(store, {
    type: 'submitted',
    batch_id: batchId,
    submission_date: batchId,
    count: activeItems.length,
    note: batch.submitted_note,
  });
  writeStore(recordsDir, store);
  const saved = readStore(recordsDir);
  return {
    dashboard: buildDashboard(recordsDir),
    batch: saved.batches[batchId],
    count: activeItems.length,
    already_submitted: false,
  };
}

function markReturned(recordsDir, batchIdInput, itemIds, note = '') {
  const batchId = normalizeDate(batchIdInput);
  const ids = new Set(normalizeAliases(itemIds));
  if (!batchId || !ids.size) throw new Error('Chưa chọn hồ sơ bị trả về.');
  const store = readStore(recordsDir);
  const batch = store.batches[batchId];
  if (!batch) throw new Error('Không tìm thấy ngày nộp hồ sơ.');
  if (!canMarkReturned(batch)) throw new Error('Chỉ đợt đã chốt nộp mới được đánh dấu hồ sơ bị trả về.');

  const changed = [];
  for (const item of batch.items || []) {
    if (!ids.has(item.id) || item.status !== 'active') continue;
    item.status = 'returned';
    item.returned_at = nowIso();
    item.return_note = cleanText(note, 1000);
    changed.push(item);
    appendEvent(store, {
      type: 'returned',
      batch_id: batchId,
      submission_date: batchId,
      item_id: item.id,
      record_id: item.record_id,
      snapshot: item.snapshot,
      note: item.return_note,
    });
  }
  if (!changed.length) throw new Error('Không có hồ sơ hợp lệ để đánh dấu trả về.');
  batch.updated_at = nowIso();
  writeStore(recordsDir, store);
  return { dashboard: buildDashboard(recordsDir), changed };
}

function removeItems(recordsDir, batchIdInput, itemIds) {
  const batchId = normalizeDate(batchIdInput);
  const ids = new Set(normalizeAliases(itemIds));
  if (!batchId || !ids.size) throw new Error('Chưa chọn hồ sơ cần bỏ khỏi đợt nộp.');
  const store = readStore(recordsDir);
  const batch = store.batches[batchId];
  if (!batch) throw new Error('Không tìm thấy ngày nộp hồ sơ.');
  if (!canRemoveFromBatch(batch)) throw new Error('Đợt nộp đã chốt. Chỉ hồ sơ bị trả về mới được đưa sang ngày nộp khác.');

  const changed = [];
  for (const item of batch.items || []) {
    if (!ids.has(item.id) || item.status !== 'active') continue;
    item.status = 'removed';
    item.removed_at = nowIso();
    changed.push(item);
    appendEvent(store, {
      type: 'removed',
      batch_id: batchId,
      submission_date: batchId,
      item_id: item.id,
      record_id: item.record_id,
      snapshot: item.snapshot,
    });
  }
  if (!changed.length) throw new Error('Không có hồ sơ hợp lệ để bỏ khỏi đợt nộp.');
  batch.updated_at = nowIso();
  writeStore(recordsDir, store);
  return { dashboard: buildDashboard(recordsDir), changed };
}

function updateBatchForExport(recordsDir, batchIdInput, rows = []) {
  const batchId = normalizeDate(batchIdInput);
  const store = readStore(recordsDir);
  const batch = store.batches[batchId];
  if (!batch) throw new Error('Không tìm thấy ngày nộp hồ sơ.');

  const normalizedRows = (Array.isArray(rows) ? rows : [])
    .filter(row => row && typeof row === 'object')
    .map(row => ({
      record_id: cleanText(row.record_id || row.case_key, 500),
      aliases: normalizeAliases([row.record_id, row.case_key, ...(row.aliases || []), ...(row.source_case_keys || [])]),
      snapshot: normalizeSnapshot(row.snapshot || row),
    }));

  for (const item of batch.items || []) {
    if (item.status === 'removed') continue;
    const current = normalizedRows.find(row => row.record_id === item.record_id || aliasesIntersect(row.aliases, item.aliases));
    if (current) {
      item.aliases = normalizeAliases([...item.aliases, ...current.aliases]);
      item.snapshot = mergeSnapshotMissingFields(item.snapshot, current.snapshot);
    }
  }

  batch.updated_at = nowIso();
  writeStore(recordsDir, store);
  const saved = readStore(recordsDir);
  return { store: saved, batch: saved.batches[batchId] };
}

function markBatchExported(recordsDir, batchIdInput, fileName = '') {
  const batchId = normalizeDate(batchIdInput);
  const store = readStore(recordsDir);
  const batch = store.batches[batchId];
  if (!batch) throw new Error('Không tìm thấy ngày nộp hồ sơ.');
  batch.exported_at = nowIso();
  batch.export_count = Number(batch.export_count || 0) + 1;
  batch.updated_at = nowIso();
  appendEvent(store, {
    type: 'exported',
    batch_id: batchId,
    submission_date: batchId,
    count: (batch.items || []).filter(item => item.status !== 'removed').length,
    file_name: cleanText(fileName, 300),
  });
  writeStore(recordsDir, store);
  return buildDashboard(recordsDir);
}

module.exports = {
  TIME_ZONE,
  todayInVietnam,
  normalizeDate,
  normalizeAliases,
  normalizeSnapshot,
  mergeSnapshotMissingFields,
  aliasesIntersect,
  readStore,
  writeStore,
  buildDashboard,
  addRecords,
  submitBatch,
  markReturned,
  removeItems,
  updateBatchForExport,
  markBatchExported,
};
