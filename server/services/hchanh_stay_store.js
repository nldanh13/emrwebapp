// server/services/hchanh_stay_store.js — kho dùng chung các đợt nằm viện đã lấy dữ liệu hành chánh.
//
// Mỗi lần tab Hành chánh / Kiểm hồ sơ lấy dữ liệu từ EMR, kết quả từng file (thông tin nền, ra viện,
// phẫu thuật, y lệnh, …) được góp vào đây theo mã BN + đợt nằm viện. Kho nghiên cứu (lấy hành chánh
// tự động) tra kho này trước khi mở EMR: đợt nào đã có đủ file thì dùng lại, không quét lại.
//
// Vị trí: <RESEARCH_STORE_DIR>/hchanh_stays/<mã BN>.json
// { ma_bn, updated_at, stays: [{ from, to, updated_at, sources: [...], files: { key: { data, status, fetched_at, source, tier } } }] }
//
// Mức tin cậy (tier) của từng file:
//   'goc'      — Kho nghiên cứu tự quét (dữ liệu gốc). Luôn được ưu tiên.
//   'tam_thoi' — tab Hành chánh / Kiểm hồ sơ quét khi người bệnh đang điều trị hoặc mới ra viện.
//                Chỉ dùng khi chưa có dữ liệu gốc và không bao giờ ghi đè lên dữ liệu gốc.

'use strict';

const fs = require('fs');
const path = require('path');
const { RESEARCH_STORE_DIR } = require('../constants');
const { writeJsonAtomic, readJsonSafe } = require('../utils/file');

const OK_STATUSES = new Set(['ok', 'done', 'success', 'partial', 'empty']);
const TIER_GOC = 'goc';
const TIER_TAM_THOI = 'tam_thoi';
const tierOf = source => (source === 'kho_nghien_cuu' ? TIER_GOC : TIER_TAM_THOI);
const STAY_FILES = ['profile', 'discharge', 'surgery', 'order_history', 'bed_days', 'billing', 'cls'];

function storeDir() {
  const dir = path.join(RESEARCH_STORE_DIR, 'hchanh_stays');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function storePath(maBn) {
  const safe = String(maBn || '').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80);
  return path.join(storeDir(), `${safe}.json`);
}

// "13:00 28/09/2026", "28/09/2026", "2026-09-28" → "2026-09-28"
function isoDay(value) {
  const s = String(value || '');
  let m = s.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  m = s.match(/(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : '';
}

function addDays(iso, days) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function fileStatus(data) {
  if (!data || typeof data !== 'object') return 'missing';
  return String(data._fetch_status || data.status || 'ok').toLowerCase();
}

// Đợt nằm viện suy từ dữ liệu: ra = ngày ra viện; vào = ngày vào (hồ sơ) hoặc ra − tổng số ngày điều trị + 1.
function stayRange(files, admissionHint = '') {
  const discharge = files.discharge || {};
  const profile = files.profile || {};
  const to = isoDay(discharge.ngay_ra || discharge.raw_time);
  const candidates = [isoDay(profile.ngay_vao_vien || profile.ngay_vao), isoDay(admissionHint)].filter(Boolean);
  const totalDays = Number.parseInt(discharge.tong_so_ngay_dt, 10);
  if (to && Number.isFinite(totalDays) && totalDays > 0) candidates.push(addDays(to, -(totalDays - 1)));
  const from = candidates.sort()[0] || '';
  return { from, to };
}

function readStore(maBn) {
  const data = readJsonSafe(storePath(maBn), null);
  return data && Array.isArray(data.stays) ? data : { ma_bn: String(maBn || ''), stays: [] };
}

function overlaps(a, b) {
  if (!a.from || !b.from) return false;
  const aTo = a.to || a.from;
  const bTo = b.to || b.from;
  return a.from <= bTo && b.from <= aTo;
}

/**
 * Góp kết quả 1 lần lấy dữ liệu hành chánh vào kho.
 * @param {string} maBn
 * @param {object} output  { profile, discharge, surgery, order_history, ... } như worker hchanh_fetch.py trả về
 * @param {{ admission?: string, source?: string, now?: string }} opts
 * @returns {{ saved: boolean, from?: string, to?: string, files?: string[] }}
 */
function recordHchanhFetch(maBn, output, { admission = '', source = 'hanh_chanh', now = new Date().toISOString() } = {}) {
  const code = String(maBn || '').trim();
  if (!code || !output || typeof output !== 'object') return { saved: false };
  const incoming = {};
  for (const key of STAY_FILES) {
    const data = output[key];
    if (data && typeof data === 'object' && OK_STATUSES.has(fileStatus(data))) incoming[key] = data;
  }
  if (!Object.keys(incoming).length) return { saved: false };

  const store = readStore(code);
  let range = stayRange(incoming, admission);
  // Chưa có ngày ra (vd chỉ lấy thông tin nền): gắn vào đợt đang mở cùng ngày vào nếu có.
  let stay = store.stays.find(s => overlaps(s, range) || (range.from && s.from === range.from));
  if (!range.from && !range.to) return { saved: false };
  if (!stay) {
    stay = { from: range.from, to: range.to, files: {}, sources: [] };
    store.stays.push(stay);
  }
  const tier = tierOf(source);
  const written = [];
  for (const [key, data] of Object.entries(incoming)) {
    // Dữ liệu tạm thời (Hành chánh / Kiểm hồ sơ) không ghi đè dữ liệu gốc của Kho nghiên cứu.
    if (tier === TIER_TAM_THOI && stay.files[key]?.tier === TIER_GOC) continue;
    stay.files[key] = { data, status: fileStatus(data), fetched_at: now, source, tier };
    written.push(key);
  }
  if (!written.length) return { saved: false, from: stay.from, to: stay.to, files: [], kept_goc: true };
  range = stayRange(Object.fromEntries(Object.entries(stay.files).map(([k, v]) => [k, v.data])), admission || stay.from);
  stay.from = [stay.from, range.from].filter(Boolean).sort()[0] || '';
  stay.to = range.to || stay.to || '';
  stay.updated_at = now;
  if (!stay.sources.includes(source)) stay.sources.push(source);
  store.ma_bn = code;
  store.updated_at = now;
  store.stays.sort((a, b) => String(a.from).localeCompare(String(b.from)));
  writeJsonAtomic(storePath(code), store);
  return { saved: true, from: stay.from, to: stay.to, files: written };
}

/**
 * Tìm đợt nằm viện đã có đủ các file cần (Kho nghiên cứu dùng lại thay vì mở EMR).
 * Chỉ trả đợt đã có ngày ra (đã kết thúc) và ngày vào nghiên cứu nằm trong đợt.
 */
function findStoredStay(maBn, admissionIso, wantedFiles = [], { onlyGoc = false } = {}) {
  const code = String(maBn || '').trim();
  const day = isoDay(admissionIso) || String(admissionIso || '');
  if (!code || !day || !fs.existsSync(storePath(code))) return null;
  const store = readStore(code);
  for (const stay of store.stays) {
    if (!stay.to || !stay.from || day < stay.from || day > stay.to) continue;
    // onlyGoc: đang quét lại để thay dữ liệu tạm thời → chỉ tính file gốc của Kho nghiên cứu.
    const files = Object.fromEntries(Object.entries(stay.files || {}).filter(([, v]) => !onlyGoc || v.tier === TIER_GOC));
    if (!Object.keys(files).length) continue;
    if (!wantedFiles.every(key => files[key])) continue;
    const output = Object.fromEntries(Object.entries(files).map(([k, v]) => [k, v.data]));
    const used = wantedFiles.length ? wantedFiles : Object.keys(files);
    const provisional = used.filter(k => (files[k]?.tier || TIER_TAM_THOI) !== TIER_GOC);
    return {
      from: stay.from, to: stay.to, output,
      sourceKey: provisional.length ? `kho_hanh_chanh:${stay.sources.join('+')}` : 'kho_nghien_cuu_goc',
      updated_at: stay.updated_at,
      // File nào đang là dữ liệu tạm thời (Hành chánh / Kiểm hồ sơ) — lần quét lại của Kho nghiên cứu sẽ thay.
      provisional_files: provisional,
      tiers: Object.fromEntries(Object.entries(files).map(([k, v]) => [k, v.tier || TIER_TAM_THOI])),
    };
  }
  return null;
}

function storeSummary() {
  const dir = storeDir();
  let patients = 0;
  let stays = 0;
  let closed = 0;
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith('.json')) continue;
    const data = readJsonSafe(path.join(dir, name), null);
    if (!data || !Array.isArray(data.stays)) continue;
    patients += 1;
    stays += data.stays.length;
    closed += data.stays.filter(s => s.to).length;
  }
  return { dir, patients, stays, closed_stays: closed };
}

module.exports = { recordHchanhFetch, findStoredStay, storeSummary, stayRange, isoDay, STAY_FILES, TIER_GOC, TIER_TAM_THOI };
