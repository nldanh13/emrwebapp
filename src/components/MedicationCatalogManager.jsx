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
import { DILUTION_APPLY, DILUTION_SOLVENTS, dilutionForm, dilutionFromForm, dilutionSummary, emptyVariant } from '../utils/dilutionRule.js';
import DilutionCheckPanel from './DilutionCheckPanel.jsx';
import DilutionStatsPanel from './DilutionStatsPanel.jsx';
import CatalogCleanupPanel from './CatalogCleanupPanel.jsx';
import NewDrugsPanel from './NewDrugsPanel.jsx';
import { catalogIssues, filterCatalog } from '../utils/catalogIssues.js';
import { presentationsForm, presentationsFromForm, volumesText } from '../utils/presentations.js';
import MedicationBuiltinPanel from './MedicationBuiltinPanel.jsx';
import { fillEmptyFields } from '../utils/medicationBuiltin.js';

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
    ten_hien_thi: '',
    co_dung_moi_di_kem: false,
    quy_cach: [],
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
    ten_hien_thi: med.ten_hien_thi || '',
    co_dung_moi_di_kem: Boolean(med.co_dung_moi_di_kem),
    dilution_suggestions: Array.isArray(med.dilution_suggestions) ? med.dilution_suggestions : [],
    quy_cach: presentationsForm(med),
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
// Nhiều cách pha theo điều kiện: đường dùng và/hoặc liều mỗi lần (mg). Worker chọn cách khớp y lệnh;
// nhiều cách cùng khớp hoặc y lệnh thiếu dữ kiện → "cần xác nhận cách pha" trên báo cáo (không đoán).
function VariantRows({ form, setForm, routes }) {
  const rows = form.dilution_variants || [];
  const update = (i, key, value) => setForm(prev => ({
    ...prev, dilution_variants: prev.dilution_variants.map((r, j) => (j === i ? { ...r, [key]: value } : r)),
  }));
  const remove = i => setForm(prev => ({ ...prev, dilution_variants: prev.dilution_variants.filter((_, j) => j !== i) }));
  const add = () => setForm(prev => ({ ...prev, dilution_variants: [...(prev.dilution_variants || []), emptyVariant()] }));
  const small = { ...INPUT_STYLE, padding: '4px 6px', fontSize: FS.sm };
  return (
    <div style={{ display: 'grid', gap: 6 }}>
      <div style={{ fontSize: FS.xs, color: C.text2 }}>
        <b>Cách pha theo điều kiện</b> (tuỳ chọn) — vd. liều ≤ 500 mg → 100 ml; liều ≥ 501 mg → 200 ml; bơm tiêm điện → 50 ml.
      </div>
      {rows.map((r, i) => (
        <div key={i} style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(92px, 1fr))', gap: 6, alignItems: 'end',
          padding: 8, border: `1px solid ${C.border2}`, borderRadius: 6, background: C.surface }}>
          <Field label="Đường dùng">
            <select value={r.route} onChange={e => update(i, 'route', e.target.value)} style={small}>
              <option value="">Bất kỳ</option>
              {routes.map(x => <option key={x.code} value={x.code}>{x.short}</option>)}
            </select>
          </Field>
          <Field label="Liều từ (mg)"><input value={r.dose_min_mg} onChange={e => update(i, 'dose_min_mg', e.target.value)} inputMode="decimal" style={small} /></Field>
          <Field label="Liều đến (mg)"><input value={r.dose_max_mg} onChange={e => update(i, 'dose_max_mg', e.target.value)} inputMode="decimal" style={small} /></Field>
          <Field label="Dung môi">
            <select value={r.solvent} onChange={e => update(i, 'solvent', e.target.value)} style={small}>
              {DILUTION_SOLVENTS.filter(([v]) => v !== 'KHONG_PHA').map(([v, label]) => <option key={v} value={v}>{label}</option>)}
            </select>
          </Field>
          <Field label="Thể tích (ml)"><input value={r.volume_ml} onChange={e => update(i, 'volume_ml', e.target.value)} inputMode="decimal" style={small} /></Field>
          <Field label="Giọt/phút"><input value={r.rate} onChange={e => update(i, 'rate', e.target.value)} inputMode="decimal" style={small} /></Field>
          <Btn variant="default" onClick={() => remove(i)} style={{ fontSize: FS.xs, padding: '2px 8px', color: C.red }}>Bỏ</Btn>
        </div>
      ))}
      <div><Btn variant="secondary" onClick={add} style={{ fontSize: FS.xs, padding: '2px 10px' }}>+ Thêm cách pha</Btn></div>
    </div>
  );
}

// Quy cách khác của cùng thuốc (vd. Natri clorid túi 100 ml và chai 500 ml): không tạo 2 thuốc trùng tên.
// Bước xử lý lấy tốc độ theo đúng thể tích của dòng thuốc (medication_catalog.presentation_rate).
function PresentationRows({ form, setForm }) {
  const rows = form.quy_cach || [];
  const update = (i, key, value) => setForm(prev => ({ ...prev, quy_cach: prev.quy_cach.map((r, j) => (j === i ? { ...r, [key]: value } : r)) }));
  const remove = i => setForm(prev => ({ ...prev, quy_cach: prev.quy_cach.filter((_, j) => j !== i) }));
  const add = () => setForm(prev => ({ ...prev, quy_cach: [...(prev.quy_cach || []), { volume_ml: '', rate: '' }] }));
  return (
    <div style={{ gridColumn: '1 / -1', display: 'grid', gap: 6 }}>
      <div style={{ fontSize: FS.xs, color: C.text2 }}>
        <b>Quy cách khác</b> — cùng thuốc nhưng thể tích khác (vd. túi 100 ml và chai 500 ml), mỗi quy cách một tốc độ.
      </div>
      {rows.map((r, i) => (
        <div key={i} style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
          <input value={r.volume_ml} onChange={e => update(i, 'volume_ml', e.target.value)} inputMode="decimal" placeholder="Thể tích (ml), vd. 500"
            aria-label={`Quy cách ${i + 1}: thể tích`} style={{ ...INPUT_STYLE, maxWidth: 180 }} />
          <input value={r.rate} onChange={e => update(i, 'rate', e.target.value)} inputMode="decimal" placeholder="Tốc độ (giọt/phút)"
            aria-label={`Quy cách ${i + 1}: tốc độ`} style={{ ...INPUT_STYLE, maxWidth: 180 }} />
          <Btn variant="default" onClick={() => remove(i)} style={{ fontSize: FS.xs, padding: '2px 8px', color: C.red }}>Bỏ</Btn>
        </div>
      ))}
      <div><Btn variant="secondary" onClick={add} style={{ fontSize: FS.xs, padding: '2px 10px' }}>+ Thêm quy cách</Btn></div>
    </div>
  );
}

// Cách pha gợi ý giữ lại khi dọn mục cũ "X + Natri clorid" (thể tích từng gặp, chưa rõ điều kiện).
function SuggestionRows({ form, setForm }) {
  const list = form.dilution_suggestions || [];
  if (!list.length) return null;
  const drop = i => setForm(prev => ({ ...prev, dilution_suggestions: prev.dilution_suggestions.filter((_, j) => j !== i) }));
  const asDefault = (s, i) => { setForm(prev => ({ ...prev, dilution_solvent: s.solvent, dilution_volume_ml: String(s.volume_ml ?? ''), dilution_rate: s.rate ? String(s.rate) : prev.dilution_rate })); drop(i); };
  const asVariant = (s, i) => {
    setForm(prev => ({ ...prev, dilution_solvent: prev.dilution_solvent || s.solvent,
      dilution_variants: [...(prev.dilution_variants || []), { ...emptyVariant(), solvent: s.solvent, volume_ml: String(s.volume_ml ?? ''), rate: s.rate ? String(s.rate) : '' }] }));
    drop(i);
  };
  return (
    <div style={{ display: 'grid', gap: 4, padding: 8, borderRadius: 6, background: C.amberBg, border: `1px solid ${C.amberBorder}`, fontSize: FS.xs, color: C.text2 }}>
      <b>Cách pha gợi ý (từ mục cũ, chưa áp dụng)</b>
      {list.map((s, i) => (
        <div key={i} style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
          <span style={{ flex: '1 1 200px', color: C.text }}>{dilutionSummary({ solvent: s.solvent, volume_ml: s.volume_ml, rate: s.rate })}{s.tu ? ` — từ "${s.tu}"` : ''}</span>
          <Btn variant="default" onClick={() => asDefault(s, i)} style={{ fontSize: 11, padding: '1px 8px' }}>Đặt làm mặc định</Btn>
          <Btn variant="default" onClick={() => asVariant(s, i)} style={{ fontSize: 11, padding: '1px 8px' }}>Thêm thành cách pha (đặt điều kiện)</Btn>
          <Btn variant="default" onClick={() => drop(i)} style={{ fontSize: 11, padding: '1px 8px', color: C.red }}>Bỏ</Btn>
        </div>
      ))}
    </div>
  );
}

function DilutionFields({ form, set, setForm, effective, routes = [] }) {
  const solvent = form.dilution_solvent;
  const builtin = !solvent && effective?.source === 'luat_san_co' ? effective.rule : null;
  return (
    <div style={{ display: 'grid', gap: 10, padding: 12, borderRadius: 6, border: `1px solid ${C.border2}`, background: C.surface2 }}>
      <div style={{ fontSize: FS.sm, fontWeight: 600, color: C.text }}>Quy tắc pha thuốc{solvent && solvent !== 'KHONG_PHA' ? ' — cách mặc định' : ''}</div>
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
      {solvent && solvent !== 'KHONG_PHA' && <VariantRows form={form} setForm={setForm} routes={routes} />}
      <SuggestionRows form={form} setForm={setForm} />
      <DilutionStatsPanel drugName={form.canonical} setForm={setForm} />
      {solvent && (
        <Field label="Ghi chú pha (tuỳ chọn)">
          <input value={form.dilution_note} onChange={set('dilution_note')} maxLength={300}
            placeholder="VD: truyền tối thiểu 60 phút; không pha chung với Ceftriaxon" style={INPUT_STYLE} />
        </Field>
      )}
      <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: FS.sm, color: C.text2 }}>
        <input type="checkbox" checked={Boolean(form.co_dung_moi_di_kem)}
          onChange={e => setForm(prev => ({ ...prev, co_dung_moi_di_kem: e.target.checked }))} />
        Có dung môi đi kèm (không ghi thêm "+ Pha nước cất")
      </label>
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
    const presentations = presentationsFromForm(form.quy_cach);
    if (presentations.error) {
      setError(presentations.error);
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
        ten_hien_thi: form.ten_hien_thi.trim(),
        co_dung_moi_di_kem: Boolean(form.co_dung_moi_di_kem),
        quy_cach: presentations.value,
        ...(form.dilution_suggestions ? { dilution_suggestions: form.dilution_suggestions } : {}),
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
          <Field label="Tên hiển thị chuẩn (tuỳ chọn — dùng ở bản xem trước Nhập dịch truyền)">
            <input value={form.ten_hien_thi} onChange={set('ten_hien_thi')} placeholder="VD: Paracetamol" style={INPUT_STYLE} />
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
              <PresentationRows form={form} setForm={setForm} />
            </div>
          )}

          <DilutionFields form={form} set={set} setForm={setForm} effective={effective}
            routes={ROUTES.filter(r => ['dich_truyen', 'thuoc_tiem'].includes(routeCategory(r.code)))} />

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
  const [builtin, setBuiltin] = useState(null);
  const [builtinError, setBuiltinError] = useState('');
  const [cleanupPlan, setCleanupPlan] = useState([]);
  const [newDrugs, setNewDrugs] = useState(null);
  const [newDrugsError, setNewDrugsError] = useState('');
  const loadNewDrugs = useCallback(() => api.getNewDrugs()
    .then(r => { setNewDrugs(r); setNewDrugsError(''); })
    .catch(e => setNewDrugsError('Không tìm được thuốc mới: ' + String(e.message || e))), []);
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
      loadNewDrugs();
      api.getCatalogCleanup().then(r => setCleanupPlan(r.plan || [])).catch(() => setCleanupPlan([]));
      api.getMedicationBuiltin()
        .then(r => { setBuiltin(r.builtin || {}); setBuiltinError(''); })
        .catch(e => setBuiltinError('Không tải được kiến thức sẵn có: ' + String(e.message || e)));
    } catch (e) {
      showToast('Lỗi tải danh mục thuốc: ' + String(e.message || e));
    } finally {
      setLoading(false);
    }
  }, [loadNewDrugs]);

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
  const filtered = filterCatalog(
    items.filter(item => !q || `${item.canonical} ${joinList(item.active_ingredients)} ${item.active_ingredient || ''} ${joinList(item.aliases)} ${item.category || ''}`.toLowerCase().includes(q)),
    ruleFilter, { hasRule, routeCategoryOf: routeCategory },
  );
  const issueCount = filterCatalog(items, 'issues').length;

  return (
    <div style={{ padding: 12, maxWidth: 1180, margin: '0 auto' }}>
      <div style={{ marginBottom: 12, display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: 10 }}>
        <div>
          <div style={{ fontSize: FS.xl, fontWeight: 700, color: C.text }}>Danh mục thuốc</div>
          <div style={{ fontSize: FS.sm, color: C.text2, marginTop: 4 }}>
            {tab === 'drugs'
              ? 'Khai báo chế phẩm, hoạt chất và các tên thương mại/cách viết trong EMR. Nhiều chế phẩm có thể cùng một hoạt chất để nghiên cứu gom chung.'
              : tab === 'new'
              ? 'Thuốc gặp trong y lệnh nhưng chưa có trong danh mục — thiết lập để bước xử lý dữ liệu nhận đúng thuốc.'
              : tab === 'builtin'
              ? 'Kiến thức thuốc đi kèm phần mềm: luật pha, thể tích mặc định, hoạt chất của tên thương mại, tên hiển thị. Chép vào danh mục để sửa.'
              : tab === 'ingredients'
              ? 'Tên thuốc (tên thương mại) đang có trong y lệnh của kho: gắn hoạt chất để tạo nghiên cứu theo hoạt chất.'
              : 'Tự thiết kế đường dùng: tên, nhãn, chuyên mục, cách hiện trên báo cáo ca trực và từ khoá nhận diện.'}
          </div>
        </div>
        <Segmented label="Mục danh mục" value={tab} onChange={setTab}
          options={[{ value: 'drugs', label: 'Thuốc' }, { value: 'new', label: `Thuốc mới${newDrugs?.pending ? ` (${newDrugs.pending})` : ''}` }, { value: 'builtin', label: 'Sẵn có' }, { value: 'ingredients', label: 'Gắn hoạt chất' }, { value: 'routes', label: 'Đường dùng' }]} />
      </div>

      {tab === 'routes' ? <RouteDesigner onSaved={showToast} />
        : tab === 'new' ? <NewDrugsPanel data={newDrugs} error={newDrugsError} onChanged={loadNewDrugs}
            onSetup={prefill => setEditing({ mode: 'create', key: '', form: { ...emptyForm(), ...prefill } })} />
        : tab === 'builtin' ? <MedicationBuiltinPanel builtin={builtin} error={builtinError}
            catalogNames={new Set(items.map(m => String(m.canonical || '').toLowerCase()))}
            onCopy={prefill => {
              const existing = items.find(m => String(m.canonical || '').toLowerCase() === String(prefill.canonical || '').toLowerCase());
              setEditing(existing
                ? { mode: 'edit', key: existing.key, form: fillEmptyFields(formFromMedication(existing), prefill) }
                : { mode: 'create', key: '', form: { ...emptyForm(), ...prefill } });
            }} />
        : tab === 'ingredients' ? <DrugNameIngredientPanel medications={items} onChanged={load} /> : <>
      <div style={{ marginBottom: 12, display: 'flex', justifyContent: 'flex-end' }}>
        <Btn variant="primary" onClick={() => setEditing({ mode: 'create', key: '', form: emptyForm() })}>+ Thêm thuốc</Btn>
      </div>

      <div style={{ marginBottom: 14, padding: '9px 12px', borderRadius: 7,
        background: C.blueBg, border: `1px solid ${C.blueBorder}`, fontSize: FS.sm, color: C.text2, lineHeight: 1.5 }}>
        <b>Hoạt chất dùng cho nghiên cứu.</b> Mỗi chế phẩm/tên thương mại nên khai báo đúng hoạt chất (nhanh nhất: mục <b>Gắn hoạt chất</b> liệt kê sẵn tên thuốc trong kho chưa có hoạt chất). Nếu cùng một hoạt chất có nhiều tên thương mại, có thể tạo nhiều thuốc hoặc thêm tên vào mục "Tên khác". Hệ thống giữ tên gốc để truy vết; việc có y lệnh không tự động được coi là đã thực hiện thuốc.
      </div>

      <CatalogCleanupPanel plan={cleanupPlan} onDone={msg => { showToast(msg); load(); }} />
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
          { value: 'no_rule', label: 'Cần pha, chưa có quy tắc' },
          { value: 'no_ingredient', label: 'Thiếu hoạt chất' },
          { value: 'issues', label: `Có thể sai${issueCount ? ` (${issueCount})` : ''}` },
        ]} />
      </div>

      {loading && !items.length ? (
        <div role="status" aria-busy="true" aria-label="Đang tải danh mục thuốc" style={{ padding: 14 }}><SkeletonTable rows={8} cols={5} /></div>
      ) : !filtered.length ? (
        <div style={{ color: C.text3, padding: 20, textAlign: 'center' }}>
          {!items.length ? 'Danh mục thuốc đang trống.'
            : ruleFilter === 'no_rule' ? 'Mọi thuốc tiêm cần pha đều đã có quy tắc (chai/túi truyền pha sẵn không cần).'
            : ruleFilter === 'issues' ? 'Không thấy mục nào có dấu hiệu sai.'
            : ruleFilter === 'no_ingredient' ? 'Mọi thuốc đều đã có hoạt chất.'
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
                  <td style={{ padding: '10px 12px', fontSize: FS.md, color: C.text, fontWeight: 500 }}>
                    {txt(item.canonical)}
                    {catalogIssues(item, items).map((msg, k) => (
                      <div key={k} style={{ fontSize: FS.xs, color: C.amber, fontWeight: 400, marginTop: 2, maxWidth: 280 }}>⚠ {msg}</div>
                    ))}
                  </td>
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
                  <td style={{ padding: '10px 12px', fontSize: FS.sm }}><code style={{ color: C.blue }}>{txt(volumesText(item))}</code></td>
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
