// Nghiên cứu → Phiếu nhập tay & theo dõi: các biến không có trên EMR (phỏng vấn, đo lúc truyền,
// gọi điện sau truyền). Ba phần:
//   Lịch gọi theo dõi  mỗi Mã NC × mốc (T24/T48/T72/Ngày 7): hạn gọi = mốc + số giờ, trạng thái
//   Nhập phiếu         nhập theo từng Mã NC, kiểm kiểu giá trị ở server
//   Thiết kế phiếu     trường, nhóm, kiểu, lựa chọn, mốc theo dõi; có mẫu dựng sẵn
// Mốc của từng mẫu: nhập tay, hoặc tự lấy từ "mốc thời gian" của nghiên cứu (vd. giờ y lệnh truyền thuốc).
import { useCallback, useEffect, useMemo, useState } from 'react';
import * as api from '../../api.js';
import { C, FS } from '../../tokens.js';
import { Btn, Segmented } from '../shared.jsx';
import { compactNumber, text } from './researchFormat.js';
import { inp, EmptyState } from './researchUi.jsx';
import { CRF_PRESETS, buildPresetForm } from './crfPresets.js';
import { useUnsavedChangesGuard } from '../../hooks/useTabActivity.js';
import { SkeletonLines } from '../Skeleton.jsx';

const card = { border: `1px solid ${C.border2}`, borderRadius: 8, background: C.surface, padding: '12px 14px' };
const TYPE_LABELS = [['number', 'Số'], ['text', 'Chữ'], ['choice', 'Lựa chọn'], ['yesno', 'Có/Không'], ['date', 'Ngày'], ['datetime', 'Ngày giờ']];
const STATUS_LABELS = { pending: 'Chưa gọi', done: 'Đã xong', unreachable: 'Không liên lạc được' };

// Đọc thời điểm mốc: "2026-03-10T14:00", "2026-03-10 14:00", "14:00 10/03/2026", "10/03/2026 14:00", "10/03/2026".
function parseWhen(value) {
  const s = text(value);
  if (!s) return null;
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{1,2}):(\d{2}))?/);
  if (m) return new Date(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0));
  m = s.match(/^(?:(\d{1,2}):(\d{2})\s+)?(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(\d{1,2}):(\d{2}))?/);
  if (m) return new Date(+m[5], +m[4] - 1, +m[3], +(m[1] || m[6] || 0), +(m[2] || m[7] || 0));
  return null;
}
const fmt = d => (d ? d.toLocaleString('vi-VN', { hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit', year: 'numeric' }) : '—');

function anchorOf(sample) {
  const manual = parseWhen(sample.anchor_at);
  if (manual) return { at: manual, source: 'nhập tay' };
  const auto = parseWhen(sample.anchor_auto);
  return auto ? { at: auto, source: 'tự động' } : null;
}

// Tình trạng một lần gọi so với bây giờ: sắp tới / đến hạn (trong 24 giờ kể từ hạn) / quá hạn.
function callState(due, status, now) {
  if (status === 'done') return ['done', 'Đã xong', C.green];
  if (!due) return ['no_anchor', 'Chưa có mốc', C.text3];
  if (now < due.getTime() - 2 * 3600000) return ['upcoming', 'Sắp tới', C.text2];
  if (now <= due.getTime() + 24 * 3600000) return ['due', status === 'unreachable' ? 'Gọi lại' : 'Đến hạn', C.blue];
  return ['overdue', 'Quá hạn', C.red];
}

function FieldInput({ field, value, onChange, hiddenSaved }) {
  const common = { 'aria-label': field.label, style: { ...inp, width: '100%', height: 32, boxSizing: 'border-box' } };
  if (field.type === 'choice' || field.type === 'yesno') {
    const options = field.type === 'yesno' ? [['1', 'Có'], ['0', 'Không']] : field.options.map(o => [o, o]);
    return (
      <select value={value ?? ''} onChange={e => onChange(e.target.value)} {...common}>
        <option value="">—</option>
        {options.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
      </select>
    );
  }
  const type = field.type === 'number' ? 'number' : field.type === 'date' ? 'date' : field.type === 'datetime' ? 'datetime-local' : 'text';
  return (
    <input type={type} step={field.type === 'number' ? 'any' : undefined} value={value ?? ''}
      min={field.min} max={field.max} onChange={e => onChange(e.target.value)}
      placeholder={hiddenSaved ? 'Đã lưu (đang ẩn)' : ''} {...common} />
  );
}

// autoValues: { [fieldId]: { value, source } } — giá trị gợi ý từ dữ liệu EMR/kho đã điền sẵn.
function AutoNote({ auto, value }) {
  if (!auto) return null;
  const shown = auto.value === '1' ? 'Có' : auto.value === '0' ? 'Không' : auto.value;
  const same = String(value ?? '') === String(auto.value);
  return (
    <span style={{ fontSize: FS.xs, color: same ? C.green : C.amber, lineHeight: 1.35 }}>
      {same ? `Tự điền từ dữ liệu: ${auto.source}` : `Đã sửa · dữ liệu ghi: ${shown} (${auto.source})`}
    </span>
  );
}

function FieldGrid({ fields, values, onChange, hiddenSaved = [], autoValues = {} }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(230px, 1fr))', gap: '10px 14px' }}>
      {fields.map(f => (
        <label key={f.id} style={{ display: 'grid', gap: 4, fontSize: FS.sm, color: C.text2, alignContent: 'start' }}>
          <span>{f.label}{f.unit ? <span style={{ color: C.text3 }}> ({f.unit})</span> : null}{f.identifier ? <span style={{ color: C.amber }}> · định danh</span> : null}</span>
          <FieldInput field={f} value={values?.[f.id]} onChange={v => onChange(f.id, v)} hiddenSaved={hiddenSaved.includes(f.id) && values?.[f.id] === undefined} />
          <AutoNote auto={autoValues[f.id]} value={values?.[f.id]} />
        </label>
      ))}
    </div>
  );
}

const groupBy = (list, key) => list.reduce((acc, item) => { (acc[item[key] || ''] ||= []).push(item); return acc; }, {});

// ── Lịch gọi theo dõi ──────────────────────────────────────────────────────
function ScheduleView({ data, onOpen }) {
  const [showAll, setShowAll] = useState(false);
  const now = Date.now();
  const phoneField = data.form.fields.find(f => f.identifier && !f.timepoint);
  const rows = [];
  for (const s of data.samples) {
    const anchor = anchorOf(s);
    for (const tp of data.form.timepoints) {
      const status = s.timepoints?.[tp.id]?.status || 'pending';
      const due = anchor ? new Date(anchor.at.getTime() + tp.offset_hours * 3600000) : null;
      const [state, label, color] = callState(due, status, now);
      rows.push({ s, tp, due, state, label, color, status, attempts: s.timepoints?.[tp.id]?.attempts || 0 });
    }
  }
  const counts = rows.reduce((acc, r) => { acc[r.state] = (acc[r.state] || 0) + 1; return acc; }, {});
  const order = { overdue: 0, due: 1, upcoming: 2, no_anchor: 3, done: 4 };
  const shown = rows
    .filter(r => showAll || ['overdue', 'due'].includes(r.state))
    .sort((a, b) => order[a.state] - order[b.state] || (a.due?.getTime() ?? Infinity) - (b.due?.getTime() ?? Infinity));
  const chip = (state, label, color) => (
    <span key={state} style={{ fontSize: FS.sm, color: C.text2 }}><b style={{ color }}>{compactNumber(counts[state] || 0)}</b> {label}</span>
  );
  if (!data.form.timepoints.length) {
    return <div style={card}><EmptyState title="Phiếu chưa có mốc theo dõi" hint="Thêm mốc (vd. 24 giờ, 48 giờ, ngày 7) ở phần Thiết kế phiếu để có lịch gọi." /></div>;
  }
  return (
    <div style={{ display: 'grid', gap: 10 }}>
      <div style={{ ...card, display: 'flex', gap: 16, flexWrap: 'wrap', alignItems: 'center' }}>
        {chip('overdue', 'quá hạn', C.red)}
        {chip('due', 'đến hạn', C.blue)}
        {chip('upcoming', 'sắp tới', C.text)}
        {chip('done', 'đã xong', C.green)}
        {!!counts.no_anchor && chip('no_anchor', 'chưa có mốc', C.amber)}
        <label style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 6, fontSize: FS.sm, color: C.text2 }}>
          <input type="checkbox" checked={showAll} onChange={e => setShowAll(e.target.checked)} />
          Hiện cả lần gọi sắp tới, đã xong, chưa có mốc
        </label>
      </div>
      {!!counts.no_anchor && (
        <div style={{ fontSize: FS.xs, color: C.amber }}>
          {compactNumber(counts.no_anchor)} lần gọi chưa tính được hạn vì mẫu chưa có thời điểm mốc. Nhập "Thời điểm mốc" trong phiếu,
          hoặc đặt mốc "Lần đầu dùng thuốc" khi tạo nghiên cứu để lấy tự động từ y lệnh.
        </div>
      )}
      {!shown.length
        ? <div style={card}><EmptyState title="Không có lần gọi nào đến hạn" hint="Bật ô bên trên để xem cả các lần gọi sắp tới." /></div>
        : (
          <div style={{ ...card, padding: 0, overflow: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: FS.sm, minWidth: 620 }}>
              <thead style={{ background: C.surface2 }}><tr>
                {['Mã NC', phoneField ? phoneField.label : null, 'Lần gọi', 'Hạn gọi', 'Tình trạng', ''].filter(x => x !== null).map(h => (
                  <th key={h || 'act'} style={{ textAlign: 'left', padding: '7px 10px', fontSize: FS.xs, color: C.text2, borderBottom: `1px solid ${C.border2}` }}>{h}</th>
                ))}
              </tr></thead>
              <tbody>
                {shown.map(r => (
                  <tr key={`${r.s.research_code}_${r.tp.id}`} style={{ borderBottom: `1px solid ${C.border2}` }}>
                    <td style={{ padding: '7px 10px', fontWeight: 700, color: C.text }}>{r.s.research_code}</td>
                    {phoneField && <td style={{ padding: '7px 10px', fontVariantNumeric: 'tabular-nums' }}>{r.s.values?.[phoneField.id] || (r.s.identifiers_saved?.includes(phoneField.id) ? 'đang ẩn' : '—')}</td>}
                    <td style={{ padding: '7px 10px' }}>{r.tp.label}{r.attempts ? <span style={{ color: C.text3 }}> · {r.attempts} lần không liên lạc được</span> : null}</td>
                    <td style={{ padding: '7px 10px', fontVariantNumeric: 'tabular-nums' }}>{fmt(r.due)}</td>
                    <td style={{ padding: '7px 10px', fontWeight: 700, color: r.color }}>{r.label}</td>
                    <td style={{ padding: '5px 10px', textAlign: 'right' }}>
                      <Btn onClick={() => onOpen(r.s.research_code, r.tp.id)} style={{ height: 28, fontSize: FS.xs }}>Nhập kết quả</Btn>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
    </div>
  );
}

// ── Nhập phiếu ─────────────────────────────────────────────────────────────
function EntryView({ data, studyId, selected, setSelected, focusTp, toast, onSaved }) {
  const [query, setQuery] = useState('');
  const [draft, setDraft] = useState(null);
  const [baseline, setBaseline] = useState('');
  const [saving, setSaving] = useState(false);
  const sample = data.samples.find(s => s.research_code === selected) || null;
  // Phiếu đang nhập có thay đổi chưa lưu (so với lúc mở phiếu).
  const dirty = Boolean(draft) && JSON.stringify(draft) !== baseline;
  useUnsavedChangesGuard(dirty);
  const baseFields = data.form.fields.filter(f => !f.timepoint);
  const sections = groupBy(baseFields, 'section');
  const tpFields = groupBy(data.form.fields.filter(f => f.timepoint), 'timepoint');

  useEffect(() => {
    if (!sample) { setDraft(null); return; }
    // Trường chưa nhập tay: điền sẵn giá trị lấy từ dữ liệu EMR/kho (sửa được; bấm Lưu để giữ).
    const autoDefaults = Object.fromEntries(Object.entries(sample.auto_values || {})
      .filter(([id]) => sample.values?.[id] === undefined || sample.values?.[id] === '')
      .map(([id, v]) => [id, v.value]));
    const next = {
      anchor_at: sample.anchor_at || '',
      values: { ...autoDefaults, ...sample.values },
      timepoints: Object.fromEntries(data.form.timepoints.map(tp => [tp.id, {
        status: sample.timepoints?.[tp.id]?.status || 'pending',
        note: sample.timepoints?.[tp.id]?.note || '',
        values: { ...(sample.timepoints?.[tp.id]?.values || {}) },
      }])),
    };
    setDraft(next);
    // Giá trị tự điền không tính là thay đổi (xuất dữ liệu đã tự lấy giá trị tự điền khi chưa nhập tay).
    setBaseline(JSON.stringify(next));
  }, [sample?.research_code, sample?.updated_at, Object.keys(sample?.auto_values || {}).length]); // eslint-disable-line

  useEffect(() => {
    if (focusTp) document.getElementById(`crf-tp-${focusTp}`)?.scrollIntoView?.({ block: 'start', behavior: 'smooth' });
  }, [focusTp, selected, draft === null]); // eslint-disable-line

  const filled = s => baseFields.length ? Math.round(baseFields.filter(f => s.values?.[f.id] || s.auto_values?.[f.id] || s.identifiers_saved?.includes(f.id)).length * 100 / baseFields.length) : 0;
  const list = data.samples.filter(s => !query || s.research_code.toLowerCase().includes(query.toLowerCase()));

  const save = async () => {
    if (!draft || !sample) return false;
    setSaving(true);
    try {
      // Chỉ gửi trường định danh khi người nhập đã gõ giá trị (đang ẩn thì giữ giá trị cũ).
      const values = { ...draft.values };
      for (const f of data.form.fields.filter(x => x.identifier)) if (values[f.id] === undefined) delete values[f.id];
      const r = await api.saveResearchStudyCrfEntry(studyId, sample.research_code, { ...draft, values });
      setBaseline(JSON.stringify(draft));
      toast?.(r.message || 'Đã lưu.', 'ok');
      await onSaved();
      return true;
    } catch (e) {
      toast?.(String(e.message || e), 'error');
      return false;
    } finally { setSaving(false); }
  };
  // Chọn mẫu khác khi phiếu đang nhập chưa lưu: lưu trước rồi mới chuyển (lưu lỗi thì ở lại).
  const choose = async (code) => {
    if (code === selected) return;
    if (dirty && !(await save())) return;
    setSelected(code);
  };

  const setValue = (id, v) => setDraft(p => ({ ...p, values: { ...p.values, [id]: v } }));
  const setTp = (tp, patch) => setDraft(p => ({ ...p, timepoints: { ...p.timepoints, [tp]: { ...p.timepoints[tp], ...patch } } }));
  const anchor = sample ? anchorOf({ ...sample, anchor_at: draft?.anchor_at }) : null;

  return (
    <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start', flexWrap: 'wrap' }}>
      <aside style={{ ...card, flex: '0 1 220px', minWidth: 190, padding: 8, display: 'grid', gap: 6 }}>
        <input value={query} onChange={e => setQuery(e.target.value)} placeholder="Tìm Mã NC" aria-label="Tìm Mã NC" style={{ ...inp, height: 30 }} />
        <div style={{ maxHeight: 'calc(100vh - 330px)', overflow: 'auto', display: 'grid' }}>
          {list.map(s => {
            const pct = filled(s);
            const active = s.research_code === selected;
            return (
              <button key={s.research_code} type="button" onClick={() => choose(s.research_code)} style={{
                display: 'flex', justifyContent: 'space-between', gap: 8, padding: '7px 8px', border: 0, borderRadius: 5, cursor: 'pointer',
                background: active ? C.blueBg : 'transparent', color: active ? C.blue : C.text, fontFamily: 'inherit', fontSize: FS.sm, fontWeight: active ? 700 : 500, textAlign: 'left',
              }}>
                <span>{s.research_code}</span>
                <span style={{ fontSize: FS.xs, color: pct === 100 ? C.green : C.text3, fontVariantNumeric: 'tabular-nums' }}>{pct}%</span>
              </button>
            );
          })}
        </div>
      </aside>

      <div style={{ flex: '1 1 560px', minWidth: 0, display: 'grid', gap: 12 }}>
        {!sample || !draft ? <div style={card}><EmptyState title="Chọn một Mã NC" hint="Chọn mẫu ở danh sách bên trái để nhập phiếu." /></div> : (
          <>
            <section style={{ ...card, display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'end' }}>
              <div style={{ fontSize: FS.lg, fontWeight: 700, color: C.text, marginRight: 'auto' }}>{sample.research_code}</div>
              <label style={{ display: 'grid', gap: 4, fontSize: FS.sm, color: C.text2 }}>
                Thời điểm mốc (vd. bắt đầu truyền)
                <input type="datetime-local" value={draft.anchor_at} onChange={e => setDraft(p => ({ ...p, anchor_at: e.target.value }))} style={{ ...inp, height: 32 }} />
              </label>
              <div style={{ fontSize: FS.xs, color: C.text3, maxWidth: 260 }}>
                {anchor ? <>Đang dùng mốc {anchor.source}: <b style={{ color: C.text2 }}>{fmt(anchor.at)}</b></> : 'Chưa có mốc: chưa tính được hạn gọi theo dõi.'}
                {!draft.anchor_at && sample.anchor_auto ? ` (${sample.anchor_auto_source || 'lấy từ y lệnh'}; nhập tay để thay)` : ''}
              </div>
            </section>

            {!data.form.fields.some(f => f.auto) && (
              <div style={{ ...card, background: C.amberBg, borderColor: C.amberBorder, fontSize: FS.sm, color: C.text2 }}>
                Phiếu này chưa có câu tự điền từ dữ liệu EMR (năm sinh, giới, khoa, xét nghiệm, thuốc, bệnh kèm). Vào <b>Thiết kế phiếu</b> → <b>Dùng mẫu này</b> → <b>Lưu thiết kế phiếu</b> để có; dữ liệu đã nhập được giữ.
              </div>
            )}
            {Object.entries(sections).map(([section, fields]) => (
              <section key={section || 'chung'} style={card}>
                <div style={{ fontSize: FS.md, fontWeight: 700, color: C.text, marginBottom: 10 }}>{section || 'Thông tin chung'}</div>
                <FieldGrid fields={fields} values={draft.values} onChange={setValue} hiddenSaved={sample.identifiers_saved || []} autoValues={sample.auto_values || {}} />
              </section>
            ))}

            {data.form.timepoints.map(tp => {
              const t = draft.timepoints[tp.id];
              const due = anchor ? new Date(anchor.at.getTime() + tp.offset_hours * 3600000) : null;
              return (
                <section key={tp.id} id={`crf-tp-${tp.id}`} style={{ ...card, borderColor: focusTp === tp.id ? C.blue : C.border2 }}>
                  <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', marginBottom: 10 }}>
                    <span style={{ fontSize: FS.md, fontWeight: 700, color: C.text }}>Theo dõi {tp.label}</span>
                    <span style={{ fontSize: FS.xs, color: C.text3 }}>hạn gọi {fmt(due)}</span>
                    <select value={t.status} onChange={e => setTp(tp.id, { status: e.target.value })} aria-label={`Tình trạng ${tp.label}`} style={{ ...inp, height: 30, marginLeft: 'auto' }}>
                      {Object.entries(STATUS_LABELS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                    </select>
                  </div>
                  {!!tpFields[tp.id]?.length && (
                    <FieldGrid fields={tpFields[tp.id]} values={t.values} onChange={(id, v) => setTp(tp.id, { values: { ...t.values, [id]: v } })} />
                  )}
                  <input value={t.note} onChange={e => setTp(tp.id, { note: e.target.value })} placeholder="Ghi chú lần gọi" aria-label={`Ghi chú ${tp.label}`} style={{ ...inp, width: '100%', height: 30, marginTop: 10, boxSizing: 'border-box' }} />
                </section>
              );
            })}

            <div style={{ position: 'sticky', bottom: 0, background: C.bg, padding: '8px 0', display: 'flex', justifyContent: 'flex-end' }}>
              {dirty && <span role="status" style={{ fontSize: FS.sm, color: C.amber, alignSelf: 'center', marginRight: 10 }}>Chưa lưu — chọn mẫu khác sẽ tự lưu phiếu này</span>}
              <Btn variant="solidPrimary" onClick={save} loading={saving} style={{ height: 34, padding: '0 20px' }}>Lưu phiếu {sample.research_code}</Btn>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ── Thiết kế phiếu ─────────────────────────────────────────────────────────
function DesignView({ data, studyId, toast, onSaved }) {
  const [form, setForm] = useState(() => ({ timepoints: data.form.timepoints, fields: data.form.fields }));
  const [saving, setSaving] = useState(false);
  useEffect(() => { setForm({ timepoints: data.form.timepoints, fields: data.form.fields }); }, [data.form.updated_at]); // eslint-disable-line

  const setField = (i, patch) => setForm(p => ({ ...p, fields: p.fields.map((f, j) => (j === i ? { ...f, ...patch } : f)) }));
  const setTp = (i, patch) => setForm(p => ({ ...p, timepoints: p.timepoints.map((t, j) => (j === i ? { ...t, ...patch } : t)) }));
  const save = async () => {
    setSaving(true);
    try {
      const r = await api.saveResearchStudyCrfForm(studyId, form);
      toast?.(r.message || 'Đã lưu phiếu.', 'ok');
      await onSaved();
    } catch (e) {
      toast?.(String(e.message || e), 'error');
    } finally { setSaving(false); }
  };
  const usePreset = (preset) => {
    if (form.fields.length && !window.confirm('Thay toàn bộ trường hiện tại bằng mẫu? Dữ liệu đã nhập của trường cùng mã vẫn giữ.')) return;
    setForm(buildPresetForm(preset));
  };
  const cell = { padding: '4px 4px', verticalAlign: 'top' };
  const small = { ...inp, height: 28, fontSize: FS.xs, width: '100%', boxSizing: 'border-box' };

  return (
    <div style={{ display: 'grid', gap: 12 }}>
      <section style={{ ...card, display: 'grid', gap: 8 }}>
        <div style={{ fontSize: FS.md, fontWeight: 700, color: C.text }}>Dùng mẫu phiếu có sẵn</div>
        {CRF_PRESETS.map(p => (
          <div key={p.key} style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
            <div style={{ flex: '1 1 300px' }}>
              <div style={{ fontSize: FS.sm, fontWeight: 700, color: C.text }}>{p.label}</div>
              <div style={{ fontSize: FS.xs, color: C.text3 }}>{p.description}</div>
            </div>
            <Btn onClick={() => usePreset(p)} style={{ height: 30 }}>Dùng mẫu này</Btn>
          </div>
        ))}
      </section>

      <section style={{ ...card, display: 'grid', gap: 8 }}>
        <div style={{ fontSize: FS.md, fontWeight: 700, color: C.text }}>Mốc theo dõi (gọi điện sau mốc)</div>
        {form.timepoints.map((tp, i) => (
          <div key={i} style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', fontSize: FS.sm, color: C.text2 }}>
            <input value={tp.id} onChange={e => setTp(i, { id: e.target.value })} aria-label="Mã mốc" placeholder="T24" style={{ ...inp, width: 70, height: 30 }} />
            <input value={tp.label} onChange={e => setTp(i, { label: e.target.value })} aria-label="Tên mốc" placeholder="24 giờ" style={{ ...inp, width: 160, height: 30 }} />
            <input type="number" value={tp.offset_hours} onChange={e => setTp(i, { offset_hours: e.target.value })} aria-label="Số giờ sau mốc" style={{ ...inp, width: 80, height: 30 }} />
            <span>giờ sau mốc</span>
            <button type="button" aria-label="Xóa mốc" onClick={() => setForm(p => ({ ...p, timepoints: p.timepoints.filter((_, j) => j !== i) }))} style={{ border: 0, background: 'transparent', color: C.red, cursor: 'pointer' }}>✕</button>
          </div>
        ))}
        <div><Btn onClick={() => setForm(p => ({ ...p, timepoints: [...p.timepoints, { id: '', label: '', offset_hours: 24 }] }))} style={{ height: 28, fontSize: FS.xs }}>+ Thêm mốc</Btn></div>
      </section>

      <section style={{ ...card, padding: 0, overflow: 'auto' }}>
        <div style={{ padding: '12px 14px 4px', fontSize: FS.md, fontWeight: 700, color: C.text }}>Trường của phiếu ({form.fields.length})</div>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: FS.xs, minWidth: 980 }}>
          <thead><tr>
            {[['Nhóm', 150], ['Câu hỏi / nhãn', 230], ['Kiểu', 100], ['Lựa chọn (cách nhau ;)', 220], ['Đơn vị', 70], ['Min', 60], ['Max', 60], ['Thuộc mốc', 100], ['Định danh', 60], ['', 30]].map(([h, w]) => (
              <th key={h || 'x'} style={{ width: w, textAlign: 'left', padding: '6px 4px', color: C.text3, fontWeight: 600, borderBottom: `1px solid ${C.border2}` }}>{h}</th>
            ))}
          </tr></thead>
          <tbody>
            {form.fields.map((f, i) => (
              <tr key={i} style={{ borderBottom: `1px solid ${C.border2}` }}>
                <td style={cell}><input value={f.section || ''} onChange={e => setField(i, { section: e.target.value })} aria-label="Nhóm" style={small} /></td>
                <td style={cell}><input value={f.label} onChange={e => setField(i, { label: e.target.value })} aria-label="Nhãn" style={small} /></td>
                <td style={cell}>
                  <select value={f.type} onChange={e => setField(i, { type: e.target.value })} aria-label="Kiểu" style={small}>
                    {TYPE_LABELS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                  </select>
                </td>
                <td style={cell}>{f.type === 'choice' && (
                  <input value={Array.isArray(f.options) ? f.options.join('; ') : (f.options || '')} onChange={e => setField(i, { options: e.target.value })} aria-label="Lựa chọn" style={small} />
                )}</td>
                <td style={cell}><input value={f.unit || ''} onChange={e => setField(i, { unit: e.target.value })} aria-label="Đơn vị" style={small} /></td>
                <td style={cell}>{f.type === 'number' && <input type="number" value={f.min ?? ''} onChange={e => setField(i, { min: e.target.value })} aria-label="Min" style={small} />}</td>
                <td style={cell}>{f.type === 'number' && <input type="number" value={f.max ?? ''} onChange={e => setField(i, { max: e.target.value })} aria-label="Max" style={small} />}</td>
                <td style={cell}>
                  <select value={f.timepoint || ''} onChange={e => setField(i, { timepoint: e.target.value })} aria-label="Thuộc mốc" style={small}>
                    <option value="">Thông tin chung</option>
                    {form.timepoints.filter(tp => text(tp.id)).map(tp => <option key={tp.id} value={tp.id}>{tp.label || tp.id}</option>)}
                  </select>
                </td>
                <td style={{ ...cell, textAlign: 'center' }}><input type="checkbox" checked={Boolean(f.identifier)} onChange={e => setField(i, { identifier: e.target.checked })} aria-label="Trường định danh" title="Thông tin định danh (vd. số điện thoại): không có trong file xuất phân tích" /></td>
                <td style={cell}><button type="button" aria-label={`Xóa trường ${f.label}`} onClick={() => setForm(p => ({ ...p, fields: p.fields.filter((_, j) => j !== i) }))} style={{ border: 0, background: 'transparent', color: C.red, cursor: 'pointer' }}>✕</button></td>
              </tr>
            ))}
          </tbody>
        </table>
        <div style={{ padding: 10 }}>
          <Btn onClick={() => setForm(p => ({ ...p, fields: [...p.fields, { section: p.fields[p.fields.length - 1]?.section || '', label: '', type: 'text', timepoint: '' }] }))} style={{ height: 28, fontSize: FS.xs }}>+ Thêm trường</Btn>
        </div>
      </section>

      <div style={{ position: 'sticky', bottom: 0, background: C.bg, padding: '8px 0', display: 'flex', alignItems: 'center', gap: 10, justifyContent: 'flex-end' }}>
        <span style={{ fontSize: FS.xs, color: C.text3 }}>Xóa hoặc đổi tên trường không xóa dữ liệu đã nhập; trường "định danh" không có trong file xuất phân tích.</span>
        <Btn variant="solidPrimary" onClick={save} loading={saving} disabled={!form.fields.length} style={{ height: 34, padding: '0 20px' }}>Lưu thiết kế phiếu</Btn>
      </div>
    </div>
  );
}

export function CrfView({ study, toast }) {
  const studyId = study?.id || '';
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [mode, setMode] = useState('');
  const [selected, setSelected] = useState('');
  const [focusTp, setFocusTp] = useState('');
  const [showContacts, setShowContacts] = useState(false);

  const load = useCallback(async () => {
    if (!studyId) return;
    setLoading(true);
    try {
      const r = await api.getResearchStudyCrf(studyId, { identified: showContacts });
      setData(r);
      if (r.identified_note) toast?.(r.identified_note, 'info');
    } catch (e) {
      toast?.(String(e.message || e), 'error');
    } finally { setLoading(false); }
  }, [studyId, showContacts, toast]);
  useEffect(() => { load(); }, [load]);

  const hasForm = Boolean(data?.form?.fields?.length);
  const activeMode = mode || (!hasForm ? 'design' : data.form.timepoints.length ? 'schedule' : 'entry');
  const doneCount = useMemo(() => (data?.samples || []).filter(s => s.updated_at).length, [data]);

  if (!data) return <div style={{ padding: 12 }}><div style={card}>{loading ? <div role="status" aria-busy="true" aria-label="Đang tải phiếu"><SkeletonLines lines={6} /></div> : 'Chưa tải được phiếu.'}</div></div>;
  return (
    <div style={{ padding: '10px 12px 16px', display: 'grid', gap: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <Segmented
          label="Phần của phiếu nhập tay"
          value={activeMode}
          onChange={setMode}
          options={[
            { value: 'schedule', label: 'Lịch gọi theo dõi' },
            { value: 'entry', label: 'Nhập phiếu' },
            { value: 'design', label: 'Thiết kế phiếu' },
          ].filter(o => hasForm || o.value === 'design')}
        />
        <span style={{ fontSize: FS.xs, color: C.text3 }}>
          {hasForm ? `${data.form.fields.length} trường · ${data.form.timepoints.length} mốc theo dõi · đã nhập ${compactNumber(doneCount)}/${compactNumber(data.samples.length)} mẫu` : 'Chưa có thiết kế phiếu.'}
        </span>
        {hasForm && data.form.fields.some(f => f.identifier) && (
          <label style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 6, fontSize: FS.sm, color: C.text2 }}
            title="Cần quyền xem dữ liệu định danh như ở Tra cứu người bệnh">
            <input type="checkbox" checked={showContacts} onChange={e => setShowContacts(e.target.checked)} />
            Hiện thông tin liên lạc
          </label>
        )}
      </div>
      {activeMode === 'design' && <DesignView data={data} studyId={studyId} toast={toast} onSaved={load} />}
      {activeMode === 'schedule' && <ScheduleView data={data} onOpen={(code, tp) => { setSelected(code); setFocusTp(tp); setMode('entry'); }} />}
      {activeMode === 'entry' && <EntryView data={data} studyId={studyId} selected={selected || data.samples[0]?.research_code || ''} setSelected={code => { setSelected(code); setFocusTp(''); }} focusTp={focusTp} toast={toast} onSaved={load} />}
    </div>
  );
}
