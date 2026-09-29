import React, { useEffect, useMemo, useState } from 'react';
import {
  IconChecklist, IconCloudCheck, IconPackageImport, IconPlus,
  IconRefresh, IconSettings, IconTrash, IconX,
} from '@tabler/icons-react';
import { C, FS } from '../../tokens.js';
import { Btn, Spinner } from '../shared.jsx';
import { HCHANH_VTYT_ITEMS } from '../../config/hchanhLists.js';
import * as api from '../../api.js';
import {
  VTYT_USAGE_STATUS, allocatedByCode, collectionRows, comboAvailability,
  eligibleInputJobs, everyPatientAvailability, everyPatientRequirements,
  infusionSetAudit, missingEveryPatientSupplies, safeQty, stockOf,
} from '../../engine/hchanhVtytWorkspace.js';
import { existingVtytQuantity } from '../../engine/hchanhVtytDraftMerge.js';

const inputStyle = {
  width: '100%', boxSizing: 'border-box', padding: '7px 8px', borderRadius: 7,
  background: C.surface, border: `1px solid ${C.border}`, color: C.text, fontSize: FS.xs,
};
const panelStyle = { border: `1px solid ${C.border}`, borderRadius: 8, background: C.surface, minWidth: 0, overflow: 'hidden' };

function safeArray(value) { return Array.isArray(value) ? value : []; }
function patientId(card = {}) { return String(card.ma_bn || card.patient_id || card.id || '').trim(); }
function nowIso() { return new Date().toISOString(); }
function supplyKey(item = {}) { return String(item.code || item.key || item.name || '').trim(); }
function drugQuantityText(drug = {}) {
  const quantity = drug.quantity ?? drug.so_luong ?? drug.sl ?? drug.total_quantity ?? drug.required_quantity;
  const unit = String(drug.unit || drug.don_vi || drug.dang || '').trim();
  if (quantity == null || String(quantity).trim() === '') return 'SL chưa rõ';
  return `SL ${quantity}${unit ? ` ${unit}` : ''}`;
}
function norm(value) {
  return String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D').toLowerCase().replace(/\s+/g, ' ').trim();
}

function Modal({ title, children, onClose, width = 760 }) {
  return <div style={{ position: 'fixed', inset: 0, zIndex: 1500, background: 'rgba(15,23,42,.48)', display: 'grid', placeItems: 'center', padding: 16 }} onMouseDown={onClose}>
    <div role="dialog" aria-modal="true" aria-label={title} style={{ width: `min(${width}px, 96vw)`, maxHeight: '90vh', overflow: 'auto', background: C.surface, borderRadius: 10, boxShadow: '0 24px 70px rgba(0,0,0,.25)' }} onMouseDown={e => e.stopPropagation()}>
      <div style={{ position: 'sticky', top: 0, zIndex: 2, display: 'flex', alignItems: 'center', gap: 8, padding: '11px 14px', background: C.surface, borderBottom: `1px solid ${C.border}` }}>
        <b style={{ flex: 1 }}>{title}</b>
        <button type="button" className="emr-icon-btn" onClick={onClose} aria-label="Đóng"><IconX size={18} /></button>
      </div>
      {children}
    </div>
  </div>;
}

function StatusBadge({ status = 'planned' }) {
  const tone = status === 'used' ? C.green : status === 'entered' ? C.blue : status === 'cancelled' || status === 'error' ? C.red : C.amber;
  return <span style={{ color: tone, fontSize: FS.xs, fontWeight: 700 }}>{VTYT_USAGE_STATUS[status] || status}</span>;
}

function ComboManager({ combos, setCombos, onClose }) {
  const blank = { name: '', description: '', enabled: true, items: [{ code: '', name: '', quantity: 1, required: true, every_patient: false }] };
  const [form, setForm] = useState(blank);
  const [saving, setSaving] = useState(false);

  function setItem(index, patch) {
    setForm(current => ({ ...current, items: safeArray(current.items).map((row, i) => i === index ? { ...row, ...patch } : row) }));
  }
  async function save() {
    const items = safeArray(form.items).map(row => {
      const catalog = HCHANH_VTYT_ITEMS.find(item => item.code === row.code);
      return { ...row, name: catalog?.name || row.name };
    }).filter(row => row.code);
    if (!form.name.trim() || !items.length) return;
    setSaving(true);
    try {
      const response = form.id
        ? await api.updateVtytCombo(form.id, { ...form, items })
        : await api.createVtytCombo({ ...form, items });
      setCombos(current => form.id
        ? current.map(row => row.id === form.id ? response.combo : row)
        : [...current, response.combo]);
      setForm(blank);
    } finally { setSaving(false); }
  }
  async function remove(combo) {
    if (!window.confirm(`Xóa combo “${combo.name}”?`)) return;
    await api.deleteVtytCombo(combo.id);
    setCombos(current => current.filter(row => row.id !== combo.id));
    if (form.id === combo.id) setForm(blank);
  }

  return <Modal title="Quản lý combo VTYT" onClose={onClose} width={900}>
    <div style={{ display: 'grid', gridTemplateColumns: '260px minmax(0,1fr)', minHeight: 440 }}>
      <div style={{ borderRight: `1px solid ${C.border}`, padding: 10 }}>
        <Btn variant="secondary" icon={IconPlus} onClick={() => setForm(blank)}>Tạo combo mới</Btn>
        <div style={{ marginTop: 10, display: 'grid', gap: 6 }}>
          {combos.map(combo => <button key={combo.id} type="button" onClick={() => setForm({ ...combo, items: safeArray(combo.items) })} style={{ textAlign: 'left', padding: 9, borderRadius: 7, cursor: 'pointer', border: `1px solid ${form.id === combo.id ? C.blue : C.border}`, background: form.id === combo.id ? C.blueBg : C.surface }}>
            <b style={{ color: C.text, fontSize: FS.sm }}>{combo.name}</b>
            <div style={{ color: C.text3, fontSize: FS.xs }}>{safeArray(combo.items).length} vật tư{safeArray(combo.items).some(item => item.every_patient) ? ' · có VTYT mỗi NB' : ''}</div>
          </button>)}
        </div>
      </div>
      <div style={{ padding: 14 }}>
        <label style={{ fontSize: FS.xs, color: C.text2 }}>Tên combo<input value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} placeholder="Ví dụ: Thay kim luồn" style={{ ...inputStyle, marginTop: 4 }} /></label>
        <label style={{ display: 'block', fontSize: FS.xs, color: C.text2, marginTop: 10 }}>Mô tả<input value={form.description || ''} onChange={e => setForm({ ...form, description: e.target.value })} style={{ ...inputStyle, marginTop: 4 }} /></label>
        <div style={{ marginTop: 14, fontWeight: 700, fontSize: FS.sm }}>Vật tư trong combo</div>
        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) 72px 94px 34px', gap: 7, marginTop: 7, color: C.text3, fontSize: FS.xs }}><span>Vật tư</span><span style={{ textAlign: 'center' }}>Số lượng</span><span style={{ textAlign: 'center' }}>Mỗi NB</span><span /></div>
        {safeArray(form.items).map((row, index) => <div key={index} style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) 72px 94px 34px', gap: 7, marginTop: 7, alignItems: 'center' }}>
          <select value={row.code} onChange={e => { const found = HCHANH_VTYT_ITEMS.find(item => item.code === e.target.value); setItem(index, { code: e.target.value, name: found?.name || '' }); }} style={inputStyle}>
            <option value="">Chọn vật tư…</option>
            {HCHANH_VTYT_ITEMS.map(item => <option key={item.code} value={item.code}>{item.code} · {item.name} · tồn {item.stock ?? '?'}</option>)}
          </select>
          <input type="number" min="1" value={row.quantity || 1} onChange={e => setItem(index, { quantity: Math.max(1, Number(e.target.value || 1)) })} style={inputStyle} aria-label="Số lượng" />
          <label title="Vật tư này phải có một lần ở từng người bệnh" style={{ display: 'inline-flex', justifyContent: 'center', alignItems: 'center', gap: 5, fontSize: FS.xs, color: row.every_patient ? C.green : C.text2 }}><input type="checkbox" checked={row.every_patient === true} onChange={e => setItem(index, { every_patient: e.target.checked })} />Bắt buộc</label>
          <button type="button" className="emr-icon-btn emr-icon-btn--danger" onClick={() => setForm(current => ({ ...current, items: current.items.filter((_, i) => i !== index) }))}><IconTrash size={16} /></button>
        </div>)}
        <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
          <Btn variant="secondary" icon={IconPlus} onClick={() => setForm(current => ({ ...current, items: [...safeArray(current.items), { code: '', name: '', quantity: 1, required: true, every_patient: false }] }))}>Thêm dòng</Btn>
          <Btn variant="solidPrimary" loading={saving} disabled={!form.name.trim()} onClick={save}>Lưu combo</Btn>
          {form.id && <Btn variant="danger" icon={IconTrash} onClick={() => remove(form)}>Xóa</Btn>}
        </div>
      </div>
    </div>
  </Modal>;
}

function CollectionModal({ draft, onClose }) {
  const rows = collectionRows(draft);
  return <Modal title="Danh sách thu thập VTYT" onClose={onClose} width={860}>
    <div style={{ padding: 14 }}>
      <div style={{ color: C.text2, fontSize: FS.xs, marginBottom: 10 }}>Tổng hợp từ các dòng dự kiến, đã thu thập hoặc đã sử dụng; không tính dòng đã hủy/đã nhập.</div>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: FS.xs }}>
        <thead><tr style={{ background: C.surface2 }}><th style={{ padding: 8, textAlign: 'left' }}>Vật tư</th><th>SL</th><th>Tồn tham chiếu</th><th>Còn lại</th><th style={{ textAlign: 'left' }}>Người bệnh</th></tr></thead>
        <tbody>{rows.map(row => <tr key={row.code} style={{ borderTop: `1px solid ${C.border2}`, color: row.blocked ? C.red : C.text }}>
          <td style={{ padding: 8 }}><b>{row.name}</b><div style={{ color: C.text3 }}>{row.code}</div></td><td style={{ textAlign: 'center' }}><b>{row.quantity}</b></td><td style={{ textAlign: 'center' }}>{row.stock ?? 'Chưa rõ'}</td><td style={{ textAlign: 'center' }}>{row.remaining ?? '—'}</td><td>{row.patients.join(', ')}</td>
        </tr>)}</tbody>
      </table>
      {!rows.length && <div style={{ padding: 24, textAlign: 'center', color: C.text3 }}>Chưa có vật tư cần thu thập.</div>}
      <div style={{ marginTop: 12 }}><Btn variant="secondary" onClick={() => window.print()}>In danh sách</Btn></div>
    </div>
  </Modal>;
}

function OrdersPanel({ job }) {
  const orders = safeArray(job?.orders);
  const drugs = safeArray(job?.drugs);
  return <div style={{ ...panelStyle, height: '100%', overflow: 'auto' }}>
    <div style={{ padding: '9px 11px', background: C.surface2, borderBottom: `1px solid ${C.border}` }}><b style={{ fontSize: FS.sm }}>Y lệnh gốc · {job?.ngay_lam || 'chọn ngày'}</b></div>
    {!job ? <div style={{ padding: 18, color: C.text3, fontSize: FS.xs }}>Chọn người bệnh và ngày để đối chiếu.</div> : <div style={{ padding: 10, display: 'grid', gap: 8 }}>
      {orders.length > 0 ? orders.map((order, index) => <div key={index} style={{ borderBottom: `1px solid ${C.border2}`, paddingBottom: 8 }}>
        <div style={{ color: C.text, fontSize: FS.xs, whiteSpace: 'pre-wrap' }}>{order.text || order.order_text || order.content || 'Y lệnh'}</div>
        {safeArray(order.drugs).map((drug, i) => <div key={i} style={{ marginTop: 5, display: 'flex', alignItems: 'start', gap: 7, color: C.blue, fontSize: FS.xs }}><span style={{ flex: 1 }}>• {drug.name || drug.ten_thuoc || drug.content || drug.order_text}</span><b style={{ flexShrink: 0, padding: '2px 6px', borderRadius: 10, background: C.blueBg }}>{drugQuantityText(drug)}</b></div>)}
      </div>) : drugs.map((drug, index) => <div key={index} style={{ borderBottom: `1px solid ${C.border2}`, paddingBottom: 8, fontSize: FS.xs }}>
        <div style={{ display: 'flex', gap: 7, alignItems: 'start' }}><b style={{ flex: 1 }}>{drug.name || drug.ten_thuoc || 'Thuốc/y lệnh'}</b><b style={{ color: C.blue, flexShrink: 0 }}>{drugQuantityText(drug)}</b></div><div style={{ color: C.text2 }}>{drug.content || drug.order_text || ''} {drug.route || drug.duong_dung_goc || ''}</div>
      </div>)}
      {!orders.length && !drugs.length && <div style={{ color: C.text3, fontSize: FS.xs }}>Ngày này không có y lệnh thuốc. Bạn vẫn có thể thêm VTYT phát sinh.</div>}
    </div>}
  </div>;
}

function SupplyRow({ item, available, onChange, onRemove }) {
  const stock = stockOf(item.code);
  const status = item.usage_status || 'planned';
  const blocked = stock == null || available < safeQty(item.input_quantity);
  return <div style={{ padding: 9, borderBottom: `1px solid ${C.border2}`, background: blocked && status !== 'cancelled' ? C.redBg : C.surface }}>
    <div style={{ display: 'flex', gap: 7, alignItems: 'start' }}>
      <div style={{ flex: 1, minWidth: 0 }}><b style={{ fontSize: FS.xs }}>{item.name || item.code}</b><div style={{ fontSize: FS.xs, color: C.text3 }}>{item.code} · tồn {stock ?? 'chưa rõ'} · khả dụng {available ?? 'chưa rõ'}</div></div>
      <button type="button" className="emr-icon-btn emr-icon-btn--danger" onClick={onRemove}><IconTrash size={15} /></button>
    </div>
    <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) 82px', gap: 7, marginTop: 7 }}>
      <select value={status} onChange={e => onChange({ ...item, usage_status: e.target.value, selected: !['cancelled', 'entered'].includes(e.target.value) })} style={inputStyle}>
        {Object.entries(VTYT_USAGE_STATUS).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
      </select>
      <input type="number" min="0" step="1" value={item.input_quantity ?? 0} onChange={e => onChange({ ...item, input_quantity: safeQty(e.target.value) })} style={{ ...inputStyle, textAlign: 'center' }} />
    </div>
    <div style={{ marginTop: 5, display: 'flex', justifyContent: 'space-between' }}><StatusBadge status={status} />{blocked && status !== 'cancelled' && <span style={{ color: C.red, fontSize: FS.xs, fontWeight: 700 }}>Không đủ tồn</span>}</div>
  </div>;
}

function PatientQueue({ patients, jobs, activeId, setActiveId }) {
  return <div style={{ ...panelStyle, overflow: 'auto', height: '100%' }}>
    <div style={{ padding: '9px 10px', background: C.surface2, borderBottom: `1px solid ${C.border}` }}><b style={{ fontSize: FS.sm }}>Người bệnh ({patients.length})</b></div>
    {patients.map(patient => {
      const patientJobs = jobs.filter(job => String(job.ma_bn) === String(patient.ma_bn));
      const active = patient.ma_bn === activeId;
      const used = patientJobs.reduce((sum, job) => sum + safeArray(job.supplies).filter(row => row.usage_status === 'used' && row.input_status !== 'entered').length, 0);
      const planned = patientJobs.reduce((sum, job) => sum + safeArray(job.supplies).filter(row => !['cancelled', 'entered'].includes(row.usage_status || 'planned')).length, 0);
      return <button key={patient.ma_bn} type="button" onClick={() => setActiveId(patient.ma_bn)} style={{ display: 'block', width: '100%', textAlign: 'left', border: 0, borderBottom: `1px solid ${C.border2}`, borderLeft: active ? `4px solid ${C.blue}` : '4px solid transparent', padding: '9px 8px', background: active ? C.blueBg : C.surface, cursor: 'pointer', color: C.text }}>
        <b style={{ fontSize: FS.sm }}>{patient.ho_ten || patient.ma_bn}</b><div style={{ fontSize: FS.xs, color: C.text3 }}>Mã {patient.ma_bn} · {patient.phong || 'chưa rõ phòng'}</div>
        <div style={{ marginTop: 3, color: patient.review_mode === 'full_episode' ? C.purple : C.blue, fontSize: FS.xs, fontWeight: 700 }}>{patient.review_label || 'Phạm vi chưa xác định'}{patient.review_from ? ` · ${patient.review_from}${patient.review_to && patient.review_to !== patient.review_from ? ` → ${patient.review_to}` : ''}` : ''}</div>
        <div style={{ marginTop: 4, fontSize: FS.xs, color: used ? C.green : C.text2 }}>{used ? `${used} dòng chờ nhập` : `${planned} dòng đang theo dõi`}</div>
      </button>;
    })}
  </div>;
}


function InfusionAuditCard({ audit, onPickDate }) {
  if (!audit?.patient) return null;
  if (!audit.full_episode) return <div style={{ padding: 9, borderRadius: 7, background: C.blueBg, border: `1px solid ${C.blueBorder}`, color: C.blue, fontSize: FS.xs }}>
    <b>Tiếp tục điều trị:</b> chỉ kiểm và lập VTYT theo y lệnh ngày hôm sau.
  </div>;
  const tone = audit.status === 'missing' ? C.red : audit.status === 'excess' ? C.amber : C.green;
  const background = audit.status === 'missing' ? C.redBg : audit.status === 'excess' ? C.amberBg : C.greenBg;
  const verdict = audit.status === 'missing'
    ? `Thiếu ${Math.abs(audit.difference)} dây — phải bổ sung`
    : audit.status === 'excess'
      ? `Dư ${audit.difference} dây — vượt mức +${audit.tolerance}, cần kiểm tra`
      : audit.difference > 0 ? `Dư +${audit.difference}, trong mức chấp nhận` : 'Số dây khớp số lượt truyền';
  return <div style={{ padding: 9, borderRadius: 7, background, border: `1px solid ${tone}`, color: tone, fontSize: FS.xs }}>
    <div style={{ display:'flex', gap:8, alignItems:'center', flexWrap:'wrap' }}><b>Đối chiếu toàn đợt ra viện</b><span>Lượt truyền: <b>{audit.expected}</b></span><span>Dây đã có: <b>{audit.actual}</b></span><b style={{ marginLeft:'auto' }}>{verdict}</b></div>
    {audit.mismatches.length > 0 && <div style={{ marginTop:7, display:'flex', alignItems:'center', gap:5, flexWrap:'wrap' }}><span>Ngày lệch:</span>{audit.mismatches.map(row => <button key={row.date} type="button" onClick={() => onPickDate(row.date)} style={{ border:`1px solid ${tone}`, borderRadius:12, padding:'2px 7px', color:tone, background:C.surface, cursor:'pointer', fontSize:FS.xs }}>{row.date} {row.difference > 0 ? `+${row.difference}` : row.difference}</button>)}</div>}
  </div>;
}

function VtytEditor({ draft, setDraft, jobIndex, combos }) {
  const job = safeArray(draft?.jobs)[jobIndex];
  const [comboId, setComboId] = useState('');
  const [comboCount, setComboCount] = useState(1);
  const [supplyCode, setSupplyCode] = useState('');
  const allocations = allocatedByCode(draft);

  function updateSupplies(updater) {
    setDraft(previous => ({
      ...previous,
      jobs: safeArray(previous.jobs).map((row, index) => index === jobIndex ? { ...row, supplies: updater(safeArray(row.supplies)) } : row),
      patients: safeArray(previous.patients).map(row => String(row.ma_bn) === String(job.ma_bn) ? { ...row, reviewed: false } : row),
      updated_at: nowIso(),
    }));
  }
  function addRows(rows, source) {
    updateSupplies(current => {
      const next = [...current];
      for (const row of rows) {
        const found = HCHANH_VTYT_ITEMS.find(item => item.code === row.code);
        const index = next.findIndex(item => supplyKey(item) === row.code && item.input_status !== 'entered');
        const quantity = safeQty(row.quantity || 1);
        if (index >= 0) next[index] = { ...next[index], input_quantity: safeQty(next[index].input_quantity) + quantity, usage_status: 'used', selected: true, source_type: source.type, combo_id: source.id, combo_name: source.name };
        else next.push({ key: row.code, code: row.code, name: found?.name || row.name, searchKeyword: found?.name || row.name, input_quantity: quantity, required_quantity: quantity, existing_quantity: existingVtytQuantity(job, row.code), selected: true, manual: true, usage_status: 'used', input_status: 'pending', source_type: source.type, combo_id: source.id || '', combo_name: source.name || '', reasons: [source.name || 'Phát sinh trong ngày'], warnings: [] });
      }
      return next;
    });
  }
  function addCombo() {
    const combo = combos.find(row => row.id === comboId);
    if (!combo) return;
    const availability = comboAvailability(combo, draft, comboCount);
    if (!availability.ok) { window.alert(`Không thể thêm combo “${combo.name}”: ${availability.details.filter(row => row.blocked).map(row => `${row.name}: ${row.reason}`).join('; ')}`); return; }
    addRows(combo.items.map(row => ({ ...row, quantity: safeQty(row.quantity || 1) * comboCount })), { type: 'combo', id: combo.id, name: combo.name });
  }
  function addSingle() {
    const item = HCHANH_VTYT_ITEMS.find(row => row.code === supplyCode);
    if (!item) return;
    const available = safeQty(item.stock) - (allocations.get(item.code) || 0);
    if (available < 1) { window.alert(`${item.name} đã hết hoặc đã được phân bổ hết trong danh sách.`); return; }
    addRows([{ code: item.code, name: item.name, quantity: 1 }], { type: 'manual', name: 'Phát sinh trong ngày' });
    setSupplyCode('');
  }

  if (!job) return <div style={{ ...panelStyle, padding: 20, color: C.text3 }}>Chưa có ngày được chọn.</div>;
  return <div style={{ ...panelStyle, height: '100%', overflow: 'auto' }}>
    <div style={{ padding: '9px 11px', background: C.surface2, borderBottom: `1px solid ${C.border}`, display: 'flex', justifyContent: 'space-between' }}><b style={{ fontSize: FS.sm }}>VTYT · {job.ngay_lam}</b><span style={{ fontSize: FS.xs, color: C.text3 }}>{safeArray(job.supplies).length} dòng</span></div>
    <div style={{ padding: 9, borderBottom: `1px solid ${C.border}` }}>
      <div style={{ fontSize: FS.xs, fontWeight: 700, marginBottom: 5 }}>Thêm combo phát sinh</div>
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) 64px 72px', gap: 6 }}>
        <select value={comboId} onChange={e => setComboId(e.target.value)} style={inputStyle}><option value="">Chọn combo…</option>{combos.filter(row => row.enabled !== false).map(row => <option key={row.id} value={row.id}>{row.name}</option>)}</select>
        <input type="number" min="1" value={comboCount} onChange={e => setComboCount(Math.max(1, Number(e.target.value || 1)))} style={inputStyle} />
        <Btn variant="secondary" onClick={addCombo} disabled={!comboId}>Thêm</Btn>
      </div>
      {comboId && (() => { const result = comboAvailability(combos.find(row => row.id === comboId), draft, comboCount); return <div style={{ marginTop: 5, fontSize: FS.xs, color: result.ok ? C.green : C.red }}>{result.ok ? 'Đủ tồn để thêm combo.' : result.details.filter(row => row.blocked).map(row => `${row.name}: ${row.reason}`).join(' · ')}</div>; })()}
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) 72px', gap: 6, marginTop: 8 }}>
        <select value={supplyCode} onChange={e => setSupplyCode(e.target.value)} style={inputStyle}><option value="">Hoặc thêm một VTYT…</option>{HCHANH_VTYT_ITEMS.map(item => <option key={item.code} value={item.code}>{item.name} · tồn {item.stock ?? '?'}</option>)}</select>
        <Btn variant="secondary" onClick={addSingle} disabled={!supplyCode}>Thêm</Btn>
      </div>
    </div>
    {safeArray(job.supplies).map((item, index) => {
      const own = safeQty(item.input_quantity);
      const available = stockOf(item.code) == null ? null : Math.max(0, stockOf(item.code) - (allocations.get(item.code) || 0) + own);
      return <SupplyRow key={`${supplyKey(item)}-${index}`} item={item} available={available} onChange={next => updateSupplies(rows => rows.map((row, i) => i === index ? next : row))} onRemove={() => updateSupplies(rows => rows.filter((_, i) => i !== index))} />;
    })}
    {!safeArray(job.supplies).length && <div style={{ padding: 18, color: C.text3, fontSize: FS.xs }}>Chưa có vật tư. Chọn combo hoặc thêm một vật tư phát sinh.</div>}
  </div>;
}

export default function HchanhVtytBatchPanel({ cards = [], draft, setDraft, onPreview, onInput, onClear, loading = false, inputting = false, onClose }) {
  const [activeId, setActiveId] = useState(safeArray(draft?.patients)[0]?.ma_bn || '');
  const [activeDate, setActiveDate] = useState('');
  const [combos, setCombos] = useState([]);
  const [showCombos, setShowCombos] = useState(false);
  const [showCollection, setShowCollection] = useState(false);
  const selectableCards = useMemo(() => safeArray(cards).filter(card => patientId(card)), [cards]);
  const patients = safeArray(draft?.patients);
  const jobs = safeArray(draft?.jobs);
  const patientJobs = jobs.map((job, index) => ({ job, index })).filter(row => String(row.job.ma_bn) === String(activeId));
  const activeJobRow = patientJobs.find(row => row.job.ngay_lam === activeDate) || patientJobs[0];
  const eligible = eligibleInputJobs(draft);
  const rows = collectionRows(draft);
  const stockBlocked = rows.some(row => row.blocked);
  const allReviewed = patients.length > 0 && patients.every(patient => patient.reviewed);
  const precheckExpired = Boolean(draft?.precheck_expires_at && Date.parse(draft.precheck_expires_at) <= Date.now());
  const commonRequirements = everyPatientRequirements(combos);
  const commonMissing = missingEveryPatientSupplies(draft, combos);
  const activeInfusionAudit = infusionSetAudit(draft, activeId);

  useEffect(() => { api.getVtytCombos().then(result => setCombos(safeArray(result?.combos))).catch(() => setCombos([])); }, []);
  useEffect(() => { if (draft && !activeId) setActiveId(patients[0]?.ma_bn || ''); }, [draft, activeId, patients]);
  useEffect(() => { if (activeJobRow?.job?.ngay_lam && !patientJobs.some(row => row.job.ngay_lam === activeDate)) setActiveDate(activeJobRow.job.ngay_lam); }, [activeDate, activeJobRow, patientJobs]);

  function setReviewed(checked) {
    setDraft(previous => ({ ...previous, patients: safeArray(previous.patients).map(row => String(row.ma_bn) === String(activeId) ? { ...row, reviewed: checked } : row), updated_at: nowIso() }));
  }
  function applyEveryPatientSupplies() {
    const availability = everyPatientAvailability(draft, combos);
    if (!availability.missing.length) {
      window.alert('Mỗi người bệnh đã có đủ các VTYT bắt buộc.');
      return;
    }
    if (!availability.ok) {
      const blocked = availability.details.filter(row => row.blocked)
        .map(row => `${row.name}: cần ${row.needed}, khả dụng ${row.available ?? 'chưa rõ'}`).join('; ');
      window.alert(`Không thể bổ sung VTYT cho mọi người bệnh: ${blocked}`);
      return;
    }
    const today = new Date();
    const todayDmy = `${String(today.getDate()).padStart(2, '0')}/${String(today.getMonth() + 1).padStart(2, '0')}/${today.getFullYear()}`;
    setDraft(previous => {
      const missing = missingEveryPatientSupplies(previous, combos);
      const byPatient = new Map();
      for (const row of missing) {
        if (!byPatient.has(row.ma_bn)) byPatient.set(row.ma_bn, []);
        byPatient.get(row.ma_bn).push(row);
      }
      const targetByPatient = new Map();
      for (const patient of safeArray(previous.patients)) {
        const indexed = safeArray(previous.jobs).map((job, index) => ({ job, index }))
          .filter(row => String(row.job.ma_bn) === String(patient.ma_bn));
        const target = indexed.find(row => row.job.ngay_lam === todayDmy)
          || indexed.sort((a, b) => String(b.job.ngay_lam || '').localeCompare(String(a.job.ngay_lam || '')))[0];
        if (target) targetByPatient.set(String(patient.ma_bn), target.index);
      }
      return {
        ...previous,
        jobs: safeArray(previous.jobs).map((job, index) => {
          const patientMissing = byPatient.get(String(job.ma_bn));
          if (!patientMissing || targetByPatient.get(String(job.ma_bn)) !== index) return job;
          const additions = patientMissing.map(row => ({
            key: row.code,
            code: row.code,
            name: row.name,
            searchKeyword: row.name,
            input_quantity: row.missing_quantity,
            required_quantity: row.missing_quantity,
            existing_quantity: 0,
            selected: true,
            manual: true,
            usage_status: 'planned',
            input_status: 'pending',
            source_type: 'every_patient',
            combo_id: row.combo_id,
            combo_name: row.combo_name,
            reasons: [`VTYT bắt buộc cho mỗi người bệnh · ${row.combo_name}`],
            warnings: [],
          }));
          return { ...job, supplies: [...safeArray(job.supplies), ...additions] };
        }),
        patients: safeArray(previous.patients).map(patient => byPatient.has(String(patient.ma_bn)) ? { ...patient, reviewed: false } : patient),
        updated_at: nowIso(),
      };
    });
  }
  return <div style={{ height: '100%', display: 'flex', flexDirection: 'column', background: C.surface, border: `1px solid ${C.border}`, borderRadius: 8, overflow: 'hidden' }}>
    <div style={{ padding: '9px 11px', borderBottom: `1px solid ${C.border}`, display: 'flex', alignItems: 'center', gap: 7, flexWrap: 'wrap' }}>
      <Btn variant="primary" icon={draft ? IconRefresh : IconChecklist} loading={loading} disabled={loading || inputting || !selectableCards.length} onClick={() => onPreview?.(selectableCards)}>{draft ? 'Cập nhật y lệnh & tồn' : `Tạo danh sách tất cả (${selectableCards.length})`}</Btn>
      {draft && <><Btn variant="secondary" icon={IconSettings} onClick={() => setShowCombos(true)}>Combo</Btn>{commonRequirements.length > 0 && <Btn variant="secondary" icon={IconPlus} disabled={!commonMissing.length} onClick={applyEveryPatientSupplies}>VTYT mỗi NB ({commonMissing.length})</Btn>}<Btn variant="secondary" icon={IconChecklist} onClick={() => setShowCollection(true)}>Danh sách thu thập</Btn></>}
      <Btn variant="solidPrimary" icon={IconPackageImport} loading={inputting} disabled={!draft || inputting || loading || !allReviewed || precheckExpired || !eligible.length || stockBlocked || commonMissing.length > 0} onClick={onInput}>Chốt & nhập ({eligible.reduce((sum, job) => sum + job.supplies.length, 0)})</Btn>
      <Btn variant="danger" icon={IconTrash} disabled={!draft || loading || inputting} onClick={onClear}>Xóa nháp</Btn>
      <span style={{ marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: FS.xs, color: C.text2 }}><IconCloudCheck size={15} color={C.green} /> Tự lưu</span>
      {onClose && <button type="button" className="emr-icon-btn" onClick={onClose}><IconX size={18} /></button>}
    </div>

    {!draft ? <div style={{ flex: 1, overflow: 'auto', padding: 12 }}>
      <div style={panelStyle}>
        <div style={{ padding: 14, background:C.surface2, borderBottom:`1px solid ${C.border}` }}>
          <b>Tự động lập danh sách cho toàn bộ người bệnh</b>
          <div style={{ marginTop:5, color:C.text2, fontSize:FS.xs, lineHeight:1.45 }}>
            Hiện có {selectableCards.length} người bệnh trong danh sách. Không cần chọn từng ca; nhập riêng một người bệnh vẫn thực hiện tại Nhập bệnh phòng.
          </div>
        </div>
        <div style={{ padding:14, color:C.text2, fontSize:FS.sm, lineHeight:1.55 }}>
          <b>Ra viện:</b> kiểm toàn bộ y lệnh từ ngày vào đến ngày ra viện và đối chiếu dây truyền theo từng ngày.<br />
          <b>Tiếp tục điều trị:</b> chỉ lập VTYT theo y lệnh ngày hôm sau.<br />
          Bấm “Tạo danh sách tất cả” để bắt đầu; bước này chưa nhập dữ liệu vào EMR.
        </div>
      </div>
    </div> : <>
      <div style={{ padding: '7px 11px', fontSize: FS.xs, color: stockBlocked || precheckExpired ? C.red : C.text2, background: stockBlocked || precheckExpired ? C.redBg : C.surface2, borderBottom: `1px solid ${C.border}` }}>
        {precheckExpired ? 'Phiên kiểm tra đã hết hạn — bấm “Cập nhật y lệnh & tồn” trước khi nhập.' : stockBlocked ? 'Có vật tư hết/không rõ tồn — hệ thống đã khóa nhập hàng loạt.' : commonMissing.length ? `Còn ${commonMissing.length} lượt VTYT bắt buộc chưa được bổ sung cho người bệnh.` : 'Tồn hiển thị là số tham chiếu lúc lập danh sách; hãy cập nhật lại trước khi chốt nhập buổi chiều.'}
      </div>
      <div style={{ flex: 1, minHeight: 0, padding: 10, display: 'grid', gridTemplateColumns: '260px minmax(310px,.95fr) minmax(380px,1.15fr)', gap: 10, overflow: 'auto' }}>
        <PatientQueue patients={patients} jobs={jobs} activeId={activeId} setActiveId={id => { setActiveId(id); setActiveDate(''); }} />
        <div style={{ minWidth: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
          <InfusionAuditCard audit={activeInfusionAudit} onPickDate={setActiveDate} />
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>{patientJobs.map(row => <button key={row.job.ngay_lam} type="button" onClick={() => setActiveDate(row.job.ngay_lam)} style={{ padding: '6px 9px', borderRadius: 7, border: `1px solid ${activeJobRow?.job?.ngay_lam === row.job.ngay_lam ? C.blue : C.border}`, background: activeJobRow?.job?.ngay_lam === row.job.ngay_lam ? C.blueBg : C.surface, color: C.text, cursor: 'pointer', fontSize: FS.xs }}>{row.job.ngay_lam}</button>)}</div>
          <div style={{ minHeight: 0, flex: 1 }}><OrdersPanel job={activeJobRow?.job} /></div>
        </div>
        <div style={{ minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column', gap: 7 }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, justifyContent: 'flex-end', fontSize: FS.xs, color: patients.find(row => row.ma_bn === activeId)?.reviewed ? C.green : C.text2, fontWeight: 700 }}><input type="checkbox" checked={Boolean(patients.find(row => row.ma_bn === activeId)?.reviewed)} onChange={e => setReviewed(e.target.checked)} />Đã đối chiếu xong người bệnh này</label>
          <div style={{ minHeight: 0, flex: 1 }}><VtytEditor draft={draft} setDraft={setDraft} jobIndex={activeJobRow?.index} combos={combos} /></div>
        </div>
      </div>
    </>}
    {(loading || inputting) && <div style={{ position: 'absolute', right: 20, bottom: 20 }}><Spinner size={18} /></div>}
    {showCombos && <ComboManager combos={combos} setCombos={setCombos} onClose={() => setShowCombos(false)} />}
    {showCollection && <CollectionModal draft={draft} onClose={() => setShowCollection(false)} />}
  </div>;
}
