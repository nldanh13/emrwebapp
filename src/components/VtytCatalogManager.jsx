// src/components/VtytCatalogManager.jsx
// Giao diện quản lý catalog VTYT:
//   - Xem danh sách vật tư đang dùng
//   - Tắt (không nhập) khi hết hàng
//   - Nhập mã vật tư thay thế

import React, { useState, useEffect, useCallback } from 'react';
import { C } from '../tokens.js';
import { Btn, Spinner } from './shared.jsx';
import * as api from '../api.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

function txt(v, fb = '—') { return String(v ?? '').trim() || fb; }

function StatusBadge({ item }) {
  if (item.disabled)
    return <span style={{ padding:'2px 8px', borderRadius: 4, fontSize:11, fontWeight:600,
      background: C.redBg, color: C.red, border:`1px solid ${C.redBorder}` }}>Tắt</span>;
  if (item.overridden)
    return <span style={{ padding:'2px 8px', borderRadius: 4, fontSize:11, fontWeight:600,
      background: C.amberBg, color: C.amber, border:`1px solid ${C.amberBorder}` }}>Thay thế</span>;
  return <span style={{ padding:'2px 8px', borderRadius: 4, fontSize:11, fontWeight:600,
    background: C.greenBg, color: C.green, border:`1px solid ${C.greenBorder}` }}>Hoạt động</span>;
}

// ── Edit row modal ────────────────────────────────────────────────────────────

function EditModal({ item, onClose, onSave }) {
  const [mode, setMode]         = useState(item.disabled ? 'disable' : item.overridden ? 'replace' : 'active');
  const [newCode, setNewCode]   = useState(item.overridden ? item.code : '');
  const [newName, setNewName]   = useState(item.overridden ? item.name : '');
  const [saving, setSaving]     = useState(false);
  const [error, setError]       = useState('');

  const handleSave = async () => {
    setError('');
    if (mode === 'replace' && !newCode.trim()) {
      setError('Cần nhập mã vật tư thay thế.');
      return;
    }
    setSaving(true);
    try {
      let patch = {};
      if (mode === 'disable')
        patch = { disabled: true, override_code: '' };
      else if (mode === 'replace')
        patch = { disabled: false, override_code: newCode.trim(), override_name: newName.trim() };
      else
        patch = { disabled: false, override_code: '' };

      await onSave(item.key, patch);
      onClose();
    } catch (e) {
      setError(String(e.message || e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div style={{ position:'fixed', inset:0, background:'rgba(23,32,51,0.42)', zIndex:50,
      display:'flex', alignItems:'center', justifyContent:'center' }}
      onClick={onClose}>
      <div style={{ background:C.surface, border:`1px solid ${C.border}`, borderRadius: 6,
        padding:18, width:470, maxWidth:'95vw' }}
        onClick={e => e.stopPropagation()}>

        <div style={{ fontSize:15, fontWeight:700, color:C.text, marginBottom:4 }}>
          Điều chỉnh vật tư
        </div>
        <div style={{ fontSize:12, color:C.text2, marginBottom:16 }}>
          {txt(item.original_name)} — Mã gốc: <code style={{ color:C.amber }}>{item.original_code}</code>
        </div>

        {/* Chọn chế độ */}
        <div style={{ display:'flex', flexDirection:'column', gap:10, marginBottom:12 }}>

          {/* Chế độ: Hoạt động bình thường */}
          <label style={{ display:'flex', alignItems:'flex-start', gap:10, cursor:'pointer',
            padding:'8px 10px', borderRadius:5,
            background: mode==='active' ? C.greenBg : C.surface2,
            border:`1px solid ${mode==='active' ? C.greenBorder : C.border}` }}>
            <input type="radio" value="active" checked={mode==='active'}
              onChange={() => setMode('active')} style={{ marginTop:2 }} />
            <div>
              <div style={{ fontSize:13, fontWeight:600, color: mode==='active' ? C.green : C.text }}>
                Hoạt động bình thường
              </div>
              <div style={{ fontSize:11, color:C.text2, marginTop:2 }}>
                Dùng mã gốc: <code>{item.original_code}</code>
              </div>
            </div>
          </label>

          {/* Chế độ: Tắt */}
          <label style={{ display:'flex', alignItems:'flex-start', gap:10, cursor:'pointer',
            padding:'8px 10px', borderRadius:5,
            background: mode==='disable' ? C.redBg : C.surface2,
            border:`1px solid ${mode==='disable' ? C.redBorder : C.border}` }}>
            <input type="radio" value="disable" checked={mode==='disable'}
              onChange={() => setMode('disable')} style={{ marginTop:2 }} />
            <div>
              <div style={{ fontSize:13, fontWeight:600, color: mode==='disable' ? C.red : C.text }}>
                Tắt — không nhập vật tư này
              </div>
              <div style={{ fontSize:11, color:C.text2, marginTop:2 }}>
                Khi hết hàng hoặc không cần thiết. Worker sẽ bỏ qua.
              </div>
            </div>
          </label>

          {/* Chế độ: Thay thế */}
          <label style={{ display:'flex', alignItems:'flex-start', gap:10, cursor:'pointer',
            padding:'8px 10px', borderRadius:5,
            background: mode==='replace' ? C.amberBg : C.surface2,
            border:`1px solid ${mode==='replace' ? C.amberBorder : C.border}` }}>
            <input type="radio" value="replace" checked={mode==='replace'}
              onChange={() => setMode('replace')} style={{ marginTop:2 }} />
            <div style={{ flex:1 }}>
              <div style={{ fontSize:13, fontWeight:600, color: mode==='replace' ? C.amber : C.text }}>
                Thay thế bằng vật tư khác
              </div>
              <div style={{ fontSize:11, color:C.text2, marginTop:2, marginBottom:8 }}>
                Khi có hàng tương đương — nhập mã vật tư từ EMR.
              </div>
              {mode === 'replace' && (
                <div style={{ display:'flex', flexDirection:'column', gap:8 }}>
                  <div>
                    <div style={{ fontSize:11, color:C.text2, marginBottom:3 }}>Mã vật tư thay thế *</div>
                    <input value={newCode} onChange={e => setNewCode(e.target.value)}
                      placeholder="VD: VTYT.000004115"
                      style={{ width:'100%', padding:'6px 10px', borderRadius:6,
                        background:C.surface, border:`1px solid ${C.border}`,
                        color:C.text, fontSize:13, boxSizing:'border-box' }} />
                  </div>
                  <div>
                    <div style={{ fontSize:11, color:C.text2, marginBottom:3 }}>Tên vật tư (để nhận biết)</div>
                    <input value={newName} onChange={e => setNewName(e.target.value)}
                      placeholder="VD: Dây truyền dịch Baxter"
                      style={{ width:'100%', padding:'6px 10px', borderRadius:6,
                        background:C.surface, border:`1px solid ${C.border}`,
                        color:C.text, fontSize:13, boxSizing:'border-box' }} />
                  </div>
                </div>
              )}
            </div>
          </label>
        </div>

        {error && (
          <div style={{ padding:'6px 10px', borderRadius:6, background:C.redBg,
            border:`1px solid ${C.redBorder}`, color:C.red, fontSize:12, marginBottom:12 }}>
            {error}
          </div>
        )}

        <div style={{ display:'flex', gap:8, justifyContent:'flex-end' }}>
          <Btn variant="default" onClick={onClose}>Hủy</Btn>
          <Btn variant="primary" disabled={saving} onClick={handleSave}>
            {saving ? <><Spinner size={12} /> Đang lưu...</> : 'Lưu'}
          </Btn>
        </div>
      </div>
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export default function VtytCatalogManager() {
  const [items, setItems]       = useState([]);
  const [loading, setLoading]   = useState(true);
  const [editing, setEditing]   = useState(null);   // item đang edit
  const [resetting, setResetting] = useState('');   // key đang reset
  const [toast, setToast]       = useState('');

  const showToast = (msg) => { setToast(msg); setTimeout(() => setToast(''), 3000); };

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api.getVtytCatalog();
      setItems(data.items || []);
    } catch (e) {
      showToast('Lỗi tải catalog: ' + String(e.message || e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const handleSave = async (key, patch) => {
    await api.updateVtytCatalog(key, patch);
    showToast('Đã cập nhật.');
    await load();
  };

  const handleReset = async (key) => {
    if (!window.confirm('Reset về mặc định?')) return;
    setResetting(key);
    try {
      await api.resetVtytCatalog(key);
      showToast('Đã reset về mặc định.');
      await load();
    } catch (e) {
      showToast('Lỗi: ' + String(e.message || e));
    } finally {
      setResetting('');
    }
  };

  const counts = {
    total:    items.length,
    active:   items.filter(i => !i.disabled && !i.overridden).length,
    disabled: items.filter(i => i.disabled).length,
    replaced: items.filter(i => i.overridden).length,
  };

  return (
    <div style={{ padding:12, maxWidth:980, margin:'0 auto' }}>

      {/* Header */}
      <div style={{ marginBottom:12 }}>
        <div style={{ fontSize:16, fontWeight:700, color:C.text }}>Quản lý vật tư y tế</div>
        <div style={{ fontSize:12, color:C.text2, marginTop:4 }}>
          Điều chỉnh khi hết hàng hoặc cần thay thế mã vật tư.
        </div>
      </div>

      {/* Summary */}
      <div style={{ display:'flex', gap:10, marginBottom:20, flexWrap:'wrap' }}>
        {[
          ['Tổng',      counts.total,    C.text2,  C.surface2],
          ['Hoạt động', counts.active,   C.green,  C.greenBg],
          ['Tắt',       counts.disabled, C.red,    C.redBg],
          ['Thay thế',  counts.replaced, C.amber,  C.amberBg],
        ].map(([label, value, color, bg]) => (
          <div key={label} style={{ padding:'4px 16px 5px 0', borderRight:`1px solid ${C.border2}` }}>
            <div style={{ fontSize:19, fontWeight:800, color }}>{value}</div>
            <div style={{ fontSize:10, color:C.text3 }}>{label}</div>
          </div>
        ))}
      </div>

      {/* Table */}
      {loading ? (
        <div style={{ color:C.text2, display:'flex', gap:8, alignItems:'center' }}>
          <Spinner /> Đang tải...
        </div>
      ) : (
        <div style={{ background:C.surface, borderTop:`1px solid ${C.border2}`, overflow:'hidden' }}>
          <table style={{ width:'100%', borderCollapse:'collapse' }}>
            <thead>
              <tr style={{ background:C.surface2 }}>
                {['Tên vật tư', 'Mã đang dùng', 'Mã gốc', 'Trạng thái', 'Tác vụ'].map(h => (
                  <th key={h} style={{ padding:'8px 12px', textAlign:'left', fontSize:11,
                    fontWeight:700, color:C.text2, borderBottom:`1px solid ${C.border}`,
                    letterSpacing:0.15 }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {items.map((item, i) => (
                <tr key={item.key} style={{
                  borderBottom: i < items.length - 1 ? `1px solid ${C.border2}` : 'none',
                  opacity: item.disabled ? 0.5 : 1,
                  background: item.disabled ? C.redBg + '20' : 'transparent',
                }}>
                  <td style={{ padding:'10px 12px' }}>
                    <div style={{ fontSize:13, color:C.text, fontWeight:500 }}>
                      {txt(item.name)}
                    </div>
                    <div style={{ fontSize:10, color:C.text3, marginTop:2 }}>{item.key}</div>
                  </td>
                  <td style={{ padding:'10px 12px' }}>
                    <code style={{ fontSize:12,
                      color: item.overridden ? C.amber : item.disabled ? C.text3 : C.blue }}>
                      {item.disabled ? '—' : txt(item.code)}
                    </code>
                  </td>
                  <td style={{ padding:'10px 12px' }}>
                    <code style={{ fontSize:11, color:C.text3 }}>{txt(item.original_code)}</code>
                  </td>
                  <td style={{ padding:'10px 12px' }}>
                    <StatusBadge item={item} />
                  </td>
                  <td style={{ padding:'10px 12px' }}>
                    <div style={{ display:'flex', gap:6 }}>
                      <Btn variant="secondary" onClick={() => setEditing(item)}
                           style={{ fontSize:11, padding:'2px 10px' }}>
                        Điều chỉnh
                      </Btn>
                      {(item.disabled || item.overridden) && (
                        <Btn variant="default" disabled={resetting === item.key}
                             onClick={() => handleReset(item.key)}
                             style={{ fontSize:11, padding:'2px 10px' }}>
                          {resetting === item.key ? <Spinner size={10} /> : 'Reset'}
                        </Btn>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Toast */}
      {toast && (
        <div style={{ position:'fixed', bottom:24, right:24, padding:'10px 18px',
          borderRadius:8, background:C.surface, border:`1px solid ${C.border}`,
          color:C.text, fontSize:13, boxShadow:C.shadow2, zIndex:100 }}>
          {toast}
        </div>
      )}

      {/* Edit modal */}
      {editing && (
        <EditModal item={editing} onClose={() => setEditing(null)} onSave={handleSave} />
      )}
    </div>
  );
}
