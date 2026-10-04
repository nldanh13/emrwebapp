// src/components/MedicationCatalogManager.jsx
// Danh mục thuốc: một hoặc nhiều hoạt chất + nhiều tên thương mại/cách viết trong EMR.
// `canonical` vẫn được giữ nội bộ làm khóa tương thích ngược; giao diện không bắt người dùng quản lý nó riêng.

import { useState, useEffect, useCallback } from 'react';
import { IconChevronDown, IconChevronUp, IconX } from '@tabler/icons-react';
import { C, FS } from '../tokens.js';
import { Btn, Spinner, Segmented } from './shared.jsx';
import * as api from '../api.js';
import { normalizeRouteCode, routeCategory, routeShort } from '../config/routes.js';
import { useRouteTable } from '../hooks/useRouteModel.js';
import RouteDesigner from './RouteDesigner.jsx';
import { RouteBadge } from './report/ReportShared.jsx';

function routeOptions(table) {
  const categories = table.categories || [];
  return {
    routes: table.routes || [],
    categories,
    categoryLabel: Object.fromEntries(categories.map(c => [c.code, c.label])),
    infusion: new Set((table.routes || []).filter(r => r.category === 'dich_truyen').map(r => r.code)),
  };
}

function txt(v, fb = '—') { return String(v ?? '').trim() || fb; }
function uniqueList(values) {
  const out = [];
  const seen = new Set();
  for (const value of values || []) {
    const text = String(value || '').trim();
    const key = text.toLocaleLowerCase('vi-VN');
    if (!text || seen.has(key)) continue;
    seen.add(key);
    out.push(text);
  }
  return out;
}
function medicationIngredients(med) {
  return uniqueList(med.active_ingredients || (med.active_ingredient ? [med.active_ingredient] : []));
}
function medicationTradeNames(med) {
  return uniqueList([med.canonical, ...(Array.isArray(med.aliases) ? med.aliases : [])]);
}

function emptyForm() {
  return {
    originalCanonical: '',
    active_ingredients: [],
    trade_names: [],
    semantic_aliases: '',
    category: '',
    default_volume_ml: '',
    default_rate: '',
    default_route: '',
    routes: [],
    default_route_text: '',
    default_rate_text: '',
    schedule_rule: '',
  };
}

function formFromMedication(med) {
  return {
    originalCanonical: med.canonical || '',
    active_ingredients: medicationIngredients(med),
    trade_names: medicationTradeNames(med),
    semantic_aliases: (Array.isArray(med.semantic_aliases) ? med.semantic_aliases : []).join(', '),
    category: med.category || (med.default_route ? routeCategory(med.default_route) : ''),
    default_volume_ml: med.default_volume_ml ?? '',
    default_rate: med.default_rate ?? '',
    default_route: normalizeRouteCode(med.default_route) || med.default_route || '',
    routes: (Array.isArray(med.routes) ? med.routes : []).map(r => normalizeRouteCode(r) || r),
    default_route_text: med.default_route_text || '',
    default_rate_text: med.default_rate_text || '',
    schedule_rule: med.schedule_rule || '',
  };
}

const FIELD_LABEL_STYLE = { fontSize: FS.xs, color: C.text2, marginBottom: 4 };
const INPUT_STYLE = {
  width: '100%', padding: '7px 10px', borderRadius: 6,
  background: C.surface, border: `1px solid ${C.border}`,
  color: C.text, fontSize: FS.md, boxSizing: 'border-box', fontFamily: 'inherit',
};

function Field({ label, children }) {
  return <div><div style={FIELD_LABEL_STYLE}>{label}</div>{children}</div>;
}

function TagList({ values, tone = 'default' }) {
  if (!values?.length) return <span style={{ color: C.text3 }}>—</span>;
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>
      {values.map(value => (
        <span key={value} style={{
          display: 'inline-flex', alignItems: 'center', minHeight: 24, padding: '2px 8px', borderRadius: 6,
          border: `1px solid ${tone === 'ingredient' ? C.blueBorder : C.border2}`,
          background: tone === 'ingredient' ? C.blueBg : C.surface2,
          color: tone === 'ingredient' ? C.blue : C.text2, fontSize: FS.xs, fontWeight: tone === 'ingredient' ? 600 : 500,
        }}>{value}</span>
      ))}
    </div>
  );
}

function TagEditor({ values, onChange, placeholder, addLabel = 'Thêm' }) {
  const [draft, setDraft] = useState('');
  const addValues = raw => {
    const additions = String(raw || '').split(/[,;\n]/).map(x => x.trim()).filter(Boolean);
    if (!additions.length) return;
    onChange(uniqueList([...(values || []), ...additions]));
    setDraft('');
  };
  const remove = value => onChange((values || []).filter(x => x !== value));
  return (
    <div style={{ border: `1px solid ${C.border}`, borderRadius: 7, padding: 7, background: C.surface }}>
      {!!values?.length && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 7 }}>
          {values.map(value => (
            <span key={value} style={{
              display: 'inline-flex', alignItems: 'center', gap: 5, padding: '4px 7px 4px 9px', borderRadius: 6,
              background: C.surface2, border: `1px solid ${C.border2}`, color: C.text, fontSize: FS.sm,
            }}>
              {value}
              <button type="button" aria-label={`Xóa ${value}`} onClick={() => remove(value)} style={{
                border: 'none', background: 'transparent', color: C.text3, padding: 0, cursor: 'pointer', display: 'inline-flex',
              }}><IconX size={14} stroke={2} /></button>
            </span>
          ))}
        </div>
      )}
      <div style={{ display: 'flex', gap: 6 }}>
        <input value={draft} onChange={e => setDraft(e.target.value)} placeholder={placeholder}
          onKeyDown={e => {
            if (e.key === 'Enter' || e.key === ',') {
              e.preventDefault();
              addValues(draft);
            }
          }}
          onPaste={e => {
            const pasted = e.clipboardData?.getData('text') || '';
            if (/[,;\n]/.test(pasted)) {
              e.preventDefault();
              addValues(pasted);
            }
          }}
          style={{ ...INPUT_STYLE, border: 'none', padding: '5px 6px', outline: 'none', flex: 1 }} />
        <button type="button" onClick={() => addValues(draft)} disabled={!draft.trim()} style={{
          border: `1px solid ${C.border}`, borderRadius: 6, background: C.surface2, color: C.text2,
          padding: '4px 10px', cursor: draft.trim() ? 'pointer' : 'default', fontFamily: 'inherit', fontSize: FS.sm,
        }}>{addLabel}</button>
      </div>
    </div>
  );
}

function RoutePicker({ routes, value, onChange }) {
  const selected = new Set(value);
  const toggle = code => onChange(selected.has(code) ? value.filter(c => c !== code) : [...value, code]);
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
      {routes.filter(r => r.code !== 'KHAC').map(r => {
        const on = selected.has(r.code);
        return (
          <button key={r.code} type="button" aria-pressed={on} title={r.label} onClick={() => toggle(r.code)} style={{
            height: 28, padding: '0 9px', borderRadius: 5, cursor: 'pointer', fontFamily: 'inherit',
            border: `1px solid ${on ? C.blueBorder : C.border2}`, background: on ? C.blueBg : C.surface,
            color: on ? C.blue : C.text2, fontSize: FS.sm, fontWeight: on ? 600 : 500,
          }}>{r.short}</button>
        );
      })}
    </div>
  );
}

function EditModal({ mode, initial, onClose, onSave }) {
  const { routes: ROUTES, categories: CATEGORIES, categoryLabel: CATEGORY_LABEL, infusion: INFUSION_ROUTES } = routeOptions(useRouteTable());
  const CATEGORY_OPTIONS = CATEGORIES.map(c => [c.code, c.label]);
  const [form, setForm] = useState(initial);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const set = key => e => setForm(prev => ({ ...prev, [key]: e.target.value }));
  const titleNames = form.trade_names.length ? form.trade_names.join(' / ') : 'thuốc mới';

  const handleSave = async () => {
    setError('');
    const tradeNames = uniqueList(form.trade_names);
    const ingredients = uniqueList(form.active_ingredients);
    if (!ingredients.length) {
      setError('Cần nhập ít nhất một hoạt chất.');
      return;
    }
    if (!tradeNames.length) {
      setError('Cần nhập ít nhất một tên thương mại/cách viết xuất hiện trong EMR.');
      return;
    }
    if (form.default_volume_ml !== '' && !Number.isFinite(Number(form.default_volume_ml))) {
      setError('Thể tích mặc định phải là số.');
      return;
    }
    setSaving(true);
    try {
      const canonical = tradeNames[0];
      await onSave({
        canonical,
        active_ingredients: ingredients,
        aliases: tradeNames.slice(1),
        semantic_aliases: String(form.semantic_aliases || '').split(/[,;\n]/).map(x => x.trim()).filter(Boolean),
        category: form.category.trim(),
        default_volume_ml: form.default_volume_ml,
        default_rate: form.default_rate,
        default_route: form.default_route.trim(),
        routes: form.routes.length && form.default_route && !form.routes.includes(form.default_route)
          ? [form.default_route, ...form.routes] : form.routes,
        default_route_text: form.default_route_text.trim(),
        default_rate_text: form.default_rate_text.trim(),
        schedule_rule: form.schedule_rule.trim(),
      });
      onClose();
    } catch (e) {
      setError(String(e.message || e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(23,32,51,0.42)', zIndex: 50,
      display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }} onClick={onClose}>
      <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 8,
        padding: 18, width: 620, maxWidth: '96vw', maxHeight: '92vh', overflowY: 'auto' }} onClick={e => e.stopPropagation()}>
        <div style={{ fontSize: FS.lg, fontWeight: 700, color: C.text, marginBottom: 14 }}>
          {mode === 'create' ? 'Thêm thuốc vào danh mục' : `Sửa thuốc: ${titleNames}`}
        </div>

        <div style={{ display: 'grid', gap: 12 }}>
          <Field label="Hoạt chất *">
            <TagEditor values={form.active_ingredients}
              onChange={active_ingredients => setForm(prev => ({ ...prev, active_ingredients }))}
              placeholder="VD: Acid Zoledronic" addLabel="+ Hoạt chất" />
            <div style={{ fontSize: FS.xs, color: C.text3, marginTop: 4, lineHeight: 1.45 }}>
              Thuốc đơn thường có 1 hoạt chất; thuốc phối hợp có thể khai báo 2–3 hoặc nhiều hoạt chất. Mỗi hoạt chất là một thẻ riêng.
            </div>
          </Field>

          <Field label="Tên thương mại / tên chế phẩm / cách viết trong EMR *">
            <TagEditor values={form.trade_names}
              onChange={trade_names => setForm(prev => ({ ...prev, trade_names }))}
              placeholder="VD: CLASTIZOL, Aclasta…" addLabel="+ Tên" />
            <div style={{ fontSize: FS.xs, color: C.text3, marginTop: 4, lineHeight: 1.45 }}>
              Có thể dán nhiều tên cùng lúc bằng dấu phẩy hoặc xuống dòng. Tên đầu tiên chỉ được dùng nội bộ làm khóa tương thích; không còn ô “Tên chuẩn” riêng.
            </div>
          </Field>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 10 }}>
            <Field label="Đường dùng mặc định">
              <select value={form.default_route} onChange={e => {
                const route = e.target.value;
                setForm(prev => ({ ...prev, default_route: route, category: route ? routeCategory(route) : prev.category }));
              }} style={INPUT_STYLE}>
                <option value="">Không đặt (lấy theo y lệnh)</option>
                {ROUTES.map(r => <option key={r.code} value={r.code}>{r.short === r.label ? r.label : `${r.short} · ${r.label}`}</option>)}
                {form.default_route && !ROUTES.some(r => r.code === form.default_route) && <option value={form.default_route}>{form.default_route} (chưa chuẩn)</option>}
              </select>
            </Field>
            <Field label="Chuyên mục">
              <select value={form.category} onChange={set('category')} style={INPUT_STYLE}>
                <option value="">Chưa chọn</option>
                {CATEGORY_OPTIONS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                {form.category && !CATEGORY_LABEL[form.category] && <option value={form.category}>{form.category} (chưa chuẩn)</option>}
              </select>
            </Field>
          </div>

          <Field label="Đường dùng cho phép (y lệnh ghi đường khác → cảnh báo)">
            <RoutePicker routes={ROUTES} value={form.routes} onChange={routes => setForm(prev => ({ ...prev, routes }))} />
            <div style={{ fontSize: FS.xs, color: C.text3, marginTop: 4, lineHeight: 1.45 }}>
              {form.routes.length
                ? `Chấp nhận: ${[...new Set([form.default_route, ...form.routes].filter(Boolean))].map(routeShort).join(', ')}.`
                : form.default_route
                  ? `Chưa chọn → chỉ chấp nhận đường mặc định ${routeShort(form.default_route)}.`
                  : 'Chưa chọn và chưa có đường mặc định → không kiểm tra.'}
            </div>
          </Field>

          {(INFUSION_ROUTES.has(form.default_route) || form.category === 'dich_truyen') && (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 10 }}>
              <Field label="Thể tích mặc định (ml)">
                <input value={form.default_volume_ml} onChange={set('default_volume_ml')} inputMode="decimal" placeholder="VD: 100" style={INPUT_STYLE} />
              </Field>
              <Field label={form.default_route === 'SE' ? 'Tốc độ mặc định (ml/giờ)' : 'Tốc độ mặc định (giọt/phút)'}>
                <input value={form.default_rate} onChange={set('default_rate')} inputMode="decimal" placeholder="VD: 30" style={INPUT_STYLE} />
              </Field>
            </div>
          )}

          <button type="button" onClick={() => setShowAdvanced(v => !v)} aria-expanded={showAdvanced} style={{
            display: 'inline-flex', alignItems: 'center', gap: 4, background: 'none', border: 'none', color: C.blue,
            fontSize: FS.sm, cursor: 'pointer', padding: 0, textAlign: 'left', fontFamily: 'inherit',
          }}>
            {showAdvanced ? <IconChevronUp size={15} stroke={1.9} /> : <IconChevronDown size={15} stroke={1.9} />}
            Tuỳ chọn nâng cao
          </button>

          {showAdvanced && (
            <div style={{ display: 'grid', gap: 10, paddingTop: 10, borderTop: `1px solid ${C.border2}` }}>
              <Field label="Tên suy luận (khi gõ tắt, lệch dấu)">
                <textarea value={form.semantic_aliases} onChange={set('semantic_aliases')} rows={2}
                  placeholder="Cách nhau bằng dấu phẩy hoặc xuống dòng" style={{ ...INPUT_STYLE, resize: 'vertical' }} />
              </Field>
              <Field label="Quy tắc giờ dùng"><input value={form.schedule_rule} onChange={set('schedule_rule')} style={INPUT_STYLE} /></Field>
              <Field label="Chữ hiển thị đường dùng"><input value={form.default_route_text} onChange={set('default_route_text')} style={INPUT_STYLE} /></Field>
              <Field label="Chữ hiển thị tốc độ"><input value={form.default_rate_text} onChange={set('default_rate_text')} style={INPUT_STYLE} /></Field>
            </div>
          )}
        </div>

        {error && <div style={{ padding: '7px 10px', borderRadius: 6, background: C.redBg,
          border: `1px solid ${C.redBorder}`, color: C.red, fontSize: FS.sm, marginTop: 12 }}>{error}</div>}

        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 16 }}>
          <Btn variant="default" onClick={onClose}>Hủy</Btn>
          <Btn variant="primary" disabled={saving} onClick={handleSave}>
            {saving ? <><Spinner size={12} /> Đang lưu...</> : 'Lưu'}
          </Btn>
        </div>
      </div>
    </div>
  );
}

function RouteCell({ item }) {
  const def = normalizeRouteCode(item.default_route) || item.default_route || '';
  const others = (item.routes || []).map(r => normalizeRouteCode(r) || r).filter(r => r && r !== def);
  if (!def && !others.length) return <span style={{ color: C.text3 }}>—</span>;
  return <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, alignItems: 'center' }}>
    {def && <RouteBadge route={routeShort(def)} />}
    {others.length > 0 && <span style={{ fontSize: FS.xs, color: C.text2 }}>+ {others.map(routeShort).join(', ')}</span>}
  </div>;
}

export default function MedicationCatalogManager() {
  const [tab, setTab] = useState('drugs');
  const { categoryLabel: CATEGORY_LABEL } = routeOptions(useRouteTable());
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState('');
  const [editing, setEditing] = useState(null);
  const [deleting, setDeleting] = useState('');
  const [toast, setToast] = useState('');

  const showToast = msg => { setToast(msg); setTimeout(() => setToast(''), 6000); };
  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api.getMedicationCatalog();
      setItems(data.medications || []);
    } catch (e) {
      showToast('Lỗi tải danh mục thuốc: ' + String(e.message || e));
    } finally { setLoading(false); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const handleCreate = async payload => {
    await api.createMedicationCatalog(payload);
    showToast('Đã thêm thuốc và lưu hoạt chất/tên thương mại.');
    await load();
  };
  const handleUpdate = async (key, payload) => {
    const result = await api.updateMedicationCatalog(key, payload);
    const saved = medicationIngredients(result?.medication || {});
    if (payload.active_ingredients?.length && !saved.length) {
      throw new Error('Máy chủ chưa lưu trường hoạt chất. Hãy khởi động lại backend sau khi cập nhật code rồi thử lại.');
    }
    showToast('Đã lưu hoạt chất và tên thương mại.');
    await load();
  };
  const handleDelete = async item => {
    const names = medicationTradeNames(item);
    if (!window.confirm(`Xoá “${names.join(' / ') || item.canonical}” khỏi danh mục thuốc?`)) return;
    setDeleting(item.key);
    try {
      await api.deleteMedicationCatalog(item.key);
      showToast('Đã xoá.');
      await load();
    } catch (e) { showToast('Lỗi: ' + String(e.message || e)); }
    finally { setDeleting(''); }
  };

  const q = query.trim().toLowerCase();
  const filtered = q ? items.filter(item => `${medicationIngredients(item).join(' ')} ${medicationTradeNames(item).join(' ')} ${item.category || ''}`.toLowerCase().includes(q)) : items;

  return (
    <div style={{ padding: 12, maxWidth: 1180, margin: '0 auto' }}>
      <div style={{ marginBottom: 12, display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: 10 }}>
        <div>
          <div style={{ fontSize: FS.xl, fontWeight: 700, color: C.text }}>Danh mục thuốc</div>
          <div style={{ fontSize: FS.sm, color: C.text2, marginTop: 4 }}>
            {tab === 'drugs'
              ? 'Quản lý theo hoạt chất và các tên thương mại/cách viết có thể xuất hiện trong EMR.'
              : 'Tự thiết kế đường dùng: tên, nhãn, chuyên mục và từ khoá nhận diện.'}
          </div>
        </div>
        <Segmented label="Mục danh mục" value={tab} onChange={setTab}
          options={[{ value: 'drugs', label: 'Thuốc' }, { value: 'routes', label: 'Đường dùng' }]} />
      </div>

      {tab === 'routes' ? <RouteDesigner onSaved={showToast} /> : <>
        <div style={{ marginBottom: 12, display: 'flex', justifyContent: 'flex-end' }}>
          <Btn variant="primary" onClick={() => setEditing({ mode: 'create', key: '', form: emptyForm() })}>+ Thêm thuốc</Btn>
        </div>

        <div style={{ marginBottom: 14, padding: '9px 12px', borderRadius: 7,
          background: C.blueBg, border: `1px solid ${C.blueBorder}`, fontSize: FS.sm, color: C.text2, lineHeight: 1.5 }}>
          Một thuốc có thể có <b>1 hoạt chất</b> hoặc là thuốc phối hợp có <b>nhiều hoạt chất</b>. Mỗi thuốc có thể có nhiều tên thương mại; hệ thống dùng tất cả tên đã khai báo để tìm trong Thuốc và Y lệnh khác.
        </div>

        <div style={{ marginBottom: 14 }}>
          <input value={query} onChange={e => setQuery(e.target.value)} placeholder="Tìm theo hoạt chất hoặc tên thương mại..."
            style={{ ...INPUT_STYLE, maxWidth: 460 }} />
        </div>

        {loading ? (
          <div style={{ color: C.text2, display: 'flex', gap: 8, alignItems: 'center' }}><Spinner /> Đang tải...</div>
        ) : !filtered.length ? (
          <div style={{ color: C.text3, padding: 20, textAlign: 'center' }}>{items.length ? 'Không tìm thấy thuốc phù hợp.' : 'Danh mục thuốc đang trống.'}</div>
        ) : (
          <div style={{ background: C.surface, borderTop: `1px solid ${C.border2}`, overflow: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead><tr style={{ background: C.surface2 }}>
                {['Hoạt chất', 'Tên thương mại / cách viết', 'Đường dùng', 'Chuyên mục', 'Thể tích (ml)', 'Tốc độ', 'Tác vụ'].map(h => (
                  <th key={h} style={{ padding: '8px 12px', textAlign: 'left', fontSize: FS.xs, fontWeight: 700,
                    color: C.text2, borderBottom: `1px solid ${C.border}`, whiteSpace: 'nowrap' }}>{h}</th>
                ))}
              </tr></thead>
              <tbody>{filtered.map((item, i) => {
                const ingredients = medicationIngredients(item);
                const tradeNames = medicationTradeNames(item);
                return (
                  <tr key={item.key} style={{ borderBottom: i < filtered.length - 1 ? `1px solid ${C.border2}` : 'none' }}>
                    <td style={{ padding: '10px 12px', maxWidth: 260 }}><TagList values={ingredients} tone="ingredient" /></td>
                    <td style={{ padding: '10px 12px', maxWidth: 380 }}><TagList values={tradeNames} /></td>
                    <td style={{ padding: '10px 12px' }}><RouteCell item={item} /></td>
                    <td style={{ padding: '10px 12px', fontSize: FS.sm, color: C.text2 }}>{txt(CATEGORY_LABEL[item.category] || item.category)}</td>
                    <td style={{ padding: '10px 12px', fontSize: FS.sm }}><code style={{ color: C.blue }}>{txt(item.default_volume_ml)}</code></td>
                    <td style={{ padding: '10px 12px', fontSize: FS.sm }}><code style={{ color: C.text2 }}>{txt(item.default_rate)}</code></td>
                    <td style={{ padding: '10px 12px' }}><div style={{ display: 'flex', gap: 6 }}>
                      <Btn variant="secondary" onClick={() => setEditing({ mode: 'edit', key: item.key, form: formFromMedication(item) })}
                        style={{ fontSize: FS.xs, padding: '2px 10px' }}>Sửa</Btn>
                      <Btn variant="default" disabled={deleting === item.key} onClick={() => handleDelete(item)}
                        style={{ fontSize: FS.xs, padding: '2px 10px', color: C.red }}>
                        {deleting === item.key ? <Spinner size={10} /> : 'Xoá'}
                      </Btn>
                    </div></td>
                  </tr>
                );
              })}</tbody>
            </table>
          </div>
        )}
      </>}

      {toast && <div style={{ position: 'fixed', bottom: 24, right: 24, maxWidth: 400, padding: '10px 18px', borderRadius: 8,
        background: C.surface, border: `1px solid ${C.border}`, color: C.text, fontSize: FS.md, lineHeight: 1.5,
        boxShadow: C.shadow2, zIndex: 100 }}>{toast}</div>}

      {editing && <EditModal mode={editing.mode} initial={editing.form} onClose={() => setEditing(null)}
        onSave={payload => editing.mode === 'create' ? handleCreate(payload) : handleUpdate(editing.key, payload)} />}
    </div>
  );
}
