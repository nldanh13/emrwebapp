// Hiển thị thống kê mô tả (không hiển thị dữ liệu từng lượt): tóm tắt mẫu và bảng đo lường
// từng biến. Số liệu lấy từ summary của server (variable_selection.summarizeSelectedDataset).
import { C, FS } from '../../tokens.js';
import { compactNumber } from './researchFormat.js';
import { VARIABLE_ROLE_SHORT, roleTone, sortByRole } from './studyRoles.js';

const KIND_LABEL = { number: 'Số', date: 'Ngày', category: 'Phân loại', text: 'Văn bản' };

function fmt(n, digits = 1) {
  if (n === null || n === undefined || !Number.isFinite(Number(n))) return '—';
  return Number(n).toLocaleString('vi-VN', { maximumFractionDigits: digits });
}

// Một dòng mô tả gọn theo loại đo lường.
function describeStats(stats, variable = null) {
  if (!stats || !stats.n) return 'Không có dữ liệu';
  if (variable?.aggregation === 'any' && stats.kind === 'category') {
    const pct = (value) => (stats.top || []).find(t => String(t.value) === value)?.pct || 0;
    const count = (value) => (stats.top || []).find(t => String(t.value) === value)?.count || 0;
    return `Có (1): ${compactNumber(count('1'))} lượt, ${fmt(pct('1'))}% · Không (0): ${compactNumber(count('0'))} lượt, ${fmt(pct('0'))}%`;
  }
  if (stats.kind === 'number') {
    if (!stats.n_numeric) return `${compactNumber(stats.n)} giá trị, không đọc được dạng số`;
    const parts = [
      `TB ${fmt(stats.mean)} ± ${fmt(stats.sd)}`,
      `trung vị ${fmt(stats.median)} [${fmt(stats.q1)}–${fmt(stats.q3)}]`,
      `khoảng ${fmt(stats.min)}–${fmt(stats.max)}`,
    ];
    if (stats.non_numeric) parts.push(`${compactNumber(stats.non_numeric)} giá trị không phải số`);
    return parts.join(' · ');
  }
  if (stats.kind === 'date') return stats.n_date ? `từ ${stats.min} đến ${stats.max}` : 'Không đọc được ngày';
  if (stats.kind === 'category') {
    const top = (stats.top || []).map(t => `${t.value} ${fmt(t.pct)}%`);
    if (stats.other) top.push(`${compactNumber(stats.other.groups)} nhóm khác ${fmt(stats.other.pct)}%`);
    return top.join(' · ');
  }
  return `${compactNumber(stats.distinct)} giá trị khác nhau (văn bản tự do, không hiển thị nội dung)`;
}

function FillBar({ rate }) {
  const pct = Math.max(0, Math.min(100, Number(rate || 0)));
  const color = pct >= 80 ? C.green : pct >= 30 ? C.blue : C.amber;
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
      <div style={{ flex: 1, minWidth: 50, height: 6, background: C.surface2, borderRadius: 3, overflow: 'hidden' }}>
        <div style={{ width: `${pct}%`, height: '100%', background: color }} />
      </div>
      <span style={{ fontSize: FS.xs, fontWeight: 700, color: pct >= 30 ? C.text2 : C.amber, fontVariantNumeric: 'tabular-nums', minWidth: 40, textAlign: 'right' }}>{fmt(pct)}%</span>
    </div>
  );
}

function Stat({ label, value, sub, small = false }) {
  return (
    <div style={{ padding: '4px 16px 6px 0', minWidth: 130, borderRight: `1px solid ${C.border2}` }}>
      <div style={{ fontSize: FS.xs, color: C.text3, fontWeight: 600 }}>{label}</div>
      <div style={{ marginTop: 1, fontSize: small ? FS.md : FS.stat, lineHeight: small ? 1.6 : 1.15, color: C.text, fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>{value}</div>
      {sub && <div style={{ marginTop: 2, fontSize: FS.xs, color: C.text3 }}>{sub}</div>}
    </div>
  );
}

function CohortSummary({ summary }) {
  if (!summary) return null;
  const cohort = summary.cohort || {};
  const age = cohort.age || {};
  const stay = cohort.hospital_stay_days || {};
  const sexTop = (cohort.sex?.top || []).map(t => `${t.value} ${fmt(t.pct)}%`).join(' · ');
  const total = Number(summary.total || 0);
  return (
    <div style={{ display: 'grid', gap: 10 }}>
      <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap' }}>
        <Stat label="Lượt điều trị" value={compactNumber(total)} sub="đạt điều kiện chọn mẫu" />
        {cohort.patients ? <Stat label="Người bệnh" value={compactNumber(cohort.patients)} /> : null}
        <Stat label="Tuổi" value={age.n_numeric ? `${fmt(age.mean)} ± ${fmt(age.sd)}` : '—'} sub={age.n_numeric ? `trung vị ${fmt(age.median)} [${fmt(age.q1)}–${fmt(age.q3)}]` : ''} />
        <Stat label="Giới" value={sexTop || '—'} small />
        <Stat label="Ngày nằm viện" value={stay.n_numeric ? fmt(stay.median) : '—'} sub={stay.n_numeric ? `trung vị · [${fmt(stay.q1)}–${fmt(stay.q3)}]` : ''} />
      </div>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center', fontSize: FS.xs, color: C.text2 }}>
        <span style={{ fontWeight: 700, color: C.text }}>Độ đầy đủ theo lượt:</span>
        <span style={{ color: C.green, fontWeight: 700 }}>{compactNumber(summary.complete || 0)} đủ tất cả biến</span>
        <span>·</span>
        <span style={{ color: summary.partial ? C.amber : C.text3, fontWeight: 700 }}>{compactNumber(summary.partial || 0)} thiếu một phần</span>
        <span>·</span>
        <span style={{ color: summary.empty ? C.amber : C.text3, fontWeight: 700 }}>{compactNumber(summary.empty || 0)} trống toàn bộ</span>
        {!!summary.review && <><span>·</span><span style={{ color: C.red, fontWeight: 700 }}>{compactNumber(summary.review)} cần rà soát</span></>}
      </div>
    </div>
  );
}

function RoleBadge({ role }) {
  if (!VARIABLE_ROLE_SHORT[role]) return null;
  const [color, bg] = roleTone(role);
  return <span style={{ display: 'inline-block', marginTop: 3, fontSize: FS.xs, fontWeight: 700, color, background: bg, borderRadius: 999, padding: '0 7px' }}>{VARIABLE_ROLE_SHORT[role]}</span>;
}

// roleOf: lấy vai trò hiện tại của biến (mặc định theo v.role từ server); biến xếp theo vai trò.
function VariableStatsTable({ variables = [], roleOf = v => v.role }) {
  if (!variables.length) return null;
  const sorted = sortByRole(variables, roleOf);
  return (
    <div style={{ border: `1px solid ${C.border2}`, borderRadius: 8, overflow: 'auto', background: C.surface }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: FS.sm, minWidth: 640 }}>
        <thead style={{ background: C.surface2 }}>
          <tr>
            {[['Biến', '28%'], ['Loại', 80], ['Có dữ liệu', 170], ['Đo lường', undefined]].map(([label, width]) => (
              <th key={label} style={{ width, textAlign: 'left', padding: '7px 10px', fontSize: FS.xs, color: C.text2, fontWeight: 700, borderBottom: `1px solid ${C.border2}` }}>{label}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {sorted.map(v => (
            <tr key={v.output_column || v.id} style={{ borderBottom: `1px solid ${C.border2}`, verticalAlign: 'top' }}>
              <td style={{ padding: '8px 10px' }}>
                <div style={{ fontWeight: 700, color: C.text }}>{v.survey_label}</div>
                {v.source_label && v.source_label !== v.survey_label && <div style={{ fontSize: FS.xs, color: C.text3 }}>{v.source_label}</div>}
                <RoleBadge role={roleOf(v)} />
              </td>
              <td style={{ padding: '8px 10px', color: C.text2 }}>{KIND_LABEL[v.stats?.kind] || '—'}</td>
              <td style={{ padding: '8px 10px' }}>
                <FillBar rate={v.fill_rate} />
                <div style={{ marginTop: 3, fontSize: FS.xs, color: C.text3 }}>thiếu {compactNumber(v.missing || 0)} lượt</div>
              </td>
              <td style={{ padding: '8px 10px', color: C.text2, lineHeight: 1.45 }}>{describeStats(v.stats, v)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export { CohortSummary, VariableStatsTable, FillBar, RoleBadge, describeStats };
