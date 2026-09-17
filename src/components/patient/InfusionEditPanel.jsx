import { useState } from 'react';
import { C, FONT_MONO } from '../../tokens.js';
import { Btn, Spinner } from '../shared.jsx';
import * as api from '../../api.js';
import { normalizeGio } from './patientDetailUtils.js';

function infusionMatchOf(item = {}) {
  return {
    ten_thuoc: item.ten_thuoc || '',
    bac_si: item.bac_si || '',
    tg_bat_dau: item.tg_bat_dau || item.gio_dung || '',
    tg_ket_thuc: item.tg_ket_thuc || '',
    the_tich: item.the_tich ?? '',
    toc_do: item.toc_do ?? '',
  };
}

function InfusionEditRow({ item, patientId, ngayLam, toast, onSaved }) {
  const [theTich, setTheTich] = useState(item.the_tich ?? '');
  const [tocDo, setTocDo] = useState(item.toc_do ?? '');
  const [saving, setSaving] = useState(false);

  const dirty = String(theTich ?? '').trim() !== String(item.the_tich ?? '').trim()
    || String(tocDo ?? '').trim() !== String(item.toc_do ?? '').trim();

  const handleSave = async () => {
    if (!dirty || saving) return;
    setSaving(true);
    try {
      const updates = {};
      if (String(theTich ?? '').trim() !== String(item.the_tich ?? '').trim()) updates.the_tich = theTich;
      if (String(tocDo ?? '').trim() !== String(item.toc_do ?? '').trim()) updates.toc_do = tocDo;
      const r = await api.updateInfusionItem(patientId, ngayLam, infusionMatchOf(item), updates);
      if (r?.status === 'ok') {
        toast?.('Đã lưu thay đổi dịch truyền.', 'ok');
        onSaved?.();
      } else {
        toast?.(r?.message || 'Không lưu được thay đổi.', 'error');
      }
    } catch (e) {
      toast?.(String(e.message || e), 'error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div style={{
      background: C.surface, border: `1px solid ${C.blueBorder || C.border}`,
      borderLeft: `3px solid ${C.blue}`, borderRadius: 5, padding: '9px 10px',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8, flexWrap: 'wrap' }}>
        <span style={{ fontFamily: FONT_MONO, fontSize: 13, fontWeight: 700, color: C.blue }}>
          {normalizeGio(item.tg_bat_dau || item.gio_dung) || '—'}
        </span>
        <span style={{ fontSize: 12, color: C.text, fontWeight: 600 }}>
          {item.ten_hien_thi || item.ten_thuoc || '—'}
        </span>
      </div>

      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
          <span style={{ fontSize: 10, color: C.text3, fontWeight: 600, letterSpacing: '0.04em', textTransform: 'uppercase' }}>Thể tích (ml)</span>
          <input
            type="text"
            inputMode="decimal"
            value={theTich}
            onChange={e => setTheTich(e.target.value)}
            style={{
              width: 90, padding: '5px 7px', borderRadius: 4,
              border: `1px solid ${C.border}`, fontSize: 12, fontFamily: FONT_MONO,
              color: C.text, background: C.surface,
            }}
          />
        </label>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
          <span style={{ fontSize: 10, color: C.text3, fontWeight: 600, letterSpacing: '0.04em', textTransform: 'uppercase' }}>Tốc độ (gt/p)</span>
          <input
            type="text"
            inputMode="decimal"
            value={tocDo}
            onChange={e => setTocDo(e.target.value)}
            style={{
              width: 90, padding: '5px 7px', borderRadius: 4,
              border: `1px solid ${C.border}`, fontSize: 12, fontFamily: FONT_MONO,
              color: C.text, background: C.surface,
            }}
          />
        </label>
        <Btn variant="primary" disabled={!dirty || saving} onClick={handleSave} style={{ padding: '5px 12px', fontSize: 11 }}>
          {saving ? <><Spinner size={10} /> Đang lưu</> : 'Lưu'}
        </Btn>
        {!dirty && <span style={{ fontSize: 11, color: C.text3 }}>Chưa có thay đổi</span>}
      </div>
    </div>
  );
}

export default function InfusionEditPanel({ patientDay, patientId, ngayLam, toast, onSaved }) {
  const items = Array.isArray(patientDay?.thuoc?.dich_truyen) ? patientDay.thuoc.dich_truyen : [];

  if (!items.length) {
    return <div style={{ fontSize: 12, color: C.text3 }}>Ngày này không có dịch truyền để sửa.</div>;
  }

  return (
    <div>
      <div style={{ margin: '0 0 10px', padding: '6px 8px', borderLeft: `2px solid ${C.blue}`, color: C.text3, fontSize: 10.5, lineHeight: 1.4 }}>
        Sửa dữ liệu dịch truyền đã thu thập (không ghi ngược EMR). Bấm "Kiểm tra / Nhập / Sửa" ở khu DT bên dưới nếu muốn đưa giá trị đã sửa vào EMR.
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {items.map((item, i) => (
          <InfusionEditRow
            key={`${item.tg_bat_dau || item.gio_dung || 'dt'}-${item.ten_thuoc || i}-${i}`}
            item={item}
            patientId={patientId}
            ngayLam={ngayLam}
            toast={toast}
            onSaved={onSaved}
          />
        ))}
      </div>
    </div>
  );
}
