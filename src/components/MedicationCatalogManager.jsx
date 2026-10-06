// src/components/MedicationCatalogManager.jsx
// Danh mục thuốc (config/medication_catalog.json) và bảng đường dùng:
//   - Tab "Thuốc": tên chuẩn, hoạt chất, alias, đường dùng mặc định, các đường dùng cho phép
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
import DrugNameIngredientPanel from './DrugNameIngredientPanel.jsx';
import { RouteBadge } from './report/ReportShared.jsx';
import { useOnTabReturn } from '../hooks/useTabActivity.js';
import { SkeletonBlock, SkeletonTable } from './Skeleton.jsx';
import { DILUTION_APPLY, DILUTION_SOLVENTS, dilutionForm, dilutionFromForm, dilutionSummary } from '../utils/dilutionRule.js';
import DilutionCheckPanel from './DilutionCheckPanel.jsx';

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
    .split(/[,;\n]/)
    .map(x => x.trim())
    .filter(Boolean);
}

function emptyForm() {
  return {
    canonical: '',
    active_ingredients: '',
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
    ...dilutionForm(null),
  };
}

function formFromMedication(med) {
  return {
    canonical: med.canonical || '',
    active_ingredients: joinList(med.active_ingredients || (med.active_ingredient ? [med.active_ingredient] : [])),
    aliases: joinList(med.aliases),
    semantic_aliases: joinList(med.semantic_aliases),
    category: med.category || (med.default_route ? routeCategory(med.default_route) : ''),
    default_volume_ml: med.default_volume_ml ?? '',
    default_rate: med.default_rate ?? '',
    default_route: normalizeRouteCode(med.default_route) || med.default_route || '',
    routes: (Array.isArray(med.routes) ? med.routes : []).map(r => normalizeRouteCode(r) || r),
    default_route_text: med.default_route_text || '',
    default_rate_text: med.default_rate_text || '',
    schedule_rule: med.schedule_rule || '',
    ...dilutionForm(med.dilution),
  };
}

const FIELD_LABEL_STYLE = { fontSize: FS.xs, color: C.text2, marginBottom: 3 };
const INPUT_STYLE = {
  width: '100%', padding: '6px 10px', borderRadius: 6,
  background: C.surface, border: `1px solid ${C.border}`,
  color: C.text, fontSize: FS.md, boxSizing: 'border-box', fontFamily: 'inherit',
};

function Field({ label, children }) {
  return <div><div style={FIELD_LABEL_STYLE}>{label}</div>{children}</div>;
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

// Quy tắc pha: bước xử lý dữ liệu dựa vào khi y lệnh không ghi rõ dung môi/thể tích.
// Y lệnh ghi rõ (vd. "pha NaCl 0.9% lấy đủ 50ml") vẫn thắng quy tắc này.
function DilutionFields({ form, set, setForm, effective }) {
  const solvent = form.dilution_solvent;
  const builtin = !solvent && effective?.source === 'luat_san_co' ? effective.rule : null;
  return (
    <div style={{ display: 'grid', gap: 10, padding: 12, borderRadius: 6, border: `1px solid ${C.border2}`, background: C.surface2 }}>
      <div style={{ fontSize: FS.sm, fontWeight: 600, color: C.text }}>Quy tắc pha thuốc</div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 10 }}>
        <Field label="Dung môi">
          <select value={solvent} onChange={set('dilution_solvent')} style={INPUT_STYLE}>
            <option value="">Chưa đặt (dùng luật sẵn có)</option>
            {DILUTION_SOLVENTS.map(([v, label]) => <option key={v} value={v}>{label}</option>)}
          </select>
        </Field>
        {solvent && solvent !== 'KHONG_PHA' && (
          <Field label="Thể tích pha (ml)">
            <input value={form.dilution_volume_ml} onChange={set('dilution_volume_ml')} inputMode="decimal" placeholder="VD: 100" style={INPUT_STYLE} />
          </Field>
        )}
        {solvent && solvent !== 'KHONG_PHA' && (
          <Field label="Tốc độ truyền (giọt/phút, tuỳ chọn)">
            <input value={form.dilution_rate} onChange={set('dilution_rate')} inputMode="decimal" placeholder="VD: 40" style={INPUT_STYLE} />
          </Field>
        )}
        {solvent && solvent !== 'KHONG_PHA' && (
          <Field label="Khi nào pha">
            <select value={form.dilution_apply} onChange={set('dilution_apply')} style={INPUT_STYLE}>
              {DILUTION_APPLY.map(([v, label]) => <option key={v} value={v}>{label}</option>)}
            </select>
          </Field>
        )}
      </div>
      {solvent && (
        <Field label="Ghi chú pha (tuỳ chọn)">
          <input value={form.dilution_note} onChange={set('dilution_note')} maxLength={300}
            placeholder="VD: truyền tối thiểu 60 phút; không pha chung với Ceftriaxon" style={INPUT_STYLE} />
        </Field>
      )}
      <div style={{ fontSize: FS.xs, color: C.text3, lineHeight: 1.45 }}>
        {!solvent && !builtin && 'Chưa đặt và không có luật sẵn có cho thuốc này: chỉ pha khi y lệnh ghi rõ dung môi hoặc có túi Natri clorid cùng giờ.'}
        {builtin && <>
          Đang áp dụng <b>luật sẵn có</b> ({builtin.keyword}): {dilutionSummary(builtin)}.{' '}
          <button type="button" onClick={() => setForm(prev => ({ ...prev,
            dilution_solvent: builtin.solvent, dilution_volume_ml: builtin.volume_ml ?? '',
            dilution_apply: builtin.apply || 'always', dilution_note: builtin.note || '' }))}
            style={{ background: 'none', border: 'none', padding: 0, color: C.blue, cursor: 'pointer', fontSize: FS.xs, fontFamily: 'inherit', textDecoration: 'underline' }}>
            Chép vào đây để sửa
          </button>
        </>}
        {solvent === 'KHONG_PHA' && 'Không tự gắn túi Natri clorid cho thuốc này (chai/túi đã pha sẵn). Y lệnh ghi rõ dung môi vẫn được giữ.'}
        {solvent === 'NACL_0.9' && (form.dilution_apply === 'infusion_only'
          ? 'Chỉ khi y lệnh ghi truyền/TTM: chuyển sang dịch truyền với thể tích này. Y lệnh tiêm tĩnh mạch chậm giữ nguyên.'
          : 'Luôn chuyển thuốc này sang dịch truyền pha Natri clorid 0.9% với thể tích này, kể cả khi y lệnh chỉ ghi "tiêm tĩnh mạch" (trừ tiêm bắp, tiêm dưới da).')}
        {(solvent === 'GLUCOSE_5' || solvent === 'NUOC_CAT') && 'Ghi lên báo cáo ca trực để đối chiếu khi chuẩn bị thuốc; hệ thống không tự đổi dung môi.'}
        {solvent && ' Y lệnh ghi rõ dung môi/thể tích luôn được ưu tiên hơn quy tắc này.'}
      </div>
    </div>
  );
}

function EditModal({ mode, initial, effective, onClose, onSave }) {
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
    const dilution = dilutionFromForm(form);
    if (dilution.error) {
      setError(dilution.error);
      return;
    }
    setSaving(true);
    try {
      await onSave({
        canonical: form.canonical.trim(),
        active_ingredients: parseList(form.active_ingredients),
        aliases: parseList(form.aliases),
        semantic_aliases: parseList(form.semantic_aliases),
        category: form.category.trim(),
        default_volume_ml: form.default_volume_ml,
        default_rate: form.default_rate,
        default_route: form.default_route.trim(),
        routes: form.routes.length && form.default_route && !form.routes.includes(form.default_route)
          ? [form.default_route, ...form.routes] : form.routes,
        default_route_text: form.default_route_text.trim(),
        default_rate_text: form.default_rate_text.trim(),
        schedule_rule: form.schedule_rule.trim(),
        dilution: dilution.value,
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
      <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 6,
        padding: 18, width: 560, maxWidth: '95vw', maxHeight: '90vh', overflowY: 'auto' }} onClick={e => e.stopPropagation()}>
        <div style={{ fontSize: FS.lg, fontWeight: 700, color: C.text, marginBottom: 14 }}>
          {mode === 'create' ? 'Thêm thuốc vào danh mục' : `Sửa thuốc: ${initial.canonical}`}
        </div>

        <div style={{ display: 'grid', gap: 10 }}>
          <Field label="Tên chuẩn / tên chế phẩm *">
            <input value={form.canonical} onChange={set('canonical')} placeholder="VD: CLASTIZOL" style={INPUT_STYLE} />
          </Field>
          <Field label="Hoạt chất (có thể nhiều hoạt chất; cách nhau bằng dấu phẩy hoặc xuống dòng)">
            <textarea value={form.active_ingredients} onChange={set('active_ingredients')} rows={2}
              placeholder="VD: Acid Zoledronic" style={{ ...INPUT_STYLE, resize: 'vertical' }} />
            <div style={{ fontSize: FS.xs, color: C.text3, marginTop: 4, lineHeight: 1.45 }}>
              Dùng cho nghiên cứu theo hoạt chất. Nhiều chế phẩm/tên thương mại có thể cùng khai báo một hoạt chất để được gom chung khi tìm mẫu.
            </div>
          </Field>
          <Field label="Tên khác / tên thương mại / cách viết khác">
            <textarea value={form.aliases} onChange={set('aliases')} rows={3}
              placeholder="Các tên có thể xuất hiện trong EMR, cách nhau bằng dấu phẩy hoặc xuống dòng" style={{ ...INPUT_STYLE, resize: 'vertical' }} />
          </Field>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 10 }}>
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

          <DilutionFields form={form} set={set} setForm={setForm} effective={effective} />

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
            border: `1px solid ${C.redBorder}`, color: C.red, fontSize: FS.sm, marginTop: 12 }}>{error}</div>
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

const SOURCE_TAG = {
  danh_muc: { label: 'Danh mục', color: C.blue, bg: C.blueBg, border: C.blueBorder },
  luat_san_co: { label: 'Sẵn có', color: C.text2, bg: C.surface2, border: C.border2 },
};

// Quy tắc pha ĐANG áp dụng (máy chủ tính bằng hàm của worker) + nguồn. Chưa tải xong → khung xám.
function DilutionCell({ item, info }) {
  if (!info) return item.dilution ? txt(dilutionSummary(item.dilution)) : <SkeletonBlock width={70} />;
  const eff = info.catalog?.[item.canonical];
  if (!eff?.rule) return <span style={{ color: C.text3 }}>—</span>;
  const tag = SOURCE_TAG[eff.source];
  return (
    <span title={eff.rule.note || ''}>
      {dilutionSummary(eff.rule)}
      {eff.rule.matched_by === 'hoat_chat' && eff.rule.canonical !== item.canonical ? ` (theo ${eff.rule.canonical})` : ''}
      {tag && <span style={{ marginLeft: 6, padding: '0 5px', borderRadius: 4, fontSize: 11, whiteSpace: 'nowrap',
        color: tag.color, background: tag.bg, border: `1px solid ${tag.border}` }}>{tag.label}</span>}
    </span>
  );
}

const INJECTABLE_CATEGORIES = new Set(['thuoc_tiem', 'dich_truyen']);

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
  const [editing, setEditing] = useState(null);
  const [deleting, setDeleting] = useState('');
  const [toast, setToast] = useState('');
  const [dilutionInfo, setDilutionInfo] = useState(null);
  const [ruleFilter, setRuleFilter] = useState('all');

  const showToast = (msg) => { setToast(msg); setTimeout(() => setToast(''), 6000); };

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api.getMedicationCatalog();
      setItems(data.medications || []);
      // Quy tắc pha đang áp dụng cho từng thuốc (gồm luật sẵn có) — tải sau, không chặn bảng.
      api.checkMedicationDilution({ include_catalog: true })
        .then(info => setDilutionInfo({ catalog: info.catalog || {}, builtin: info.builtin || [] }))
        .catch(() => setDilutionInfo({ catalog: {}, builtin: [], failed: true }));
    } catch (e) {
      showToast('Lỗi tải danh mục thuốc: ' + String(e.message || e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);
  useOnTabReturn(() => load());

  const handleCreate = async (payload) => {
    await api.createMedicationCatalog(payload);
    showToast('Đã thêm thuốc. Hoạt chất/tên thương mại mới có thể dùng cho lọc nghiên cứu; dữ liệu xử lý thuốc cũ cần chạy lại bước xử lý nếu muốn áp dụng suy luận khác.');
    await load();
  };

  const handleUpdate = async (key, payload) => {
    await api.updateMedicationCatalog(key, payload);
    showToast('Đã cập nhật danh mục thuốc. Hoạt chất và tên thương mại mới có thể dùng cho nghiên cứu.');
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
  const hasRule = item => Boolean(item.dilution || dilutionInfo?.catalog?.[item.canonical]?.rule);
  const isInjectable = item => INJECTABLE_CATEGORIES.has(item.category) || ['thuoc_tiem', 'dich_truyen'].includes(routeCategory(item.default_route || ''));
  const filtered = items
    .filter(item => !q || `${item.canonical} ${joinList(item.active_ingredients)} ${item.active_ingredient || ''} ${joinList(item.aliases)} ${item.category || ''}`.toLowerCase().includes(q))
    .filter(item => ruleFilter === 'all' || (ruleFilter === 'has_rule' ? hasRule(item) : (!hasRule(item) && isInjectable(item))));

  return (
    <div style={{ padding: 12, maxWidth: 1180, margin: '0 auto' }}>
      <div style={{ marginBottom: 12, display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: 10 }}>
        <div>
          <div style={{ fontSize: FS.xl, fontWeight: 700, color: C.text }}>Danh mục thuốc</div>
          <div style={{ fontSize: FS.sm, color: C.text2, marginTop: 4 }}>
            {tab === 'drugs'
              ? 'Khai báo chế phẩm, hoạt chất và các tên thương mại/cách viết trong EMR. Nhiều chế phẩm có thể cùng một hoạt chất để nghiên cứu gom chung.'
              : tab === 'ingredients'
              ? 'Tên thuốc (tên thương mại) đang có trong y lệnh của kho: gắn hoạt chất để tạo nghiên cứu theo hoạt chất.'
              : 'Tự thiết kế đường dùng: tên, nhãn, chuyên mục, cách hiện trên báo cáo ca trực và từ khoá nhận diện.'}
          </div>
        </div>
        <Segmented label="Mục danh mục" value={tab} onChange={setTab}
          options={[{ value: 'drugs', label: 'Thuốc' }, { value: 'ingredients', label: 'Gắn hoạt chất' }, { value: 'routes', label: 'Đường dùng' }]} />
      </div>

      {tab === 'routes' ? <RouteDesigner onSaved={showToast} />
        : tab === 'ingredients' ? <DrugNameIngredientPanel medications={items} onChanged={load} /> : <>
      <div style={{ marginBottom: 12, display: 'flex', justifyContent: 'flex-end' }}>
        <Btn variant="primary" onClick={() => setEditing({ mode: 'create', key: '', form: emptyForm() })}>+ Thêm thuốc</Btn>
      </div>

      <div style={{ marginBottom: 14, padding: '9px 12px', borderRadius: 7,
        background: C.blueBg, border: `1px solid ${C.blueBorder}`, fontSize: FS.sm, color: C.text2, lineHeight: 1.5 }}>
        <b>Hoạt chất dùng cho nghiên cứu.</b> Mỗi chế phẩm/tên thương mại nên khai báo đúng hoạt chất (nhanh nhất: mục <b>Gắn hoạt chất</b> liệt kê sẵn tên thuốc trong kho chưa có hoạt chất). Nếu cùng một hoạt chất có nhiều tên thương mại, có thể tạo nhiều thuốc hoặc thêm tên vào mục "Tên khác". Hệ thống giữ tên gốc để truy vết; việc có y lệnh không tự động được coi là đã thực hiện thuốc.
      </div>

      <DilutionCheckPanel builtin={dilutionInfo?.builtin || []} />
      {dilutionInfo?.failed && (
        <div role="alert" style={{ marginBottom: 10, fontSize: FS.sm, color: C.amber }}>
          Chưa tính được quy tắc pha đang áp dụng (cột "Quy tắc pha" chỉ hiện quy tắc đặt trong danh mục). Tải lại trang; nếu vẫn vậy, khởi động lại máy chủ.
        </div>
      )}

      <div style={{ marginBottom: 14, display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
        <input value={query} onChange={e => setQuery(e.target.value)}
          placeholder="Tìm theo chế phẩm, hoạt chất, tên thương mại, chuyên mục..." style={{ ...INPUT_STYLE, maxWidth: 460 }} />
        <Segmented label="Lọc theo quy tắc pha" value={ruleFilter} onChange={setRuleFilter} options={[
          { value: 'all', label: 'Tất cả' },
          { value: 'has_rule', label: 'Có quy tắc pha' },
          { value: 'no_rule', label: 'Tiêm/truyền chưa có quy tắc' },
        ]} />
      </div>

      {loading && !items.length ? (
        <div role="status" aria-busy="true" aria-label="Đang tải danh mục thuốc" style={{ padding: 14 }}><SkeletonTable rows={8} cols={5} /></div>
      ) : !filtered.length ? (
        <div style={{ color: C.text3, padding: 20, textAlign: 'center' }}>
          {!items.length ? 'Danh mục thuốc đang trống.'
            : ruleFilter === 'no_rule' ? 'Mọi thuốc tiêm/truyền trong danh mục đều đã có quy tắc pha.'
            : 'Không tìm thấy thuốc phù hợp.'}
        </div>
      ) : (
        <div style={{ background: C.surface, borderTop: `1px solid ${C.border2}`, overflow: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ background: C.surface2 }}>
                {['Tên chuẩn / chế phẩm', 'Hoạt chất', 'Tên khác / thương mại', 'Đường dùng', 'Chuyên mục', 'Thể tích (ml)', 'Tốc độ', 'Quy tắc pha', 'Tác vụ'].map(h => (
                  <th key={h} style={{ padding: '8px 12px', textAlign: 'left', fontSize: FS.xs,
                    fontWeight: 700, color: C.text2, borderBottom: `1px solid ${C.border}`, whiteSpace: 'nowrap' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filtered.map((item, i) => (
                <tr key={item.key} style={{ borderBottom: i < filtered.length - 1 ? `1px solid ${C.border2}` : 'none' }}>
                  <td style={{ padding: '10px 12px', fontSize: FS.md, color: C.text, fontWeight: 500 }}>{txt(item.canonical)}</td>
                  <td style={{ padding: '10px 12px', fontSize: FS.xs, color: C.text2, maxWidth: 220 }}>
                    {(item.active_ingredients?.length || item.active_ingredient)
                      ? joinList(item.active_ingredients || [item.active_ingredient])
                      : <span style={{ color: C.text3 }}>—</span>}
                  </td>
                  <td style={{ padding: '10px 12px', fontSize: FS.xs, color: C.text2, maxWidth: 320 }}>
                    {item.aliases?.length ? joinList(item.aliases) : <span style={{ color: C.text3 }}>—</span>}
                  </td>
                  <td style={{ padding: '10px 12px', fontSize: FS.sm, color: C.text2 }}><RouteCell item={item} /></td>
                  <td style={{ padding: '10px 12px', fontSize: FS.sm, color: C.text2 }}>{txt(CATEGORY_LABEL[item.category] || item.category)}</td>
                  <td style={{ padding: '10px 12px', fontSize: FS.sm }}><code style={{ color: C.blue }}>{txt(item.default_volume_ml)}</code></td>
                  <td style={{ padding: '10px 12px', fontSize: FS.sm }}><code style={{ color: C.text2 }}>{txt(item.default_rate)}</code></td>
                  <td style={{ padding: '10px 12px', fontSize: FS.xs, color: C.text2, maxWidth: 220 }}><DilutionCell item={item} info={dilutionInfo} /></td>
                  <td style={{ padding: '10px 12px' }}>
                    <div style={{ display: 'flex', gap: 6 }}>
                      <Btn variant="secondary" onClick={() => setEditing({ mode: 'edit', key: item.key, form: formFromMedication(item) })}
                        style={{ fontSize: FS.xs, padding: '2px 10px' }}>Sửa</Btn>
                      <Btn variant="default" disabled={deleting === item.key} onClick={() => handleDelete(item)}
                        style={{ fontSize: FS.xs, padding: '2px 10px', color: C.red }}>
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
          color: C.text, fontSize: FS.md, lineHeight: 1.5, boxShadow: C.shadow2, zIndex: 100 }}>{toast}</div>
      )}

      {editing && (
        <EditModal mode={editing.mode} initial={editing.form}
          effective={editing.mode === 'edit' ? dilutionInfo?.catalog?.[editing.form.canonical] : null} onClose={() => setEditing(null)}
          onSave={(payload) => editing.mode === 'create' ? handleCreate(payload) : handleUpdate(editing.key, payload)} />
      )}
    </div>
  );
}
