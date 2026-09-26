// src/components/RouteDesigner.jsx
// Tab "Đường dùng" trong Danh mục thuốc: xem toàn bộ đường dùng của hệ thống, sửa tên/nhãn/
// chuyên mục/cách hiện trên báo cáo ca trực, thêm từ khoá nhận diện, thêm đường dùng mới.
// Bảng chuẩn nằm ở config/routes.json; phần sửa ở đây lưu riêng (config/routes.custom.json)
// và được worker, máy chủ, giao diện gộp vào cùng một model.

import { useState, useEffect, useMemo } from 'react';
import { C, FS } from '../tokens.js';
import { Btn, Spinner } from './shared.jsx';
import * as api from '../api.js';
import { applyRouteTable, getBaseRouteTable, previewRouteModel } from '../config/routes.js';
import { RouteBadge } from './report/ReportShared.jsx';

export const REPORT_MODES = [
  ['dose', 'Làm theo cữ'],
  ['daily', 'Phát cả ngày (như thuốc uống)'],
  ['hide', 'Không hiện trên báo cáo ca trực'],
];
const REPORT_LABEL = Object.fromEntries(REPORT_MODES);
const TONE_OPTIONS = [
  ['green', 'Xanh lá'], ['blue', 'Xanh dương'], ['amber', 'Cam'], ['purple', 'Tím'], ['gray', 'Xám'],
];
const EDITABLE = ['label', 'short', 'category', 'report', 'tone'];

const FIELD_LABEL_STYLE = { fontSize: 11, color: C.text2, marginBottom: 3 };
export const INPUT_STYLE = {
  width: '100%', padding: '6px 10px', borderRadius: 6,
  background: C.surface, border: `1px solid ${C.border}`,
  color: C.text, fontSize: 13, boxSizing: 'border-box', fontFamily: 'inherit',
};

function Field({ label, hint, children }) {
  return (
    <div>
      <div style={FIELD_LABEL_STYLE}>{label}</div>
      {children}
      {hint && <div style={{ fontSize: 11, color: C.text3, marginTop: 3 }}>{hint}</div>}
    </div>
  );
}

function parseKeywords(text) {
  return [...new Set(String(text || '').split(/[,\n]/).map(x => x.trim()).filter(Boolean))];
}

// Phần tự cài của một đường dùng, chỉ giữ trường khác bảng chuẩn.
function customEntry(code, form, baseRoute) {
  const entry = { code };
  for (const key of EDITABLE) {
    const value = String(form[key] || '').trim();
    if (value && (!baseRoute || value !== baseRoute[key])) entry[key] = value;
  }
  const keywords = parseKeywords(form.keywords);
  if (keywords.length) entry.keywords = keywords;
  return entry;
}

function isEmptyEntry(entry) {
  return Object.keys(entry).length === 1;
}

function RouteEditModal({ route, baseRoute, customItem, categories, existingCodes, customRoutes, onClose, onSave }) {
  const isNew = !route;
  const [form, setForm] = useState(() => ({
    code: route?.code || '',
    label: route?.label || '',
    short: route?.short || '',
    category: route?.category || 'khac',
    report: route?.report || 'dose',
    tone: route?.tone || 'gray',
    keywords: (customItem?.keywords || []).join(', '),
  }));
  const [sample, setSample] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const set = key => e => setForm(prev => ({ ...prev, [key]: e.target.value }));
  const code = form.code.trim().toUpperCase();

  // Xem trước: gộp bảng chuẩn với phần tự cài đang sửa để thử nhận diện một câu y lệnh.
  const preview = useMemo(() => {
    if (!sample.trim() || !code) return null;
    const others = customRoutes.filter(r => r.code !== code);
    const model = previewRouteModel({ routes: [...others, { ...customEntry(code, form, baseRoute), label: form.label || code }] });
    const detected = model.detectRouteCode(sample);
    return { detected, info: detected ? model.routeInfo(detected) : null };
  }, [sample, code, form, baseRoute, customRoutes]);

  const handleSave = async () => {
    setError('');
    if (isNew) {
      if (!/^[A-Z][A-Z0-9_]{0,11}$/.test(code)) {
        setError('Mã: chữ in hoa không dấu, số hoặc dấu gạch dưới, tối đa 12 ký tự, bắt đầu bằng chữ (VD: TIEM_KHOP).');
        return;
      }
      if (existingCodes.has(code)) { setError(`Mã ${code} đã có.`); return; }
      if (!form.label.trim()) { setError('Cần nhập tên đường dùng.'); return; }
    }
    setSaving(true);
    try {
      await onSave(customEntry(code, form, baseRoute));
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
      <div role="dialog" aria-modal="true" aria-label={isNew ? 'Thêm đường dùng' : `Sửa đường dùng ${route.code}`}
        style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 6,
          padding: 18, width: 520, maxWidth: '95vw', maxHeight: '90vh', overflowY: 'auto' }}
        onClick={e => e.stopPropagation()}>
        <div style={{ fontSize: 15, fontWeight: 700, color: C.text, marginBottom: 14 }}>
          {isNew ? 'Thêm đường dùng' : `Sửa đường dùng ${route.code}`}
        </div>

        <div style={{ display: 'grid', gap: 10 }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 10 }}>
            <Field label="Mã *" hint={isNew ? 'Không đổi được sau khi lưu' : 'Mã chuẩn, không đổi được'}>
              <input value={form.code} onChange={set('code')} disabled={!isNew} placeholder="VD: TIEM_KHOP"
                style={{ ...INPUT_STYLE, textTransform: 'uppercase', background: isNew ? C.surface : C.surface2 }} />
            </Field>
            <Field label="Nhãn ngắn" hint="Hiện trên báo cáo, phiếu">
              <input value={form.short} onChange={set('short')} placeholder={code || 'VD: Tiêm khớp'} style={INPUT_STYLE} />
            </Field>
          </div>
          <Field label={isNew ? 'Tên đầy đủ *' : 'Tên đầy đủ'}>
            <input value={form.label} onChange={set('label')} placeholder="VD: Tiêm nội khớp" style={INPUT_STYLE} />
          </Field>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 10 }}>
            <Field label="Chuyên mục">
              <select value={form.category} onChange={set('category')} style={INPUT_STYLE}>
                {categories.map(c => <option key={c.code} value={c.code}>{c.label}</option>)}
              </select>
            </Field>
            <Field label="Màu nhãn">
              <select value={form.tone} onChange={set('tone')} style={INPUT_STYLE}>
                {TONE_OPTIONS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
              </select>
            </Field>
          </div>
          <Field label="Báo cáo ca trực">
            <select value={form.report} onChange={set('report')} style={INPUT_STYLE}>
              {REPORT_MODES.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select>
          </Field>
          <Field label="Từ khoá nhận diện trong y lệnh"
            hint="Cách nhau bằng dấu phẩy hoặc xuống dòng. Không phân biệt dấu, hoa/thường; được xét trước các luật có sẵn.">
            <textarea value={form.keywords} onChange={set('keywords')} rows={2}
              placeholder="VD: tiêm khớp, nội khớp" style={{ ...INPUT_STYLE, resize: 'vertical' }} />
          </Field>

          <div style={{ padding: 10, borderRadius: 6, background: C.surface2, border: `1px solid ${C.border2}` }}>
            <Field label="Thử nhận diện">
              <input value={sample} onChange={e => setSample(e.target.value)} placeholder="Gõ đường dùng như trong y lệnh, VD: Tiêm khớp gối (P)" style={INPUT_STYLE} />
            </Field>
            {preview && (
              <div style={{ marginTop: 6, fontSize: FS.sm, color: C.text2, display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                {preview.detected
                  ? <>Nhận ra: <b style={{ color: preview.detected === code ? C.green : C.text }}>{preview.detected}</b> · {preview.info.label}</>
                  : <>Không nhận ra đường dùng nào.</>}
              </div>
            )}
          </div>
        </div>

        {error && (
          <div role="alert" style={{ padding: '6px 10px', borderRadius: 6, background: C.redBg,
            border: `1px solid ${C.redBorder}`, color: C.red, fontSize: 12, marginTop: 12 }}>{error}</div>
        )}

        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 16 }}>
          <Btn variant="default" onClick={onClose}>Hủy</Btn>
          <Btn variant="primary" loading={saving} onClick={handleSave}>Lưu</Btn>
        </div>
      </div>
    </div>
  );
}

export default function RouteDesigner({ onSaved }) {
  const [table, setTable] = useState(null);
  const [custom, setCustom] = useState({ routes: [] });
  const [error, setError] = useState('');
  const [editing, setEditing] = useState(null); // { route|null }
  const [busy, setBusy] = useState('');

  useEffect(() => {
    let alive = true;
    api.getRouteTable()
      .then(data => { if (alive) { setTable(data.table); setCustom(data.custom || { routes: [] }); } })
      .catch(e => { if (alive) setError(String(e.message || e)); });
    return () => { alive = false; };
  }, []);

  const baseByCode = useMemo(() => Object.fromEntries(getBaseRouteTable().routes.map(r => [r.code, r])), []);
  const customRoutes = custom.routes || [];
  const customByCode = Object.fromEntries(customRoutes.map(r => [r.code, r]));

  const save = async (nextRoutes, message) => {
    const res = await api.saveCustomRoutes({ routes: nextRoutes });
    setTable(res.table);
    setCustom(res.custom);
    applyRouteTable(res.table);
    onSaved?.(message);
  };

  const upsert = entry => {
    const rest = customRoutes.filter(r => r.code !== entry.code);
    const keep = baseByCode[entry.code] && isEmptyEntry(entry) ? rest : [...rest, entry];
    return save(keep, `Đã lưu đường dùng ${entry.code}.`);
  };

  const remove = async route => {
    const builtin = Boolean(baseByCode[route.code]);
    const question = builtin
      ? `Khôi phục ${route.code} về mặc định (bỏ phần đã sửa và từ khoá tự thêm)?`
      : `Xoá đường dùng ${route.code}? Thuốc trong danh mục đang dùng mã này sẽ không còn cảnh báo theo mã đó.`;
    if (!window.confirm(question)) return;
    setBusy(route.code);
    try {
      await save(customRoutes.filter(r => r.code !== route.code), builtin ? `Đã khôi phục ${route.code}.` : `Đã xoá ${route.code}.`);
    } catch (e) {
      onSaved?.('Lỗi: ' + String(e.message || e));
    } finally {
      setBusy('');
    }
  };

  if (error) return <div style={{ color: C.red, fontSize: FS.sm }}>Lỗi tải bảng đường dùng: {error}</div>;
  if (!table) return <div style={{ color: C.text2, display: 'flex', gap: 8, alignItems: 'center' }}><Spinner /> Đang tải...</div>;

  const categories = table.categories || [];
  const catLabel = Object.fromEntries(categories.map(c => [c.code, c.label]));
  const grouped = categories
    .map(cat => ({ cat, routes: table.routes.filter(r => r.category === cat.code) }))
    .filter(g => g.routes.length);

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 10, flexWrap: 'wrap', marginBottom: 12 }}>
        <div style={{ fontSize: 12, color: C.text2, lineHeight: 1.5, maxWidth: 680 }}>
          Một bảng đường dùng chung cho cả hệ thống: nhận diện y lệnh, chia chuyên mục, báo cáo ca trực, phiếu in.
          Sửa ở đây có hiệu lực ngay trên giao diện; dữ liệu đã phân loại cần chạy lại "③ Xử lý &amp; phân loại".
        </div>
        <Btn variant="primary" onClick={() => setEditing({ route: null })}>+ Thêm đường dùng</Btn>
      </div>

      <div style={{ display: 'grid', gap: 12 }}>
        {grouped.map(({ cat, routes }) => (
          <section key={cat.code} style={{ border: `1px solid ${C.border2}`, borderRadius: 7, background: C.surface, overflow: 'hidden' }}>
            <header style={{ padding: '7px 12px', background: C.surface2, fontSize: FS.sm, fontWeight: 650, color: C.text }}>
              {catLabel[cat.code] || cat.code}
            </header>
            {routes.map(route => {
              const item = customByCode[route.code];
              const builtin = Boolean(baseByCode[route.code]);
              return (
                <div key={route.code} style={{ display: 'grid', gridTemplateColumns: 'minmax(56px, auto) minmax(0, 1fr) auto', alignItems: 'center', gap: 10,
                  padding: '8px 12px', borderTop: `1px solid ${C.border2}` }}>
                  <span><RouteBadge route={route.short} /></span>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontSize: FS.md, color: C.text, fontWeight: 600 }}>
                      {route.label}
                      <code style={{ marginLeft: 8, fontSize: FS.xs, color: C.text3, fontWeight: 500 }}>{route.code}</code>
                      {!builtin && <span style={{ marginLeft: 8, fontSize: FS.xs, color: C.blue, fontWeight: 600 }}>Tự thêm</span>}
                      {builtin && route.customized && <span style={{ marginLeft: 8, fontSize: FS.xs, color: C.amber, fontWeight: 600 }}>Đã sửa</span>}
                    </div>
                    <div style={{ fontSize: FS.xs, color: C.text2, marginTop: 2 }}>
                      Báo cáo: {REPORT_LABEL[route.report] || route.report}
                      {item?.keywords?.length ? <> · Từ khoá: {item.keywords.join(', ')}</> : null}
                    </div>
                  </div>
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                    <Btn variant="secondary" onClick={() => setEditing({ route })} style={{ fontSize: 11, padding: '2px 10px' }}>Sửa</Btn>
                    {item && (
                      <Btn variant="default" loading={busy === route.code} onClick={() => remove(route)}
                        style={{ fontSize: 11, padding: '2px 10px', color: builtin ? C.text2 : C.red }}>
                        {builtin ? 'Khôi phục' : 'Xoá'}
                      </Btn>
                    )}
                  </div>
                </div>
              );
            })}
          </section>
        ))}
      </div>

      {editing && (
        <RouteEditModal
          route={editing.route}
          baseRoute={editing.route ? baseByCode[editing.route.code] : null}
          customItem={editing.route ? customByCode[editing.route.code] : null}
          categories={categories}
          existingCodes={new Set(table.routes.map(r => r.code))}
          customRoutes={customRoutes}
          onClose={() => setEditing(null)}
          onSave={upsert}
        />
      )}
    </div>
  );
}
