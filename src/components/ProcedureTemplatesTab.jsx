// src/components/ProcedureTemplatesTab.jsx
// Tab "Mẫu thủ thuật – PT": mỗi DVKT thủ thuật / phẫu thuật một mẫu nhập. Phòng khám chọn mẫu theo
// tên DVKT (từ khoá) lúc nhập thủ thuật / kết thúc mổ; người thực hiện lấy theo Lịch Phòng khám.
// Sửa xong tự lưu (~0,8 giây); rời tab khi còn thay đổi thì lưu ngay.
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { IconCopy, IconPlus, IconRefresh, IconTrash } from '@tabler/icons-react';
import ctchCatalog from '../../config/procedure_templates.ctch_neuro.suggestions.json';
import { C, FS, R } from '../tokens.js';
import { Btn, Segmented } from './shared.jsx';
import { SkeletonTable } from './Skeleton.jsx';
import * as api from '../api.js';
import { useOnTabReturn, useUnsavedChangesGuard } from '../hooks/useTabActivity.js';
import useIsMobile from '../hooks/useIsMobile.js';
import {
  KIND_OPTIONS, PERFORMER_OPTIONS, SCOPE_OPTIONS,
  cleanKeywords, defaultTemplates, keywordConflicts, newTemplate, summary, templateFromMissing, uncoveredMissing,
  foldText, catalogAlreadyAdded, catalogDraft, catalogReviewIssues,
} from './procedureTemplates/templateModel.js';

const TAB_ID = 'procedure-templates';
const SAVE_DELAY_MS = 800;

const fieldStyle = {
  width: '100%', boxSizing: 'border-box', minHeight: 32, padding: '6px 8px', borderRadius: R.sm,
  border: `1px solid ${C.border}`, background: C.surface, color: C.text, fontSize: FS.md, fontFamily: 'inherit',
};

function Field({ label, hint, children }) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 }}>
      <span style={{ fontSize: FS.sm, fontWeight: 600, color: C.text2 }}>{label}</span>
      {children}
      {hint ? <span style={{ fontSize: FS.xs, color: C.text3 }}>{hint}</span> : null}
    </label>
  );
}

function Note({ tone = 'info', children }) {
  const tones = {
    info: { bg: C.blueBg, border: C.blueBorder, color: C.text2 },
    warn: { bg: C.amberBg, border: C.amberBorder, color: C.amber },
  };
  const t = tones[tone] || tones.info;
  return (
    <div style={{ padding: '8px 10px', borderRadius: R.sm, border: `1px solid ${t.border}`, background: t.bg, color: t.color, fontSize: FS.sm }}>
      {children}
    </div>
  );
}

function saveLabel(save) {
  if (save.state === 'pending') return 'Có thay đổi, đang chờ tự lưu…';
  if (save.state === 'saving') return 'Đang lưu…';
  if (save.state === 'saved') return `Đã tự lưu lúc ${save.at}`;
  if (save.state === 'error') return `Chưa lưu được: ${save.message}`;
  return '';
}

function TemplateList({ items, selectedId, onSelect }) {
  if (!items.length) {
    return <div style={{ padding: 12, fontSize: FS.sm, color: C.text3 }}>Chưa có mẫu nào. Bấm "Thêm mẫu".</div>;
  }
  return (
    <ul aria-label="Danh sách mẫu" style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 4 }}>
      {items.map(t => {
        const active = t.id === selectedId;
        return (
          <li key={t.id}>
            <button type="button" onClick={() => onSelect(t.id)} aria-current={active || undefined} style={{
              width: '100%', textAlign: 'left', padding: '8px 10px', borderRadius: R.sm, cursor: 'pointer',
              border: `1px solid ${active ? C.blueBorder : C.border2}`, background: active ? C.blueBg : C.surface,
              color: C.text, fontFamily: 'inherit', opacity: t.enabled === false ? 0.6 : 1,
            }}>
              <div style={{ fontSize: FS.md, fontWeight: 600 }}>{t.name || '(chưa đặt tên)'}</div>
              <div style={{ fontSize: FS.xs, color: C.text3, marginTop: 2 }}>
                {t.performer === 'bac_si' ? 'Bác sĩ' : 'Điều dưỡng'} · {t.minutes} phút
                {t.enabled === false ? ' · Đang tắt' : t.auto === false ? ' · Nhập tay' : ''}
              </div>
              <div style={{ fontSize: FS.xs, color: C.text2, marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {summary(t)}
              </div>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

function MissingList({ items, onCreate }) {
  if (!items.length) return null;
  return (
    <section aria-label="DVKT chưa có mẫu" style={{ background: C.amberBg, border: `1px solid ${C.amberBorder}`, borderRadius: R.md, padding: 10 }}>
      <div style={{ fontSize: FS.sm, fontWeight: 600, color: C.amber, marginBottom: 6 }}>
        DVKT chưa có mẫu, Phòng khám đã bỏ qua ({items.length})
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {items.map(m => (
          <div key={`${m.kind}:${m.name}`} style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', fontSize: FS.sm, color: C.text }}>
            <span style={{ flex: '1 1 220px' }}>
              <b>{m.name}</b>
              <span style={{ color: C.text3 }}> · {m.count || 1} lần{m.ho_ten ? ` · gần nhất ${m.ho_ten}` : ''}</span>
            </span>
            <Btn icon={IconPlus} onClick={() => onCreate(m)}>Tạo mẫu</Btn>
          </div>
        ))}
      </div>
    </section>
  );
}

function CatalogSuggestions({ templates, onAdd, onAddPriority }) {
  const [query, setQuery] = useState('');
  const [level, setLevel] = useState('A');
  const rows = useMemo(() => ctchCatalog.suggestions.filter(t =>
    (level === 'all' || t.priority === level) &&
    (!query.trim() || foldText(`${t.name} ${t.code} ${t.group}`).includes(foldText(query)))
  ), [query, level]);
  const added = ctchCatalog.suggestions.filter(t => catalogAlreadyAdded(templates, t)).length;
  return (
    <section aria-label="Danh mục gợi ý CTCH – Thần kinh" style={{
      border: `1px solid ${C.blueBorder}`, borderRadius: R.md, background: C.surface, padding: 12,
      display: 'flex', flexDirection: 'column', gap: 10,
    }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', justifyContent: 'space-between' }}>
        <div>
          <div style={{ fontSize: FS.lg, fontWeight: 700, color: C.text }}>Kỹ thuật gợi ý CTCH – Thần kinh</div>
          <div style={{ fontSize: FS.sm, color: C.text3 }}>
            {ctchCatalog.suggestions.length} kỹ thuật · {added} đã có mẫu · 16 ưu tiên theo công việc thực tế
          </div>
        </div>
        <Btn icon={IconPlus} onClick={onAddPriority} disabled={ctchCatalog.suggestions.filter(t => t.priority === 'A' && !catalogAlreadyAdded(templates, t)).length === 0}>
          Thêm các mẫu ưu tiên chưa có
        </Btn>
      </div>
      <Note tone="warn">
        Chỉ là danh mục để đối chiếu, chưa xác nhận kỹ thuật được bệnh viện phê duyệt.
        Thêm vào chỉ tạo <b>bản nháp đang tắt</b>; cần duyệt mã DVKT, người thực hiện, mẫu EMR và nội dung tường trình trước khi bật tự nhập.
        Các kỹ thuật trùng hoặc gần giống nhau phải chọn đúng mã trên EMR.
      </Note>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
        <input style={{ ...fieldStyle, flex: '1 1 230px', width: 'auto' }} aria-label="Tìm kỹ thuật CTCH"
          value={query} onChange={e => setQuery(e.target.value)} placeholder="Tìm tên hoặc mã DVKT, nhóm..." />
        <select aria-label="Mức gợi ý" style={{ ...fieldStyle, flex: '0 0 210px', width: 'auto' }}
          value={level} onChange={e => setLevel(e.target.value)}>
          <option value="A">Ưu tiên theo công việc (16)</option>
          <option value="B">Kỹ thuật cần đối chiếu (24)</option>
          <option value="all">Tất cả (40)</option>
        </select>
      </div>
      <div style={{ maxHeight: 325, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 6 }}>
        {rows.map(item => {
          const isAdded = catalogAlreadyAdded(templates, item);
          return (
            <div key={item.code} style={{
              display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap',
              border: `1px solid ${C.border2}`, borderRadius: R.sm, padding: '8px 10px',
            }}>
              <div style={{ flex: '1 1 240px', minWidth: 0 }}>
                <div style={{ fontSize: FS.md, color: C.text, fontWeight: 600 }}>{item.name}</div>
                <div style={{ fontSize: FS.xs, color: C.text3 }}>
                  Mã {item.code} · {item.group} · {item.kind === 'phau_thuat' ? 'Phẫu thuật' : 'Thủ thuật'}
                </div>
                <div style={{ fontSize: FS.xs, color: C.text2 }}>{item.note}</div>
              </div>
              <Btn icon={isAdded ? undefined : IconPlus} disabled={isAdded} onClick={() => onAdd(item)}>
                {isAdded ? 'Đã có mẫu' : 'Thêm bản nháp'}
              </Btn>
            </div>
          );
        })}
        {!rows.length ? <div style={{ padding: 8, fontSize: FS.sm, color: C.text3 }}>Không tìm thấy kỹ thuật trong danh mục gợi ý.</div> : null}
      </div>
    </section>
  );
}

function TemplateEditor({ template, templates, onChange, onDuplicate, onDelete, onReview }) {
  const set = (key) => (e) => onChange({ [key]: e.target.value });
  const pt = template.kind === 'phau_thuat';
  const requiresReview = !!template.catalog_code && template.reviewed !== true;
  const reviewIssues = catalogReviewIssues(template);
  const conflicts = keywordConflicts(templates, template);
  const isDefault = !cleanKeywords(template).length;
  const defaults = defaultTemplates(templates, template.kind);
  const shadowed = isDefault && template.enabled !== false && defaults[0] && defaults[0].id !== template.id;
  const grid = { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 12 };

  return (
    <section aria-label="Sửa mẫu" style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div style={grid}>
        <Field label="Tên mẫu">
          <input style={fieldStyle} value={template.name} onChange={set('name')} placeholder={pt ? 'vd. Cắt u bã đậu' : 'vd. Thay băng vết thương'} />
        </Field>
        <Field label="Loại">
          <Segmented label="Loại" value={template.kind} options={KIND_OPTIONS} onChange={v => onChange({ kind: v })} />
        </Field>
      </div>

      <Field
        label="Từ khoá tên DVKT (mỗi dòng một từ khoá)"
        hint={pt
          ? 'Khớp với Nội dung phẫu thuật / Chỉ định mổ trên EMR, không phân biệt dấu. Để trống = mẫu mặc định cho mọi ca mổ chưa có mẫu riêng.'
          : 'Khớp với tên DVKT trên D/s Thủ thuật, không phân biệt dấu. Để trống = mẫu mặc định cho mọi thủ thuật chưa có mẫu riêng.'}
      >
        <textarea
          style={{ ...fieldStyle, minHeight: 64, resize: 'vertical' }}
          value={(template.keywords || []).join('\n')}
          onChange={e => onChange({ keywords: e.target.value.split('\n') })}
          placeholder={pt ? 'cắt u bã đậu' : 'thay băng\ncắt chỉ'}
        />
      </Field>
      {conflicts.length ? (
        <Note tone="warn">
          {conflicts.map(c => `"${c.keyword}" cũng có ở mẫu "${c.other}"`).join('; ')}. Hai mẫu trùng từ khoá thì mẫu có từ khoá dài hơn được chọn; nên sửa cho mỗi DVKT chỉ khớp một mẫu.
        </Note>
      ) : null}
      {shadowed ? (
        <Note tone="warn">Mẫu "{defaults[0].name || '(chưa đặt tên)'}" cũng không có từ khoá và đứng trước, nên mẫu này không bao giờ được chọn. Thêm từ khoá hoặc tắt một mẫu.</Note>
      ) : null}

      <div style={grid}>
        <Field label={pt ? 'Người mổ chính / gây mê chính' : 'Thủ thuật viên chính'} hint="Tên lấy theo Lịch Phòng khám ngày nhập.">
          <Segmented label="Người thực hiện" value={template.performer} options={PERFORMER_OPTIONS} onChange={v => onChange({ performer: v })} />
        </Field>
        <Field label="Thời gian (phút)" hint={pt ? 'Bắt đầu = giờ vào khoa + 1 phút.' : 'Bắt đầu = giờ chỉ định.'}>
          <input style={fieldStyle} type="number" min={1} max={240} value={template.minutes}
            onChange={e => onChange({ minutes: e.target.value === '' ? '' : Number(e.target.value) })} />
        </Field>
        <Field label="Phương pháp vô cảm" hint="Ghi đúng chữ trong ô chọn trên EMR.">
          <input style={fieldStyle} value={template.anesthesia} onChange={set('anesthesia')} />
        </Field>
        {pt ? (
          <Field label="Tư thế">
            <input style={fieldStyle} value={template.position} onChange={set('position')} />
          </Field>
        ) : (
          <Field label="Mẫu tường trình EMR" hint="Tên mẫu trong ô chọn trên phiếu thủ thuật EMR.">
            <input style={fieldStyle} value={template.emr_template} onChange={set('emr_template')} placeholder="vd. CTCH-thay băng" />
          </Field>
        )}
      </div>

      <div style={grid}>
        <Field label="Áp dụng cho">
          <Segmented label="Áp dụng cho" value={template.applies_to} options={SCOPE_OPTIONS} onChange={v => onChange({ applies_to: v })} />
        </Field>
        <Field label="Cách nhập">
          <span style={{ display: 'flex', flexWrap: 'wrap', gap: 14, alignItems: 'center', minHeight: 32, fontSize: FS.md, color: C.text }}>
            <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
              <input type="checkbox" checked={template.auto !== false} disabled={requiresReview} onChange={e => onChange({ auto: e.target.checked })} aria-label="Tự nhập" />
              Tự nhập
            </span>
            <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
              <input type="checkbox" checked={template.enabled !== false} disabled={requiresReview} onChange={e => onChange({ enabled: e.target.checked })} aria-label="Đang dùng" />
              Đang dùng
            </span>
          </span>
        </Field>
      </div>

      {pt ? (
        <>
          <Field label="Phương pháp phẫu thuật" hint="Để trống = giữ phương pháp đã chọn trên EMR.">
            <input style={fieldStyle} value={template.phuong_phap} onChange={set('phuong_phap')} />
          </Field>
          <Field label="Mô tả phương pháp phẫu thuật" hint="Để trống = giữ nội dung đang có trên EMR.">
            <textarea style={{ ...fieldStyle, minHeight: 64, resize: 'vertical' }} value={template.mo_ta} onChange={set('mo_ta')} />
          </Field>
          <Field label="Trình tự phẫu thuật (tường trình)" hint="Để trống = giữ nội dung đang có trên EMR.">
            <textarea style={{ ...fieldStyle, minHeight: 140, resize: 'vertical' }} value={template.report} onChange={set('report')} />
          </Field>
          <Field label="Dặn dò sau phẫu thuật" hint="Để trống = giữ nội dung đang có trên EMR.">
            <textarea style={{ ...fieldStyle, minHeight: 64, resize: 'vertical' }} value={template.dan_do} onChange={set('dan_do')} />
          </Field>
        </>
      ) : (
        <>
          <Field label="Nội dung tường trình">
            <textarea style={{ ...fieldStyle, minHeight: 140, resize: 'vertical' }} value={template.report} onChange={set('report')} />
          </Field>
          <Note>
            Khi nhập, app chọn "Mẫu tường trình EMR" rồi ghi nội dung này vào ô EMR vừa tự điền.
            Để trống thì giữ nguyên nội dung EMR tự điền.
          </Note>
        </>
      )}

      <Field label="Ghi chú">
        <input style={fieldStyle} value={template.note} onChange={set('note')} />
      </Field>
      {template.catalog_code ? (
        <Note tone={requiresReview ? 'warn' : 'info'}>
          Mã DMKT tham khảo: <b>{template.catalog_code}</b>.
          {requiresReview ? (
            <>
              {' '}Mẫu đang tắt và chưa được duyệt. Kiểm tra kỹ thuật được phép triển khai, tên DVKT trên EMR, người thực hiện, nội dung tường trình.
              {reviewIssues.length ? <div style={{ marginTop: 4 }}>Cần hoàn thành: {reviewIssues.join(' ')}</div> : null}
              <div style={{ marginTop: 8 }}>
                <Btn disabled={reviewIssues.length > 0} onClick={onReview}>Xác nhận đã duyệt mẫu</Btn>
              </div>
            </>
          ) : ' Đã duyệt cấu hình; chỉ hoạt động khi bạn bật “Đang dùng” và “Tự nhập”.'}
        </Note>
      ) : null}

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <Btn icon={IconCopy} onClick={onDuplicate}>Nhân bản mẫu</Btn>
        <Btn variant="danger" icon={IconTrash} onClick={onDelete}>Xoá mẫu</Btn>
      </div>
    </section>
  );
}

export default function ProcedureTemplatesTab({ toast }) {
  const isMobile = useIsMobile();
  const [templates, setTemplates] = useState(null);
  const [loadError, setLoadError] = useState('');
  const [kind, setKind] = useState('thu_thuat');
  const [selectedId, setSelectedId] = useState('');
  const [save, setSave] = useState({ state: '', at: '', message: '' });
  const [editVersion, setEditVersion] = useState(0);
  const [missing, setMissing] = useState([]);
  const [catalogVisible, setCatalogVisible] = useState(true);
  const templatesRef = useRef(null);
  const pendingRef = useRef(false);

  // DVKT Phòng khám bỏ qua vì chưa có mẫu (đọc từ màn theo dõi, không mở EMR).
  const loadMissing = useCallback(async () => {
    try {
      const res = await api.getClinicMonitorState();
      const list = res?.monitor?.missing_templates;
      setMissing(Array.isArray(list) ? list : []);
    } catch {
      setMissing([]);
    }
  }, []);

  const load = useCallback(async () => {
    try {
      const res = await api.getProcedureTemplates();
      const rows = Array.isArray(res?.templates) ? res.templates : [];
      templatesRef.current = rows;
      setTemplates(rows);
      setLoadError('');
    } catch (e) {
      setLoadError(String(e.message || e));
    }
  }, []);

  useEffect(() => { load(); loadMissing(); }, [load, loadMissing]);
  // Quay lại tab: tải lại (máy khác có thể đã sửa), trừ khi còn thay đổi chưa lưu.
  useOnTabReturn(() => { if (!pendingRef.current) load(); loadMissing(); });
  useUnsavedChangesGuard(save.state === 'pending' || save.state === 'error');

  const saveNow = useCallback(async () => {
    if (!templatesRef.current) return true;
    pendingRef.current = false;
    setSave({ state: 'saving', at: '', message: '' });
    try {
      await api.saveProcedureTemplates(templatesRef.current);
      setSave({ state: 'saved', at: new Date().toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' }), message: '' });
      return true;
    } catch (e) {
      pendingRef.current = true;
      const message = String(e.message || e);
      setSave({ state: 'error', at: '', message });
      toast?.(`Chưa lưu được mẫu thủ thuật – PT: ${message}. Sửa lại hoặc bấm "Lưu lại".`, 'error');
      return false;
    }
  }, [toast]);

  useEffect(() => {
    if (!editVersion) return undefined;
    const id = setTimeout(() => { saveNow(); }, SAVE_DELAY_MS);
    return () => clearTimeout(id);
  }, [editVersion, saveNow]);

  // Rời tab khi còn thay đổi chưa lưu: lưu ngay.
  useEffect(() => {
    const onActive = (e) => { if (e.detail !== TAB_ID && pendingRef.current) saveNow(); };
    window.addEventListener('emr:tab-active', onActive);
    return () => window.removeEventListener('emr:tab-active', onActive);
  }, [saveNow]);
  useEffect(() => () => {
    if (pendingRef.current && templatesRef.current) api.saveProcedureTemplates(templatesRef.current).catch(() => {});
  }, []);

  const commit = useCallback((next) => {
    templatesRef.current = next;
    pendingRef.current = true;
    setTemplates(next);
    setSave({ state: 'pending', at: '', message: '' });
    setEditVersion(v => v + 1);
  }, []);

  const items = useMemo(() => (templates || []).filter(t => t.kind === kind), [templates, kind]);
  const selected = (templates || []).find(t => t.id === selectedId) || items[0] || null;

  const update = (patch) => {
    if (!selected) return;
    commit(templatesRef.current.map(t => (t.id === selected.id ? { ...t, ...patch } : t)));
    if (patch.kind && patch.kind !== kind) setKind(patch.kind);
  };
  const createFromMissing = (m) => {
    const tpl = templateFromMissing(m, `tpl-${Date.now().toString(36)}`);
    commit([...(templatesRef.current || []), tpl]);
    setKind(tpl.kind);
    setSelectedId(tpl.id);
  };
  const addSuggested = (suggestion) => {
    if (catalogAlreadyAdded(templatesRef.current || [], suggestion)) {
      toast?.('Kỹ thuật này đã có mẫu. Hãy chọn mẫu hiện có để tránh trùng từ khóa.', 'info');
      return;
    }
    if ((templatesRef.current || []).length >= 300) {
      toast?.('Đã đạt giới hạn 300 mẫu. Hãy rà soát lại mẫu hiện có trước khi thêm.', 'error');
      return;
    }
    const tpl = catalogDraft(suggestion);
    commit([...(templatesRef.current || []), tpl]);
    setKind(tpl.kind);
    setSelectedId(tpl.id);
  };
  const addPriority = () => {
    const existing = templatesRef.current || [];
    const additions = ctchCatalog.suggestions.filter(item =>
      item.priority === 'A' && !catalogAlreadyAdded(existing, item)
    ).map(catalogDraft);
    if (!additions.length) return;
    if (existing.length + additions.length > 300) {
      toast?.('Thêm các mẫu ưu tiên sẽ vượt giới hạn 300 mẫu.', 'error');
      return;
    }
    if (!window.confirm(`Thêm ${additions.length} mẫu ưu tiên dạng BẢN NHÁP ĐANG TẮT? Các mẫu đang sử dụng sẽ được giữ nguyên.`)) return;
    commit([...existing, ...additions]);
    setKind('thu_thuat');
    setSelectedId(additions[0].id);
  };
  const reviewSelected = () => {
    if (!selected?.catalog_code || selected.reviewed === true) return;
    const issues = catalogReviewIssues(selected);
    if (issues.length) {
      toast?.(issues.join(' '), 'error');
      return;
    }
    const conflicts = keywordConflicts(templatesRef.current || [], selected);
    if (conflicts.length) {
      toast?.(`Từ khóa trùng mẫu đang dùng: ${conflicts.map(c => c.other).join(', ')}. Hãy tắt mẫu cũ trước khi duyệt.`, 'error');
      return;
    }
    if (!window.confirm(`Xác nhận kỹ thuật "${selected.name}" (mã ${selected.catalog_code}) đã có trong danh mục bệnh viện được phép thực hiện, đúng DVKT trên EMR, đã kiểm tra người thực hiện và tường trình? Mẫu vẫn ở trạng thái TẮT sau khi duyệt.`)) return;
    commit(templatesRef.current.map(t => t.id === selected.id ? { ...t, reviewed: true, auto: false, enabled: false } : t));
    toast?.('Đã duyệt cấu hình mẫu. Bạn có thể bật Đang dùng và Tự nhập khi sẵn sàng.', 'success');
  };
  const add = () => {
    const tpl = newTemplate(kind);
    commit([...(templatesRef.current || []), tpl]);
    setSelectedId(tpl.id);
  };
  const duplicate = () => {
    if (!selected) return;
    const copy = { ...selected, id: `tpl-${Date.now().toString(36)}`, name: `${selected.name || 'Mẫu'} (bản sao)` };
    commit([...templatesRef.current, copy]);
    setSelectedId(copy.id);
  };
  const remove = () => {
    if (!selected) return;
    if (!window.confirm(`Xoá mẫu "${selected.name || '(chưa đặt tên)'}"? DVKT khớp mẫu này sẽ không được tự nhập nữa.`)) return;
    commit(templatesRef.current.filter(t => t.id !== selected.id));
    setSelectedId('');
  };

  if (!templates) {
    if (loadError) {
      return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, alignItems: 'flex-start' }}>
          <Note tone="warn">Chưa tải được mẫu thủ thuật – PT: {loadError}. Kiểm tra máy chủ đang chạy rồi bấm "Thử lại".</Note>
          <Btn icon={IconRefresh} onClick={load}>Thử lại</Btn>
        </div>
      );
    }
    return <SkeletonTable rows={6} cols={3} />;
  }

  const counts = Object.fromEntries(KIND_OPTIONS.map(o => [o.value, templates.filter(t => t.kind === o.value).length]));
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
        <Segmented label="Loại mẫu" value={kind}
          options={KIND_OPTIONS.map(o => ({ ...o, label: `${o.label} (${counts[o.value]})` }))}
          onChange={v => { setKind(v); setSelectedId(''); }} />
        <Btn variant="solidPrimary" icon={IconPlus} onClick={add}>Thêm mẫu</Btn>
        <span role="status" style={{ marginLeft: 'auto', fontSize: FS.sm, color: save.state === 'error' ? C.red : C.text3 }}>
          {saveLabel(save)}
        </span>
        {save.state === 'error' ? <Btn icon={IconRefresh} onClick={saveNow}>Lưu lại</Btn> : null}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <Btn onClick={() => setCatalogVisible(v => !v)}>
          {catalogVisible ? 'Ẩn danh mục gợi ý CTCH – Thần kinh' : 'Hiện danh mục gợi ý CTCH – Thần kinh'}
        </Btn>
      </div>
      {catalogVisible ? <CatalogSuggestions templates={templates} onAdd={addSuggested} onAddPriority={addPriority} /> : null}
      <MissingList items={uncoveredMissing(missing, templates)} onCreate={createFromMissing} />
      <div style={{ fontSize: FS.sm, color: C.text3 }}>
        Phòng khám chọn mẫu theo tên DVKT lúc nhập {kind === 'phau_thuat' ? 'kết thúc mổ' : 'thủ thuật'}. DVKT không khớp mẫu nào thì bỏ qua (nhập các thủ thuật khác) và hiện ở khung "DVKT chưa có mẫu" phía trên.
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : 'minmax(220px, 300px) 1fr', gap: 16, alignItems: 'start' }}>
        <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: R.md, padding: 8 }}>
          <TemplateList items={items} selectedId={selected?.id} onSelect={setSelectedId} />
        </div>
        <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: R.md, padding: 16 }}>
          {selected ? (
            <TemplateEditor template={selected} templates={templates} onChange={update} onDuplicate={duplicate} onDelete={remove} onReview={reviewSelected} />
          ) : (
            <div style={{ fontSize: FS.sm, color: C.text3 }}>Chọn một mẫu bên trái hoặc bấm "Thêm mẫu".</div>
          )}
        </div>
      </div>
    </div>
  );
}
