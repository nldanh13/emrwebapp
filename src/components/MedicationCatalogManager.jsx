// src/components/MedicationCatalogManager.jsx
// Giao diện quản lý danh mục thuốc (config/medication_catalog.json):
//   - Xem danh sách thuốc, tên chuẩn, alias, hàm lượng/thể tích mặc định
//   - Thêm / sửa / xoá thuốc trong danh mục

import { useState, useEffect, useCallback } from 'react';
import { C } from '../tokens.js';
import { Btn, Spinner } from './shared.jsx';
import * as api from '../api.js';

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
    category: med.category || '',
    default_volume_ml: med.default_volume_ml ?? '',
    default_rate: med.default_rate ?? '',
    default_route: med.default_route || '',
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

function EditModal({ mode, initial, onClose, onSave }) {
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
          <Field label="Tên chuẩn (canonical) *">
            <input value={form.canonical} onChange={set('canonical')} placeholder="VD: THERMODOL" style={INPUT_STYLE} />
          </Field>
          <Field label="Alias (tên khác, cách nhau bằng dấu phẩy hoặc xuống dòng)">
            <textarea value={form.aliases} onChange={set('aliases')} rows={3}
              placeholder="THERMODON, PARACETAMOL 1G, EFFERALGAN 1G..." style={{ ...INPUT_STYLE, resize: 'vertical' }} />
          </Field>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
            <Field label="Chuyên mục (category)">
              <input value={form.category} onChange={set('category')} placeholder="VD: dich_truyen" style={INPUT_STYLE} />
            </Field>
            <Field label="Thể tích mặc định (ml)">
              <input value={form.default_volume_ml} onChange={set('default_volume_ml')} inputMode="decimal" placeholder="VD: 100" style={INPUT_STYLE} />
            </Field>
          </div>
          <Field label="Tốc độ mặc định (gt/p)">
            <input value={form.default_rate} onChange={set('default_rate')} placeholder="VD: 100" style={INPUT_STYLE} />
          </Field>

          <button type="button" onClick={() => setShowAdvanced(v => !v)} style={{
            background: 'none', border: 'none', color: C.blue, fontSize: 11.5, cursor: 'pointer',
            padding: 0, textAlign: 'left', fontFamily: 'inherit',
          }}>
            {showAdvanced ? '▲ Ẩn tuỳ chọn nâng cao' : '▼ Tuỳ chọn nâng cao (đường dùng, quy tắc giờ dùng, alias suy luận)'}
          </button>

          {showAdvanced && (
            <div style={{ display: 'grid', gap: 10, paddingTop: 2, borderTop: `1px solid ${C.border2}` }}>
              <Field label="Alias suy luận ngữ nghĩa (semantic_aliases)">
                <textarea value={form.semantic_aliases} onChange={set('semantic_aliases')} rows={2}
                  placeholder="Dùng khi tên gõ tắt/lệch dấu — cách nhau bằng dấu phẩy hoặc xuống dòng" style={{ ...INPUT_STYLE, resize: 'vertical' }} />
              </Field>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                <Field label="Đường dùng mặc định (default_route)">
                  <input value={form.default_route} onChange={set('default_route')} placeholder="VD: TTM" style={INPUT_STYLE} />
                </Field>
                <Field label="Quy tắc giờ dùng (schedule_rule)">
                  <input value={form.schedule_rule} onChange={set('schedule_rule')} placeholder="VD: order_time_first_then_remaining_routine" style={INPUT_STYLE} />
                </Field>
              </div>
              <Field label="Mô tả đường dùng hiển thị (default_route_text)">
                <input value={form.default_route_text} onChange={set('default_route_text')} placeholder="VD: TTM 100 giọt/phút" style={INPUT_STYLE} />
              </Field>
              <Field label="Mô tả tốc độ hiển thị (default_rate_text)">
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

export default function MedicationCatalogManager() {
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
            Tên chuẩn, alias và hàm lượng/thể tích mặc định — dùng để hệ thống suy luận khi EMR chỉ ghi tên thuốc.
          </div>
        </div>
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
                {['Tên chuẩn', 'Alias', 'Chuyên mục', 'Thể tích (ml)', 'Tốc độ', 'Tác vụ'].map(h => (
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
                  <td style={{ padding: '10px 12px', fontSize: 12, color: C.text2 }}>{txt(item.category)}</td>
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
