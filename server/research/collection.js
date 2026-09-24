'use strict';

// Sổ thu thập (collection ledger): trạng thái RIÊNG của từng phần dữ liệu của từng
// lượt điều trị, để lần chạy sau chỉ lấy đúng phần còn thiếu, lỗi hoặc đã thay đổi.
//
// Module thuần (không Selenium, không đọc/ghi file) để test được. research.js đọc
// progress của các worker, gọi các hàm ở đây, rồi ghi collection_ledger.json.
//
// Trạng thái một phần:
//   pending  chưa lấy (hoặc lần trước dừng giữa chừng)
//   ok       đã lấy, EMR có dữ liệu
//   empty    đã lấy, EMR xác nhận KHÔNG có dữ liệu (khác với "chưa lấy được")
//   failed   lỗi kỹ thuật (timeout, mất phiên, tab không tải...) → tự thử lại có giới hạn
//   blocked  cần người xem (giao diện EMR khác mẫu, không xác định chắc lượt điều trị,
//            EMR nay rỗng trong khi trước đó có dữ liệu) → KHÔNG tự thử lại

const crypto = require('crypto');
const variableSelection = require('./variable_selection');

const LEDGER_VERSION = 1;
const DEFAULT_MAX_ATTEMPTS = 3;

const PARTS = [
  { key: 'xn', label: 'Xét nghiệm', fetcher: 'xn_cdha' },
  { key: 'cdha', label: 'CĐHA', fetcher: 'xn_cdha' },
  { key: 'profile', label: 'Hồ sơ nền', fetcher: 'hchanh' },
  { key: 'discharge', label: 'Ra viện', fetcher: 'hchanh' },
  { key: 'surgery', label: 'Phẫu thuật', fetcher: 'hchanh' },
  { key: 'order_history', label: 'Y lệnh', fetcher: 'order_history' },
];
const PART_KEYS = PARTS.map(p => p.key);
const DONE_STATUSES = new Set(['ok', 'empty']);

const REASON_LABELS = {
  new: 'Ca mới',
  missing: 'Chưa lấy',
  changed: 'Dữ liệu trên EMR đã thay đổi',
  retry: 'Thử lại sau lỗi kỹ thuật',
  interrupted: 'Lần trước dừng giữa chừng',
  legacy_empty_unverified: 'Bản cũ ghi 0 dòng, chưa chắc EMR không có',
  timeout: 'Hết thời gian chờ EMR',
  session: 'Mất phiên/đăng nhập trình duyệt',
  tab_load: 'Tab không tải xong',
  partial: 'Chỉ đọc được một phần',
  no_content: 'Trang mở được nhưng không đọc được nội dung',
  no_result: 'Worker không trả kết quả',
  search_error: 'Lỗi khi tìm người bệnh',
  popup_error: 'Không mở được lượt điều trị',
  error: 'Lỗi kỹ thuật',
  unknown: 'Trạng thái không xác định',
  not_found: 'Không tìm thấy người bệnh trên EMR',
  emr_ui_changed: 'Giao diện EMR khác mẫu đang biết',
  encounter_not_identified: 'Không xác định chắc lượt điều trị',
  emr_now_empty_previously_had_data: 'EMR nay trống nhưng lần trước có dữ liệu',
  not_completed: 'Hồ sơ chưa ở trạng thái Hoàn tất',
  retry_exhausted: 'Đã thử lại đủ số lần, vẫn lỗi',
  refresh_due: 'Quá hạn kiểm tra lại theo chính sách làm mới',
  manual_refresh: 'Người dùng chọn Làm mới',
};

// Trường nội dung/phiên bản của một phần, giữ qua các lần dựng lại sổ.
const CONTENT_FIELDS = ['content_hash', 'content_version', 'content_changed_at', 'last_check_outcome', 'last_check_at', 'history_stored_version'];

function pickContentFields(p) {
  const out = {};
  for (const f of CONTENT_FIELDS) if (p && p[f] !== undefined) out[f] = p[f];
  return out;
}

const TECHNICAL_REASONS = new Set(['timeout', 'session', 'tab_load', 'partial', 'no_content', 'no_result', 'search_error', 'popup_error', 'error', 'unknown']);
const IDENTITY_REASONS = new Set(['encounter_not_identified']);

function nowIso() {
  return new Date().toISOString();
}

function shortHash(value) {
  return crypto.createHash('sha1').update(String(value)).digest('hex').slice(0, 10);
}

// Chi tiết lỗi đưa ra báo cáo/ngoại lệ: bỏ URL (có thể chứa keyword=Mã BN) và dãy số dài
// (mã BN, số thẻ, điện thoại) để không lộ định danh trong file/giao diện.
function scrubDetail(value) {
  return String(value || '')
    .replace(/https?:\/\/\S+/gi, '[url]')
    .replace(/\b\d{6,}\b/g, '[số]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 300);
}

function clean(value) {
  return String(value ?? '').normalize('NFC').replace(/\s+/g, ' ').trim().toLowerCase();
}

function cell(row, names) {
  return variableSelection.getCell(row, names);
}

function isoDateOnly(value) {
  const raw = String(value || '').trim();
  let m = raw.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  m = raw.match(/(\d{1,2})[/-](\d{1,2})[/-](\d{4})/);
  if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  return '';
}

function reasonKind(reason) {
  const head = String(reason || '').split(':')[0].trim().toLowerCase();
  return head || '';
}

// ── Dấu vân tay danh sách ────────────────────────────────────────────────────
// Mỗi dòng trên D/s điều trị nội trú (một dòng / khoa) cho 1 chữ ký:
//   <khóa dòng>:<hash thông tin đợt>:<hash hành chính>
// Khóa dòng = Mã BN + T/G vào (cùng khóa upsert của Bước 1). Chỉ lưu hash, không lưu
// giá trị gốc. Dòng bị gộp/xóa khỏi du_lieu_ban_dau.csv không bị coi là thay đổi.
function listRowSignature(row) {
  const code = clean(cell(row, ['Mã BN', 'patient_code']));
  const admitted = clean(cell(row, ['T/G vào', 'TG vào', 'Ngày vào viện', 'admission_date']));
  if (!code || !admitted) return '';
  const rowKey = shortHash(`${code}|${admitted}`);
  const stay = shortHash([
    cell(row, ['Mã nội trú', 'noitruid', 'emr_noitru_id']),
    cell(row, ['Trạng thái']),
    cell(row, ['Xử trí']),
    cell(row, ['Khoa chuyển đến']),
    cell(row, ['T/G ra', 'Ngày ra viện', 'discharge_date']),
  ].map(clean).join('|'));
  const demo = shortHash([
    cell(row, ['Họ tên', 'patient_name']),
    cell(row, ['Tuổi']),
    cell(row, ['GT', 'Giới', 'Giới tính']),
  ].map(clean).join('|'));
  return `${rowKey}:${stay}:${demo}`;
}

function mergeSignatures(...values) {
  const set = new Set();
  for (const v of values) {
    for (const sig of String(v || '').split(/\s+/)) if (/^[0-9a-f]{10}:[0-9a-f]{10}:[0-9a-f]{10}$/.test(sig)) set.add(sig);
  }
  return [...set].sort().join(' ');
}

function parseSignatures(value) {
  const out = {};
  for (const sig of String(value || '').split(/\s+/)) {
    const m = /^([0-9a-f]{10}):([0-9a-f]{10}):([0-9a-f]{10})$/.exec(sig);
    if (m) out[m[1]] = { stay: m[2], demo: m[3] };
  }
  return out;
}

// ── Phân loại kết quả từ progress của từng worker ────────────────────────────

function part(status, reason = '', extra = {}) {
  return { status, reason, ...extra };
}

// Trạng thái _fetch_status của hchanh_fetch.py cho một file → trạng thái phần.
function classifyFetchStatus(fetchStatus, rows = 0, extraReason = '') {
  const st = String(fetchStatus || '').trim().toLowerCase();
  const n = Number(rows) || 0;
  if (extraReason === 'patient_not_completed_currently') return part('blocked', 'not_completed');
  if (st === 'ok') return n > 0 ? part('ok') : part('empty');
  if (st === 'empty') return part('failed', 'no_content');
  if (st === 'partial') return part('failed', 'partial');
  if (st === 'timeout' || st === 'cdha_timeout') return part('failed', 'timeout');
  if (['no_session', 'no_driver', 'no_selenium'].includes(st)) return part('failed', 'session');
  if (st === 'error') return part('failed', 'error');
  if (st === 'no_url' || st === 'no_patient_link') return part('failed', 'not_found');
  if (['no_results_popup', 'no_cdha_tab', 'no_table', 'no_tiepnhanid'].includes(st)) return part('blocked', 'emr_ui_changed');
  if (st === 'pending' || !st) return part('failed', 'no_result');
  return part('failed', 'unknown', { detail: st });
}

// Một tab trong progress.json của script XN/CĐHA.
function classifyXnTab(entry, tab) {
  if (!entry || typeof entry !== 'object') return part('pending', 'missing');
  const st = String(entry[tab] || '').trim().toLowerCase();
  const reason = String(entry.tab_reason?.[tab] || entry.last_error || '').trim();
  const at = String(entry.tab_at?.[tab] || entry.updated_at || '').trim();
  const saved = entry.committed === true || Boolean(entry.tab_saved?.[tab]);
  const rows = Number(entry.counts?.[tab]);
  const newFormat = Boolean(entry.tab_saved);
  if (st === 'done') {
    if (!saved) return part('pending', 'interrupted', { result_at: at });
    if (Number.isFinite(rows) && rows > 0) return part('ok', '', { rows, result_at: at });
    // Bản cũ ghi "done" cả khi tab không tải được (0 dòng) → chưa chắc EMR không có.
    if (!newFormat) return part('pending', 'legacy_empty_unverified', { rows: 0, result_at: at });
    return part('empty', '', { rows: 0, result_at: at });
  }
  if (st === 'empty') return saved ? part('empty', '', { rows: 0, result_at: at }) : part('pending', 'interrupted', { result_at: at });
  if (st === 'error') {
    const kind = reasonKind(reason);
    const mapped = kind === 'not_found' ? 'not_found' : (TECHNICAL_REASONS.has(kind) ? kind : 'error');
    return part('failed', mapped, { detail: scrubDetail(reason), result_at: at });
  }
  if (st === 'blocked') {
    const kind = reasonKind(reason);
    return part('blocked', REASON_LABELS[kind] ? kind : 'emr_ui_changed', { detail: scrubDetail(reason), result_at: at });
  }
  if (st === 'running') return part('pending', 'interrupted', { result_at: at });
  return part('pending', st === 'pending_refetch' ? 'missing' : 'missing', { result_at: at });
}

// Một file trong progress hành chánh (hchanh_auto_progress / order_history_auto_progress).
function classifyHchanhFile(entry, file) {
  if (!entry || typeof entry !== 'object') return part('pending', 'missing');
  const fs = entry.file_status?.[file];
  if (fs && typeof fs === 'object') {
    const res = classifyFetchStatus(fs.fetch_status, fs.rows, fs.reason);
    if (fs.override_status) {
      return part(fs.override_status, fs.override_reason || res.reason, { rows: Number(fs.rows) || 0, result_at: String(fs.at || ''), detail: scrubDetail(fs.detail) });
    }
    return { ...res, rows: Number(fs.rows) || 0, result_at: String(fs.at || entry.finished_at || ''), ...(fs.detail ? { detail: scrubDetail(fs.detail) } : {}) };
  }
  const files = Array.isArray(entry.files) ? entry.files : [];
  if (!files.includes(file)) return part('pending', 'missing');
  const st = String(entry.status || '').trim().toLowerCase();
  const rows = Number(entry.rows?.[file]) || 0;
  const at = String(entry.finished_at || entry.skipped_at || entry.updated_at || '');
  if (st === 'done') return part(rows > 0 ? 'ok' : 'empty', '', { rows, result_at: at });
  if (st === 'partial') return rows > 0 ? part('ok', '', { rows, result_at: at }) : part('failed', 'partial', { result_at: at });
  if (st === 'error') return rows > 0 ? part('ok', '', { rows, result_at: at }) : part('failed', 'error', { detail: scrubDetail(String(entry.error || '').split('\n')[0]), result_at: at });
  if (st === 'skipped_recent_failure') return part('failed', 'not_found', { result_at: at });
  if (['queued', 'running', 'pending_refetch'].includes(st)) return part('pending', 'interrupted', { result_at: at });
  return part('pending', 'missing', { result_at: at });
}

// ── Ghép progress XN/CĐHA với dòng nguồn ─────────────────────────────────────
// Chỉ nhận khi ghép được về ĐÚNG MỘT dòng nguồn ở mức chắc chắn nhất; mức nào ra
// nhiều dòng thì bỏ (không đoán).
function sourceIdentity(row) {
  return {
    key: cell(row, ['Research key']),
    research_code: cell(row, ['Mã NC', 'research_code']),
    patient_code: cell(row, ['Mã BN', 'patient_code']),
    noitru: clean(cell(row, ['Mã nội trú', 'noitruid', 'emr_noitru_id'])),
    treatment: clean(cell(row, ['Mã điều trị', 'emr_treatment_id'])),
    admission_date: isoDateOnly(cell(row, ['Ngày vào viện', 'T/G vào', 'admission_date'])),
  };
}

// Đơn vị theo dõi = một LƯỢT điều trị. Danh sách nội trú có nhiều dòng cho cùng một lượt
// (mỗi lần chuyển khoa một dòng); các dòng đó được gom về lượt đã chuẩn hóa
// (encounters.csv) để tiến độ không bị chia nhỏ theo dòng. Dòng chưa ghép chắc về đúng
// một lượt thì đứng riêng (không đoán).
function sourceUnitFromRow(row) {
  const id = sourceIdentity(row);
  return {
    ...id,
    members: [id.key],
    stay_from: id.admission_date,
    stay_to: '',
    signatures: cell(row, ['list_row_signatures']),
    row,
  };
}

function rowAdmissionSortKey(row) {
  const raw = cell(row, ['T/G vào', 'Ngày vào viện', 'admission_date']);
  const d = isoDateOnly(raw);
  const t = (String(raw).match(/(\d{1,2}):(\d{2})/) || []).slice(1).map(x => x.padStart(2, '0')).join(':');
  return `${d} ${t}`;
}

function buildCollectionUnits({ sourceRows = [], encounterRows = [] } = {}) {
  const encs = (encounterRows || []).map(r => ({
    id: cell(r, ['encounter_id']),
    research_code: cell(r, ['research_code']),
    patient_code: cell(r, ['patient_code']),
    noitru: clean(cell(r, ['emr_noitru_id'])),
    treatment: clean(cell(r, ['emr_treatment_id'])),
    from: isoDateOnly(cell(r, ['admission_date'])),
    to: isoDateOnly(cell(r, ['discharge_date'])),
  })).filter(e => e.id && e.patient_code && !e.id.startsWith('enc_unresolved_'));
  const byCode = new Map();
  for (const e of encs) {
    if (!byCode.has(e.patient_code)) byCode.set(e.patient_code, []);
    byCode.get(e.patient_code).push(e);
  }
  const units = new Map();
  const seen = new Set();
  for (const row of sourceRows || []) {
    const id = sourceIdentity(row);
    if (!id.key || seen.has(id.key)) continue;
    seen.add(id.key);
    const rowDate = isoDateOnly(cell(row, ['T/G vào', 'Ngày vào viện', 'admission_date']));
    const cands = byCode.get(id.patient_code) || [];
    const noConflict = e => !(id.noitru && e.noitru && e.noitru !== id.noitru);
    const levels = [
      () => (id.noitru ? cands.filter(e => e.noitru === id.noitru || e.treatment === id.noitru) : []),
      () => (id.treatment ? cands.filter(e => e.treatment === id.treatment || e.noitru === id.treatment) : []),
      () => (rowDate ? cands.filter(e => noConflict(e) && e.from && rowDate >= e.from && rowDate <= (e.to || e.from)) : []),
    ];
    let match = null;
    for (const level of levels) {
      const found = level();
      if (found.length === 1) { match = found[0]; break; }
      if (found.length > 1) break; // nhiều lượt khớp → không đoán, đứng riêng
    }
    const key = match ? match.id : id.key;
    if (!units.has(key)) {
      units.set(key, {
        key,
        encounter_id: match?.id || '',
        research_code: match?.research_code || id.research_code,
        patient_code: id.patient_code,
        noitru: match?.noitru || id.noitru,
        treatment: match?.treatment || id.treatment,
        admission_date: match?.from || id.admission_date,
        stay_from: match?.from || id.admission_date,
        stay_to: match?.to || '',
        members: [],
        rows: [],
      });
    }
    const u = units.get(key);
    u.members.push(id.key);
    u.rows.push(row);
  }
  const out = [];
  for (const u of units.values()) {
    const rows = [...u.rows].sort((a, b) => rowAdmissionSortKey(a).localeCompare(rowAdmissionSortKey(b)));
    const first = rows[0];
    const froms = rows.map(r => cell(r, ['fetch_from_date'])).filter(Boolean).sort();
    const tos = rows.map(r => cell(r, ['fetch_to_date'])).filter(Boolean).sort();
    // Dòng giao cho worker: dòng vào sớm nhất của lượt, khoảng lấy dữ liệu phủ cả lượt.
    const row = {
      ...first,
      ...(froms.length ? { fetch_from_date: froms[0] } : {}),
      ...(tos.length ? { fetch_to_date: tos[tos.length - 1] } : {}),
    };
    out.push({
      key: u.key,
      encounter_id: u.encounter_id,
      research_code: u.research_code,
      patient_code: u.patient_code,
      noitru: u.noitru,
      treatment: u.treatment,
      admission_date: u.admission_date,
      stay_from: u.stay_from,
      stay_to: u.stay_to,
      members: u.members,
      member_codes: [...new Set(rows.map(r => cell(r, ['Mã NC', 'research_code'])).filter(Boolean))],
      signatures: mergeSignatures(...rows.map(r => cell(r, ['list_row_signatures']))),
      row,
    });
  }
  return out;
}

function matchXnEntriesToSources(progress, sources) {
  const byKey = new Map();
  for (const s of sources) for (const m of (s.members || [s.key])) byKey.set(m, s);
  const inStay = (s, date) => {
    const from = s.stay_from || s.admission_date;
    if (!from || !date) return false;
    return s.stay_to ? (date >= from && date <= s.stay_to) : date === from;
  };
  const matches = new Map();
  const unmatched = [];
  for (const [rawKey, entry] of Object.entries(progress || {})) {
    if (String(rawKey).startsWith('__') || !entry || typeof entry !== 'object') continue;
    if (!('xn' in entry) && !('cdha' in entry)) continue;
    const explicit = String(entry['Research key'] || '').trim() || (String(rawKey).startsWith('source:') ? String(rawKey).slice(7) : '');
    const code = String(entry['Mã BN'] || entry.ma_bn || String(rawKey).split('|')[0] || '').trim();
    const rc = String(entry['Mã NC'] || entry.research_code || '').trim();
    const noitru = clean(entry['Mã nội trú'] || '');
    const treatment = clean(entry['Mã điều trị'] || '');
    const admission = isoDateOnly(entry['Ngày vào viện'] || '');
    const levels = [
      () => (explicit && byKey.has(explicit) ? [byKey.get(explicit)] : []),
      () => (noitru ? sources.filter(s => s.patient_code === code && (s.noitru === noitru || s.treatment === noitru)) : []),
      () => (treatment ? sources.filter(s => s.patient_code === code && (s.treatment === treatment || s.noitru === treatment)) : []),
      () => (rc && code ? sources.filter(s => s.research_code === rc && s.patient_code === code) : []),
      () => (code && admission ? sources.filter(s => s.patient_code === code && inStay(s, admission)) : []),
    ];
    let picked = null;
    let ambiguous = false;
    for (const level of levels) {
      const found = level();
      if (found.length === 1) { picked = found[0]; break; }
      if (found.length > 1) { ambiguous = true; break; }
    }
    if (!picked) { unmatched.push({ key: rawKey, ambiguous }); continue; }
    if (!matches.has(picked.key)) matches.set(picked.key, []);
    matches.get(picked.key).push(entry);
  }
  return { matches, unmatched };
}

function latestTabResult(entries, tab) {
  let best = null;
  for (const entry of entries || []) {
    const res = classifyXnTab(entry, tab);
    if (!best) { best = res; continue; }
    const a = String(res.result_at || '');
    const b = String(best.result_at || '');
    if (a > b) best = res;
  }
  return best || part('pending', 'missing');
}

function latestResult(results) {
  let best = null;
  for (const res of results) {
    if (!res) continue;
    if (!best || String(res.result_at || '') > String(best.result_at || '') || (best.status === 'pending' && res.status !== 'pending')) best = res;
  }
  return best || part('pending', 'missing');
}

// ── Dựng sổ thu thập ─────────────────────────────────────────────────────────

// Nhiều dòng (thành viên) của cùng một lượt: nếu có dòng đã lấy xong thì dùng kết quả xong
// mới nhất (dữ liệu của lượt đã có); nếu không thì dùng kết quả mới nhất.
function latestPreferDone(results) {
  const list = (results || []).filter(Boolean);
  const done = list.filter(r => DONE_STATUSES.has(r.status));
  return latestResult(done.length ? done : list);
}

// Progress hành chánh ghi theo khóa dòng. Khóa không còn thuộc lượt nào (nguồn được tạo lại
// với khóa khác) thì ghép theo Mã BN + ngày vào nằm trong lượt — chỉ khi khớp đúng 1 lượt.
function matchOrphanHchanhEntries(progress, sources) {
  const memberOf = new Set();
  for (const s of sources) for (const m of (s.members || [s.key])) memberOf.add(m);
  const out = new Map();
  for (const [key, entry] of Object.entries(progress || {})) {
    if (memberOf.has(key) || String(key).startsWith('__') || !entry || typeof entry !== 'object') continue;
    const code = String(entry.ma_bn || entry['Mã BN'] || '').trim();
    const date = isoDateOnly(entry.admission_date || entry['Ngày vào viện'] || '');
    if (!code || !date) continue;
    const found = sources.filter(s => {
      const from = s.stay_from || s.admission_date;
      if (s.patient_code !== code || !from) return false;
      return s.stay_to ? (date >= from && date <= s.stay_to) : date === from;
    });
    if (found.length !== 1) continue;
    if (!out.has(found[0].key)) out.set(found[0].key, []);
    out.get(found[0].key).push(entry);
  }
  return out;
}

function derivePartResults(source, xnMatches, hchanhProgress, orderProgress, orphanHc = new Map(), orphanOh = new Map()) {
  const xnEntries = xnMatches.get(source.key) || [];
  const members = source.members || [source.key];
  const hcs = members.map(m => hchanhProgress?.[m]).filter(Boolean).concat(orphanHc.get(source.key) || []);
  const ohs = members.map(m => orderProgress?.[m]).filter(Boolean).concat(orphanOh.get(source.key) || []);
  const hcFile = file => latestPreferDone(hcs.map(e => classifyHchanhFile(e, file)));
  return {
    xn: latestPreferDone(xnEntries.map(e => classifyXnTab(e, 'xn'))),
    cdha: latestPreferDone(xnEntries.map(e => classifyXnTab(e, 'cdha'))),
    profile: hcFile('profile'),
    discharge: hcFile('discharge'),
    surgery: hcFile('surgery'),
    order_history: latestPreferDone([...ohs, ...hcs].map(e => classifyHchanhFile(e, 'order_history'))),
  };
}

function buildLedger({ sourceRows = [], units = null, xnProgress = {}, hchanhProgress = {}, orderProgress = {}, previous = null, now = nowIso() } = {}) {
  const prevEncounters = previous?.encounters || {};
  const sources = [];
  const seen = new Set();
  // Không truyền units (không có encounters.csv): mỗi dòng nguồn là một đơn vị như trước.
  for (const u of units || sourceRows.map(sourceUnitFromRow)) {
    if (!u.key || seen.has(u.key)) continue;
    seen.add(u.key);
    sources.push(u);
  }
  const { matches: xnMatches, unmatched } = matchXnEntriesToSources(xnProgress, sources);
  const orphanHc = matchOrphanHchanhEntries(hchanhProgress, sources);
  const orphanOh = matchOrphanHchanhEntries(orderProgress, sources);
  const encounters = {};

  // Giữ lại lượt đã rời khỏi nguồn (không xóa lịch sử), đánh dấu ngoài phạm vi.
  for (const [key, enc] of Object.entries(prevEncounters)) {
    if (!seen.has(key)) encounters[key] = { ...enc, in_source: false };
  }

  for (const src of sources) {
    const prev = prevEncounters[src.key];
    const rows = parseSignatures(src.signatures);
    let changeSeq = Number(prev?.change_seq) || 0;
    let demoSeq = Number(prev?.demo_seq) || 0;
    let listRows = { ...(prev?.list_rows || {}) };
    let changedAt = prev?.changed_at || '';
    if (prev && Object.keys(rows).length) {
      if (!Object.keys(listRows).length) {
        listRows = rows; // lần đầu có chữ ký: làm mốc, không coi là thay đổi
      } else {
        let stayChanged = false;
        let demoChanged = false;
        for (const [rowKey, sig] of Object.entries(rows)) {
          const old = listRows[rowKey];
          if (!old) stayChanged = true;
          else {
            if (old.stay !== sig.stay) stayChanged = true;
            if (old.demo !== sig.demo) demoChanged = true;
          }
          listRows[rowKey] = sig;
        }
        if (stayChanged) { changeSeq += 1; changedAt = now; }
        if (demoChanged) demoSeq += 1;
      }
    } else if (!prev) {
      listRows = rows;
    }

    const derived = derivePartResults(src, xnMatches, hchanhProgress, orderProgress, orphanHc, orphanOh);
    const parts = {};
    for (const key of PART_KEYS) {
      const d = derived[key];
      const p = prev?.parts?.[key];
      const done = DONE_STATUSES.has(d.status);
      if (!p) {
        parts[key] = {
          status: d.status, reason: d.reason || '', detail: d.detail || '', rows: d.rows ?? null,
          result_at: d.result_at || '', attempts: d.status === 'failed' ? 1 : 0,
          seen_seq: changeSeq, seen_demo_seq: demoSeq,
        };
        continue;
      }
      const isNewResult = Boolean(d.result_at) && d.result_at !== p.result_at;
      if (!isNewResult) {
        // Progress không có gì mới → giữ trạng thái đã biết (kể cả no_result do điều phối ghi).
        parts[key] = { ...p };
        if (p.status === 'pending' && d.status !== 'pending' && !d.result_at) {
          parts[key] = { ...p, status: d.status, reason: d.reason || '', detail: d.detail || '', rows: d.rows ?? p.rows ?? null };
        }
        continue;
      }
      parts[key] = {
        ...pickContentFields(p),
        status: d.status,
        reason: d.reason || '',
        detail: d.detail || '',
        rows: d.rows ?? null,
        result_at: d.result_at,
        attempts: d.status === 'failed' ? (Number(p.attempts) || 0) + 1 : (done ? 0 : Number(p.attempts) || 0),
        seen_seq: done ? changeSeq : (Number(p.seen_seq) || 0),
        seen_demo_seq: done ? demoSeq : (Number(p.seen_demo_seq) || 0),
      };
    }

    encounters[src.key] = {
      key: src.key,
      encounter_id: src.encounter_id || '',
      members: src.members || [src.key],
      // Mã NC mà dữ liệu thô XN/CĐHA của lượt có thể mang (mã lượt, mã các dòng, mã script đã cấp).
      data_codes: [...new Set([
        src.research_code,
        ...(src.member_codes || []),
        ...(xnMatches.get(src.key) || []).map(e => String(e['Mã NC'] || '').trim()),
      ].filter(Boolean))],
      research_code: src.research_code,
      patient_code: src.patient_code,
      admission_date: src.admission_date,
      in_source: true,
      first_seen_at: prev?.first_seen_at || now,
      change_seq: changeSeq,
      demo_seq: demoSeq,
      changed_at: changedAt,
      list_rows: listRows,
      parts,
    };
  }

  return {
    version: LEDGER_VERSION,
    updated_at: now,
    encounters,
    unmatched_progress: unmatched.length,
    ambiguous_progress: unmatched.filter(u => u.ambiguous).length,
  };
}

function isStale(enc, key) {
  const p = enc?.parts?.[key];
  if (!p || !DONE_STATUSES.has(p.status)) return false;
  if ((Number(p.seen_seq) || 0) < (Number(enc.change_seq) || 0)) return true;
  if (key === 'profile' && (Number(p.seen_demo_seq) || 0) < (Number(enc.demo_seq) || 0)) return true;
  return false;
}

function partIsCurrent(enc, key) {
  const p = enc?.parts?.[key];
  return Boolean(p && DONE_STATUSES.has(p.status) && !isStale(enc, key));
}

// Sau khi chạy worker: phần đã giao mà không có kết quả mới → lỗi no_result (tính 1 lần thử),
// để không lặp lại mãi một phần worker lặng lẽ bỏ qua.
function applyDispatchOutcome(before, after, dispatched = [], now = nowIso()) {
  for (const { key, part: partKey } of dispatched) {
    const enc = after?.encounters?.[key];
    const prevPart = before?.encounters?.[key]?.parts?.[partKey];
    const cur = enc?.parts?.[partKey];
    if (!enc || !cur) continue;
    const gotNew = (cur.result_at || '') !== (prevPart?.result_at || '');
    if (gotNew) continue;
    if (DONE_STATUSES.has(cur.status) && !isStale(enc, partKey)) continue;
    // result_at giữ nguyên mốc của progress: lần dựng sổ sau chỉ ghi đè khi worker
    // thật sự có kết quả mới.
    enc.parts[partKey] = {
      ...cur,
      status: 'failed',
      reason: 'no_result',
      detail: 'Đã giao cho worker nhưng không nhận được kết quả mới cho phần này',
      attempts: (Number(cur.attempts) || 0) + 1,
      no_result_at: now,
    };
  }
  return after;
}

// ── So sánh nội dung & phiên bản ─────────────────────────────────────────────
// Khi lấy lại một phần đã có, so dữ liệu mới với bản trước: giống thì chỉ ghi nhận
// "đã kiểm tra, không đổi"; khác thì tăng số phiên bản và trả về các dòng lịch sử
// (bản cũ + bản mới) để ghi vào file chỉ-thêm. Không ghi đè mất dấu bản cũ.

// Cột không phản ánh nội dung lâm sàng/hành chính (mã nội bộ, nguồn, URL phiên...).
const VOLATILE_COLUMNS = new Set([
  'source_run_id', 'raw json', 'nguồn input', 'nguồn', 'url bác sĩ', 'url điều dưỡng', 'url',
  'research key', 'mã nc', 'row_hash',
]);

function rowFingerprint(row) {
  const entries = Object.entries(row || {})
    .filter(([k, v]) => !VOLATILE_COLUMNS.has(String(k).trim().toLowerCase()) && String(v ?? '').trim() !== '')
    .map(([k, v]) => [String(k).trim(), String(v).replace(/\s+/g, ' ').trim()])
    .sort((a, b) => a[0].localeCompare(b[0]));
  return JSON.stringify(entries);
}

function contentHash(rows) {
  const prints = (rows || []).map(rowFingerprint).sort();
  return crypto.createHash('sha1').update(prints.join('\n')).digest('hex').slice(0, 16);
}

function diffRowSets(oldRows, newRows) {
  const count = rows => {
    const m = new Map();
    for (const r of rows || []) { const f = rowFingerprint(r); m.set(f, (m.get(f) || 0) + 1); }
    return m;
  };
  const a = count(oldRows);
  const b = count(newRows);
  let added = 0;
  let removed = 0;
  for (const [f, n] of b) added += Math.max(0, n - (a.get(f) || 0));
  for (const [f, n] of a) removed += Math.max(0, n - (b.get(f) || 0));
  return { added, removed };
}

// targets: [{key, part}] đã giao cho worker. beforeRows/afterRows: Map "key|part" → rows
// (dữ liệu của phần đó ngay trước và sau khi lấy). Sửa trực tiếp các phần trong `after`.
// Khóa định danh ổn định: cùng lượt + phần + số phiên bản + nội dung → cùng id. Chạy lại
// (khôi phục sau khi dừng) sinh đúng các id cũ nên có thể bỏ qua dòng đã ghi, không trùng.
function versionId(v) {
  return `${v.key}|${v.part}|v${v.version}|${v.content_hash}`;
}

function changeId(c) {
  return `${c.key}|${c.part}|v${c.from_version}>v${c.to_version}|${c.to_hash}`;
}

// targets: [{key, part}] đã giao cho worker. beforeRows/afterRows: Map "key|part" → rows
// (dữ liệu của phần đó ngay trước và sau khi lấy). Sửa trực tiếp các phần trong `after`.
// beforeRows là ảnh chụp đĩa lúc chuẩn bị giao dịch nên là "bản trước" đáng tin nhất.
function applyContentVersions({ before, after, targets = [], beforeRows = new Map(), afterRows = new Map(), reasons = {}, now = nowIso() } = {}) {
  const out = { changes: [], versions: [], rechecked: 0, unchanged: 0, first: 0 };
  const seen = new Set();
  for (const { key, part: partKey } of targets) {
    const id = `${key}|${partKey}`;
    if (seen.has(id)) continue;
    seen.add(id);
    const enc = after?.encounters?.[key];
    const pa = enc?.parts?.[partKey];
    const pb = before?.encounters?.[key]?.parts?.[partKey];
    if (!pa) continue;
    const gotNew = (pa.result_at || '') !== (pb?.result_at || '');
    const checked = gotNew && DONE_STATUSES.has(pa.status);
    const newRows = afterRows.get(id) || [];
    const oldRows = beforeRows.get(id) || [];
    const newHash = contentHash(newRows);
    const hadPrevious = Boolean(pb?.content_hash) || DONE_STATUSES.has(pb?.status) || oldRows.length > 0;
    const prevHash = beforeRows.has(id) ? contentHash(oldRows) : (pb?.content_hash || contentHash([]));
    // Dữ liệu trên đĩa đã đổi dù worker chưa kịp ghi progress (dừng giữa CSV và progress)
    // vẫn phải được lưu phiên bản, không được âm thầm thay bản cũ.
    const rowsChanged = hadPrevious && prevHash !== newHash;
    if (!checked && !rowsChanged) continue;
    // Mốc kiểm tra = lúc worker thật sự đọc EMR (result_at), không phải lúc ghi sổ.
    const checkedAt = pa.result_at || now;
    if (!hadPrevious) {
      Object.assign(pa, { content_hash: newHash, content_version: 1, last_check_outcome: 'first', last_check_at: checkedAt });
      out.first += 1;
      continue;
    }
    const baseVersion = Number(pb?.content_version) || 1;
    if (checked) out.rechecked += 1;
    if (!rowsChanged) {
      Object.assign(pa, { content_hash: newHash, content_version: baseVersion, last_check_outcome: 'unchanged', last_check_at: checkedAt });
      out.unchanged += 1;
      continue;
    }
    const nextVersion = baseVersion + 1;
    const common = { key, research_code: enc.research_code || '', part: partKey };
    if ((Number(pb?.history_stored_version) || 0) < baseVersion) {
      const v = { ...common, version: baseVersion, content_hash: prevHash, captured_at: pb?.last_check_at || pb?.result_at || '', role: 'before_change', rows: oldRows };
      out.versions.push({ version_id: versionId(v), ...v });
    }
    const vNew = { ...common, version: nextVersion, content_hash: newHash, captured_at: checkedAt, role: 'after_change', rows: newRows };
    out.versions.push({ version_id: versionId(vNew), ...vNew });
    const diff = diffRowSets(oldRows, newRows);
    const change = {
      ...common,
      part_label: PARTS.find(x => x.key === partKey)?.label || partKey,
      from_version: baseVersion,
      to_version: nextVersion,
      rows_added: diff.added,
      rows_removed: diff.removed,
      trigger: reasons[id] || (checked ? '' : 'detected_on_disk'),
      changed_at: checkedAt,
      to_hash: newHash,
    };
    out.changes.push({ change_id: changeId(change), ...change });
    Object.assign(pa, {
      content_hash: newHash, content_version: nextVersion, content_changed_at: checkedAt, history_stored_version: nextVersion,
      ...(checked ? { last_check_outcome: 'changed', last_check_at: checkedAt } : { last_check_outcome: 'changed_unconfirmed' }),
    });
  }
  return out;
}

// ── Kế hoạch lấy bù ──────────────────────────────────────────────────────────

// Chính sách làm mới RIÊNG từng phần: số ngày tối đa kể từ lần kiểm tra gần nhất.
// Phần không có trong chính sách thì không tự kiểm tra lại (chỉ khi danh sách EMR đổi
// hoặc người dùng chọn Làm mới) — không có một khoảng thời gian chung cho mọi loại.
function sanitizeRefreshPolicy(input) {
  const src = input && typeof input === 'object' ? input : {};
  const out = {};
  for (const k of PART_KEYS) {
    const n = Number(src[k]);
    if (Number.isFinite(n) && n >= 1 && n <= 3650) out[k] = Math.trunc(n);
  }
  return out;
}

function lastCheckedAt(p) {
  return String(p?.last_check_at || p?.result_at || '');
}

function refreshDue(p, days, now) {
  if (!days) return false;
  const at = Date.parse(lastCheckedAt(p));
  if (!Number.isFinite(at)) return true; // không rõ lần kiểm tra → coi như quá hạn
  return (Date.parse(now) - at) >= days * 86400000;
}

function planCollection(ledger, {
  keys = null, maxAttempts = DEFAULT_MAX_ATTEMPTS, parts = PART_KEYS, retryBlocked = false, force = false,
  refreshPolicy = {}, refreshParts = [], refreshKeys = null, now = nowIso(),
} = {}) {
  const policy = sanitizeRefreshPolicy(refreshPolicy);
  const manual = new Set((refreshParts || []).filter(k => PART_KEYS.includes(k)));
  const manualKeys = refreshKeys ? new Set(refreshKeys) : null;
  const scope = keys ? [...keys] : Object.keys(ledger?.encounters || {}).filter(k => ledger.encounters[k].in_source !== false);
  const tasks = [];
  const summary = {
    encounters: scope.length, unchanged: 0, to_fetch: 0, new_encounters: 0, parts_to_fetch: 0,
    by_reason: {}, exhausted_parts: 0, blocked_parts: 0, deferred_encounters: 0, refresh_parts: 0,
  };
  for (const key of scope) {
    const enc = ledger?.encounters?.[key];
    if (!enc) continue;
    const needs = {};
    let deferredOnly = true;
    let allCurrent = true;
    const isNew = PART_KEYS.every(k => (enc.parts?.[k]?.status || 'pending') === 'pending' && !enc.parts?.[k]?.result_at);
    for (const k of parts) {
      const p = enc.parts?.[k] || { status: 'pending', reason: 'missing' };
      if (DONE_STATUSES.has(p.status)) {
        if (force) { needs[k] = 'forced'; deferredOnly = false; allCurrent = false; continue; }
        if (isStale(enc, k)) { needs[k] = 'changed'; deferredOnly = false; allCurrent = false; continue; }
        if (manual.has(k) && (!manualKeys || manualKeys.has(key))) {
          needs[k] = 'manual_refresh'; deferredOnly = false; summary.refresh_parts += 1; continue;
        }
        if (refreshDue(p, policy[k], now)) {
          needs[k] = 'refresh_due'; deferredOnly = false; summary.refresh_parts += 1;
        }
        continue;
      }
      allCurrent = false;
      if (p.status === 'pending') {
        needs[k] = isNew ? 'new' : (p.reason === 'legacy_empty_unverified' || p.reason === 'interrupted' ? p.reason : 'missing');
        deferredOnly = false;
      } else if (p.status === 'failed') {
        const manualHere = manual.has(k) && (!manualKeys || manualKeys.has(key));
        if ((Number(p.attempts) || 0) >= maxAttempts && !force) {
          // Hết lượt tự thử lại: chỉ thử tiếp khi người dùng chủ động chọn Làm mới.
          if (manualHere) { needs[k] = 'manual_refresh'; deferredOnly = false; continue; }
          summary.exhausted_parts += 1;
          continue;
        }
        needs[k] = p.reason === 'not_found' ? 'not_found' : 'retry';
        if (p.reason !== 'not_found') deferredOnly = false;
      } else if (p.status === 'blocked') {
        summary.blocked_parts += 1;
        if (retryBlocked || force) { needs[k] = 'review_retry'; deferredOnly = false; }
      }
    }
    const partList = Object.keys(needs);
    if (!partList.length) {
      if (allCurrent) summary.unchanged += 1;
      continue;
    }
    // Chỉ kiểm tra lại định kỳ/làm mới (dữ liệu vẫn đủ) thì vẫn tính là lượt không đổi
    // cho tới khi so sánh thấy khác.
    const refreshOnly = partList.every(k => needs[k] === 'refresh_due' || needs[k] === 'manual_refresh');
    const deferred = deferredOnly;
    tasks.push({ key, research_code: enc.research_code, patient_code: enc.patient_code, parts: partList, reasons: needs, deferred, is_new: isNew, refresh_only: refreshOnly && allCurrent });
    summary.to_fetch += 1;
    if (isNew) summary.new_encounters += 1;
    if (deferred) summary.deferred_encounters += 1;
    summary.parts_to_fetch += partList.length;
    for (const r of Object.values(needs)) summary.by_reason[r] = (summary.by_reason[r] || 0) + 1;
  }
  // Ca chỉ còn "không tìm thấy BN" để cuối: chỉ tìm lại sau khi các ca khác đã xong.
  tasks.sort((a, b) => Number(a.deferred) - Number(b.deferred));
  return { tasks, summary };
}

// Gom task theo nhóm worker để gọi đúng fetcher với đúng phần.
function groupTasksByFetcher(tasks = []) {
  const fetcherOf = Object.fromEntries(PARTS.map(p => [p.key, p.fetcher]));
  const groups = { xn_cdha: [], hchanh: new Map(), order_history: [] };
  for (const t of tasks) {
    const xnParts = t.parts.filter(p => fetcherOf[p] === 'xn_cdha');
    const hcParts = t.parts.filter(p => fetcherOf[p] === 'hchanh').sort();
    if (xnParts.length) groups.xn_cdha.push({ ...t, parts: xnParts });
    if (hcParts.length) {
      const sig = hcParts.join(',');
      if (!groups.hchanh.has(sig)) groups.hchanh.set(sig, []);
      groups.hchanh.get(sig).push({ ...t, parts: hcParts });
    }
    if (t.parts.includes('order_history')) groups.order_history.push({ ...t, parts: ['order_history'] });
  }
  return groups;
}

// ── Báo cáo vận hành ─────────────────────────────────────────────────────────

function exceptionRows(ledger, { keys = null, maxAttempts = DEFAULT_MAX_ATTEMPTS, unmatchedEncounters = [] } = {}) {
  const scope = keys ? new Set(keys) : null;
  const out = [];
  for (const [key, enc] of Object.entries(ledger?.encounters || {})) {
    if (enc.in_source === false) continue;
    if (scope && !scope.has(key)) continue;
    for (const k of PART_KEYS) {
      const p = enc.parts?.[k];
      if (!p || !['failed', 'blocked'].includes(p.status)) continue;
      const exhausted = p.status === 'failed' && (Number(p.attempts) || 0) >= maxAttempts;
      out.push({
        key,
        research_code: enc.research_code || '',
        patient_code: enc.patient_code || '',
        part: k,
        part_label: PARTS.find(x => x.key === k)?.label || k,
        status: p.status,
        reason: p.reason || '',
        reason_label: REASON_LABELS[p.reason] || p.reason || '',
        detail: scrubDetail(p.detail),
        attempts: Number(p.attempts) || 0,
        auto_retry: p.status === 'failed' && !exhausted ? 'yes' : 'no',
        category: p.status === 'blocked'
          ? (IDENTITY_REASONS.has(p.reason) ? 'unmatched' : 'needs_review')
          : (exhausted ? 'retry_exhausted' : 'selenium_error'),
        updated_at: p.no_result_at || p.result_at || '',
      });
    }
  }
  for (const u of unmatchedEncounters || []) {
    if (scope && u.key && !scope.has(u.key)) continue;
    out.push({
      key: u.key || u.encounter_id || '',
      research_code: u.research_code || '',
      patient_code: u.patient_code || '',
      part: 'encounter_match',
      part_label: 'Ghép lượt điều trị',
      status: 'blocked',
      reason: 'encounter_not_identified',
      reason_label: REASON_LABELS.encounter_not_identified,
      detail: scrubDetail(u.detail),
      attempts: 0,
      auto_retry: 'no',
      category: 'unmatched',
      updated_at: '',
    });
  }
  const order = { unmatched: 0, needs_review: 1, retry_exhausted: 2, selenium_error: 3 };
  out.sort((a, b) => (order[a.category] - order[b.category]) || String(a.research_code).localeCompare(String(b.research_code)));
  return out;
}

function buildRunReport({ before, after, plan, keys = null, maxAttempts = DEFAULT_MAX_ATTEMPTS, unmatchedEncounters = [], startedAt = '', finishedAt = nowIso(), cancelled = false, errors = [], content = null, readinessChanges = [] } = {}) {
  const scope = keys ? [...keys] : Object.keys(after?.encounters || {}).filter(k => after.encounters[k].in_source !== false);
  const planned = new Map((plan?.tasks || []).map(t => [t.key, t]));
  let fetchedEncounters = 0;
  let newParts = 0;
  let backfilledParts = 0;
  for (const [key, task] of planned.entries()) {
    const encAfter = after?.encounters?.[key];
    if (!encAfter) continue;
    let gotAny = false;
    for (const k of task.parts) {
      const pb = before?.encounters?.[key]?.parts?.[k];
      const pa = encAfter.parts?.[k];
      const newResult = (pa?.result_at || '') !== (pb?.result_at || '');
      if (newResult && partIsCurrent(encAfter, k)) {
        gotAny = true;
        const reason = task.reasons?.[k];
        if (reason === 'refresh_due' || reason === 'manual_refresh') continue; // kiểm tra lại, không phải lấy bù
        if (task.is_new) newParts += 1; else backfilledParts += 1;
      }
    }
    if (gotAny) fetchedEncounters += 1;
  }
  const exceptions = exceptionRows(after, { keys: scope, maxAttempts, unmatchedEncounters });
  const count = cat => exceptions.filter(e => e.category === cat);
  const encCount = rows => new Set(rows.map(r => r.key)).size;
  const seleniumOpen = exceptions.filter(e => e.category === 'selenium_error' || e.category === 'retry_exhausted');
  let complete = 0;
  for (const key of scope) {
    const enc = after?.encounters?.[key];
    if (enc && PART_KEYS.every(k => partIsCurrent(enc, k))) complete += 1;
  }
  return {
    started_at: startedAt,
    finished_at: finishedAt,
    cancelled: Boolean(cancelled),
    encounters_total: scope.length,
    encounters_complete: complete,
    fetched_encounters: fetchedEncounters,
    skipped_unchanged: plan?.summary?.unchanged || 0,
    new_encounters: plan?.summary?.new_encounters || 0,
    parts_new: newParts,
    parts_backfilled: backfilledParts,
    selenium_errors_open: seleniumOpen.length,
    selenium_error_encounters: encCount(seleniumOpen),
    retry_exhausted: count('retry_exhausted').length,
    unmatched_encounters: encCount(count('unmatched')),
    needs_review: count('needs_review').length,
    exceptions_total: exceptions.length,
    parts_rechecked: content?.rechecked || 0,
    parts_rechecked_unchanged: content?.unchanged || 0,
    parts_changed: (content?.changes || []).length,
    changes: (content?.changes || []).slice(0, 500),
    readiness_changes: (readinessChanges || []).slice(0, 500),
    plan_summary: plan?.summary || null,
    errors: (errors || []).map(e => scrubDetail(String(e).split('\n')[0])),
    exceptions,
  };
}

// ── "Đủ dùng" theo từng nghiên cứu ───────────────────────────────────────────
// Không có nhãn đủ/thiếu chung cho người bệnh: mỗi nghiên cứu có phần bắt buộc và
// điều kiện dữ liệu riêng (ví dụ phải có CT). Kết quả mỗi lượt:
//   usable        đủ dùng cho nghiên cứu này
//   not_eligible  đã lấy đủ phần bắt buộc nhưng EMR không có dữ liệu đề tài yêu cầu
//   incomplete    phần bắt buộc chưa lấy xong / lỗi đang chờ thử lại / đã đổi trên EMR
//   needs_review  phần bắt buộc bị chặn (cần người xem) hoặc không ghép chắc lượt

const TABLE_PARTS = {
  lab_results: ['xn'],
  imaging_results: ['cdha'],
  surgery_results: ['surgery'],
  medication_orders: ['order_history'],
  medication_day_summary: ['order_history'],
  clinical_notes: ['order_history'],
  patients: ['profile'],
  patient_master: ['profile'],
  encounters: ['profile', 'discharge'],
  diagnoses: ['profile', 'discharge'],
  analysis_ready: ['profile', 'discharge'],
  patient_day: ['xn', 'cdha', 'order_history'],
};

const ITEM_KINDS = {
  lab_item: { table: 'lab_results', part: 'xn', label: 'Xét nghiệm' },
  imaging_modality: { table: 'imaging_results', part: 'cdha', label: 'CĐHA' },
  procedure_item: { table: 'surgery_results', part: 'surgery', label: 'Phẫu thuật' },
  drug_item: { table: 'medication_orders', part: 'order_history', label: 'Thuốc' },
  drug_group: { table: 'medication_orders', part: 'order_history', label: 'Nhóm thuốc' },
};

function sanitizeDataRequirements(input) {
  const src = input && typeof input === 'object' ? input : {};
  const parts = Array.isArray(src.parts) ? [...new Set(src.parts.map(String).filter(p => PART_KEYS.includes(p)))] : [];
  const items = Array.isArray(src.items) ? src.items.slice(0, 50).map(it => ({
    kind: ITEM_KINDS[String(it?.kind || '')] ? String(it.kind) : '',
    value: String(it?.value ?? '').trim().slice(0, 120),
    label: String(it?.label || it?.value || '').trim().slice(0, 160),
  })).filter(it => it.kind) : [];
  return { parts, items, max_attempts: Number.isInteger(src.max_attempts) && src.max_attempts > 0 && src.max_attempts <= 10 ? src.max_attempts : undefined };
}

function requirementsFromStudy(study) {
  const explicit = study?.data_requirements;
  if (explicit && ((explicit.parts || []).length || (explicit.items || []).length)) {
    const clean = sanitizeDataRequirements(explicit);
    const parts = new Set(clean.parts);
    for (const it of clean.items) parts.add(ITEM_KINDS[it.kind].part);
    return { source: 'explicit', parts: [...parts], items: clean.items, conditions: [] };
  }
  const selection = study?.variable_selection || study?.analysis_config?.variable_selection || null;
  if (variableSelection.hasActiveSelection(selection)) {
    const parts = new Set();
    for (const v of [...(selection.selected_variables || []), ...(selection.conditions || [])]) {
      for (const p of TABLE_PARTS[String(v.table || '')] || []) parts.add(p);
    }
    // Chỉ điều kiện chọn mẫu (không phải biến kết cục) mới đòi dữ liệu phải CÓ.
    const conditions = (selection.conditions || []).filter(c => c.table && TABLE_PARTS[c.table] && String(c.operator || '') !== 'empty');
    return { source: 'variables', parts: parts.size ? [...parts] : [...PART_KEYS], items: [], conditions };
  }
  return { source: 'default', parts: [...PART_KEYS], items: [], conditions: [] };
}

function itemPresent(item, rows) {
  const needle = clean(item.value);
  return (rows || []).some(row => {
    if (item.kind === 'lab_item') return !needle || clean([cell(row, ['test_name_norm']), cell(row, ['test_name_raw'])].join(' ')).includes(needle);
    if (item.kind === 'imaging_modality') return !needle || clean(cell(row, ['modality'])) === needle || clean(cell(row, ['service_name_raw'])).includes(needle);
    if (item.kind === 'procedure_item') return !needle || clean([cell(row, ['surgery_name']), cell(row, ['surgery_method'])].join(' ')).includes(needle);
    if (item.kind === 'drug_item') return !needle || clean([cell(row, ['drug_name_norm']), cell(row, ['drug_name_raw'])].join(' ')).includes(needle);
    if (item.kind === 'drug_group') return !needle || clean(cell(row, ['drug_group_guess'])).includes(needle);
    return false;
  });
}

function indexRowsByEncounter(rows) {
  const byEnc = new Map();
  const byCode = new Map();
  for (const row of rows || []) {
    const e = cell(row, ['encounter_id']);
    const rc = cell(row, ['research_code']);
    if (e) { if (!byEnc.has(e)) byEnc.set(e, []); byEnc.get(e).push(row); }
    if (rc) { if (!byCode.has(rc)) byCode.set(rc, []); byCode.get(rc).push(row); }
  }
  return { byEnc, byCode };
}

function evaluateStudyReadiness({ ledger, keys = null, requirements, tables = {}, maxAttempts = DEFAULT_MAX_ATTEMPTS } = {}) {
  const req = requirements || { parts: PART_KEYS, items: [], conditions: [] };
  const scope = keys ? [...keys] : Object.keys(ledger?.encounters || {}).filter(k => ledger.encounters[k].in_source !== false);
  const encounterRows = tables.encounters || [];
  const encByCode = new Map();
  const encById = new Map();
  for (const row of encounterRows) {
    const rc = cell(row, ['research_code']);
    const id = cell(row, ['encounter_id']);
    if (rc) encByCode.set(rc, row);
    if (id) encById.set(id, row);
  }
  const indexes = {};
  for (const [name, rows] of Object.entries(tables)) indexes[name] = indexRowsByEncounter(rows);
  const rowsFor = (table, encounterId, researchCode) => {
    const idx = indexes[table];
    if (!idx) return [];
    return (encounterId && idx.byEnc.get(encounterId)) || (researchCode && idx.byCode.get(researchCode)) || [];
  };

  const rows = [];
  const counts = { usable: 0, not_eligible: 0, incomplete: 0, needs_review: 0 };
  for (const key of scope) {
    const enc = ledger?.encounters?.[key];
    if (!enc) continue;
    const encRow = encByCode.get(enc.research_code) || encById.get(key) || null;
    const encounterId = cell(encRow, ['encounter_id']) || key;
    const reasons = [];
    const missingParts = [];
    const reviewParts = [];
    for (const p of req.parts) {
      const st = enc.parts?.[p];
      if (partIsCurrent(enc, p)) continue;
      if (st?.status === 'blocked') reviewParts.push(p);
      else missingParts.push(p);
    }
    const matchText = cell(encRow, ['needs_manual_review']);
    const matchUnsafe = /encounter_match_(?:ambiguous|missing)|enc_unresolved/.test(`${matchText} ${encounterId}`);
    let status;
    if (reviewParts.length || matchUnsafe) {
      status = 'needs_review';
      if (reviewParts.length) reasons.push(`Cần người xem: ${reviewParts.map(p => PARTS.find(x => x.key === p)?.label || p).join(', ')}`);
      if (matchUnsafe) reasons.push('Không ghép chắc lượt điều trị');
    } else if (missingParts.length) {
      status = 'incomplete';
      const exhausted = missingParts.filter(p => enc.parts?.[p]?.status === 'failed' && (Number(enc.parts[p].attempts) || 0) >= maxAttempts);
      reasons.push(`Chưa lấy xong: ${missingParts.map(p => PARTS.find(x => x.key === p)?.label || p).join(', ')}`);
      if (exhausted.length) reasons.push(`Đã hết lượt tự thử lại: ${exhausted.map(p => PARTS.find(x => x.key === p)?.label || p).join(', ')}`);
    } else {
      const absent = [];
      for (const item of req.items || []) {
        const def = ITEM_KINDS[item.kind];
        if (!itemPresent(item, rowsFor(def.table, encounterId, enc.research_code))) absent.push(item.label || item.value || def.label);
      }
      for (const cond of req.conditions || []) {
        const condRows = rowsFor(cond.table, encounterId, enc.research_code);
        if (!variableSelection.conditionMatchesRows(cond, condRows)) absent.push(cond.label || cond.name);
      }
      if (absent.length) {
        status = 'not_eligible';
        reasons.push(`EMR không có dữ liệu đề tài yêu cầu: ${absent.join(', ')}`);
      } else {
        status = 'usable';
      }
    }
    counts[status] += 1;
    rows.push({
      key,
      encounter_id: encounterId,
      research_code: enc.research_code || '',
      readiness: status,
      reasons: reasons.join('; '),
      missing_parts: missingParts.join(';'),
      review_parts: reviewParts.join(';'),
    });
  }
  return { requirements: req, counts, total: rows.length, rows };
}

module.exports = {
  LEDGER_VERSION,
  DEFAULT_MAX_ATTEMPTS,
  PARTS,
  PART_KEYS,
  REASON_LABELS,
  scrubDetail,
  listRowSignature,
  mergeSignatures,
  buildCollectionUnits,
  parseSignatures,
  classifyFetchStatus,
  classifyXnTab,
  classifyHchanhFile,
  matchXnEntriesToSources,
  buildLedger,
  applyDispatchOutcome,
  isStale,
  partIsCurrent,
  sanitizeRefreshPolicy,
  refreshDue,
  contentHash,
  diffRowSets,
  applyContentVersions,
  versionId,
  changeId,
  planCollection,
  groupTasksByFetcher,
  exceptionRows,
  buildRunReport,
  sanitizeDataRequirements,
  requirementsFromStudy,
  evaluateStudyReadiness,
};
