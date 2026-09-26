// src/components/MedicationCatalogManager.jsx
// Danh mục thuốc (config/medication_catalog.json) và bảng đường dùng:
//   - Tab "Thuốc": tên chuẩn, alias, đường dùng mặc định, các đường dùng cho phép
//     (y lệnh ghi khác → cảnh báo), thể tích/tốc độ mặc định.
//   - Tab "Đường dùng": tự thiết kế đường dùng (RouteDesigner).

import { useState, useEffect, useCallback } from 'react';
import { IconChevronDown, IconChevronUp } from '@tabler/icons-react';
import { C, FS } from '../tokens.js';
import { Btn, Spinner, Segmented } from './shared.jsx';
import * as api from '../api.js';
import { normalizeRouteCode, routeCategory, routeShort } from '../config/routes.js';
import { useRouteTable } from '../hooks/useRouteModel.js';
import RouteDesigner from './RouteDesigner.jsx';
import { RouteBadge } from './report/ReportShared.jsx';

// Chuyên mục và đường dùng lấy từ model đường dùng chung (bảng chuẩn + phần tự cài).
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

function joinList(list) { return (Array.isArray(list) ? list : []).join(', '); }

function parseList(text) {
  return String(text || '')
    .split(/[,\n]/)
    .map(x => x.trim())
    .filter(Boolean);
}

function emptyForm() {
  return {
    canonical: '',
    aliases: '',
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
    canonical: med.canonical || '',
    aliases: joinList(med.aliases),
    semantic_aliases: joinList(med.semantic_aliases),
    category: med.category || (med.default_route ? routeCategory(med.default_route) : ''),
    default_volume_ml: med.default_volume_ml ?? '',
    default_rate: med.default_rate ?? '',
    // Nhãn cũ (U, IV, IM…) được đổi sang mã chuẩn khi mở để sửa.
    default_route: normalizeRouteCode(med.default_route) || med.default_route || '',
    routes: (Array.isArray(med.routes) ? med.routes : []).map(r => normalizeRouteCode(r) || r),
    default_route_text: med.default_route_text || '',
    default_rate_text: med.default_rate_text || '',
    schedule_rule: med.schedule_rule || '',
  };
}

const FIELD_LABEL_STYLE = { fontSize: 11, color: C.text2, marginBottom: 3 };
const INPUT_STYLE = {
  width: '100%', padding: '6px 10px', borderRadius: 6,
  background: C.surface, border: `1px solid ${C.border}`,
  color: C.text, fontSize: 13, boxSizing: 'border-box', fontFamily: 'inherit',
};

function Field({ label, children }) {
  return (
    <div>
      <div style={FIELD_LABEL_STYLE}>{label}</div>
      {children}
    </div>
  );
}

// Chọn nhiều đường dùng bằng nút bật/tắt.
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
            color: on ? C.blue : C.text2, fontSize: FS.sm, fontWeight: on ? 650 : 500,
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

  const set = (key) => (e) => setForm(prev => ({ ...prev, [key]: e.target.value }));

  const handleSave = async () => {
    setError('');
    if (!form.canonical.trim()) {
      setError('Cần nhập tên chuẩn của thuốc.');
      return;
    }
    if (form.default_volume_ml !== '' && !Number.isFinite(Number(form.default_volume_ml))) {
      setError('Thể tích mặc định phải là số.');
      return;
    }
    setSaving(true);
    try {
      await onSave({
        canonical: form.canonical.trim(),
        aliases: parseList(form.aliases),
        semantic_aliases: parseList(form.semantic_aliases),
        category: form.category.trim(),
        default_volume_ml: form.default_volume_ml,
        default_rate: form.default_rate,
        default_route: form.default_route.trim(),
        // Đường mặc định luôn nằm trong danh sách cho phép (nếu có danh sách).
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
      display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}
      onClick={onClose}>
      <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 6,
        padding: 18, width: 520, maxWidth: '95vw', maxHeight: '90vh', overflowY: 'auto' }}
        onClick={e => e.stopPropagation()}>

        <div style={{ fontSize: 15, fontWeight: 700, color: C.text, marginBottom: 14 }}>
          {mode === 'create' ? 'Thêm thuốc vào danh mục' : `Sửa thuốc: ${initial.canonical}`}
        </div>

        <div style={{ display: 'grid', gap: 10 }}>
          <Field label="Tên chuẩn *">
            <input value={form.canonical} onChange={set('canonical')} placeholder="VD: THERMODOL" style={INPUT_STYLE} />
          </Field>
          <Field label="Tên khác (cách nhau bằng dấu phẩy hoặc xuống dòng)">
            <textarea value={form.aliases} onChange={set('aliases')} rows={3}
              placeholder="THERMODON, PARACETAMOL 1G, EFFERALGAN 1G..." style={{ ...INPUT_STYLE, resize: 'vertical' }} />
          </Field>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 10 }}>
            <Field label="Đường dùng mặc định">
              <select value={form.default_route} onChange={e => {
                const route = e.target.value;
                // Chọn đường dùng thì tự điền chuyên mục tương ứng (vẫn đổi tay được).
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
            <div style={{ fontSize: 11, color: C.text3, marginTop: 4, lineHeight: 1.45 }}>
              {form.routes.length
                ? `Chấp nhận: ${[...new Set([form.default_route, ...form.routes].filter(Boolean))].map(routeShort).join(', ')}.`
                : form.default_route
                  ? `Chưa chọn → chỉ chấp nhận đường mặc định ${routeShort(form.default_route)}.`
                  : 'Chưa chọn và chưa có đường mặc định → không kiểm tra.'}
              {' '}Cảnh báo hiện ở mục "Cảnh báo cần kiểm tra" trong chi tiết người bệnh sau khi xử lý dữ liệu.
            </div>
          </Field>
          {(INFUSION_ROUTES.has(form.default_route) || form.category === 'dich_truyen') && (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 10 }}>
              <Field label="Thể tích mặc định (ml)">
                <input value={form.default_volume_ml} onChange={set('default_volume_ml')} inputMode="decimal" placeholder="VD: 100" style={INPUT_STYLE} />
              </Field>
              <Field label={form.default_route === 'SE' ? 'Tốc độ mặc định (ml/giờ)' : 'Tốc độ mặc định (giọt/phút)'}>
                <input value={form.default_rate} onChange={set('default_rate')} inputMode="decimal" placeholder="VD: 100" style={INPUT_STYLE} />
              </Field>
            </div>
          )}

          <button type="button" onClick={() => setShowAdvanced(v => !v)} aria-expanded={showAdvanced} style={{
            display: 'inline-flex', alignItems: 'center', gap: 4,
            background: 'none', border: 'none', color: C.blue, fontSize: FS.sm, cursor: 'pointer',
            padding: 0, textAlign: 'left', fontFamily: 'inherit',
          }}>
            {showAdvanced ? <IconChevronUp size={15} stroke={1.9} aria-hidden="true" /> : <IconChevronDown size={15} stroke={1.9} aria-hidden="true" />}
            Tuỳ chọn nâng cao (tên suy luận, quy tắc giờ dùng, chữ hiển thị)
          </button>

          {showAdvanced && (
            <div style={{ display: 'grid', gap: 10, paddingTop: 10, borderTop: `1px solid ${C.border2}` }}>
              <Field label="Tên suy luận (khi gõ tắt, lệch dấu)">
                <textarea value={form.semantic_aliases} onChange={set('semantic_aliases')} rows={2}
                  placeholder="Cách nhau bằng dấu phẩy hoặc xuống dòng" style={{ ...INPUT_STYLE, resize: 'vertical' }} />
              </Field>
              <Field label="Quy tắc giờ dùng">
                <input value={form.schedule_rule} onChange={set('schedule_rule')} placeholder="VD: order_time_first_then_remaining_routine" style={INPUT_STYLE} />
              </Field>
              <Field label="Chữ hiển thị đường dùng">
                <input value={form.default_route_text} onChange={set('default_route_text')} placeholder="VD: TTM 100 giọt/phút" style={INPUT_STYLE} />
              </Field>
              <Field label="Chữ hiển thị tốc độ">
                <input value={form.default_rate_text} onChange={set('default_rate_text')} placeholder="VD: 100 giọt/phút" style={INPUT_STYLE} />
              </Field>
            </div>
          )}
        </div>

        {error && (
          <div style={{ padding: '6px 10px', borderRadius: 6, background: C.redBg,
            border: `1px solid ${C.redBorder}`, color: C.red, fontSize: 12, marginTop: 12 }}>
            {error}
          </div>
        )}

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

// Đường mặc định (nhãn màu) + các đường khác được phép.
function RouteCell({ item }) {
  const def = normalizeRouteCode(item.default_route) || item.default_route || '';
  const others = (item.routes || []).map(r => normalizeRouteCode(r) || r).filter(r => r && r !== def);
  if (!def && !others.length) return <span style={{ color: C.text3 }}>—</span>;
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, alignItems: 'center' }}>
      {def && <RouteBadge route={routeShort(def)} />}
      {others.length > 0 && <span style={{ fontSize: FS.xs, color: C.text2 }}>+ {others.map(routeShort).join(', ')}</span>}
    </div>
  );
}

export default function MedicationCatalogManager() {
  const [tab, setTab] = useState('drugs');
  const { categoryLabel: CATEGORY_LABEL } = routeOptions(useRouteTable());
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState('');
  const [editing, setEditing] = useState(null); // { mode: 'create'|'edit', key, form }
  const [deleting, setDeleting] = useState('');
  const [toast, setToast] = useState('');

  const showToast = (msg) => { setToast(msg); setTimeout(() => setToast(''), 6000); };

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api.getMedicationCatalog();
      setItems(data.medications || []);
    } catch (e) {
      showToast('Lỗi tải danh mục thuốc: ' + String(e.message || e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const handleCreate = async (payload) => {
    await api.createMedicationCatalog(payload);
    showToast('Đã thêm thuốc. Cần chạy lại "③ Xử lý & phân loại" ở tab Lấy dữ liệu để áp dụng cho dữ liệu đã quét trước đó.');
    await load();
  };

  const handleUpdate = async (key, payload) => {
    await api.updateMedicationCatalog(key, payload);
    showToast('Đã cập nhật. Cần chạy lại "③ Xử lý & phân loại" ở tab Lấy dữ liệu để áp dụng cho dữ liệu đã quét trước đó.');
    await load();
  };

  const handleDelete = async (item) => {
    if (!window.confirm(`Xoá "${item.canonical}" khỏi danh mục thuốc?`)) return;
    setDeleting(item.key);
    try {
      await api.deleteMedicationCatalog(item.key);
      showToast('Đã xoá.');
      await load();
    } catch (e) {
      showToast('Lỗi: ' + String(e.message || e));
    } finally {
      setDeleting('');
    }
  };

  const q = query.trim().toLowerCase();
  const filtered = q
    ? items.filter(item => `${item.canonical} ${joinList(item.aliases)} ${item.category || ''}`.toLowerCase().includes(q))
    : items;

  return (
    <div style={{ padding: 12, maxWidth: 1080, margin: '0 auto' }}>
      <div style={{ marginBottom: 12, display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: 10 }}>
        <div>
          <div style={{ fontSize: 16, fontWeight: 700, color: C.text }}>Danh mục thuốc</div>
          <div style={{ fontSize: 12, color: C.text2, marginTop: 4 }}>
            {tab === 'drugs'
              ? 'Tên chuẩn, alias, đường dùng cho phép và thể tích mặc định — dùng để suy luận và cảnh báo khi y lệnh ghi khác.'
              : 'Tự thiết kế đường dùng: tên, nhãn, chuyên mục, cách hiện trên báo cáo ca trực và từ khoá nhận diện.'}
          </div>
        </div>
        <Segmented label="Mục danh mục" value={tab} onChange={setTab}
          options={[{ value: 'drugs', label: 'Thuốc' }, { value: 'routes', label: 'Đường dùng' }]} />
      </div>

      {tab === 'routes' ? <RouteDesigner onSaved={showToast} /> : <>
      <div style={{ marginBottom: 12, display: 'flex', justifyContent: 'flex-end' }}>
        <Btn variant="primary" onClick={() => setEditing({ mode: 'create', key: '', form: emptyForm() })}>
          + Thêm thuốc
        </Btn>
      </div>

      <div style={{
        marginBottom: 14, padding: '9px 12px', borderRadius: 7,
        background: C.blueBg, border: `1px solid ${C.blueBorder}`,
        fontSize: 12, color: C.text2, lineHeight: 1.5,
      }}>
        Thêm/sửa thuốc ở đây <b>không áp dụng ngược</b> cho dữ liệu đã quét/phân loại trước đó — chỉ có hiệu lực từ lần chạy
        "③ Xử lý &amp; phân loại" tiếp theo (tab "Lấy dữ liệu"). Đã thêm thuốc mới nhưng phần nhập dịch truyền chưa thấy?
        Vào tab "Lấy dữ liệu" và chạy lại bước ③.
      </div>

      <div style={{ marginBottom: 14 }}>
        <input
          value={query}
          onChange={e => setQuery(e.target.value)}
          placeholder="Tìm theo tên chuẩn, alias, chuyên mục..."
          style={{ ...INPUT_STYLE, maxWidth: 360 }}
        />
      </div>

      {loading ? (
        <div style={{ color: C.text2, display: 'flex', gap: 8, alignItems: 'center' }}>
          <Spinner /> Đang tải...
        </div>
      ) : !filtered.length ? (
        <div style={{ color: C.text3, padding: 20, textAlign: 'center' }}>
          {items.length ? 'Không tìm thấy thuốc phù hợp.' : 'Danh mục thuốc đang trống.'}
        </div>
      ) : (
        <div style={{ background: C.surface, borderTop: `1px solid ${C.border2}`, overflow: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ background: C.surface2 }}>
                {['Tên chuẩn', 'Tên khác', 'Đường dùng', 'Chuyên mục', 'Thể tích (ml)', 'Tốc độ', 'Tác vụ'].map(h => (
                  <th key={h} style={{ padding: '8px 12px', textAlign: 'left', fontSize: 11,
                    fontWeight: 700, color: C.text2, borderBottom: `1px solid ${C.border}`,
                    letterSpacing: 0.15, whiteSpace: 'nowrap' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filtered.map((item, i) => (
                <tr key={item.key} style={{ borderBottom: i < filtered.length - 1 ? `1px solid ${C.border2}` : 'none' }}>
                  <td style={{ padding: '10px 12px', fontSize: 13, color: C.text, fontWeight: 500 }}>{txt(item.canonical)}</td>
                  <td style={{ padding: '10px 12px', fontSize: 11.5, color: C.text2, maxWidth: 320 }}>
                    {item.aliases?.length ? joinList(item.aliases) : <span style={{ color: C.text3 }}>—</span>}
                  </td>
                  <td style={{ padding: '10px 12px', fontSize: 12, color: C.text2 }}>
                    <RouteCell item={item} />
                  </td>
                  <td style={{ padding: '10px 12px', fontSize: 12, color: C.text2 }}>{txt(CATEGORY_LABEL[item.category] || item.category)}</td>
                  <td style={{ padding: '10px 12px', fontSize: 12 }}>
                    <code style={{ color: C.blue }}>{txt(item.default_volume_ml)}</code>
                  </td>
                  <td style={{ padding: '10px 12px', fontSize: 12 }}>
                    <code style={{ color: C.text2 }}>{txt(item.default_rate)}</code>
                  </td>
                  <td style={{ padding: '10px 12px' }}>
                    <div style={{ display: 'flex', gap: 6 }}>
                      <Btn variant="secondary" onClick={() => setEditing({ mode: 'edit', key: item.key, form: formFromMedication(item) })}
                        style={{ fontSize: 11, padding: '2px 10px' }}>
                        Sửa
                      </Btn>
                      <Btn variant="default" disabled={deleting === item.key} onClick={() => handleDelete(item)}
                        style={{ fontSize: 11, padding: '2px 10px', color: C.red }}>
                        {deleting === item.key ? <Spinner size={10} /> : 'Xoá'}
                      </Btn>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      </>}

      {toast && (
        <div style={{ position: 'fixed', bottom: 24, right: 24, maxWidth: 380, padding: '10px 18px',
          borderRadius: 8, background: C.surface, border: `1px solid ${C.border}`,
          color: C.text, fontSize: 13, lineHeight: 1.5, boxShadow: C.shadow2, zIndex: 100 }}>
          {toast}
        </div>
      )}

      {editing && (
        <EditModal
          mode={editing.mode}
          initial={editing.form}
          onClose={() => setEditing(null)}
          onSave={(payload) => editing.mode === 'create' ? handleCreate(payload) : handleUpdate(editing.key, payload)}
        />
      )}
    </div>
  );
}
