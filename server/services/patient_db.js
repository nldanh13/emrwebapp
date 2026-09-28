// server/services/patient_db.js — Kho người bệnh: 1 file SQLite gom mọi lượt khám / nằm viện.
//
// Vị trí: <RUNTIME_ROOT>/kho_benh_nhan/kho.sqlite3 (đổi bằng EMR_PATIENT_DB_PATH).
//
// Hai tầng:
//   1. lan_quet  — dữ liệu thô: mỗi dòng là 1 file lấy từ 1 màn hình EMR trong 1 lần quét,
//                  giữ nguyên văn, KHÔNG bao giờ sửa hay xoá. Nội dung trùng (cùng hash) không lưu lại.
//   2. benh_nhan, luot, chan_doan, dich_vu, thao_tac — dữ liệu chuẩn hoá, luôn dựng lại được
//                  từ tầng 1 theo quy tắc: dữ liệu GỐC thắng dữ liệu TẠM THỜI; cùng mức thì bản mới hơn.
//
// Mức tin cậy:
//   'goc'      — lượt đã kết thúc và được quét để chốt (Kho nghiên cứu; lượt khám đã Hoàn tất).
//   'tam_thoi' — quét lúc người bệnh còn đang điều trị (Hành chánh, Kiểm hồ sơ, Phòng khám đang theo dõi).
//
// Chỉ tiến trình máy chủ Node ghi vào kho (worker Python trả JSON như cũ) nên không có 2 nơi cùng ghi.
// Cần Node.js >= 22.13 (có sẵn node:sqlite). Máy chạy Node cũ hơn: kho tắt, phần còn lại vẫn chạy bình thường.

'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { RUNTIME_ROOT } = require('../constants');

const SCHEMA_VERSION = 2;
// Tái khám đúng hẹn: lệch tối đa ±3 ngày so với ngày hẹn. Tái nhập viện: trong 30 ngày sau ra viện.
const HEN_LECH_TOI_DA = 3;
const TAI_NHAP_VIEN_NGAY = 30;
const KHAM_NHAP_VIEN_NGAY = 2;
const TIER_GOC = 'goc';
const TIER_TAM_THOI = 'tam_thoi';
const LOAI_KHAM = 'kham';
const LOAI_NOI_TRU = 'noi_tru';

let sqlite = null;
let sqliteError = '';
try {
  // node:sqlite in cảnh báo "experimental" mỗi lần nạp; chỉ nuốt đúng cảnh báo đó.
  const emit = process.emitWarning;
  process.emitWarning = function (warning, ...rest) {
    if (/SQLite is an experimental feature/.test(String(warning?.message || warning))) return undefined;
    return emit.call(process, warning, ...rest);
  };
  try {
    sqlite = require('node:sqlite');
  } finally {
    process.emitWarning = emit;
  }
} catch (err) {
  sqliteError = `Kho người bệnh cần Node.js 22.13 trở lên (đang chạy ${process.version}).`;
}

let db = null;
let dbPath = '';

function defaultDbPath() {
  const custom = String(process.env.EMR_PATIENT_DB_PATH || '').trim();
  return custom ? path.resolve(custom) : path.join(RUNTIME_ROOT, 'kho_benh_nhan', 'kho.sqlite3');
}

function available() {
  return Boolean(sqlite);
}

function unavailableReason() {
  return sqliteError;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);

CREATE TABLE IF NOT EXISTS benh_nhan (
  ma_bn TEXT PRIMARY KEY,
  ho_ten TEXT, ho_ten_khong_dau TEXT, nam_sinh TEXT, ngay_sinh TEXT, gioi_tinh TEXT,
  dia_chi TEXT, sdt TEXT, the_bhyt TEXT,
  tao_luc TEXT, cap_nhat_luc TEXT
);

-- 1 lượt = 1 lần tiếp xúc: 'kham' (Danh sách Khám bệnh) hoặc 'noi_tru' (đợt nằm viện).
CREATE TABLE IF NOT EXISTS luot (
  id INTEGER PRIMARY KEY,
  ma_bn TEXT NOT NULL,
  loai TEXT NOT NULL,
  khoa_emr TEXT UNIQUE,            -- 'kb:<khambenhid>' cho lượt khám; nội trú ghép theo khoảng ngày
  khoa TEXT, gio_vao TEXT, gio_ra TEXT,
  trang_thai TEXT,                 -- 'dang_dieu_tri' | 'da_ket_thuc'
  trang_thai_emr TEXT, xu_tri TEXT, co_bhyt INTEGER, doi_tuong TEXT, ly_do TEXT,
  chan_doan_chinh TEXT, icd_chinh TEXT, hen_tai_kham TEXT,
  muc TEXT, nguon TEXT,
  tao_luc TEXT, cap_nhat_luc TEXT
);
CREATE INDEX IF NOT EXISTS luot_bn_vao ON luot(ma_bn, gio_vao);
CREATE INDEX IF NOT EXISTS luot_vao ON luot(gio_vao);
CREATE INDEX IF NOT EXISTS luot_loai_vao ON luot(loai, gio_vao);

CREATE TABLE IF NOT EXISTS lan_quet (
  id INTEGER PRIMARY KEY,
  ma_bn TEXT NOT NULL,
  luot_id INTEGER,
  loai TEXT NOT NULL,              -- profile, discharge, cls, kham_danh_sach, kham_chi_tiet, ...
  nguon TEXT NOT NULL,             -- kho_nghien_cuu, hanh_chanh, kiem_ho_so, phong_kham
  muc TEXT NOT NULL,               -- goc | tam_thoi
  lay_luc TEXT NOT NULL,
  trang_thai TEXT,
  hash TEXT NOT NULL,
  du_lieu TEXT NOT NULL,
  UNIQUE (luot_id, loai, nguon, muc, hash)
);
CREATE INDEX IF NOT EXISTS lan_quet_luot ON lan_quet(luot_id, loai, lay_luc);
CREATE INDEX IF NOT EXISTS lan_quet_bn ON lan_quet(ma_bn);

CREATE TABLE IF NOT EXISTS chan_doan (
  id INTEGER PRIMARY KEY,
  luot_id INTEGER NOT NULL,
  loai TEXT,                       -- chinh | kem | vao | ra
  icd TEXT, ten TEXT,
  lan_quet_id INTEGER
);
CREATE INDEX IF NOT EXISTS chan_doan_luot ON chan_doan(luot_id);
CREATE INDEX IF NOT EXISTS chan_doan_icd ON chan_doan(icd);

CREATE TABLE IF NOT EXISTS dich_vu (
  id INTEGER PRIMARY KEY,
  luot_id INTEGER NOT NULL,
  nhom TEXT, ma TEXT, ten TEXT, thoi_gian TEXT,
  so_da_xong INTEGER, so_chi_dinh INTEGER, trang_thai TEXT,
  lan_quet_id INTEGER
);
CREATE INDEX IF NOT EXISTS dich_vu_luot ON dich_vu(luot_id);

-- Việc hệ thống đã làm trên EMR (hoàn tất khám, lập SBBHC, điều trị ngoại trú, ...).
CREATE TABLE IF NOT EXISTS thao_tac (
  id INTEGER PRIMARY KEY,
  luot_id INTEGER, ma_bn TEXT,
  loai TEXT, ket_qua TEXT, thong_diep TEXT, cac_buoc TEXT, luc TEXT,
  hash TEXT UNIQUE
);
CREATE INDEX IF NOT EXISTS thao_tac_luot ON thao_tac(luot_id);

-- Nối 2 lượt của cùng người bệnh (tính lại từ bảng luot, không nhập tay):
--   tai_kham_dung_hen / tai_kham_tre_hen — lượt sau ứng với ngày hẹn của lượt trước
--   tai_nhap_vien_30  — nhập viện lại trong 30 ngày sau ra viện
--   kham_nhap_vien    — lượt khám có xử trí Nhập viện → đợt nội trú bắt đầu trong 2 ngày
CREATE TABLE IF NOT EXISTS lien_ket_luot (
  id INTEGER PRIMARY KEY,
  ma_bn TEXT NOT NULL,
  luot_truoc INTEGER NOT NULL,
  luot_sau INTEGER NOT NULL,
  loai TEXT NOT NULL,
  so_ngay INTEGER,                 -- từ ngày kết thúc lượt trước đến ngày bắt đầu lượt sau
  ngay_hen TEXT,
  lech_hen INTEGER                 -- ngày quay lại − ngày hẹn (âm = sớm, dương = trễ)
);
CREATE INDEX IF NOT EXISTS lien_ket_bn ON lien_ket_luot(ma_bn);
CREATE INDEX IF NOT EXISTS lien_ket_truoc ON lien_ket_luot(luot_truoc, loai);
CREATE INDEX IF NOT EXISTS lien_ket_sau ON lien_ket_luot(luot_sau);
CREATE INDEX IF NOT EXISTS luot_hen ON luot(hen_tai_kham);
CREATE INDEX IF NOT EXISTS luot_ra ON luot(loai, gio_ra);
`;

function open() {
  if (!sqlite) throw new Error(sqliteError);
  const wanted = defaultDbPath();
  if (db && dbPath === wanted) return db;
  if (db) close();
  fs.mkdirSync(path.dirname(wanted), { recursive: true });
  db = new sqlite.DatabaseSync(wanted);
  dbPath = wanted;
  db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  const hadMeta = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'meta'").get();
  const previous = hadMeta ? Number(db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get()?.value) || 0 : SCHEMA_VERSION;
  db.exec(SCHEMA);
  db.prepare('INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)').run('schema_version', String(SCHEMA_VERSION));
  // Kho tạo từ bản trước chưa có bảng nối lượt: tính cho toàn bộ người bệnh 1 lần.
  if (previous < 2) rebuildAllLinks(db);
  return db;
}

function close() {
  if (db) {
    try { db.close(); } catch (_) {}
  }
  db = null;
  dbPath = '';
}

function tx(fn) {
  const conn = open();
  conn.exec('BEGIN IMMEDIATE');
  try {
    const out = fn(conn);
    conn.exec('COMMIT');
    return out;
  } catch (err) {
    try { conn.exec('ROLLBACK'); } catch (_) {}
    throw err;
  }
}

// ── Chuẩn hoá giá trị ─────────────────────────────────────────────────────────

const txt = v => (v == null ? '' : String(v).replace(/\s+/g, ' ').trim());

function stripMarks(value) {
  return txt(value).normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D').toLowerCase();
}

// "13:05 28/09/2026", "28/09/2026 13:05", "28/09/2026", "2026-09-28T13:05:00" → "2026-09-28 13:05" / "2026-09-28"
function isoTime(value) {
  const s = txt(value);
  if (!s) return '';
  let m = s.match(/(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?/);
  if (m) return m[4] ? `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}` : `${m[1]}-${m[2]}-${m[3]}`;
  m = s.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (!m) return '';
  const day = `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  const t = s.match(/(\d{1,2}):(\d{2})/);
  return t ? `${day} ${t[1].padStart(2, '0')}:${t[2]}` : day;
}

const dayOf = value => isoTime(value).slice(0, 10);

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value === undefined ? null : value);
}

// Hash bỏ qua các khoá kỹ thuật (_meta, thời điểm lấy) để 2 lần quét cùng nội dung chỉ lưu 1 bản.
function contentHash(data) {
  const clean = data && typeof data === 'object' && !Array.isArray(data)
    ? Object.fromEntries(Object.entries(data).filter(([k]) => !['_meta', 'fetched_at', '_fetched_at'].includes(k)))
    : data;
  return crypto.createHash('sha256').update(stableStringify(clean)).digest('hex');
}

function fileStatus(data) {
  if (!data || typeof data !== 'object') return '';
  return txt(data._fetch_status || data.status || 'ok').toLowerCase();
}

// ── Người bệnh ────────────────────────────────────────────────────────────────

const PATIENT_FIELDS = ['ho_ten', 'nam_sinh', 'ngay_sinh', 'gioi_tinh', 'dia_chi', 'sdt', 'the_bhyt'];

// Chỉ ghi đè trường đang trống hoặc khi nguồn mới là dữ liệu gốc: không để bản tạm thời xoá thông tin đã có.
function upsertPatient(conn, maBn, info = {}, { tier = TIER_TAM_THOI, now }) {
  const code = txt(maBn);
  if (!code) return;
  const current = conn.prepare('SELECT * FROM benh_nhan WHERE ma_bn = ?').get(code);
  const next = {};
  for (const key of PATIENT_FIELDS) {
    const incoming = txt(info[key]);
    const existing = current ? txt(current[key]) : '';
    next[key] = incoming && (!existing || tier === TIER_GOC) ? incoming : existing;
  }
  if (!next.nam_sinh) {
    const m = `${next.ngay_sinh} ${txt(info.tuoi)}`.match(/\b(19\d{2}|20\d{2})\b/);
    if (m) next.nam_sinh = m[1];
  }
  if (!current) {
    conn.prepare(`INSERT INTO benh_nhan (ma_bn, ho_ten, ho_ten_khong_dau, nam_sinh, ngay_sinh, gioi_tinh, dia_chi, sdt, the_bhyt, tao_luc, cap_nhat_luc)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(code, next.ho_ten, stripMarks(next.ho_ten), next.nam_sinh, next.ngay_sinh, next.gioi_tinh, next.dia_chi, next.sdt, next.the_bhyt, now, now);
    return;
  }
  if (PATIENT_FIELDS.every(k => next[k] === txt(current[k]))) return;
  conn.prepare(`UPDATE benh_nhan SET ho_ten = ?, ho_ten_khong_dau = ?, nam_sinh = ?, ngay_sinh = ?, gioi_tinh = ?, dia_chi = ?, sdt = ?, the_bhyt = ?, cap_nhat_luc = ?
    WHERE ma_bn = ?`)
    .run(next.ho_ten, stripMarks(next.ho_ten), next.nam_sinh, next.ngay_sinh, next.gioi_tinh, next.dia_chi, next.sdt, next.the_bhyt, now, code);
}

// ── Lượt ──────────────────────────────────────────────────────────────────────

// Lượt khám: theo mã khám bệnh EMR. Nội trú: đợt cùng mã BN có khoảng ngày giao nhau.
function findOrCreateLuot(conn, { maBn, loai, khoaEmr = '', from = '', to = '', now }) {
  if (khoaEmr) {
    const hit = conn.prepare('SELECT * FROM luot WHERE khoa_emr = ?').get(khoaEmr);
    if (hit) return hit;
  } else if (from) {
    const candidates = conn.prepare('SELECT * FROM luot WHERE ma_bn = ? AND loai = ? AND khoa_emr IS NULL').all(maBn, loai);
    const aFrom = from.slice(0, 10);
    const aTo = (to || from).slice(0, 10);
    const hit = candidates.find(l => {
      const bFrom = txt(l.gio_vao).slice(0, 10);
      if (!bFrom) return false;
      const bTo = txt(l.gio_ra || l.gio_vao).slice(0, 10);
      return aFrom <= bTo && bFrom <= aTo;
    });
    if (hit) return hit;
  } else {
    return null;
  }
  const res = conn.prepare(`INSERT INTO luot (ma_bn, loai, khoa_emr, gio_vao, gio_ra, trang_thai, tao_luc, cap_nhat_luc)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(maBn, loai, khoaEmr || null, from, to, to ? 'da_ket_thuc' : 'dang_dieu_tri', now, now);
  return conn.prepare('SELECT * FROM luot WHERE id = ?').get(Number(res.lastInsertRowid));
}

function insertScan(conn, { maBn, luotId, loai, nguon, muc, now, data }) {
  const hash = contentHash(data);
  const res = conn.prepare(`INSERT OR IGNORE INTO lan_quet (ma_bn, luot_id, loai, nguon, muc, lay_luc, trang_thai, hash, du_lieu)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(maBn, luotId, loai, nguon, muc, now, fileStatus(data), hash, JSON.stringify(data));
  return Number(res.changes) > 0;
}

// Bản tốt nhất của 1 loại dữ liệu trong 1 lượt: gốc trước, rồi bản mới nhất.
function bestScans(conn, luotId) {
  const rows = conn.prepare(`SELECT id, loai, nguon, muc, lay_luc, du_lieu FROM lan_quet WHERE luot_id = ?
    ORDER BY CASE muc WHEN 'goc' THEN 0 ELSE 1 END, lay_luc DESC, id DESC`).all(luotId);
  const out = {};
  for (const r of rows) {
    if (out[r.loai]) continue;
    let data = null;
    try { data = JSON.parse(r.du_lieu); } catch (_) {}
    out[r.loai] = { id: r.id, nguon: r.nguon, muc: r.muc, lay_luc: r.lay_luc, data };
  }
  return out;
}

function listText(value) {
  if (Array.isArray(value)) return value.map(v => (typeof v === 'object' && v ? txt(v.ten || v.name || v.text) : txt(v))).filter(Boolean);
  const s = txt(value);
  return s ? s.split(/\s*[;\n]\s*/).filter(Boolean) : [];
}

// "M51.1 - Thoát vị đĩa đệm" / "Thoát vị đĩa đệm (M51.1)" → { icd, ten }
function splitIcd(value, icdHint = '') {
  const s = txt(value);
  let icd = txt(icdHint).toUpperCase();
  let ten = s;
  const lead = s.match(/^([A-Z]\d{2}(?:\.\d{1,2})?)\s*[-–:]\s*(.+)$/i);
  const tail = s.match(/^(.+?)\s*[([]\s*([A-Z]\d{2}(?:\.\d{1,2})?)\s*[)\]]$/i);
  if (lead) { icd = icd || lead[1].toUpperCase(); ten = lead[2]; } else if (tail) { icd = icd || tail[2].toUpperCase(); ten = tail[1]; }
  return { icd, ten: txt(ten) };
}

// Dựng lại các cột tổng hợp của lượt + bảng con từ bản tốt nhất mỗi loại dữ liệu.
function rebuildLuot(conn, luotId, now) {
  const luot = conn.prepare('SELECT * FROM luot WHERE id = ?').get(luotId);
  if (!luot) return;
  const best = bestScans(conn, luotId);
  const d = k => best[k]?.data || {};
  const diagnoses = [];
  const services = [];
  const upd = {};

  if (luot.loai === LOAI_KHAM) {
    const row = d('kham_danh_sach');
    const det = d('kham_chi_tiet');
    const stage = txt(row.stage);
    Object.assign(upd, {
      khoa: txt(row.noi_thuc_hien),
      gio_vao: isoTime(row.thoi_gian) || luot.gio_vao,
      gio_ra: isoTime(det.thoi_gian_ra) || (stage === 'xong' ? luot.gio_ra : ''),
      trang_thai: stage === 'xong' ? 'da_ket_thuc' : 'dang_dieu_tri',
      trang_thai_emr: txt(row.trang_thai),
      xu_tri: txt(row.xu_tri),
      co_bhyt: row.has_bhyt ? 1 : 0,
      doi_tuong: txt(row.doi_tuong),
      ly_do: txt(det.ly_do || row.ly_do),
      hen_tai_kham: isoTime(det.hen_tai_kham),
    });
    const main = splitIcd(det.cd_chinh);
    upd.chan_doan_chinh = main.ten;
    upd.icd_chinh = main.icd;
    if (main.ten) diagnoses.push({ loai: 'chinh', ...main, scan: best.kham_chi_tiet });
    for (const extra of listText(det.cd_kem_theo)) diagnoses.push({ loai: 'kem', ...splitIcd(extra), scan: best.kham_chi_tiet });
    for (const s of Array.isArray(row.services) ? row.services : []) {
      services.push({ nhom: txt(s.code), ma: txt(s.code), ten: txt(s.label), so_da_xong: Number(s.done) || 0, so_chi_dinh: Number(s.total) || 0, scan: best.kham_danh_sach });
    }
    for (const o of Array.isArray(row.imaging_orders) ? row.imaging_orders : []) {
      services.push({ nhom: txt(o.kind), ma: '', ten: txt(o.name), thoi_gian: isoTime(o.time), scan: best.kham_danh_sach });
    }
  } else {
    const profile = d('profile');
    const discharge = d('discharge');
    const out = isoTime(discharge.raw_time) || isoTime([discharge.gio_ra, discharge.ngay_ra].filter(Boolean).join(' ')) || isoTime(discharge.ngay_ra);
    Object.assign(upd, {
      khoa: txt(profile.khoa || discharge.khoa),
      gio_vao: isoTime(profile.ngay_vao_vien || profile.ngay_vao) || luot.gio_vao,
      gio_ra: out || luot.gio_ra,
      trang_thai: (out || luot.gio_ra) ? 'da_ket_thuc' : 'dang_dieu_tri',
      trang_thai_emr: txt(discharge.tinh_trang_ra),
      xu_tri: txt(discharge.xu_tri),
      co_bhyt: txt(profile.bhyt_code) ? 1 : (profile.bhyt_code === undefined ? luot.co_bhyt : 0),
      doi_tuong: txt(profile.doi_tuong),
      ly_do: txt(discharge.ly_do_vao_vien),
      hen_tai_kham: isoTime(discharge.tg_hen_kham || discharge.hen_tai_kham),
    });
    const main = splitIcd(discharge.chan_doan_chinh || discharge.chan_doan_ra, discharge.chan_doan_chinh_icd);
    upd.chan_doan_chinh = main.ten;
    upd.icd_chinh = main.icd;
    if (main.ten) diagnoses.push({ loai: 'ra', ...main, scan: best.discharge });
    const vao = txt(discharge.chan_doan_vao || profile.chan_doan_vao);
    if (vao) diagnoses.push({ loai: 'vao', ...splitIcd(vao), scan: best.discharge || best.profile });
    for (const extra of listText(discharge.benh_kem)) diagnoses.push({ loai: 'kem', ...splitIcd(extra), scan: best.discharge });
    for (const r of Array.isArray(d('cls').results) ? d('cls').results : []) {
      services.push({ nhom: txt(r.nhom_dich_vu || r.loai), ma: '', ten: txt(r.ten_dv || r.name), thoi_gian: isoTime(r.tg_chi_dinh), trang_thai: txt(r.trang_thai), scan: best.cls });
    }
  }

  const tierScan = best.kham_danh_sach || best.discharge || best.profile || Object.values(best)[0];
  upd.muc = Object.values(best).some(s => s.muc === TIER_GOC) ? TIER_GOC : TIER_TAM_THOI;
  upd.nguon = [...new Set(Object.values(best).map(s => s.nguon))].sort().join('+') || (tierScan?.nguon || '');
  const cols = Object.keys(upd);
  conn.prepare(`UPDATE luot SET ${cols.map(c => `${c} = ?`).join(', ')}, cap_nhat_luc = ? WHERE id = ?`)
    .run(...cols.map(c => (upd[c] === undefined ? null : upd[c])), now, luotId);

  conn.prepare('DELETE FROM chan_doan WHERE luot_id = ?').run(luotId);
  const insDx = conn.prepare('INSERT INTO chan_doan (luot_id, loai, icd, ten, lan_quet_id) VALUES (?, ?, ?, ?, ?)');
  for (const dx of diagnoses) if (dx.ten || dx.icd) insDx.run(luotId, dx.loai, dx.icd, dx.ten, dx.scan?.id ?? null);

  conn.prepare('DELETE FROM dich_vu WHERE luot_id = ?').run(luotId);
  const insSv = conn.prepare(`INSERT INTO dich_vu (luot_id, nhom, ma, ten, thoi_gian, so_da_xong, so_chi_dinh, trang_thai, lan_quet_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  for (const s of services) {
    insSv.run(luotId, s.nhom || '', s.ma || '', s.ten || '', s.thoi_gian || '', s.so_da_xong ?? null, s.so_chi_dinh ?? null, s.trang_thai || '', s.scan?.id ?? null);
  }
}

// ── Nối lượt: tái khám, tái nhập viện, khám → nhập viện ─────────────────────

function daysBetween(fromDay, toDay) {
  const a = Date.parse(`${fromDay}T00:00:00Z`);
  const b = Date.parse(`${toDay}T00:00:00Z`);
  return Number.isFinite(a) && Number.isFinite(b) ? Math.round((b - a) / 86400000) : null;
}

function todayIso() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Tính lại mọi mối nối giữa các lượt của 1 người bệnh (gọi sau mỗi lần lượt thay đổi). */
function rebuildLinks(conn, maBn) {
  const code = txt(maBn);
  const visits = conn.prepare('SELECT id, loai, gio_vao, gio_ra, xu_tri, hen_tai_kham FROM luot WHERE ma_bn = ? ORDER BY gio_vao, id').all(code)
    .map(v => ({ ...v, start: dayOf(v.gio_vao), end: dayOf(v.gio_ra) || dayOf(v.gio_vao) }))
    .filter(v => v.start);
  conn.prepare('DELETE FROM lien_ket_luot WHERE ma_bn = ?').run(code);
  const ins = conn.prepare('INSERT INTO lien_ket_luot (ma_bn, luot_truoc, luot_sau, loai, so_ngay, ngay_hen, lech_hen) VALUES (?, ?, ?, ?, ?, ?, ?)');
  for (const a of visits) {
    const later = visits.filter(v => v.id !== a.id && v.start > a.end);

    // Tái khám: lượt sau gần ngày hẹn nhất trong ±3 ngày; không có thì lượt đầu tiên sau hạn (trễ hẹn).
    const hen = dayOf(a.hen_tai_kham);
    if (hen) {
      const inWindow = later
        .map(v => ({ v, lech: daysBetween(hen, v.start) }))
        .filter(x => x.lech !== null && Math.abs(x.lech) <= HEN_LECH_TOI_DA)
        .sort((x, y) => Math.abs(x.lech) - Math.abs(y.lech)
          // Cùng ngày: lượt khám mới là lượt tái khám, không phải đợt nội trú.
          || (x.v.loai === LOAI_KHAM ? 0 : 1) - (y.v.loai === LOAI_KHAM ? 0 : 1)
          || x.v.start.localeCompare(y.v.start))[0];
      const late = inWindow ? null : later
        .filter(v => (daysBetween(hen, v.start) ?? 0) > HEN_LECH_TOI_DA)
        .sort((x, y) => x.start.localeCompare(y.start) || (x.loai === LOAI_KHAM ? 0 : 1) - (y.loai === LOAI_KHAM ? 0 : 1))[0];
      const hit = inWindow ? inWindow.v : late;
      if (hit) {
        ins.run(code, a.id, hit.id, inWindow ? 'tai_kham_dung_hen' : 'tai_kham_tre_hen', daysBetween(a.end, hit.start), hen, daysBetween(hen, hit.start));
      }
    }

    // Tái nhập viện trong 30 ngày sau ra viện.
    if (a.loai === LOAI_NOI_TRU && dayOf(a.gio_ra)) {
      const next = later.find(v => v.loai === LOAI_NOI_TRU);
      const gap = next ? daysBetween(a.end, next.start) : null;
      if (next && gap !== null && gap <= TAI_NHAP_VIEN_NGAY) ins.run(code, a.id, next.id, 'tai_nhap_vien_30', gap, null, null);
    }

    // Khám có xử trí Nhập viện → đợt nội trú bắt đầu trong 2 ngày.
    if (a.loai === LOAI_KHAM && stripMarks(a.xu_tri).includes('nhap vien')) {
      const stay = visits.find(v => v.loai === LOAI_NOI_TRU && (daysBetween(a.start, v.start) ?? -1) >= 0 && daysBetween(a.start, v.start) <= KHAM_NHAP_VIEN_NGAY);
      if (stay) ins.run(code, a.id, stay.id, 'kham_nhap_vien', daysBetween(a.start, stay.start), null, null);
    }
  }
}

function rebuildAllLinks(conn) {
  const codes = conn.prepare('SELECT DISTINCT ma_bn FROM luot').all().map(r => r.ma_bn);
  if (!codes.length) return;
  conn.exec('BEGIN IMMEDIATE');
  try {
    for (const code of codes) rebuildLinks(conn, code);
    conn.exec('COMMIT');
  } catch (err) {
    try { conn.exec('ROLLBACK'); } catch (_) {}
    throw err;
  }
}

// ── Ghi từ các module ─────────────────────────────────────────────────────────

const INPATIENT_FILES = ['profile', 'discharge', 'surgery', 'order_history', 'bed_days', 'billing', 'cls'];
const OK_STATUSES = new Set(['ok', 'done', 'success', 'partial', 'empty']);

/**
 * Góp kết quả lấy dữ liệu hành chánh của 1 đợt nằm viện (Hành chánh / Kiểm hồ sơ / Kho nghiên cứu).
 * @returns {{ saved: boolean, luot_id?: number, new_scans?: number }}
 */
function recordInpatient(maBn, files, { from = '', to = '', source = 'hanh_chanh', tier, now = new Date().toISOString() } = {}) {
  const code = txt(maBn);
  if (!code || !files || typeof files !== 'object') return { saved: false };
  const muc = tier || (source === 'kho_nghien_cuu' ? TIER_GOC : TIER_TAM_THOI);
  const usable = INPATIENT_FILES.filter(k => files[k] && typeof files[k] === 'object' && OK_STATUSES.has(fileStatus(files[k])));
  const start = dayOf(from) || dayOf(to);
  if (!usable.length || !start) return { saved: false };
  return tx(conn => {
    const profile = files.profile || {};
    upsertPatient(conn, code, {
      ho_ten: profile.ho_ten, ngay_sinh: profile.ngay_sinh, tuoi: profile.tuoi, gioi_tinh: profile.gioi_tinh,
      dia_chi: profile.dia_chi, sdt: profile.sdt || profile.dien_thoai, the_bhyt: profile.bhyt_code,
    }, { tier: muc, now });
    const luot = findOrCreateLuot(conn, { maBn: code, loai: LOAI_NOI_TRU, from: start, to: dayOf(to), now });
    // Đợt đã biết rộng hơn (vd lần sau biết ngày vào sớm hơn): nới khoảng ngày.
    const newFrom = [txt(luot.gio_vao), start].filter(Boolean).sort()[0];
    const newTo = [txt(luot.gio_ra), dayOf(to)].filter(Boolean).sort().pop() || '';
    conn.prepare('UPDATE luot SET gio_vao = ?, gio_ra = ? WHERE id = ?').run(newFrom, newTo, luot.id);
    let added = 0;
    for (const key of usable) {
      if (insertScan(conn, { maBn: code, luotId: luot.id, loai: key, nguon: source, muc, now, data: files[key] })) added += 1;
    }
    rebuildLuot(conn, luot.id, now);
    rebuildLinks(conn, code);
    return { saved: true, luot_id: luot.id, new_scans: added };
  });
}

// Bỏ các trường chỉ phục vụ màn hình, đổi liên tục (không phải dữ liệu người bệnh).
const VOLATILE_ROW_KEYS = ['check', 'blockers', 'next_action', 'ready', 'eligible', 'weight_entered', 'bbhc_state', 'ngoaitru_state', 'details', 'stt'];

/**
 * Góp 1 lượt khám đọc từ Danh sách Khám bệnh (Phòng khám). Lượt đã Hoàn tất là dữ liệu gốc.
 * @param {object} row  dòng public_rows của clinic_monitor.py (có thể kèm row.details = chi tiết màn khám)
 */
function recordClinicVisit(row, { now = new Date().toISOString(), day = '' } = {}) {
  const code = txt(row?.ma_bn);
  const kb = txt(row?.khambenhid);
  if (!code || !kb) return { saved: false };
  const muc = txt(row.stage) === 'xong' ? TIER_GOC : TIER_TAM_THOI;
  return tx(conn => {
    upsertPatient(conn, code, { ho_ten: row.ho_ten, nam_sinh: row.nam_sinh }, { tier: TIER_TAM_THOI, now });
    const gioVao = isoTime(row.thoi_gian) || dayOf(day);
    const luot = findOrCreateLuot(conn, { maBn: code, loai: LOAI_KHAM, khoaEmr: `kb:${kb}`, from: gioVao, now });
    const listPart = Object.fromEntries(Object.entries(row).filter(([k]) => !VOLATILE_ROW_KEYS.includes(k)));
    let added = insertScan(conn, { maBn: code, luotId: luot.id, loai: 'kham_danh_sach', nguon: 'phong_kham', muc, now, data: listPart }) ? 1 : 0;
    const det = row.details;
    if (det && typeof det === 'object' && det.status === 'ok') {
      const detMuc = det.stage === 'xong' ? TIER_GOC : TIER_TAM_THOI;
      const { at, status, ...content } = det;
      if (insertScan(conn, { maBn: code, luotId: luot.id, loai: 'kham_chi_tiet', nguon: 'phong_kham', muc: detMuc, now, data: content })) added += 1;
    }
    if (added) {
      rebuildLuot(conn, luot.id, now);
      rebuildLinks(conn, code);
    }
    return { saved: true, luot_id: luot.id, new_scans: added };
  });
}

/** Ghi 1 thao tác hệ thống đã làm trên EMR (trùng nội dung thì bỏ qua). */
function recordAction({ ma_bn: maBn, khambenhid, kind = '', result = '', message = '', steps = [], at = '' }) {
  const code = txt(maBn);
  if (!code) return { saved: false };
  const luc = txt(at) || new Date().toISOString();
  const hash = contentHash({ code, khambenhid: txt(khambenhid), kind, result, message, luc });
  return tx(conn => {
    const luot = khambenhid ? conn.prepare('SELECT id FROM luot WHERE khoa_emr = ?').get(`kb:${txt(khambenhid)}`) : null;
    const res = conn.prepare(`INSERT OR IGNORE INTO thao_tac (luot_id, ma_bn, loai, ket_qua, thong_diep, cac_buoc, luc, hash)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(luot?.id ?? null, code, txt(kind), txt(result), txt(message).slice(0, 1000), JSON.stringify(Array.isArray(steps) ? steps.slice(0, 40) : []), luc, hash);
    return { saved: Number(res.changes) > 0 };
  });
}

// ── Tra cứu ───────────────────────────────────────────────────────────────────

function summary() {
  const conn = open();
  const one = sql => Number(conn.prepare(sql).get().n) || 0;
  let size = 0;
  try { size = fs.statSync(dbPath).size; } catch (_) {}
  return {
    path: dbPath,
    size_bytes: size,
    benh_nhan: one('SELECT COUNT(*) n FROM benh_nhan'),
    luot: one('SELECT COUNT(*) n FROM luot'),
    luot_kham: one(`SELECT COUNT(*) n FROM luot WHERE loai = '${LOAI_KHAM}'`),
    luot_noi_tru: one(`SELECT COUNT(*) n FROM luot WHERE loai = '${LOAI_NOI_TRU}'`),
    lan_quet: one('SELECT COUNT(*) n FROM lan_quet'),
    thao_tac: one('SELECT COUNT(*) n FROM thao_tac'),
    lien_ket: one('SELECT COUNT(*) n FROM lien_ket_luot'),
  };
}

function luotDetail(conn, l) {
  return {
    ...l,
    chan_doan: conn.prepare('SELECT loai, icd, ten FROM chan_doan WHERE luot_id = ? ORDER BY id').all(l.id),
    dich_vu: conn.prepare('SELECT nhom, ma, ten, thoi_gian, so_da_xong, so_chi_dinh, trang_thai FROM dich_vu WHERE luot_id = ? ORDER BY id').all(l.id),
    thao_tac: conn.prepare('SELECT loai, ket_qua, thong_diep, luc FROM thao_tac WHERE luot_id = ? ORDER BY luc').all(l.id),
    nguon_du_lieu: conn.prepare('SELECT loai, nguon, muc, MAX(lay_luc) lay_luc, COUNT(*) so_ban FROM lan_quet WHERE luot_id = ? GROUP BY loai, nguon, muc ORDER BY loai').all(l.id),
    lien_ket: conn.prepare(`SELECT loai, luot_truoc, luot_sau, so_ngay, ngay_hen, lech_hen FROM lien_ket_luot
      WHERE luot_truoc = ? OR luot_sau = ? ORDER BY id`).all(l.id, l.id).map(r => ({ ...r })),
    trang_thai_hen: appointmentStatus(conn, l, todayIso()),
  };
}

// Trạng thái hẹn tái khám của 1 lượt: dung_hen | tre_hen | qua_hen (chưa thấy quay lại) | chua_den_hen.
function appointmentStatus(conn, l, homNay) {
  const hen = dayOf(l.hen_tai_kham);
  if (!hen) return null;
  const link = conn.prepare(`SELECT * FROM lien_ket_luot WHERE luot_truoc = ? AND loai IN ('tai_kham_dung_hen', 'tai_kham_tre_hen')`).get(l.id);
  if (link) return { trang_thai: link.loai === 'tai_kham_dung_hen' ? 'dung_hen' : 'tre_hen', ngay_hen: hen, lech_hen: link.lech_hen, luot_sau: link.luot_sau };
  const qua = (daysBetween(hen, homNay) ?? 0) > HEN_LECH_TOI_DA;
  return { trang_thai: qua ? 'qua_hen' : 'chua_den_hen', ngay_hen: hen, lech_hen: null, luot_sau: null };
}

/**
 * Báo cáo tái khám: mọi lượt có ngày hẹn trong [tu, den].
 * Tỉ lệ đúng hẹn tính trên các hẹn đã quá hạn theo dõi (bỏ các hẹn chưa tới / đang trong ±3 ngày).
 */
function appointmentReport({ tu = '', den = '', homNay = todayIso(), loai = '' } = {}) {
  const conn = open();
  const where = ["l.hen_tai_kham IS NOT NULL", "l.hen_tai_kham <> ''"];
  const args = [];
  if (tu) { where.push('substr(l.hen_tai_kham, 1, 10) >= ?'); args.push(dayOf(tu)); }
  if (den) { where.push('substr(l.hen_tai_kham, 1, 10) <= ?'); args.push(dayOf(den)); }
  const visits = conn.prepare(`SELECT l.*, b.ho_ten, b.nam_sinh FROM luot l LEFT JOIN benh_nhan b ON b.ma_bn = l.ma_bn
    WHERE ${where.join(' AND ')} ORDER BY l.hen_tai_kham, l.id`).all(...args);
  const sau = conn.prepare('SELECT id, loai, gio_vao, khoa, chan_doan_chinh FROM luot WHERE id = ?');
  const rows = [];
  const dem = { tong: 0, dung_hen: 0, tre_hen: 0, qua_hen: 0, chua_den_hen: 0 };
  for (const v of visits) {
    const st = appointmentStatus(conn, v, homNay);
    if (!st || (loai && st.trang_thai !== loai)) continue;
    dem.tong += 1;
    dem[st.trang_thai] += 1;
    const next = st.luot_sau ? sau.get(st.luot_sau) : null;
    rows.push({
      ma_bn: v.ma_bn, ho_ten: v.ho_ten, nam_sinh: v.nam_sinh,
      luot_id: v.id, loai_luot: v.loai, khoa: v.khoa, gio_vao: v.gio_vao, gio_ra: v.gio_ra, chan_doan_chinh: v.chan_doan_chinh,
      ...st, luot_sau: next ? { ...next } : null,
    });
  }
  const daTheoDoi = dem.dung_hen + dem.tre_hen + dem.qua_hen;
  return {
    hom_nay: homNay,
    tong_ket: { ...dem, da_theo_doi: daTheoDoi, ti_le_dung_hen: daTheoDoi ? Math.round((dem.dung_hen / daTheoDoi) * 1000) / 10 : null },
    rows,
  };
}

/**
 * Báo cáo tái nhập viện trong 30 ngày: các đợt nội trú ra viện trong [tu, den].
 * Đợt ra viện chưa đủ 30 ngày mà chưa thấy tái nhập được đếm riêng (chưa đủ thời gian theo dõi).
 */
function readmissionReport({ tu = '', den = '', homNay = todayIso() } = {}) {
  const conn = open();
  const where = [`l.loai = '${LOAI_NOI_TRU}'`, "l.gio_ra IS NOT NULL", "l.gio_ra <> ''"];
  const args = [];
  if (tu) { where.push('substr(l.gio_ra, 1, 10) >= ?'); args.push(dayOf(tu)); }
  if (den) { where.push('substr(l.gio_ra, 1, 10) <= ?'); args.push(dayOf(den)); }
  const stays = conn.prepare(`SELECT l.*, b.ho_ten, b.nam_sinh FROM luot l LEFT JOIN benh_nhan b ON b.ma_bn = l.ma_bn
    WHERE ${where.join(' AND ')} ORDER BY l.gio_ra, l.id`).all(...args);
  const linkOf = conn.prepare(`SELECT k.so_ngay, s.id, s.gio_vao, s.khoa, s.chan_doan_chinh FROM lien_ket_luot k JOIN luot s ON s.id = k.luot_sau
    WHERE k.luot_truoc = ? AND k.loai = 'tai_nhap_vien_30'`);
  const dem = { ra_vien: 0, tai_nhap_vien: 0, khong_tai_nhap: 0, chua_du_30_ngay: 0 };
  const rows = stays.map(v => {
    const link = linkOf.get(v.id);
    let trang_thai = 'khong_tai_nhap';
    if (link) trang_thai = 'tai_nhap_vien';
    else if ((daysBetween(dayOf(v.gio_ra), homNay) ?? 0) < TAI_NHAP_VIEN_NGAY) trang_thai = 'chua_du_30_ngay';
    dem.ra_vien += 1;
    dem[trang_thai] += 1;
    return {
      ma_bn: v.ma_bn, ho_ten: v.ho_ten, nam_sinh: v.nam_sinh, luot_id: v.id, khoa: v.khoa, gio_vao: v.gio_vao, gio_ra: v.gio_ra,
      chan_doan_chinh: v.chan_doan_chinh, trang_thai,
      tai_nhap: link ? { luot_id: link.id, gio_vao: link.gio_vao, khoa: link.khoa, chan_doan_chinh: link.chan_doan_chinh, so_ngay: link.so_ngay } : null,
    };
  });
  const daTheoDoi = dem.tai_nhap_vien + dem.khong_tai_nhap;
  return {
    hom_nay: homNay,
    tong_ket: { ...dem, da_theo_doi: daTheoDoi, ti_le_tai_nhap: daTheoDoi ? Math.round((dem.tai_nhap_vien / daTheoDoi) * 1000) / 10 : null },
    rows,
  };
}

/** Hành trình 1 người bệnh: thông tin + mọi lượt theo thời gian. */
function patientJourney(maBn) {
  const conn = open();
  const code = txt(maBn);
  const patient = conn.prepare('SELECT * FROM benh_nhan WHERE ma_bn = ?').get(code);
  if (!patient) return null;
  const visits = conn.prepare('SELECT * FROM luot WHERE ma_bn = ? ORDER BY gio_vao, id').all(code);
  return { benh_nhan: { ...patient }, luot: visits.map(l => luotDetail(conn, { ...l })) };
}

/** Danh sách lượt theo khoảng ngày / loại / khoa. */
function listVisits({ tu = '', den = '', loai = '', khoa = '', limit = 200, offset = 0 } = {}) {
  const conn = open();
  const where = [];
  const args = [];
  if (tu) { where.push('l.gio_vao >= ?'); args.push(dayOf(tu)); }
  if (den) { where.push('l.gio_vao < ?'); args.push(`${dayOf(den)} 99`); }
  if (loai) { where.push('l.loai = ?'); args.push(loai); }
  if (khoa) { where.push('l.khoa = ?'); args.push(khoa); }
  const cond = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const lim = Math.min(Math.max(Number(limit) || 200, 1), 1000);
  const off = Math.max(Number(offset) || 0, 0);
  const total = Number(conn.prepare(`SELECT COUNT(*) n FROM luot l ${cond}`).get(...args).n) || 0;
  const rows = conn.prepare(`SELECT l.*, b.ho_ten, b.nam_sinh FROM luot l LEFT JOIN benh_nhan b ON b.ma_bn = l.ma_bn ${cond}
    ORDER BY l.gio_vao DESC, l.id DESC LIMIT ? OFFSET ?`).all(...args, lim, off);
  return { total, rows: rows.map(r => ({ ...r })) };
}

/** Tìm người bệnh theo mã BN, họ tên (không dấu), SĐT hoặc số thẻ BHYT. */
function searchPatients(query, limit = 30) {
  const conn = open();
  const q = txt(query);
  if (q.length < 2) return [];
  const like = `%${stripMarks(q).replace(/[%_]/g, '')}%`;
  const raw = `%${q.replace(/[%_]/g, '')}%`;
  const rows = conn.prepare(`SELECT b.ma_bn, b.ho_ten, b.nam_sinh, b.gioi_tinh,
      (SELECT COUNT(*) FROM luot l WHERE l.ma_bn = b.ma_bn) so_luot,
      (SELECT MAX(gio_vao) FROM luot l WHERE l.ma_bn = b.ma_bn) lan_cuoi
    FROM benh_nhan b
    WHERE b.ma_bn LIKE ? OR b.ho_ten_khong_dau LIKE ? OR b.sdt LIKE ? OR b.the_bhyt LIKE ?
    ORDER BY lan_cuoi DESC LIMIT ?`).all(raw, like, raw, raw, Math.min(Math.max(Number(limit) || 30, 1), 200));
  return rows.map(r => ({ ...r }));
}

module.exports = {
  available, unavailableReason, open, close,
  recordInpatient, recordClinicVisit, recordAction,
  summary, patientJourney, listVisits, searchPatients, appointmentReport, readmissionReport,
  HEN_LECH_TOI_DA, TAI_NHAP_VIEN_NGAY,
  isoTime, splitIcd, contentHash,
  TIER_GOC, TIER_TAM_THOI, LOAI_KHAM, LOAI_NOI_TRU,
};
