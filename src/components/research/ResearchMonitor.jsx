// Bảng theo dõi tiến độ lấy dữ liệu của Kho nghiên cứu: thẻ từng phần, bảng lượt, lịch sử đợt, dashboard vận hành.
import { C, FS } from '../../tokens.js';
import { compactNumber, lower, text } from './researchFormat.js';
import { statusIsDone, summarizeStatusRows } from './researchStatusModel.js';
import { StatusPill, StatBadge, SmallRowsTable, inp } from './researchUi.jsx';
import { useState } from 'react';
import { Spinner, Btn } from '../shared.jsx';

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
              {['Người bệnh / mẫu','Tiến độ','Trạng thái','Thiếu hoặc lỗi','Cập nhật'].map(label => (
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
                <td style={{ padding: '8px 10px', minWidth: 245 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 9, flexWrap: 'wrap' }}>
                    <MiniPartStatus label="XN" value={row.xn_cdha} />
                    <MiniPartStatus label="HS" value={row.profile} />
                    <MiniPartStatus label="RV" value={row.discharge} />
                    <MiniPartStatus label="PT" value={row.surgery} />
                    <MiniPartStatus label="YL" value={row.order_history} />
                  </div>
                </td>
                <td style={{ padding: '8px 10px', whiteSpace: 'nowrap' }}>
                  <StatusPill value={row.state_label} state={row.state} wide />
                </td>
                <td title={[text(row.missing), text(row.last_error)].filter(Boolean).join(' — ')} style={{ padding: '8px 10px', minWidth: 190, maxWidth: 360 }}>
                  <div style={{ color: row.last_error ? C.red : row.missing ? C.amber : C.text3, fontWeight: row.last_error || row.missing ? 700 : 500, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {text(row.last_error) || text(row.missing) || '—'}
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

function EncounterHistoryCard({ enc, index }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div style={{ border: `1px solid ${C.border2}`, borderRadius: 8, background: C.bg, padding: 9 }}>
      <button type="button" onClick={() => setExpanded(v => !v)} style={{
        width: '100%', border: 0, background: 'transparent', padding: 0, cursor: 'pointer',
        display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, textAlign: 'left',
      }}>
        <span style={{ fontSize: FS.xs, fontWeight: 700, color: C.blue }}>
          Đợt {index + 1}: {enc.admission_date || '—'} → {enc.discharge_date || '—'}
        </span>
        <span style={{ fontSize: FS.xs, color: C.text3 }}>{expanded ? 'Thu gọn' : 'Xem chi tiết'}</span>
      </button>
      <div style={{ marginTop: 6, display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
        <span style={{ fontSize: FS.xs, color: C.text2, flex: '1 1 280px' }}>{enc.diagnosis_raw || 'Chưa có chẩn đoán'}</span>
        <StatBadge label="XN" value={enc.counts?.labs || 0} tone="neutral" />
        <StatBadge label="CĐHA" value={enc.counts?.imaging || 0} tone="neutral" />
        <StatBadge label="Thuốc" value={enc.counts?.medications || 0} tone="neutral" />
        <StatBadge label="PT/TT" value={enc.counts?.surgeries || 0} tone="neutral" />
      </div>
      {expanded && (
        <div style={{ marginTop: 9, display: 'grid', gap: 8 }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 6, fontSize: FS.xs, color: C.text2 }}>
            <div><b>Khoa/phòng:</b> {[enc.department, enc.room_bed].filter(Boolean).join(' · ') || '—'}</div>
            <div><b>Ngày mổ:</b> {enc.surgery_date || '—'}</div>
            <div><b>Số ngày điều trị:</b> {enc.treatment_duration || '—'}</div>
            <div><b>Mã NC:</b> {enc.research_code || '—'}</div>
          </div>
          <details><summary style={{ cursor: 'pointer', fontSize: FS.xs, fontWeight: 700, color: C.text2 }}>Xét nghiệm ({enc.counts?.labs || 0})</summary><SmallRowsTable max={120} rows={enc.labs || []} columns={[{key:'lab_datetime',label:'Thời gian'}, {key:'test_name_raw',label:'Tên XN'}, {key:'result_raw',label:'KQ'}, {key:'unit',label:'Đơn vị'}]} /></details>
          <details><summary style={{ cursor: 'pointer', fontSize: FS.xs, fontWeight: 700, color: C.text2 }}>CĐHA ({enc.counts?.imaging || 0})</summary><SmallRowsTable max={80} rows={enc.imaging || []} columns={[{key:'ordered_at',label:'Thời gian'}, {key:'service_name_raw',label:'Dịch vụ'}, {key:'conclusion_text',label:'Kết luận', long:true}]} /></details>
          <details><summary style={{ cursor: 'pointer', fontSize: FS.xs, fontWeight: 700, color: C.text2 }}>Thuốc / y lệnh ({enc.counts?.medications || 0})</summary><SmallRowsTable max={120} rows={enc.medications || []} columns={[{key:'order_datetime',label:'Thời gian'}, {key:'drug_name_raw',label:'Thuốc'}, {key:'dose_raw',label:'Liều'}, {key:'route_raw',label:'Đường'}]} /></details>
          <details><summary style={{ cursor: 'pointer', fontSize: FS.xs, fontWeight: 700, color: C.text2 }}>Phẫu thuật / thủ thuật ({enc.counts?.surgeries || 0})</summary><SmallRowsTable max={60} rows={enc.surgeries || []} columns={[{key:'surgery_datetime',label:'Thời gian'}, {key:'surgery_name',label:'Tên PT/TT'}, {key:'surgery_method',label:'Phương pháp'}, {key:'anesthesia_method',label:'Vô cảm'}]} /></details>
        </div>
      )}
    </div>
  );
}

const whenText = (iso) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString('vi-VN', { hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit' });
};

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

function ResearchOperationDashboard({ snapshot, lastUpdate, loading = false, onRefresh }) {
  const [filter, setFilter] = useState('need');
  const [query, setQuery] = useState('');
  const [manualShowRows, setManualShowRows] = useState(false);
  const snap = snapshot || summarizeStatusRows([]);
  // Đang có tác vụ chạy thì tự mở bảng chi tiết + khối "Mới cập nhật" — không
  // cần bấm "Xem ca thiếu/lỗi" mới thấy từng ca vừa quét xong. Hết tác vụ thì
  // quay lại đúng lựa chọn tay của người dùng.
  // Đang chạy theo máy chủ: tác vụ ghi trạng thái (active_task) hoặc khóa phạm vi (scope_running).
  const isTaskActive = Boolean(snap.active_task || snap.scope_running);
  const showRows = manualShowRows || isTaskActive;
  const rows = Array.isArray(snap.rows) ? snap.rows : [];
  const counts = snap.counts || {
    running: rows.filter(r => r.state === 'running').length,
    error: rows.filter(r => r.state === 'error').length,
    missing: rows.filter(r => r.state === 'missing').length,
    waiting: rows.filter(r => r.state === 'waiting').length,
    done: rows.filter(r => r.state === 'done').length,
  };
  const total = Number(snap.total || rows.length || 0);
  const need = Number(counts.running || 0) + Number(counts.error || 0) + Number(counts.missing || 0) + Number(counts.waiting || 0);
  const generatedAt = snap.generated_at ? new Date(snap.generated_at).toLocaleString('vi-VN') : '';
  const updateBlock = lastUpdate || (Array.isArray(snap.recentUpdates) && snap.recentUpdates.length
    ? { title: 'Mới cập nhật', at: generatedAt, totalChanged: snap.recentUpdates.length, rows: snap.recentUpdates }
    : null);
  const filterButtons = [
    ['need', `Cần xử lý ${compactNumber(need)}`],
    ['running', `Đang chạy ${compactNumber(counts.running || 0)}`],
    ['error', `Lỗi ${compactNumber(counts.error || 0)}`],
    ['done', `Đã đủ ${compactNumber(counts.done || snap.ready || 0)}`],
    ['all', `Tất cả ${compactNumber(rows.length || total)}`],
  ];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <section style={{ borderTop: `1px solid ${C.border2}`, borderBottom: `1px solid ${C.border2}`, background: C.surface, padding: '10px 2px' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 9, flexWrap: 'wrap' }}>
            <span style={{ fontSize: FS.md, fontWeight: 700, color: C.text }}>Giám sát dữ liệu</span>
            {loading && <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, color: C.text3, fontSize: FS.xs }}><Spinner size={8} /> đang cập nhật</span>}
            <StatBadge label="tổng ca" value={total || rows.length} tone="neutral" />
            <StatBadge label="đủ cả 5 phần" value={counts.done || snap.ready || 0} tone="ok" />
            <StatBadge label="chưa đủ" value={(counts.missing || 0) + (counts.waiting || 0)} tone={(counts.missing || counts.waiting) ? 'warn' : 'neutral'} />
            <StatBadge label="có lỗi" value={counts.error || 0} tone={counts.error ? 'danger' : 'neutral'} />
          </div>
          <div style={{ display: 'flex', gap: 5 }}>
            <Btn
              onClick={() => setManualShowRows(v => !v)}
              disabled={isTaskActive}
              title={isTaskActive ? 'Đang tự động hiện trong lúc chạy tác vụ' : undefined}
              style={{ height: 26, padding: '0 9px', fontSize: FS.xs }}
            >
              {showRows ? 'Ẩn danh sách' : `Xem ca thiếu/lỗi (${compactNumber(need)})`}
            </Btn>
            {onRefresh && (
              <Btn onClick={onRefresh} disabled={loading} style={{ height: 26, padding: '0 9px', fontSize: FS.xs }}>
                {loading ? <Spinner size={8} /> : '↻'}
              </Btn>
            )}
          </div>
        </div>

        {!snap.active_task && snap.scope_running && (
          <div style={{ marginTop: 9, borderTop: `1px solid ${C.border2}`, paddingTop: 8, fontSize: FS.xs, color: C.text2, display: 'flex', alignItems: 'center', gap: 7, flexWrap: 'wrap' }}>
            <Spinner size={9} />
            <b>Đang chạy:</b>
            <span>{snap.scope_running.label}</span>
            <span style={{ color: C.text3 }}>— từ {new Date(snap.scope_running.since).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' })}</span>
          </div>
        )}

        {snap.active_task && (
          <div style={{ marginTop: 9, borderTop: `1px solid ${C.border2}`, paddingTop: 8, fontSize: FS.xs, color: C.text2, display: 'flex', alignItems: 'center', gap: 7, flexWrap: 'wrap' }}>
            <Spinner size={9} />
            <b>{snap.active_task.status === 'queued' ? 'Đang chờ' : 'Đang chạy'}:</b>
            <span>{snap.active_task.label || 'Tác vụ nghiên cứu'}</span>
            {snap.active_task.message && <span style={{ color: C.text3 }}>— {snap.active_task.message}</span>}
          </div>
        )}

        {snap.current_case && (
          <div style={{
            marginTop: 6, fontSize: FS.xs, color: snap.current_case.stale ? C.text3 : C.blue, display: 'flex',
            alignItems: 'center', gap: 7, flexWrap: 'wrap',
          }}>
            <b>{snap.current_case.stale ? 'Ca xử lý cuối của lần chạy trước:' : 'Đang quét:'}</b>
            <span>{snap.current_case.ho_ten || snap.current_case.ma_bn || 'BN'}{snap.current_case.ma_bn ? ` (${snap.current_case.ma_bn})` : ''}</span>
            {!!snap.current_case.total && (
              <span style={{ color: C.text3 }}>ca {snap.current_case.index}/{snap.current_case.total}</span>
            )}
            {snap.current_case.last_step && (
              <span style={{ color: C.text3 }} title={snap.current_case.last_step.takes || undefined}>
                — {snap.current_case.last_step.step}
                {snap.current_case.last_step.takes ? `: ${snap.current_case.last_step.takes}` : ''}
              </span>
            )}
          </div>
        )}

        {!isTaskActive && <LastRunNote stopped={snap.stopped} lastTask={snap.last_task} />}

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(145px, 1fr))', columnGap: 18, rowGap: 2, marginTop: 8 }}>
          {(snap.modules || []).map(part => <ModuleProgressCard key={part.key} part={part} />)}
        </div>
        {!!(snap.modules || []).length && (
          <div style={{ marginTop: 2, fontSize: FS.xs, color: C.text3, display: 'flex', gap: 12, flexWrap: 'wrap' }}>
            {[[C.green, 'Đã lấy'], [C.blue, 'Đang lấy'], [C.red, 'Lỗi'], [C.surface2, 'Chưa lấy']].map(([color, label]) => (
              <span key={label} style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                <span style={{ width: 10, height: 6, borderRadius: 2, background: color, border: `1px solid ${C.border2}` }} />{label}
              </span>
            ))}
          </div>
        )}
      </section>

      {showRows && (
        <>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
          {filterButtons.map(([id, label]) => {
            const active = filter === id;
            return (
              <button key={id} type="button" onClick={() => setFilter(id)} style={{
                height: 26, padding: '0 9px', borderRadius: 5, cursor: 'pointer',
                border: `1px solid ${active ? C.text3 : C.border2}`,
                background: active ? C.surface2 : C.surface,
                color: active ? C.text : C.text2,
                fontSize: FS.xs, fontWeight: active ? 700 : 600,
              }}>{label}</button>
            );
          })}
        </div>
        <input value={query} onChange={e => setQuery(e.target.value)} placeholder="Mã BN, mã NC, tên hoặc lỗi" style={{ ...inp, width: 235, marginLeft: 'auto', background: C.surface, fontSize: FS.xs }} />
        {generatedAt && <span style={{ fontSize: FS.xs, color: C.text3 }}>{generatedAt}</span>}
      </div>

      <ResearchMonitorTable rows={rows} max={90} filter={filter} query={query} />

      {updateBlock?.rows?.length ? (
        <details open={isTaskActive} style={{
          border: `1px solid ${isTaskActive ? C.blueBorder : C.border2}`, borderRadius: 8,
          background: isTaskActive ? C.blueBg : C.surface, padding: '8px 10px',
        }}>
          <summary style={{ cursor: 'pointer', color: isTaskActive ? C.blue : C.text2, fontSize: FS.xs, fontWeight: 700 }}>
            {isTaskActive && <Spinner size={8} />} {updateBlock.title} · {compactNumber(updateBlock.totalChanged)} mẫu
          </summary>
          <div style={{ marginTop: 8 }}>
            <SmallRowsTable max={8} rows={updateBlock.rows} columns={[
              { key: 'sample', label: 'Mẫu' },
              { key: 'patient_code', label: 'Mã BN' },
              { key: 'patient_name', label: 'Họ tên' },
              { key: 'updated', label: 'Đã cập nhật' },
              { key: 'result', label: 'Kết quả' },
              { key: 'missing', label: 'Còn thiếu' },
            ]} />
          </div>
        </details>
      ) : null}
        </>
      )}
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
