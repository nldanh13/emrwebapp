// Cách trình bày gọn cho thẻ đợt điều trị ở màn Tra cứu người bệnh (không đổi dữ liệu, chỉ sắp xếp hiển thị).
import { encounterPeriod } from './encounterPeriod.js';

const text = v => String(v ?? '').trim();

// Chỉ hiện cột "Giai đoạn" khi có dòng ngoài khoảng nằm viện; toàn "Trong đợt" thì cột đó thừa.
export function needsPeriodColumn(rows = []) {
  return rows.some(r => !encounterPeriod(r).inStay);
}

// "2026-07-06 08:47" → "06/07 08:47" (năm ở title). Chỉ có ngày → "06/07".
export function shortWhen(value) {
  const s = text(value);
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}))?/);
  if (!m) return s;
  return m[4] ? `${m[3]}/${m[2]} ${m[4]}:${m[5]}` : `${m[3]}/${m[2]}`;
}

// Xét nghiệm một nhóm → bảng chỉ số × thời điểm: mỗi chỉ số một dòng, mỗi lần lấy mẫu một cột.
// Thay cho bảng dài lặp lại thời gian và giai đoạn ở mọi dòng.
export function pivotLabRows(rows = []) {
  const times = new Map();
  const tests = new Map();
  for (const r of rows) {
    const when = text(r.lab_datetime) || text(r.lab_date);
    const timeKey = when || '—';
    if (!times.has(timeKey)) {
      const p = encounterPeriod(r);
      times.set(timeKey, { key: timeKey, label: when ? shortWhen(when) : '—', title: when, period: p.inStay ? '' : p.label, outside: Boolean(p.outside) });
    }
    const name = text(r.test_name_raw) || text(r.test_name) || '—';
    const unit = text(r.unit) || text(r.unit_raw);
    const testKey = `${name}|${unit}`;
    if (!tests.has(testKey)) tests.set(testKey, { key: testKey, name, unit, values: {} });
    const cell = tests.get(testKey).values;
    const value = text(r.result_raw) || text(r.result_value);
    // Cùng chỉ số, cùng thời điểm có hai kết quả (hiếm): giữ cả hai.
    cell[timeKey] = cell[timeKey] && cell[timeKey] !== value ? `${cell[timeKey]}; ${value}` : value;
  }
  const columns = [...times.values()].sort((a, b) => a.key.localeCompare(b.key));
  return { columns, rows: [...tests.values()] };
}

// Phẫu thuật: một ô thời gian "15/01 13:30 – 14:40", ngày khác thì ghi đủ ngày kết thúc.
export function surgeryTimeRange(row) {
  const start = text(row?.surgery_datetime) || text(row?.surgery_date);
  const end = text(row?.surgery_end_datetime);
  if (!start) return '—';
  const s = shortWhen(start) + (row?.surgery_datetime ? '' : ' (chưa rõ giờ)');
  if (!end) return s;
  const sameDay = start.slice(0, 10) === end.slice(0, 10);
  return `${s} – ${sameDay ? end.slice(11, 16) : shortWhen(end)}`;
}

// ICD trước/sau mổ: giống nhau thì ghi một lần.
export function surgeryIcd(row) {
  const pre = text(row?.preop_icd10);
  const post = text(row?.postop_icd10);
  if (pre && post && pre !== post) return `${pre} → ${post}`;
  return pre || post || '—';
}

const MATCH_REASON_LABEL = {
  encounter_match_outside_time: 'thời gian nằm ngoài mọi đợt đã có',
  encounter_match_ambiguous: 'khớp nhiều đợt, chưa chắc thuộc đợt nào',
  encounter_match_missing: 'chưa có đợt nào của Mã BN này',
  encounter_match_missing_event_time: 'dòng không có thời gian để xác định đợt',
  encounter_match_strong_key_not_found: 'mã đợt EMR không có trong kho',
  encounter_match_strong_key_ambiguous: 'mã đợt EMR khớp nhiều đợt',
  encounter_match_identity_conflict: 'Mã BN và mã đợt mâu thuẫn',
  raw_patient_lookup_unassigned: 'chưa gắn được vào đợt',
};
export function matchReasonLabel(code) {
  const c = text(code);
  return MATCH_REASON_LABEL[c] || c;
}
