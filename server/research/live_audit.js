'use strict';

// Đối chiếu tự động với EMR: chọn ngẫu nhiên một đợt đã lấy đủ và đã chuẩn hóa trong kho gốc, lấy
// lại đúng người bệnh đó từ EMR vào một thư mục RIÊNG (kiem_tra_ngau_nhien/runs/<id>), chuẩn hóa thư
// mục đó (không lấy bù từ Kho người bệnh, để thấy đúng EMR hôm nay), rồi so từng loại dữ liệu với kho.
//
// Không ghi gì vào kho gốc ngoài kết quả đối chiếu (audit/live.json); không ghi vào kho dùng chung.
// Lưu ý: hai bên đi qua cùng bước chuẩn hóa, nên cách này bắt được dữ liệu lấy thiếu/thừa/cũ; lỗi
// logic chuẩn hóa dùng chung cho cả hai bên thì cần Kiểm tra ngẫu nhiên bằng tay.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { readCsvTable, patientCode, writeCsvUnion } = require('./table_io');
const { readJsonSafe, writeJsonAtomic } = require('../utils/file');
const { parseAnyDate, firstNonEmpty } = require('./encounter_context');
const { nowIso } = require('./store_paths');
const { compareCase, KIND_LABELS } = require('./live_audit_compare');
const { wilson } = require('./audit_sample');

const LIVE_PROJECT = 'kiem_tra_ngau_nhien';
const STORE_FILE = path.join('audit', 'live.json');
// v2: worker Lịch sử y lệnh đọc độc lập Thuốc/T-VT và Y lệnh khác.
// Kết quả v1 có thể báo "kho thừa" giả (ca Sismyodin) nên không được cộng vào tỉ lệ mới.
const LIVE_AUDIT_VERSION = 2;
const HCHANH_FILES = ['profile', 'discharge', 'surgery', 'order_history'];
const DAY_MS = 86400000;
const TABLES = {
  labs: 'lab_results.csv',
  imaging: 'imaging_results.csv',
  medications: 'medication_orders.csv',
  surgeries: 'surgery_results.csv',
};

function text(v) { return String(v ?? '').trim(); }
function fail(message, status = 400) {
  const err = new Error(message);
  err.status = status;
  return err;
}
function rowsOf(dir, file) {
  return readCsvTable(path.join(dir, file), Number.MAX_SAFE_INTEGER).rows || [];
}

function storePath(runDir) { return path.join(runDir, STORE_FILE); }
function readStore(runDir) {
  const data = readJsonSafe(storePath(runDir), null);
  return data && typeof data === 'object' && data.audits ? data : { audits: {} };
}
function patchAudit(runDir, id, patch) {
  const store = readStore(runDir);
  store.audits[id] = { ...(store.audits[id] || { id }), ...patch, updated_at: nowIso() };
  fs.mkdirSync(path.dirname(storePath(runDir)), { recursive: true });
  writeJsonAtomic(storePath(runDir), store);
  return store.audits[id];
}

// Đợt đã lấy đủ mọi phần bắt buộc (extract_status.ready_for_analysis = 1), chưa đối chiếu lần nào.
function pickCandidate(runDir, { random = Math.random, encounterId = '' } = {}) {
  const encounters = rowsOf(runDir, 'encounters.csv').filter(e => text(e.encounter_id) && text(e.patient_code));
  if (encounterId) {
    const enc = encounters.find(e => text(e.encounter_id) === text(encounterId));
    if (!enc) throw fail('Không tìm thấy đợt điều trị này trong kho đã chuẩn hóa.', 404);
    return enc;
  }
  const ready = new Set(rowsOf(runDir, 'extract_status.csv')
    .filter(s => text(s.ready_for_analysis) === '1')
    .map(s => text(s.encounter_id)));
  const pool = encounters.filter(e => ready.has(text(e.encounter_id)));
  if (!pool.length) throw fail('Kho chưa có đợt nào đã lấy đủ và chuẩn hóa xong. Hãy thu thập và chuẩn hóa trước khi đối chiếu.');
  const done = new Set(Object.values(readStore(runDir).audits).map(a => text(a.encounter_id)));
  const fresh = pool.filter(e => !done.has(text(e.encounter_id)));
  const list = fresh.length ? fresh : pool;
  return list[Math.floor(random() * list.length)];
}

function windowOf(enc) {
  const start = parseAnyDate(enc?.admission_date);
  const end = parseAnyDate(enc?.discharge_date);
  return { start: start ? start.getTime() : null, end: end ? end.getTime() : null };
}

// Các dòng danh sách nguồn của người bệnh rơi vào đợt (mỗi khoa/lần chuyển khoa một dòng).
function sourceRowsFor(runDir, enc) {
  const code = text(enc.patient_code);
  let rows = rowsOf(runDir, 'research_source.csv');
  if (!rows.length) rows = rowsOf(runDir, 'du_lieu_ban_dau.csv');
  const mine = rows.filter(r => text(patientCode(r)) === code);
  const win = windowOf(enc);
  if (win.start == null) return mine;
  const end = (win.end == null ? win.start : win.end) + DAY_MS;
  const inStay = mine.filter(r => {
    const t = parseAnyDate(firstNonEmpty(r, ['Ngày vào viện', 'T/G vào', 'TG vào', 'admission_date']));
    return t && t.getTime() >= win.start - DAY_MS && t.getTime() <= end;
  });
  return inStay.length ? inStay : mine;
}

function sliceFor(dir, enc) {
  const id = text(enc?.encounter_id);
  const out = { encounter: enc || null };
  for (const [kind, file] of Object.entries(TABLES)) out[kind] = id ? rowsOf(dir, file).filter(r => text(r.encounter_id) === id) : [];
  return out;
}

// Đợt trong bản lấy lại ứng với đợt của kho: cùng ngày vào, nếu không thì chồng thời gian nhiều nhất.
function matchingEncounter(dir, enc) {
  const code = text(enc.patient_code);
  const list = rowsOf(dir, 'encounters.csv').filter(e => text(e.patient_code) === code);
  const day = text(enc.admission_date).slice(0, 10);
  const same = list.find(e => text(e.admission_date).slice(0, 10) === day);
  if (same) return same;
  const w = windowOf(enc);
  let best = null;
  let bestOverlap = 0;
  for (const e of list) {
    const x = windowOf(e);
    if (w.start == null || x.start == null) continue;
    const overlap = Math.min(w.end ?? w.start, x.end ?? x.start) - Math.max(w.start, x.start);
    if (overlap >= 0 && (best == null || overlap > bestOverlap)) { best = e; bestOverlap = overlap; }
  }
  return best;
}

// Lỗi khi lấy lại: không so một bản lấy hỏng (sẽ ra "kho thừa" giả).
function fetchProblems(auditDir, results) {
  const problems = [];
  if (results.hchanh?.cancelled || results.xn?.stopped) problems.push('Đã dừng giữa chừng.');
  const progress = readJsonSafe(path.join(auditDir, 'hchanh_auto_progress.json'), {}) || {};
  const bad = Object.values(progress).filter(p => p && p.status === 'error');
  if (bad.length) problems.push(`Hồ sơ/ra viện/phẫu thuật/y lệnh: ${text(bad[0].error).split('\n')[0].slice(0, 200) || 'lỗi khi lấy'}`);
  if (results.xn?.error) problems.push(`XN/CĐHA: ${text(results.xn.error).split('\n')[0].slice(0, 200)}`);
  return problems;
}

function newId() {
  return `live_${Date.now().toString(36)}_${crypto.randomBytes(3).toString('hex')}`;
}

function liveRunDir(storeRoot, id) {
  return path.join(storeRoot, LIVE_PROJECT, 'runs', id);
}

// Ghi nhận lượt đối chiếu (trạng thái queued) để giao diện thấy ngay; phần chạy ở runLiveAudit.
function startLiveAudit(runDir, { runId = '', encounterId = '', random = Math.random } = {}) {
  const enc = pickCandidate(runDir, { random, encounterId });
  const id = newId();
  return patchAudit(runDir, id, {
    id, run_id: runId, audit_version: LIVE_AUDIT_VERSION, created_at: nowIso(), status: 'queued', step: 'Đang chờ tới lượt mở EMR',
    encounter_id: text(enc.encounter_id), patient_code: text(enc.patient_code),
    research_code: text(enc.research_code), admission_date: text(enc.admission_date), discharge_date: text(enc.discharge_date),
  });
}

async function runLiveAudit(ctx, {
  runDir, id, storeRoot, fromDate = '', toDate = '', headless = true, runners, onStep = () => {},
} = {}) {
  const audit = readStore(runDir).audits[id];
  if (!audit) throw fail('Không tìm thấy lượt đối chiếu.', 404);
  const enc = rowsOf(runDir, 'encounters.csv').find(e => text(e.encounter_id) === audit.encounter_id);
  if (!enc) return patchAudit(runDir, id, { status: 'error', step: '', message: 'Đợt này không còn trong kho (kho vừa chuẩn hóa lại). Hãy chọn ca khác.' });

  // Ảnh chụp phía kho lấy NGAY lúc bắt đầu: chuẩn hóa nền chạy xen giữa (đổi mã đợt) không làm lệch phép so.
  const archiveSlice = sliceFor(runDir, enc);
  const archiveState = readJsonSafe(path.join(runDir, 'normalize_state.json'), {}) || {};
  patchAudit(runDir, id, { archive_normalized_at: text(archiveState.finished_at), archive_schema_version: archiveState.schema_version ?? '' });
  const step = (s) => { patchAudit(runDir, id, { status: 'running', step: s }); onStep(s); };
  const auditDir = liveRunDir(storeRoot, id);
  fs.mkdirSync(auditDir, { recursive: true });
  const rows = sourceRowsFor(runDir, enc);
  if (!rows.length) {
    return patchAudit(runDir, id, { status: 'fetch_error', step: '', finished_at: nowIso(), message: 'Không thấy dòng danh sách nguồn của người bệnh này trong kho (research_source.csv / du_lieu_ban_dau.csv), nên không biết mở EMR ở đợt nào. Ca này không tính; hãy chọn ca khác.' });
  }
  writeCsvUnion(path.join(auditDir, 'research_source.csv'), rows, Object.keys(rows[0] || {}));

  try {
    const results = {};
    step('Đang lấy lại hồ sơ, ra viện, phẫu thuật, y lệnh từ EMR');
    results.hchanh = await runners.hchanh(ctx, {
      runDir: auditDir, sourceRows: rows, sourceRunId: id, files: HCHANH_FILES, headless,
      force: true, recordStore: false, fallbackDateFrom: fromDate, fallbackDateTo: toDate, mode: 'hchanh_auto',
    });
    if (!results.hchanh?.cancelled) {
      step('Đang lấy lại XN và CĐHA từ EMR');
      results.xn = await runners.xnCdha(ctx, {
        runDir: auditDir, runId: id, scope: LIVE_PROJECT, isArchive: false,
        rows: rows.map(r => ({ ...r, refetch_parts: 'xn;cdha' })), fromDate, toDate, headless,
      });
    }
    const problems = fetchProblems(auditDir, results);
    if (problems.length) {
      return patchAudit(runDir, id, {
        status: results.hchanh?.cancelled || results.xn?.stopped ? 'cancelled' : 'fetch_error', step: '', finished_at: nowIso(),
        message: `Không so được vì lấy lại từ EMR chưa trọn: ${problems.join(' ')} Ca này không tính vào tỉ lệ; hãy chạy đối chiếu lại.`,
      });
    }

    step('Đang chuẩn hóa bản vừa lấy và so với kho');
    await runners.normalize(auditDir, { sourceRunId: id, force: true, skipPatientDbOverlay: true });
    const emrEnc = matchingEncounter(auditDir, enc);
    const result = compareCase(archiveSlice, sliceFor(auditDir, emrEnc));
    return patchAudit(runDir, id, {
      status: 'done', step: '', finished_at: nowIso(), emr_encounter_found: Boolean(emrEnc), result,
      message: emrEnc ? '' : 'EMR không trả về đợt điều trị này (mọi dòng của kho tính là kho thừa).',
    });
  } catch (err) {
    patchAudit(runDir, id, { status: 'error', step: '', finished_at: nowIso(), message: `Đối chiếu bị lỗi: ${text(err?.message || err).split('\n')[0].slice(0, 300)}` });
    throw err;
  }
}

function getLiveAudit(runDir, id) {
  const audit = readStore(runDir).audits[id];
  if (!audit) throw fail('Không tìm thấy lượt đối chiếu này. Hãy chọn ca mới.', 404);
  return audit;
}

function summarizeLive(runDir) {
  const audits = Object.values(readStore(runDir).audits).sort((a, b) => text(b.created_at).localeCompare(text(a.created_at)));
  const currentAudits = audits.filter(a => Number(a.audit_version || 0) === LIVE_AUDIT_VERSION);
  const done = currentAudits.filter(a => a.status === 'done' && a.result);
  const kinds = Object.keys(KIND_LABELS).map(kind => {
    const sum = { kind, label: KIND_LABELS[kind], matched: 0, mismatched: 0, archive_only: 0, emr_only: 0 };
    for (const a of done) {
      const r = (a.result.kinds || []).find(k => k.kind === kind);
      if (!r) continue;
      for (const f of ['matched', 'mismatched', 'archive_only', 'emr_only']) sum[f] += r[f] || 0;
    }
    const compared = sum.matched + sum.mismatched + sum.archive_only + sum.emr_only;
    return { ...sum, compared, accuracy: compared ? sum.matched / compared : null, ci95: wilson(sum.matched, compared) };
  });
  const matched = kinds.reduce((s, k) => s + k.matched, 0);
  const compared = kinds.reduce((s, k) => s + k.compared, 0);
  return {
    case_count: done.length,
    all_match_count: done.filter(a => a.result.all_match).length,
    running: currentAudits.find(a => a.status === 'queued' || a.status === 'running') || null,
    kinds,
    overall: { matched, compared, accuracy: compared ? matched / compared : null, ci95: wilson(matched, compared) },
    recent: audits.slice(0, 20).map(a => ({
      id: a.id, created_at: a.created_at, status: a.status, step: a.step || '', message: a.message || '',
      patient_code: a.patient_code, admission_date: a.admission_date, discharge_date: a.discharge_date,
      audit_version: Number(a.audit_version || 0),
      outdated: Number(a.audit_version || 0) !== LIVE_AUDIT_VERSION,
      match_rate: a.result?.overall?.match_rate ?? null, all_match: Boolean(a.result?.all_match),
    })),
  };
}

// Máy chủ khởi động lại giữa lúc đối chiếu: lượt dở dang không bao giờ xong, ghi rõ để chạy lại.
// activeIds: các lượt tiến trình máy chủ hiện tại còn đang giữ (xếp hàng hoặc đang chạy).
function markInterruptedLiveAudits(runDir, activeIds = new Set()) {
  const store = readStore(runDir);
  let changed = 0;
  for (const a of Object.values(store.audits)) {
    if ((a.status === 'queued' || a.status === 'running') && !activeIds.has(a.id)) {
      Object.assign(a, { status: 'cancelled', step: '', message: 'Máy chủ đã khởi động lại khi đang đối chiếu. Hãy chạy đối chiếu lại.', updated_at: nowIso() });
      changed += 1;
    }
  }
  if (changed) writeJsonAtomic(storePath(runDir), store);
  return changed;
}

module.exports = {
  LIVE_PROJECT, STORE_FILE, HCHANH_FILES, LIVE_AUDIT_VERSION,
  pickCandidate, sourceRowsFor, sliceFor, matchingEncounter, liveRunDir,
  startLiveAudit, runLiveAudit, getLiveAudit, summarizeLive, markInterruptedLiveAudits,
};
