// Bảng theo dõi tiến độ lấy dữ liệu của Kho nghiên cứu: thẻ từng phần, bảng lượt, lịch sử đợt, dashboard vận hành.
import { C, FS } from '../../tokens.js';
import { compactNumber, formatWhen, lower, text } from './researchFormat.js';
import { describeQaWarnings } from './qaNotes.js';
import { statusIsDone } from './researchStatusModel.js';
import { StatBadge, SmallRowsTable, inp } from './researchUi.jsx';
import { useEffect, useState } from 'react';
import { buildDataHealth, issueLabel } from './dataHealth.js';
import { encounterPeriod, countOutsideStay, medicationRouteLabel } from './encounterPeriod.js';
import { SkeletonBlock, SkeletonLines } from '../Skeleton.jsx';
import { Spinner, Btn } from '../shared.jsx';
import { groupLabRows, groupImagingRows } from './patientHistoryGrouping.js';

function ModuleProgressCard({ part }) {
  const total = Number(part.total || 0);
  const done = Number(part.done || 0);
  const running = Number(part.running || 0);
  const error = Number(part.error || 0);
  const waiting = Number(part.waiting || 0);
  const missing = Math.max(0, Number(part.missing || 0) + waiting);
  const pct = total ? Math.max(0, Math.min(100, Math.round(done * 100 / total))) : 0;
  // Thanh chia đoạn theo đúng tỷ lệ: xanh lá = đã lấy, xanh dương = đang lấy,
  // đỏ = lỗi, phần xám còn lại = chưa lấy. Trước đây cả thanh đổi màu đỏ chỉ vì
  // có 1 ca lỗi, nên 91% đã lấy trông như hỏng hết.
  const segments = [
    [done, C.green, 'đã lấy'],
    [running, C.blue, 'đang lấy'],
    [error, C.red, 'lỗi'],
  ].filter(([n]) => n > 0);
  return (
    <div style={{ background: 'transparent', padding: '6px 2px 7px', minWidth: 145 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'baseline' }}>
        <div style={{ fontSize: FS.xs, color: C.text, fontWeight: 700 }}>{part.label}</div>
        <div style={{ fontSize: FS.xs, color: C.text3 }}>
          <b style={{ color: done === total && total ? C.green : C.text }}>{pct}%</b> · {compactNumber(done)}/{compactNumber(total)}
        </div>
      </div>
      <div
        title={`${part.label}: ${compactNumber(done)} đã lấy, ${compactNumber(running)} đang lấy, ${compactNumber(error)} lỗi, ${compactNumber(missing)} chưa lấy / ${compactNumber(total)} ca`}
        style={{ display: 'flex', height: 6, borderRadius: 3, background: C.surface2, marginTop: 6, overflow: 'hidden' }}
      >
        {total > 0 && segments.map(([n, color, label]) => (
          <div key={label} style={{ width: `${Math.min(100, n * 100 / total)}%`, background: color }} />
        ))}
      </div>
      <div style={{ marginTop: 5, minHeight: 15, fontSize: FS.xs, color: C.text3, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        {!!running && <span style={{ color: C.blue }}>{compactNumber(running)} đang lấy</span>}
        {!!missing && <span>{compactNumber(missing)} chưa lấy</span>}
        {!!error && <span style={{ color: C.red }}>{compactNumber(error)} lỗi</span>}
        {!running && !missing && !error && total > 0 && <span style={{ color: C.green }}>Đã lấy đủ</span>}
      </div>
    </div>
  );
}

function MiniPartStatus({ label, value }) {
  const raw = lower(value);
  const done = statusIsDone(value);
  const error = raw.includes('lỗi') || raw.includes('error') || raw.includes('fail') || raw.includes('timeout');
  const running = raw.includes('đang') || raw.includes('running');
  const color = error ? C.red : done ? C.green : running ? C.blue : C.amber;
  const symbol = error ? '!' : done ? '✓' : running ? '…' : '–';
  return (
    <span title={`${label}: ${text(value) || 'Chưa lấy'}`} style={{
      display: 'inline-flex', alignItems: 'center', gap: 3, color,
      fontSize: FS.xs, fontWeight: 700, whiteSpace: 'nowrap',
    }}><b>{symbol}</b>{label}</span>
  );
}

function ResearchMonitorTable({ rows = [], max = 80, filter = 'need', query = '' }) {
  const q = text(query).toLowerCase();
  const filtered = (Array.isArray(rows) ? rows : []).filter(row => {
    if (filter === 'running' && row.state !== 'running') return false;
    if (filter === 'need' && !['running','error','missing','waiting'].includes(row.state)) return false;
    if (filter === 'missing' && !['missing','waiting'].includes(row.state)) return false;
    if (filter === 'error' && row.state !== 'error') return false;
    if (filter === 'done' && row.state !== 'done') return false;
    if (q) {
      const hay = [row.sample, row.research_code, row.patient_code, row.patient_name, row.missing, row.last_error].map(text).join(' ').toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
  const shown = filtered.slice(0, max);
  if (!shown.length) {
    return (
      <div style={{ padding: 16, border: `1px solid ${C.border2}`, borderRadius: 8, background: C.surface, fontSize: FS.xs, color: C.text3, textAlign: 'center' }}>
        Không có dữ liệu phù hợp.
      </div>
    );
  }
  return (
    <div style={{ border: `1px solid ${C.border2}`, borderRadius: 8, overflow: 'hidden', background: C.surface }}>
      <div style={{ maxHeight: 500, overflow: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: FS.xs }}>
          <thead style={{ position: 'sticky', top: 0, background: C.surface2, zIndex: 1 }}>
            <tr>
              {['Người bệnh / mẫu','Còn thiếu phần','Lý do lỗi','Cập nhật'].map(label => (
                <th key={label} style={{ textAlign: 'left', padding: '8px 10px', color: C.text3, whiteSpace: 'nowrap', fontWeight: 700, borderBottom: `1px solid ${C.border2}` }}>{label}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {shown.map((row, idx) => (
              <tr key={row.key || `${row.sample}_${idx}`} style={{ borderBottom: `1px solid ${C.border2}` }}>
                <td style={{ padding: '8px 10px', minWidth: 210 }}>
                  <div style={{ color: C.text, fontWeight: 700, fontSize: FS.xs }}>{text(row.patient_name) || '—'}</div>
                  <div style={{ marginTop: 2, color: C.text3, fontSize: FS.xs }}>
                    BN {text(row.patient_code) || '—'} · NC {text(row.sample) || '—'}
                  </div>
                </td>
                <td style={{ padding: '8px 10px', minWidth: 200, color: row.missing ? C.amber : C.green, fontWeight: 600 }}>
                  {text(row.missing) || 'Đủ'}
                </td>
                <td title={text(row.last_error)} style={{ padding: '8px 10px', minWidth: 190, maxWidth: 360 }}>
                  <div style={{ color: row.last_error ? C.red : C.text3, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {text(row.last_error) || '—'}
                  </div>
                </td>
                <td style={{ padding: '8px 10px', color: C.text3, whiteSpace: 'nowrap', fontSize: FS.xs }}>{text(row.updated_at) || '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div style={{ padding: '7px 10px', fontSize: FS.xs, color: C.text3, borderTop: `1px solid ${C.border2}` }}>
        {compactNumber(shown.length)}/{compactNumber(filtered.length)} dòng
      </div>
    </div>
  );
}

// Nhãn giai đoạn: dòng trước nhập viện / sau ra viện tô màu cam để nhận ra ngay.
function periodCell(row) {
  const p = encounterPeriod(row);
  if (p.inStay) return <span style={{ color: C.text3 }}>{p.label}</span>;
  return (
    <span style={{ padding: '1px 6px', borderRadius: 4, fontWeight: 700, color: p.outside ? C.amber : C.blue, background: p.outside ? C.amberBg : C.blueBg, border: `1px solid ${p.outside ? C.amberBorder : C.blueBorder}` }}>
      {p.label}
    </span>
  );
}

function GroupedHistoryRows({ groups = [], columns, max = 80, unit = 'dòng' }) {
  if (!groups.length) return <SmallRowsTable max={max} rows={[]} columns={columns} />;
  return (
    <div style={{ display: 'grid', gap: 7, marginTop: 6 }}>
      {groups.map(group => (
        <section key={group.label} style={{ border: `1px solid ${C.border2}`, borderRadius: 7, overflow: 'hidden', background: C.surface }}>
          <div style={{
            padding: '6px 9px', background: C.surface2, borderBottom: `1px solid ${C.border2}`,
            display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8,
          }}>
            <b style={{ fontSize: FS.xs, color: C.text }}>{group.label}</b>
            <span style={{ fontSize: FS.xs, color: C.text3 }}>{group.rows.length} {unit}</span>
          </div>
          <SmallRowsTable max={max} rows={group.rows} columns={columns} />
        </section>
      ))}
    </div>
  );
}

function EncounterHistoryCard({ enc, index }) {
  const [expanded, setExpanded] = useState(false);
  const outsideStay = countOutsideStay(enc);
  return (
    <div style={{ border: `1px solid ${C.border2}`, borderRadius: 8, background: C.bg, padding: 9 }}>
      <button type="button" onClick={() => setExpanded(v => !v)} style={{
        width: '100%', border: 0, background: 'transparent', padding: 0, cursor: 'pointer',
        display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, textAlign: 'left',
      }}>
        <span style={{ fontSize: FS.xs, fontWeight: 700, color: enc.unmatched ? C.amber : C.blue }}>
          {enc.unmatched
            ? 'Chưa xác định đợt điều trị'
            : `Đợt ${index + 1}: ${enc.admission_date || '—'} → ${enc.discharge_date || '—'}`}
        </span>
        <span style={{ fontSize: FS.xs, color: C.text3 }}>{expanded ? 'Thu gọn' : 'Xem chi tiết'}</span>
      </button>
      <div style={{ marginTop: 6, display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
        <span style={{ fontSize: FS.xs, color: C.text2, flex: '1 1 280px' }}>{enc.diagnosis_raw || 'Chưa có chẩn đoán'}</span>
        <StatBadge label="XN" value={enc.counts?.labs || 0} tone="neutral" />
        <StatBadge label="CĐHA" value={enc.counts?.imaging || 0} tone="neutral" />
        <StatBadge label="Thuốc" value={enc.counts?.medications || 0} tone="neutral" />
        <StatBadge label="PT/TT" value={enc.counts?.surgeries || 0} tone="neutral" />
        {outsideStay > 0 && <StatBadge label="Trước/sau đợt" value={outsideStay} tone="warn" />}
      </div>
      {enc.unmatched && !!enc.match_reasons?.length && (
        <div style={{ marginTop: 6, fontSize: FS.xs, color: C.amber }}>
          <b>Lý do chưa ghép:</b> {enc.match_reasons.join(' · ')}
        </div>
      )}

      {expanded && (
        <div style={{ marginTop: 9, display: 'grid', gap: 8 }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 6, fontSize: FS.xs, color: C.text2 }}>
            <div><b>Khoa/phòng:</b> {[enc.department, enc.room_bed].filter(Boolean).join(' · ') || '—'}</div>
            <div><b>Ngày mổ:</b> {enc.surgery_date || '—'}</div>
            <div><b>Số ngày điều trị:</b> {enc.treatment_duration || '—'}</div>
            {!enc.unmatched && <div><b>Mã NC:</b> {enc.research_code || '—'}</div>}
          </div>
          <details><summary style={{ cursor: 'pointer', fontSize: FS.xs, fontWeight: 700, color: C.text2 }}>Xét nghiệm ({enc.counts?.labs || 0})</summary><GroupedHistoryRows groups={groupLabRows(enc.labs || [])} max={120} unit="chỉ số" columns={[{key:'encounter_match_method',label:'Giai đoạn',render:periodCell}, {key:'lab_datetime',label:'Thời gian'}, {key:'test_name_raw',label:'Chỉ số'}, {key:'result_raw',label:'KQ'}, {key:'unit',label:'Đơn vị'}]} /></details>
          <details><summary style={{ cursor: 'pointer', fontSize: FS.xs, fontWeight: 700, color: C.text2 }}>CĐHA ({enc.counts?.imaging || 0})</summary><GroupedHistoryRows groups={groupImagingRows(enc.imaging || [])} max={80} unit="kết quả" columns={[{key:'encounter_match_method',label:'Giai đoạn',render:periodCell}, {key:'ordered_at',label:'Thời gian'}, {key:'body_region',label:'Vùng'}, {key:'service_name_raw',label:'Dịch vụ'}, {key:'conclusion_text',label:'Kết luận', long:true}]} /></details>
          <details><summary style={{ cursor: 'pointer', fontSize: FS.xs, fontWeight: 700, color: C.text2 }}>Thuốc / y lệnh ({enc.counts?.medications || 0})</summary><SmallRowsTable max={120} rows={enc.medications || []} columns={[{key:'encounter_match_method',label:'Giai đoạn',render:periodCell}, {key:'order_datetime',label:'Thời gian'}, {key:'drug_name_raw',label:'Thuốc'}, {key:'dose_raw',label:'Liều'}, {key:'route_norm',label:'Đường',render:row => medicationRouteLabel(row) || '—'}]} /></details>
          <details><summary style={{ cursor: 'pointer', fontSize: FS.xs, fontWeight: 700, color: C.text2 }}>Phẫu thuật / thủ thuật ({enc.counts?.surgeries || 0})</summary><SmallRowsTable max={60} rows={enc.surgeries || []} columns={[{key:'encounter_match_method',label:'Giai đoạn',render:periodCell}, {key:'surgery_datetime',label:'Bắt đầu'}, {key:'surgery_end_datetime',label:'Kết thúc'}, {key:'surgery_name',label:'Tên PT/TT'}, {key:'surgery_method',label:'Phương pháp'}, {key:'anesthesia_method',label:'Vô cảm'}, {key:'primary_surgeon',label:'PTV chính'}, {key:'preop_icd10',label:'ICD trước'}, {key:'postop_icd10',label:'ICD sau'}, {key:'surgery_sequence',label:'Trình tự',long:true}]} /></details>
        </div>
      )}
    </div>
  );
}

const whenText = formatWhen;

// Lần chạy gần nhất kết thúc ra sao: dừng theo yêu cầu, bị ngắt, lỗi hay xong — kèm thời điểm,
// thay cho câu chung "đã dừng giữa chừng" không biết từ lúc nào.
function LastRunNote({ stopped, lastTask }) {
  const resume = <> Bấm <b>Thu thập tự động</b> để chạy tiếp phần còn thiếu.</>;
  const box = (color, children) => (
    <div style={{ marginTop: 9, borderLeft: `3px solid ${color}`, background: C.surface2, color: C.text2, padding: '7px 9px', fontSize: FS.xs, lineHeight: 1.5 }}>{children}</div>
  );
  const label = stopped?.label || lastTask?.label || 'Tác vụ';
  if (stopped?.reason === 'cancelled') return box(C.amber, <>"{label}" đã dừng theo yêu cầu lúc {whenText(stopped.at)}.{resume}</>);
  if (stopped?.reason === 'interrupted') return box(C.amber, <>"{label}" bị ngắt lúc {whenText(stopped.at)} do máy chủ khởi động lại.{resume}</>);
  if (stopped) {
    const who = stopped.ho_ten || stopped.ma_bn ? ` ở ca ${stopped.ho_ten || ''}${stopped.ma_bn ? ` (${stopped.ma_bn})` : ''}` : '';
    return box(C.red, <>Lần chạy trước gặp lỗi và dừng{who}{stopped.at ? ` lúc ${whenText(stopped.at)}` : ''}.{resume}</>);
  }
  if (lastTask?.status === 'error') return box(C.red, <>"{label}" lỗi lúc {whenText(lastTask.finished_at)}: {lastTask.message || 'không rõ lỗi'}.{resume}</>);
  if (lastTask?.status === 'done') return box(C.green, <>Lần chạy gần nhất: "{label}" xong lúc {whenText(lastTask.finished_at)}.{lastTask.message ? ` ${lastTask.message}` : ''}</>);
  return null;
}

const TONE = {
  ok: [C.green, C.greenBg],
  warn: [C.amber, C.amberBg],
  danger: [C.red, C.redBg],
  info: [C.blue, C.blueBg],
};

// Một con số: nó là gì + phải làm gì (+ nút mở danh sách lượt liên quan).
function HealthItem({ item, active, onOpen }) {
  const [color] = TONE[item.tone] || TONE.info;
  return (
    <div style={{ padding: '7px 0', borderTop: `1px solid ${C.border2}`, display: 'grid', gridTemplateColumns: '78px 1fr', gap: 10 }}>
      <div style={{ fontSize: FS.lg || 18, fontWeight: 700, color, fontVariantNumeric: 'tabular-nums', lineHeight: 1.2 }}>
        {item.value == null ? '—' : compactNumber(item.value)}
      </div>
      <div style={{ minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <b style={{ fontSize: FS.sm, color: C.text }}>{item.label}</b>
          {item.filter && (
            <button type="button" onClick={() => onOpen(active ? null : item.filter)} aria-pressed={active} style={{
              border: `1px solid ${active ? C.text3 : C.border2}`, background: active ? C.surface2 : C.surface,
              color: C.text2, borderRadius: 5, height: 22, padding: '0 8px', fontSize: FS.xs, cursor: 'pointer',
            }}>{active ? 'Ẩn danh sách' : 'Xem danh sách'}</button>
          )}
        </div>
        <div style={{ fontSize: FS.xs, color: C.text2, marginTop: 2, lineHeight: 1.5 }}>{item.meaning}</div>
        {item.action && (
          <div style={{ fontSize: FS.xs, color: C.text, marginTop: 2, lineHeight: 1.5 }}><b>Cần làm:</b> {item.action}</div>
        )}
      </div>
    </div>
  );
}

function ReviewTable({ rows = [] }) {
  if (!rows.length) {
    return <div style={{ padding: 14, fontSize: FS.xs, color: C.text3, textAlign: 'center' }}>Không có lượt cần kiểm tra.</div>;
  }
  return (
    <SmallRowsTable max={300} rows={rows.map(r => ({ ...r, issue_label: issueLabel(r.issue) }))} columns={[
      { key: 'research_code', label: 'Mã NC' },
      { key: 'patient_code', label: 'Mã BN' },
      { key: 'issue_label', label: 'Vấn đề' },
      { key: 'detail', label: 'Chi tiết', long: true },
    ]} />
  );
}

const SCREEN_STATE_LABEL = {
  automatic: 'Máy xử lý',
  manual: 'Cần bạn kiểm tra',
  error: 'Lỗi, sẽ tự thử lại',
  waiting: 'Chờ người xem',
  unmatched: 'Chưa ghép chắc',
  missing: 'Còn thiếu',
};

function rowMatchesScreenState(row, state) {
  if (state === 'automatic') return row.user_state === 'automatic' || ['missing', 'error'].includes(row.state);
  if (state === 'manual') return row.user_state === 'manual' || ['waiting', 'unmatched'].includes(row.state);
  return row.state === state;
}

// Danh sách lượt của một nhóm (từ mô hình màn hình): chỉ gom theo trạng thái hành động ở màn chính.
function ScreenRowsTable({ rows = [], state, query = '' }) {
  const q = text(query).toLowerCase();
  const filtered = rows.filter(r => rowMatchesScreenState(r, state) && (!q || [r.research_code, r.patient_code, r.patient_name, r.reason].map(text).join(' ').toLowerCase().includes(q)));
  if (!filtered.length) {
    return <div style={{ padding: 14, fontSize: FS.xs, color: C.text3, textAlign: 'center', border: `1px solid ${C.border2}`, borderRadius: 8, background: C.surface }}>Không có lượt phù hợp.</div>;
  }
  return (
    <SmallRowsTable max={300} rows={filtered.map(r => ({ ...r, who: [r.patient_name, r.patient_code ? `BN ${r.patient_code}` : ''].filter(Boolean).join(' · ') }))} columns={[
      { key: 'research_code', label: 'Mã NC' },
      { key: 'who', label: 'Người bệnh' },
      { key: 'missing', label: 'Phần cần xử lý' },
      { key: 'reason', label: 'Lý do', long: true },
    ]} />
  );
}

function DashboardSkeleton() {
  return (
    <section aria-busy="true" aria-label="Đang tải đánh giá dữ liệu" style={{ borderTop: `1px solid ${C.border2}`, borderBottom: `1px solid ${C.border2}`, background: C.surface, padding: '10px 2px', display: 'grid', gap: 10 }}>
      <SkeletonBlock width="45%" height={16} />
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: 18 }}>
        <SkeletonLines lines={5} />
        <SkeletonLines lines={3} />
      </div>
    </section>
  );
}

// screen: mô hình màn hình từ máy chủ (useServerData). Khung này CHỈ hiển thị, không tự gọi API,
// không tự tính lại số liệu (UX_RULES mục 9).
function ResearchOperationDashboard({ screen, loading = false, error = null, autoRunning = false, onRefresh, initialFilter = null }) {
  const [filter, setFilter] = useState(initialFilter);
  useEffect(() => { if (initialFilter) setFilter(initialFilter); }, [initialFilter]);
  const [query, setQuery] = useState('');
  if (!screen) {
    if (error) {
      return (
        <div role="alert" style={{ fontSize: FS.sm, color: C.red, padding: 10 }}>
          Không tải được đánh giá dữ liệu: {String(error.message || error)}
          {onRefresh && <Btn onClick={onRefresh} style={{ marginLeft: 8, height: 26, fontSize: FS.xs }}>Thử lại</Btn>}
        </div>
      );
    }
    return <DashboardSkeleton />;
  }
  const health = buildDataHealth(screen, { autoRunning });
  const [verdictColor, verdictBg] = TONE[health.verdict.tone] || TONE.info;
  const generatedAt = formatWhen(screen.generated_at);
  const total = health.total;
  const counts = screen.counts || {};
  const bar = [
    [health.ready, C.green, 'sẵn sàng'],
    [health.automatic, C.blue, autoRunning ? 'máy đang xử lý' : 'chờ máy xử lý'],
    [health.manual, C.red, 'cần bạn kiểm tra'],
  ].filter(([n]) => n > 0);
  const qaWarnings = Array.isArray(screen.qa?.warnings) ? screen.qa.warnings : [];
  const openItem = [...health.complete, ...health.accurate].find(i => i.filter && i.filter === filter);
  const task = screen.task || {};

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <section style={{ borderTop: `1px solid ${C.border2}`, borderBottom: `1px solid ${C.border2}`, background: C.surface, padding: '10px 2px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 9, flexWrap: 'wrap' }}>
          <span style={{ fontSize: FS.md, fontWeight: 700, color: C.text }}>{compactNumber(total)} lượt điều trị</span>
          <span role="status" style={{ fontSize: FS.sm, fontWeight: 600, color: verdictColor, background: verdictBg, borderRadius: 5, padding: '2px 8px' }}>
            {health.verdict.text}
          </span>
          <span style={{ marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: FS.xs, color: C.text3 }}>
            {loading ? <><Spinner size={8} /> đang cập nhật</> : generatedAt ? `số liệu lúc ${generatedAt}` : ''}
            {onRefresh && <Btn onClick={onRefresh} disabled={loading} style={{ height: 26, padding: '0 9px', fontSize: FS.xs }}>Làm mới số liệu</Btn>}
          </span>
        </div>

        {/* Trạng thái "đang chạy" (tác vụ, ca đang lấy, tuổi tiến độ) chỉ hiện ở dải đầu trang
            (RunningBanner) — không lặp lại ở đây (UX_RULES 3.2). */}
        {!autoRunning && <LastRunNote stopped={task.stopped} lastTask={task.last_task} />}

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: 18, marginTop: 10 }}>
          <div>
            <div style={{ fontSize: FS.sm, fontWeight: 700, color: C.text }}>
              1. Trạng thái dữ liệu · {compactNumber(health.ready)}/{compactNumber(total)} lượt sẵn sàng ({health.pct}%)
            </div>
            <div
              title={bar.map(([n, , label]) => `${compactNumber(n)} ${label}`).join(', ') + ` / ${compactNumber(total)} lượt`}
              style={{ display: 'flex', height: 6, borderRadius: 3, background: C.surface2, margin: '6px 0 4px', overflow: 'hidden' }}
            >
              {total > 0 && bar.map(([n, color, label]) => (
                <div key={label} style={{ width: `${Math.min(100, n * 100 / total)}%`, background: color }} />
              ))}
            </div>
            {health.complete.map(item => <HealthItem key={item.key} item={item} active={filter === item.filter} onOpen={setFilter} />)}
          </div>
          <div>
            <div style={{ fontSize: FS.sm, fontWeight: 700, color: C.text }}>
              2. Kiểm tra chất lượng{screen.qa?.generated_at && !autoRunning ? <span style={{ fontWeight: 400, color: C.text3, fontSize: FS.xs }}> · kiểm tra lúc {formatWhen(screen.qa.generated_at)}</span> : null}
            </div>
            <div style={{ height: 10 }} />
            {health.accurate.map(item => <HealthItem key={item.key} item={item} active={filter === item.filter} onOpen={setFilter} />)}
          </div>
        </div>
      </section>

      {filter && (
        <section aria-label={openItem ? `Danh sách: ${openItem.label}` : 'Danh sách'}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 6 }}>
            <b style={{ fontSize: FS.sm, color: C.text }}>{openItem?.label || SCREEN_STATE_LABEL[filter] || 'Danh sách'}</b>
            {filter !== 'review' && (
              <input value={query} onChange={e => setQuery(e.target.value)} placeholder="Mã BN, mã NC, tên hoặc lý do" style={{ ...inp, width: 235, marginLeft: 'auto', background: C.surface, fontSize: FS.xs }} />
            )}
          </div>
          {filter === 'review'
            ? <ReviewTable rows={screen.qa?.review || []} />
            : <ScreenRowsTable rows={screen.rows || []} state={filter} query={query} />}
        </section>
      )}

      <details style={{ border: `1px solid ${C.border2}`, borderRadius: 8, background: C.surface, padding: '8px 10px' }}>
        <summary style={{ cursor: 'pointer', color: C.text2, fontSize: FS.xs, fontWeight: 700 }}>
          Chi tiết kỹ thuật (không cần xử lý)
        </summary>
        <div style={{ display: 'grid', gap: 10, marginTop: 8 }}>
          <div style={{ fontSize: FS.xs, color: C.text3 }}>
            Tiến độ từng phần trên {compactNumber(total - Number(counts.unmatched || 0))} lượt đã ghép chắc
            {Number(counts.unmatched || 0) ? ` (${compactNumber(total)} lượt trừ ${compactNumber(counts.unmatched)} lượt chưa ghép chắc)` : ''}:
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(145px, 1fr))', columnGap: 18, rowGap: 2 }}>
            {(screen.parts || []).map(part => <ModuleProgressCard key={part.key} part={{ ...part, error: part.failed || 0, missing: Math.max(0, part.total - part.done - (part.failed || 0)) }} />)}
          </div>
          {!!qaWarnings.length && (
            <div style={{ fontSize: FS.xs, color: C.text3, lineHeight: 1.6 }}>
              <b style={{ color: C.text2 }}>Ghi chú khi chuẩn hóa (đã tự xử lý, chỉ để biết):</b>
              <ul style={{ margin: '4px 0 0 16px', padding: 0 }}>
                {describeQaWarnings(qaWarnings).map(line => <li key={line}>{line}</li>)}
              </ul>
            </div>
          )}
          {generatedAt && <div style={{ fontSize: FS.xs, color: C.text3 }}>Mọi số trên màn hình này tính cùng lúc từ sổ thu thập, lúc {generatedAt}.</div>}
        </div>
      </details>
    </div>
  );
}

export {
  ModuleProgressCard,
  MiniPartStatus,
  ResearchMonitorTable,
  EncounterHistoryCard,
  ResearchOperationDashboard,
};
