// server/utils/done_state.js — done-state with content fingerprint.
'use strict';

const crypto = require('crypto');
const { readJsonSafe, writeJsonAtomic } = require('./file');
const { normalizeDmy, dmyToIso } = require('./validation');

function stable(value) {
  if (value == null) return null;
  if (Array.isArray(value)) return value.map(stable);
  if (typeof value === 'object') {
    const out = {};
    for (const k of Object.keys(value).sort()) {
      const v = value[k];
      if (typeof v === 'undefined') continue;
      out[k] = stable(v);
    }
    return out;
  }
  return value;
}

function hashValue(value) {
  return crypto.createHash('sha1').update(JSON.stringify(stable(value))).digest('hex').slice(0, 16);
}

function baseDoneKey(key) {
  const parts = String(key || '').split('::');
  return parts.length >= 2 ? `${parts[0]}::${parts[1]}` : String(key || '').trim();
}

function keyAliases(rawKey) {
  const key = String(rawKey || '').trim();
  if (!key) return [];
  const parts = key.split('::');
  if (parts.length < 2) return [key];
  const [id, date, ...rest] = parts;
  const dmy = normalizeDmy(date);
  const iso = dmyToIso(date);
  const suffix = rest.length ? `::${rest.join('::')}` : '';
  const out = [];
  if (iso) out.push(`${id}::${iso}${suffix}`);
  if (dmy) out.push(`${id}::${dmy}${suffix}`);
  out.push(key);
  return [...new Set(out.filter(Boolean))];
}


function normalizeDoneState(raw) {
  const items = {};
  if (Array.isArray(raw)) {
    for (const key of raw) {
      const k = String(key || '').trim();
      if (!k) continue;
      for (const alias of keyAliases(k)) {
        if (!items[alias]) items[alias] = { status: 'done', done_at: '', content_hash: '', legacy: true };
      }
    }
    return { version: 1, items };
  }
  if (raw && typeof raw === 'object') {
    const src = raw.items && typeof raw.items === 'object' ? raw.items : raw;
    for (const [key, val] of Object.entries(src)) {
      const k = String(key || '').trim();
      if (!k) continue;
      let normalizedItem = null;
      if (val && typeof val === 'object' && !Array.isArray(val)) {
        normalizedItem = {
          status: String(val.status || 'done'),
          done_at: String(val.done_at || val.updated_at || ''),
          content_hash: String(val.content_hash || val.hash || ''),
          job_count: Number.isFinite(Number(val.job_count)) ? Number(val.job_count) : undefined,
          note: String(val.note || ''),
        };
      } else if (val) {
        normalizedItem = { status: 'done', done_at: '', content_hash: '', legacy: true };
      }
      if (normalizedItem) {
        for (const alias of keyAliases(k)) {
          if (!items[alias]) items[alias] = normalizedItem;
        }
      }
    }
  }
  return { version: 2, items };
}

function readDoneState(filePath) {
  return normalizeDoneState(readJsonSafe(filePath, {}));
}

function getDoneInfo(doneState, key, currentHash = '') {
  const state = normalizeDoneState(doneState);
  const k = String(key || '').trim();
  const item = (state.items || {})[k];
  if (!item || item.status !== 'done') {
    return { done: false, stale: false, legacy: false, item: null };
  }
  const savedHash = String(item.content_hash || '');
  const hash = String(currentHash || '');
  const stale = Boolean(savedHash && hash && savedHash !== hash);
  return {
    done: !stale,
    stale,
    legacy: Boolean(item.legacy || !savedHash),
    item,
  };
}

function markDoneKeys(filePath, keys, hashByKey = {}, extra = {}) {
  const state = readDoneState(filePath);
  const now = new Date().toISOString();
  const items = { ...(state.items || {}) };
  for (const rawKey of keys || []) {
    const key = String(rawKey || '').trim();
    if (!key) continue;
    const baseKey = baseDoneKey(key);
    const aliases = keyAliases(key);
    const primaryKey = aliases[0] || key;
    const contentHash = String(hashByKey[primaryKey] || hashByKey[key] || hashByKey[baseKey] || '');
    items[primaryKey] = {
      status: 'done',
      done_at: now,
      content_hash: contentHash,
      ...(extra && typeof extra === 'object' ? extra : {}),
    };
  }
  writeJsonAtomic(filePath, { version: 2, updated_at: now, items });
}

function pickTaskPayload(row, taskType) {
  const r = row || {};
  const thuoc = r.thuoc || {};
  const common = {
    ma_bn: r.ma_bn || '',
    ngay_lam: r.ngay_lam || '',
    care_mode: r.care_mode || '',
    care_special_events: r.care_special_events || [],
    ngay_ra_vien: r.ngay_ra_vien || '',
    gio_ra_vien: r.gio_ra_vien || '',
    ngay_ra_vien_date: r.ngay_ra_vien_date || '',
    ra_vien_hom_nay: Boolean(r.ra_vien_hom_nay),
    surgery_out: Boolean(r.surgery_out),
    surgery_out_time: r.surgery_out_time || '',
    surgery_out_reason: r.surgery_out_reason || '',
    y_lenh_khac: r.y_lenh_khac || {},
    processing_warnings: r.processing_warnings || [],
    unparsed_orders: r.unparsed_orders || [],
  };
  if (taskType === 'infusions') {
    return { ...common, dich_truyen: thuoc.dich_truyen || [], rule_log: r.rule_log || {} };
  }
  if (taskType === 'procedures') {
    return { ...common, chi_dinh_khac: r.chi_dinh_khac || {}, chi_dinh_dvkt: r.chi_dinh_dvkt || [] };
  }
  if (taskType === 'vtyt') {
    return {
      ...common,
      thuoc: {
        dich_truyen: thuoc.dich_truyen || [],
        thuoc_tiem: thuoc.thuoc_tiem || [],
        khac: thuoc.khac || [],
      },
      chi_dinh_khac: r.chi_dinh_khac || {},
      chi_dinh_dvkt: r.chi_dinh_dvkt || [],
      chan_doan: r.chan_doan || '',
      tuoi: r.tuoi || r.age || '',
    };
  }
  return {
    ...common,
    tong_hop_gio_dung: r.tong_hop_gio_dung || [],
    chi_dinh_khac: r.chi_dinh_khac || {},
    chi_dinh_dvkt: r.chi_dinh_dvkt || [],
    thuoc: {
      dich_truyen: thuoc.dich_truyen || [],
      thuoc_tiem: thuoc.thuoc_tiem || [],
      thuoc_uong: thuoc.thuoc_uong || [],
      khac: thuoc.khac || [],
    },
    nhap_cham_soc: r.nhap_cham_soc || {},
  };
}

function fingerprintRecords(records, taskType = 'care') {
  const rows = Array.isArray(records) ? records : [];
  return hashValue(rows.map(r => pickTaskPayload(r, taskType)));
}

module.exports = {
  stable,
  hashValue,
  baseDoneKey,
  keyAliases,
  normalizeDoneState,
  readDoneState,
  getDoneInfo,
  markDoneKeys,
  fingerprintRecords,
};
