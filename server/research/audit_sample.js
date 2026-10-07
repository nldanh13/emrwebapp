'use strict';

// Kiểm tra ngẫu nhiên độ chính xác của kho: chọn ngẫu nhiên một đợt điều trị, lấy vài dòng dữ liệu đã
// ghép vào đợt (và vài dòng của cùng người bệnh KHÔNG được ghép, nằm sát đợt) để người kiểm đối chiếu
// EMR và ghi Đúng / Sai / Không chắc. Kết quả lưu theo từng đợt kho (audit/reviews.json) và cộng dồn
// thành tỉ lệ đạt theo từng loại dữ liệu.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { readCsvTable } = require('./table_io');
const { readJsonSafe, writeJsonAtomic } = require('../utils/file');
const { buildPatientHistory } = require('./patient_history');
const { parseAnyDate } = require('./encounter_context');
const { nowIso } = require('./store_paths');

const AUDIT_FILE = path.join('audit', 'reviews.json');
const VERDICTS = new Set(['dung', 'sai', 'khong_chac', '']);
const PER_KIND = 5;
const UNASSIGNED_MAX = 3;
const NEAR_MS = 7 * 86400000;

const GROUPS = {
  encounter: 'Mốc đợt (vào/ra viện, chẩn đoán)',
  labs: 'Xét nghiệm',
  imaging: 'CĐHA',
  medications: 'Thuốc / y lệnh',
  surgeries: 'Phẫu thuật / thủ thuật',
  unassigned: 'Dòng không gắn vào đợt',
};

const PERIOD_LABELS = {
  emergency_before_ward: 'Cấp cứu, trước vào khoa',
  pre_admission: 'Trước nhập viện',
};

function text(v) { return String(v ?? '').trim(); }
function auditPath(runDir) { return path.join(runDir, AUDIT_FILE); }

function readStore(runDir) {
  const data = readJsonSafe(auditPath(runDir), null);
  return data && typeof data === 'object' && data.audits ? data : { audits: {} };
}

function writeStore(runDir, store) {
  fs.mkdirSync(path.dirname(auditPath(runDir)), { recursive: true });
  writeJsonAtomic(auditPath(runDir), store);
}

function sampleOf(rows, n, random) {
  const pool = rows.slice();
  const out = [];
  while (pool.length && out.length < n) out.push(pool.splice(Math.floor(random() * pool.length), 1)[0]);
  return out;
}

function eventTime(kind, row) {
  const keys = {
    labs: ['lab_datetime', 'lab_date'],
    imaging: ['ordered_at', 'order_date'],
    medications: ['order_datetime', 'order_date'],
    surgeries: ['surgery_datetime', 'surgery_date'],
  }[kind] || [];
  for (const k of keys) if (text(row?.[k])) return text(row[k]);
  return '';
}

function describeRow(kind, row) {
  const at = eventTime(kind, row);
  if (kind === 'labs') return { label: `${at} · ${text(row.test_name_raw) || '—'}`, detail: [text(row.result_raw), text(row.unit)].filter(Boolean).join(' ') };
  if (kind === 'imaging') return { label: `${at} · ${text(row.service_name_raw) || '—'}`, detail: text(row.conclusion_text) };
  if (kind === 'medications') return { label: `${at} · ${text(row.drug_name_raw) || '—'}`, detail: [text(row.dose_raw), text(row.route_norm).replace(/_/g, ' ') || text(row.route_raw)].filter(Boolean).join(' · ') };
  return { label: `${at} · ${text(row.surgery_name) || '—'}`, detail: text(row.surgery_method) };
}

function rowKey(kind, row) {
  return crypto.createHash('sha1').update(JSON.stringify([kind, eventTime(kind, row), describeRow(kind, row)])).digest('hex').slice(0, 12);
}

function encounterWindow(enc) {
  const start = parseAnyDate(enc?.admission_date);
  const end = parseAnyDate(enc?.discharge_date);
  return { start: start ? start.getTime() : null, end: end ? end.getTime() + 86400000 - 1 : null };
}

// Các mục cần kiểm của một đợt: mốc đợt + mẫu ngẫu nhiên từng loại dữ liệu đã ghép + dòng không ghép sát đợt.
function buildItems(enc, unassignedEncs, random) {
  const items = [
    { id: 'enc_admission', group: 'encounter', label: 'Ngày giờ vào viện (bắt đầu đợt, tính cả Cấp cứu)', detail: text(enc.admission_date) || '—', question: 'Đúng với EMR?' },
    { id: 'enc_discharge', group: 'encounter', label: 'Ngày giờ ra viện (kết thúc đợt)', detail: text(enc.discharge_date) || 'Chưa có', question: 'Đúng với EMR?' },
    { id: 'enc_diagnosis', group: 'encounter', label: 'Chẩn đoán của đợt', detail: text(enc.diagnosis_raw) || '—', question: 'Đúng với EMR?' },
  ];
  for (const kind of ['labs', 'imaging', 'medications', 'surgeries']) {
    for (const row of sampleOf(enc[kind] || [], PER_KIND, random)) {
      const d = describeRow(kind, row);
      items.push({
        id: `${kind}_${rowKey(kind, row)}`, group: kind, label: d.label, detail: d.detail,
        period: PERIOD_LABELS[text(row.encounter_match_method)] || 'Trong đợt',
        question: 'Đúng nội dung và đúng thuộc đợt này?',
      });
    }
  }
  const win = encounterWindow(enc);
  const near = [];
  for (const other of unassignedEncs) {
    for (const kind of ['labs', 'imaging', 'medications', 'surgeries']) {
      for (const row of other[kind] || []) {
        const t = parseAnyDate(eventTime(kind, row));
        if (!t || win.start == null) continue;
        const ms = t.getTime();
        const end = win.end == null ? Date.now() : win.end;
        if (ms >= win.start - NEAR_MS && ms <= end + NEAR_MS) near.push({ kind, row });
      }
    }
  }
  for (const { kind, row } of sampleOf(near, UNASSIGNED_MAX, random)) {
    const d = describeRow(kind, row);
    items.push({
      id: `unassigned_${rowKey(kind, row)}`, group: 'unassigned', label: `${GROUPS[kind]}: ${d.label}`, detail: d.detail,
      question: 'Đúng là KHÔNG thuộc đợt này?',
    });
  }
  return items.map(item => ({ ...item, verdict: '', note: '' }));
}

function createAudit(runDir, { random = Math.random, runId = '' } = {}) {
  const encounters = (readCsvTable(path.join(runDir, 'encounters.csv'), Number.MAX_SAFE_INTEGER).rows || [])
    .filter(e => text(e.encounter_id) && text(e.patient_code));
  if (!encounters.length) {
    const err = new Error('Kho chưa có đợt điều trị nào đã chuẩn hóa. Hãy chạy Chuẩn hóa trước khi kiểm tra.');
    err.status = 400;
    throw err;
  }
  const store = readStore(runDir);
  const done = new Set(Object.values(store.audits).map(a => a.encounter_id));
  const pool = encounters.filter(e => !done.has(text(e.encounter_id)));
  const picked = (pool.length ? pool : encounters)[Math.floor(random() * (pool.length || encounters.length))];

  const history = buildPatientHistory(runDir, text(picked.patient_code));
  const patient = (history.patients || []).find(p => text(p.patient_code) === text(picked.patient_code)) || (history.patients || [])[0];
  const encs = patient?.encounters || [];
  const real = encs.filter(e => !e.unmatched);
  const enc = real.find(e => text(e.encounter_id) === text(picked.encounter_id))
    || real.find(e => text(e.admission_date).slice(0, 10) === text(picked.admission_date).slice(0, 10))
    || real[0];
  if (!enc) {
    const err = new Error('Không mở được đợt đã chọn từ dữ liệu chuẩn hóa. Hãy chạy Chuẩn hóa lại rồi chọn ca khác.');
    err.status = 409;
    throw err;
  }

  const id = `aud_${Date.now().toString(36)}_${crypto.randomBytes(3).toString('hex')}`;
  const audit = {
    id, run_id: runId, created_at: nowIso(),
    encounter_id: text(picked.encounter_id),
    patient_code: text(patient?.patient_code || picked.patient_code),
    patient_name: text(patient?.patient_name),
    research_code: text(enc.research_code),
    admission_date: text(enc.admission_date),
    discharge_date: text(enc.discharge_date),
    items: buildItems(enc, encs.filter(e => e.unmatched), random),
  };
  store.audits[id] = audit;
  writeStore(runDir, store);
  return audit;
}

function getAudit(runDir, id) {
  const audit = readStore(runDir).audits[id];
  if (!audit) {
    const err = new Error('Không tìm thấy lượt kiểm tra này (có thể đã bị xoá). Hãy chọn ca mới.');
    err.status = 404;
    throw err;
  }
  return audit;
}

function saveVerdict(runDir, id, itemId, { verdict = '', note = '', reviewer = '' } = {}) {
  if (!VERDICTS.has(verdict)) {
    const err = new Error('Kết quả kiểm chỉ nhận Đúng, Sai hoặc Không chắc.');
    err.status = 400;
    throw err;
  }
  const store = readStore(runDir);
  const audit = store.audits[id];
  const item = audit?.items?.find(x => x.id === itemId);
  if (!item) {
    const err = new Error('Không tìm thấy mục cần lưu. Hãy tải lại lượt kiểm tra.');
    err.status = 404;
    throw err;
  }
  item.verdict = verdict;
  item.note = String(note || '').slice(0, 1000);
  item.reviewed_at = nowIso();
  if (reviewer) item.reviewer = String(reviewer).slice(0, 120);
  audit.updated_at = item.reviewed_at;
  writeStore(runDir, store);
  return audit;
}

// Khoảng tin cậy Wilson 95% cho tỉ lệ đạt (mẫu nhỏ vẫn ổn định hơn ±1,96·SE).
function wilson(pass, n) {
  if (!n) return null;
  const z = 1.96;
  const p = pass / n;
  const den = 1 + (z * z) / n;
  const centre = (p + (z * z) / (2 * n)) / den;
  const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / den;
  return { low: Math.max(0, centre - half), high: Math.min(1, centre + half) };
}

function summarize(runDir) {
  const audits = Object.values(readStore(runDir).audits).sort((a, b) => text(b.created_at).localeCompare(text(a.created_at)));
  const groups = Object.fromEntries(Object.keys(GROUPS).map(g => [g, { group: g, label: GROUPS[g], dung: 0, sai: 0, khong_chac: 0, pending: 0 }]));
  const failures = [];
  for (const audit of audits) {
    for (const item of audit.items || []) {
      const g = groups[item.group];
      if (!g) continue;
      if (item.verdict === 'dung') g.dung += 1;
      else if (item.verdict === 'sai') {
        g.sai += 1;
        failures.push({ audit_id: audit.id, patient_code: audit.patient_code, admission_date: audit.admission_date, group: item.group, group_label: GROUPS[item.group], label: item.label, detail: item.detail, note: item.note, reviewed_at: item.reviewed_at || '' });
      } else if (item.verdict === 'khong_chac') g.khong_chac += 1;
      else g.pending += 1;
    }
  }
  const rows = Object.values(groups).map(g => {
    const n = g.dung + g.sai;
    return { ...g, checked: n, accuracy: n ? g.dung / n : null, ci95: wilson(g.dung, n) };
  });
  const dung = rows.reduce((s, r) => s + r.dung, 0);
  const sai = rows.reduce((s, r) => s + r.sai, 0);
  return {
    audit_count: audits.length,
    completed_count: audits.filter(a => (a.items || []).every(i => i.verdict)).length,
    groups: rows,
    overall: { dung, sai, checked: dung + sai, accuracy: dung + sai ? dung / (dung + sai) : null, ci95: wilson(dung, dung + sai) },
    failures: failures.sort((a, b) => text(b.reviewed_at).localeCompare(text(a.reviewed_at))).slice(0, 100),
    recent: audits.slice(0, 20).map(a => ({
      id: a.id, created_at: a.created_at, patient_code: a.patient_code, patient_name: a.patient_name,
      admission_date: a.admission_date, discharge_date: a.discharge_date,
      total: (a.items || []).length, reviewed: (a.items || []).filter(i => i.verdict).length,
      sai: (a.items || []).filter(i => i.verdict === 'sai').length,
    })),
  };
}

module.exports = { GROUPS, AUDIT_FILE, createAudit, getAudit, saveVerdict, summarize, wilson };
