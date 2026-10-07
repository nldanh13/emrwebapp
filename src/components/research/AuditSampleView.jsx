// Kiểm tra ngẫu nhiên độ chính xác của kho: máy chọn một đợt, người kiểm mở EMR của người bệnh đối chiếu
// từng mục và bấm Đúng / Sai / Không chắc. Mỗi lần bấm lưu ngay (không có nút Lưu), kết quả cộng dồn
// thành tỉ lệ đạt theo từng loại dữ liệu.
import { useEffect, useState } from 'react';
import * as api from '../../api.js';
import { C, FS } from '../../tokens.js';
import { Btn } from '../shared.jsx';
import { SkeletonLines } from '../Skeleton.jsx';
import { inp } from './researchUi.jsx';
import { auditVerdictLabel, formatAccuracy, groupAuditItems, auditProgress } from './auditSampleModel.js';

const VERDICT_STYLE = {
  dung: { color: C.green, bg: C.greenBg, border: C.greenBorder },
  sai: { color: C.red, bg: C.redBg, border: C.redBorder },
  khong_chac: { color: C.text2, bg: C.surface2, border: C.border2 },
};

function errorText(e) {
  return String(e?.message || e || 'Không kết nối được máy chủ. Hãy thử lại.');
}

function VerdictButtons({ value, saving, onPick }) {
  return (
    <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
      {['dung', 'sai', 'khong_chac'].map(v => {
        const active = value === v;
        const st = VERDICT_STYLE[v];
        return (
          <button key={v} type="button" disabled={saving} onClick={() => onPick(active ? '' : v)} aria-pressed={active}
            style={{
              padding: '3px 9px', borderRadius: 4, fontSize: FS.xs, fontWeight: 700, cursor: saving ? 'wait' : 'pointer',
              border: `1px solid ${active ? st.border : C.border2}`, background: active ? st.bg : C.surface,
              color: active ? st.color : C.text3,
            }}>
            {auditVerdictLabel(v)}
          </button>
        );
      })}
    </div>
  );
}

function AuditItem({ item, onSave }) {
  const [note, setNote] = useState(item.note || '');
  const [state, setState] = useState({ saving: false, error: '' });
  useEffect(() => { setNote(item.note || ''); }, [item.note]);

  const save = async (verdict, nextNote = note) => {
    setState({ saving: true, error: '' });
    try {
      await onSave(item.id, { verdict, note: nextNote });
      setState({ saving: false, error: '' });
    } catch (e) {
      setState({ saving: false, error: `Chưa lưu được: ${errorText(e)}` });
    }
  };

  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'minmax(220px, 1fr) auto', gap: 8, padding: '8px 0', borderTop: `1px solid ${C.border2}` }}>
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: FS.sm, color: C.text, fontWeight: 600 }}>
          {item.label}
          {item.period && item.period !== 'Trong đợt' && (
            <span style={{ marginLeft: 6, padding: '1px 6px', borderRadius: 4, fontSize: FS.xs, color: C.amber, background: C.amberBg, border: `1px solid ${C.amberBorder}` }}>{item.period}</span>
          )}
        </div>
        {item.detail && <div style={{ fontSize: FS.xs, color: C.text2, marginTop: 2, whiteSpace: 'pre-wrap' }}>{item.detail}</div>}
        <div style={{ fontSize: FS.xs, color: C.text3, marginTop: 2 }}>{item.question}</div>
        {(item.verdict === 'sai' || item.verdict === 'khong_chac' || note) && (
          <input value={note} onChange={e => setNote(e.target.value)} onBlur={() => { if (note !== (item.note || '')) save(item.verdict, note); }}
            placeholder="Ghi chú: sai ở đâu, EMR ghi gì (tự lưu khi rời ô)" style={{ ...inp, marginTop: 5, width: '100%' }} />
        )}
        {state.error && <div role="alert" style={{ fontSize: FS.xs, color: C.red, marginTop: 3 }}>{state.error}</div>}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 3 }}>
        <VerdictButtons value={item.verdict} saving={state.saving} onPick={v => save(v)} />
        <span style={{ fontSize: FS.xs, color: C.text3 }}>{state.saving ? 'Đang lưu…' : item.verdict ? 'Đã lưu' : ''}</span>
      </div>
    </div>
  );
}

function SummaryTable({ summary }) {
  const rows = (summary?.groups || []).filter(g => g.checked || g.khong_chac || g.pending);
  return (
    <div style={{ border: `1px solid ${C.border2}`, borderRadius: 8, overflow: 'auto' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: FS.xs }}>
        <thead style={{ background: C.surface2 }}>
          <tr>{['Loại dữ liệu', 'Đã kiểm', 'Đúng', 'Sai', 'Không chắc', 'Tỉ lệ đạt (KTC 95%)'].map(h => (
            <th key={h} style={{ textAlign: 'left', padding: '6px 8px', color: C.text3, whiteSpace: 'nowrap' }}>{h}</th>
          ))}</tr>
        </thead>
        <tbody>
          {rows.map(g => (
            <tr key={g.group} style={{ borderTop: `1px solid ${C.border2}` }}>
              <td style={{ padding: '6px 8px', color: C.text, fontWeight: 600 }}>{g.label}</td>
              <td style={{ padding: '6px 8px' }}>{g.checked}</td>
              <td style={{ padding: '6px 8px', color: C.green }}>{g.dung}</td>
              <td style={{ padding: '6px 8px', color: g.sai ? C.red : C.text3 }}>{g.sai}</td>
              <td style={{ padding: '6px 8px', color: C.text3 }}>{g.khong_chac}</td>
              <td style={{ padding: '6px 8px', fontWeight: 700 }}>{formatAccuracy(g)}</td>
            </tr>
          ))}
          <tr style={{ borderTop: `2px solid ${C.border2}`, background: C.surface2 }}>
            <td style={{ padding: '6px 8px', fontWeight: 700 }}>Tất cả</td>
            <td style={{ padding: '6px 8px' }}>{summary?.overall?.checked || 0}</td>
            <td style={{ padding: '6px 8px', color: C.green }}>{summary?.overall?.dung || 0}</td>
            <td style={{ padding: '6px 8px', color: summary?.overall?.sai ? C.red : C.text3 }}>{summary?.overall?.sai || 0}</td>
            <td style={{ padding: '6px 8px' }} />
            <td style={{ padding: '6px 8px', fontWeight: 700 }}>{formatAccuracy(summary?.overall)}</td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}

export function AuditSampleView() {
  const [summary, setSummary] = useState(null);
  const [audit, setAudit] = useState(null);
  const [loading, setLoading] = useState(true);
  const [picking, setPicking] = useState(false);
  const [error, setError] = useState('');

  const loadSummary = async () => {
    try {
      const s = await api.getResearchAuditSummary();
      setSummary(s);
      setError('');
      return s;
    } catch (e) {
      setError(errorText(e));
      return null;
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    // Mở lại lượt kiểm còn dở gần nhất (không mất phần đang kiểm khi chuyển màn).
    (async () => {
      const s = await loadSummary();
      const open = (s?.recent || []).find(a => a.reviewed < a.total);
      if (open) {
        try { setAudit((await api.getResearchAudit(open.id)).audit); } catch (_) { /* chọn ca mới là được */ }
      }
    })();
  }, []);

  const pick = async () => {
    setPicking(true);
    setError('');
    try {
      setAudit((await api.createResearchAuditSample()).audit);
      loadSummary();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setPicking(false);
    }
  };

  const openAudit = async (id) => {
    try { setAudit((await api.getResearchAudit(id)).audit); setError(''); } catch (e) { setError(errorText(e)); }
  };

  const saveItem = async (itemId, body) => {
    const r = await api.saveResearchAuditItem(audit.id, itemId, body);
    setAudit(r.audit);
    loadSummary();
  };

  if (loading) return <div style={{ padding: 14 }}><SkeletonLines lines={6} /></div>;

  const progress = audit ? auditProgress(audit) : null;
  return (
    <div style={{ padding: '10px 12px 16px', display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div>
        <div style={{ fontSize: FS.lg, fontWeight: 700, color: C.text }}>Kiểm tra ngẫu nhiên</div>
        <div style={{ fontSize: FS.xs, color: C.text2, marginTop: 3 }}>
          Máy chọn ngẫu nhiên một đợt điều trị (ca đã kiểm không bị chọn lại). Mở EMR của người bệnh, đối chiếu từng mục rồi bấm
          {' '}<b>Đúng</b> / <b>Sai</b> / <b>Không chắc</b>. Mỗi lần bấm được lưu ngay; tỉ lệ đạt cộng dồn ở bảng bên dưới.
        </div>
        <div style={{ display: 'flex', gap: 8, marginTop: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <Btn variant="solidPrimary" onClick={pick} loading={picking}>{audit ? 'Chọn ca ngẫu nhiên khác' : 'Chọn ca ngẫu nhiên'}</Btn>
          <span style={{ fontSize: FS.xs, color: C.text3 }}>Đã kiểm {summary?.completed_count || 0}/{summary?.audit_count || 0} ca.</span>
        </div>
        {error && <div role="alert" style={{ marginTop: 6, fontSize: FS.sm, color: C.red }}>{error}</div>}
      </div>

      {audit && (
        <div style={{ border: `1px solid ${C.border2}`, borderRadius: 8, padding: 10, background: C.bg }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
            <div>
              <div style={{ fontSize: FS.sm, fontWeight: 700, color: C.text }}>
                Mã BN <span style={{ userSelect: 'all' }}>{audit.patient_code}</span>{audit.patient_name ? ` · ${audit.patient_name}` : ''}
              </div>
              <div style={{ fontSize: FS.xs, color: C.text2, marginTop: 2 }}>
                Đợt {audit.admission_date || '—'} → {audit.discharge_date || 'chưa ra viện'}{audit.research_code ? ` · Mã NC ${audit.research_code}` : ''}
              </div>
            </div>
            <div style={{ fontSize: FS.xs, color: progress.done ? C.green : C.text2, fontWeight: 700 }}>
              {progress.reviewed}/{progress.total} mục đã kiểm{progress.sai ? ` · ${progress.sai} sai` : ''}
            </div>
          </div>
          {groupAuditItems(audit.items).map(g => (
            <div key={g.group} style={{ marginTop: 10 }}>
              <div style={{ fontSize: FS.xs, fontWeight: 700, color: C.text2, textTransform: 'uppercase' }}>{g.label}</div>
              {g.items.map(item => <AuditItem key={item.id} item={item} onSave={saveItem} />)}
            </div>
          ))}
        </div>
      )}

      <div>
        <div style={{ fontSize: FS.sm, fontWeight: 700, color: C.text, marginBottom: 6 }}>Tỉ lệ đạt cộng dồn</div>
        {summary?.overall?.checked ? <SummaryTable summary={summary} /> : (
          <div style={{ fontSize: FS.xs, color: C.text3 }}>Chưa có mục nào được kiểm. Bấm "Chọn ca ngẫu nhiên" để bắt đầu.</div>
        )}
      </div>

      {!!summary?.failures?.length && (
        <div>
          <div style={{ fontSize: FS.sm, fontWeight: 700, color: C.red, marginBottom: 6 }}>Các mục sai ({summary.failures.length})</div>
          <div style={{ display: 'grid', gap: 4 }}>
            {summary.failures.map((f, i) => (
              <button key={`${f.audit_id}_${i}`} type="button" onClick={() => openAudit(f.audit_id)}
                style={{ textAlign: 'left', border: `1px solid ${C.redBorder}`, background: C.redBg, borderRadius: 6, padding: '6px 8px', cursor: 'pointer', fontSize: FS.xs, color: C.text2 }}>
                <b style={{ color: C.text }}>{f.group_label}</b> · Mã BN {f.patient_code} · {f.label}
                {f.note ? <div style={{ color: C.red, marginTop: 2 }}>Ghi chú: {f.note}</div> : null}
              </button>
            ))}
          </div>
        </div>
      )}

      {!!summary?.recent?.length && (
        <div>
          <div style={{ fontSize: FS.sm, fontWeight: 700, color: C.text, marginBottom: 6 }}>Các ca đã chọn gần đây</div>
          <div style={{ display: 'grid', gap: 4 }}>
            {summary.recent.map(a => (
              <button key={a.id} type="button" onClick={() => openAudit(a.id)}
                style={{ textAlign: 'left', border: `1px solid ${C.border2}`, background: audit?.id === a.id ? C.blueBg : C.surface, borderRadius: 6, padding: '6px 8px', cursor: 'pointer', fontSize: FS.xs, color: C.text2 }}>
                Mã BN {a.patient_code}{a.patient_name ? ` · ${a.patient_name}` : ''} · {a.admission_date || '—'} → {a.discharge_date || '—'}
                {' · '}<b style={{ color: a.reviewed < a.total ? C.amber : C.green }}>{a.reviewed}/{a.total} mục</b>{a.sai ? <b style={{ color: C.red }}> · {a.sai} sai</b> : null}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
