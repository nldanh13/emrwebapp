'use strict';

// So một đợt điều trị trong kho với bản vừa lấy lại từ EMR (đã qua cùng bước chuẩn hóa).
// Mỗi loại dữ liệu ghép dòng theo khóa (thời điểm + tên), rồi so giá trị:
//   khớp       — cùng khóa, cùng giá trị
//   lệch       — cùng khóa, khác giá trị (vd. kết quả XN đã sửa trên EMR)
//   kho thiếu  — EMR có, kho không có
//   kho thừa   — kho có, EMR không còn
// Hàm thuần: không đọc file, không mở EMR.

const { isoDate, isoDateTime } = require('./encounter_context');

const KIND_LABELS = {
  encounter: 'Mốc đợt (vào/ra viện, chẩn đoán)',
  labs: 'Xét nghiệm',
  imaging: 'CĐHA',
  medications: 'Thuốc / y lệnh',
  surgeries: 'Phẫu thuật / thủ thuật',
};
const KINDS = ['labs', 'imaging', 'medications', 'surgeries'];
const EXAMPLE_LIMIT = 20;

function text(v) { return String(v ?? '').trim(); }
function norm(v) { return text(v).normalize('NFC').toLowerCase().replace(/\s+/g, ' '); }
// Mốc thời gian so tới phút; chỉ có ngày thì so ngày.
function at(v) {
  const raw = text(v);
  if (!raw) return '';
  return /\d{1,2}:\d{2}/.test(raw) ? (isoDateTime(raw) || raw) : (isoDate(raw) || raw);
}
function firstOf(row, keys) {
  for (const k of keys) if (text(row?.[k])) return text(row[k]);
  return '';
}
function sameOptional(a, b) {
  const x = norm(a);
  const y = norm(b);
  return !x || !y || x === y;
}
function canonicalSurgeryName(value) {
  return norm(value)
    .replace(/^\s*\((?:pt|tt)\.?\s*\d+\)\s*/i, '')
    .replace(/^\s*(?:pt|tt)\.?\s*\d+\s*[-:.]?\s*/i, '')
    .trim();
}
function hasMinute(value) {
  return /\d{1,2}:\d{2}/.test(text(value));
}

const SPECS = {
  labs: {
    key: r => [at(firstOf(r, ['lab_datetime', 'lab_date'])), norm(r.test_name_raw || r.test_name_norm)],
    value: r => [norm(r.result_raw), norm(r.unit)].filter(Boolean).join(' '),
    label: r => `${firstOf(r, ['lab_datetime', 'lab_date']) || '—'} · ${text(r.test_name_raw) || text(r.test_name_norm) || '—'}`,
  },
  imaging: {
    key: r => [at(firstOf(r, ['ordered_at', 'order_date'])), norm(r.service_name_raw)],
    value: r => norm(r.conclusion_text || r.result_text),
    label: r => `${firstOf(r, ['ordered_at', 'order_date']) || '—'} · ${text(r.service_name_raw) || '—'}`,
  },
  medications: {
    key: r => [at(firstOf(r, ['order_datetime', 'order_date'])), norm(r.drug_name_raw || r.drug_name_norm)],
    value: r => [norm(r.dose_raw), norm(r.route_norm || r.route_raw), norm(r.order_action)].filter(Boolean).join(' · '),
    equalRows: (a, b) => sameOptional(a.dose_raw, b.dose_raw)
      && sameOptional(a.route_norm || a.route_raw, b.route_norm || b.route_raw)
      && sameOptional(a.order_action, b.order_action),
    label: r => `${firstOf(r, ['order_datetime', 'order_date']) || '—'} · ${text(r.drug_name_raw) || text(r.drug_name_norm) || '—'}`,
  },
  surgeries: {
    key: r => [isoDate(firstOf(r, ['surgery_date', 'surgery_datetime'])) || at(firstOf(r, ['surgery_date', 'surgery_datetime'])), canonicalSurgeryName(r.surgery_name)],
    value: r => [at(r.surgery_datetime), norm(r.surgery_method)].filter(Boolean).join(' · '),
    equalRows: (a, b) => {
      if (!sameOptional(canonicalSurgeryName(a.surgery_method), canonicalSurgeryName(b.surgery_method))) return false;
      // Nếu một phía chỉ có ngày thì giờ là unknown, không phải khác biệt.
      if (hasMinute(a.surgery_datetime) && hasMinute(b.surgery_datetime)
        && at(a.surgery_datetime) !== at(b.surgery_datetime)) return false;
      return true;
    },
    label: r => `${firstOf(r, ['surgery_datetime', 'surgery_date']) || '—'} · ${text(r.surgery_name) || '—'}`,
  },
};

function emptyResult(kind) {
  return {
    kind, label: KIND_LABELS[kind], archive_count: 0, emr_count: 0,
    matched: 0, mismatched: 0, archive_only: 0, emr_only: 0,
    examples: { mismatched: [], archive_only: [], emr_only: [] },
  };
}

function pushExample(list, item) {
  if (list.length < EXAMPLE_LIMIT) list.push(item);
}

function groupByKey(rows, spec) {
  const map = new Map();
  for (const row of rows || []) {
    const key = JSON.stringify(spec.key(row));
    if (!map.has(key)) map.set(key, []);
    const item = { row, value: spec.value(row), label: spec.label(row) };
    // Audit đo "sự thật lâm sàng" chứ không đo số bản sao do cùng một nguồn được
    // nhập lặp. Hai dòng cùng key + cùng value chỉ tính một lần; raw_count vẫn giữ
    // để truy lỗi nếu cần.
    const bucket = map.get(key);
    if (!bucket.some(x => x.value === item.value)) bucket.push(item);
  }
  return map;
}
function logicalCount(map) {
  let n = 0;
  for (const rows of map.values()) n += rows.length;
  return n;
}

function compareRows(kind, archiveRows = [], emrRows = []) {
  const spec = SPECS[kind];
  const out = emptyResult(kind);
  out.archive_raw_count = archiveRows.length;
  out.emr_raw_count = emrRows.length;
  const a = groupByKey(archiveRows, spec);
  const e = groupByKey(emrRows, spec);
  out.archive_count = logicalCount(a);
  out.emr_count = logicalCount(e);
  for (const key of new Set([...a.keys(), ...e.keys()])) {
    const left = (a.get(key) || []).slice();
    const right = (e.get(key) || []).slice();
    // Cùng khóa: với XN/CĐHA dùng exact value; thuốc/PT dùng so ngữ nghĩa bảo thủ.
    for (let i = left.length - 1; i >= 0; i -= 1) {
      const j = right.findIndex(x => spec.equalRows
        ? spec.equalRows(left[i].row, x.row)
        : x.value === left[i].value);
      if (j >= 0) {
        out.matched += 1;
        left.splice(i, 1);
        right.splice(j, 1);
      }
    }
    // Còn lại cùng khóa nhưng khác giá trị: lệch.
    while (left.length && right.length) {
      const x = left.shift();
      const y = right.shift();
      out.mismatched += 1;
      pushExample(out.examples.mismatched, { label: x.label, archive: x.value, emr: y.value });
    }
    for (const x of left) { out.archive_only += 1; pushExample(out.examples.archive_only, { label: x.label, value: x.value }); }
    for (const y of right) { out.emr_only += 1; pushExample(out.examples.emr_only, { label: y.label, value: y.value }); }
  }
  return out;
}

const ENCOUNTER_FIELDS = [
  { field: 'admission_date', label: 'Ngày giờ vào viện', value: r => at(r.admission_date) },
  { field: 'discharge_date', label: 'Ngày giờ ra viện', value: r => at(r.discharge_date) },
  { field: 'treatment_duration', label: 'Số ngày điều trị', value: r => text(r.treatment_duration) },
  { field: 'discharge_diagnosis', label: 'Chẩn đoán ra viện', value: r => norm(r.discharge_diagnosis || r.diagnosis_raw) },
];

function compareEncounter(archiveEnc, emrEnc) {
  const out = emptyResult('encounter');
  out.archive_count = archiveEnc ? 1 : 0;
  out.emr_count = emrEnc ? 1 : 0;
  for (const f of ENCOUNTER_FIELDS) {
    const x = archiveEnc ? f.value(archiveEnc) : '';
    const y = emrEnc ? f.value(emrEnc) : '';
    if (!x && !y) continue;
    if (x === y) out.matched += 1;
    else if (x && y) { out.mismatched += 1; pushExample(out.examples.mismatched, { label: f.label, archive: x, emr: y }); }
    else if (x) { out.archive_only += 1; pushExample(out.examples.archive_only, { label: f.label, value: x }); }
    else { out.emr_only += 1; pushExample(out.examples.emr_only, { label: f.label, value: y }); }
  }
  return out;
}

function withRate(r) {
  const total = r.matched + r.mismatched + r.archive_only + r.emr_only;
  return { ...r, compared: total, match_rate: total ? r.matched / total : null };
}

// archive / emr: { encounter, labs, imaging, medications, surgeries } của MỘT đợt.
function compareCase(archive = {}, emr = {}) {
  const kinds = [withRate(compareEncounter(archive.encounter, emr.encounter))];
  for (const kind of KINDS) kinds.push(withRate(compareRows(kind, archive[kind] || [], emr[kind] || [])));
  const totals = kinds.reduce((s, r) => ({
    matched: s.matched + r.matched, mismatched: s.mismatched + r.mismatched,
    archive_only: s.archive_only + r.archive_only, emr_only: s.emr_only + r.emr_only,
  }), { matched: 0, mismatched: 0, archive_only: 0, emr_only: 0 });
  const overall = withRate({ ...totals });
  return { kinds, overall, all_match: overall.compared > 0 && overall.matched === overall.compared };
}

module.exports = { KIND_LABELS, KINDS, compareRows, compareEncounter, compareCase };
