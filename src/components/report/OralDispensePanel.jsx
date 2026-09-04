import { useState } from 'react';
import { C, FONT_MONO } from '../../tokens.js';
import { formatQty } from './ReportShared.jsx';

function OralDispensePanel({ data }) {
  const [openSet, setOpenSet] = useState(new Set());
  if (!data?.length) return null;

  const toggle = (id) => setOpenSet(prev => {
    const next = new Set(prev);
    next.has(id) ? next.delete(id) : next.add(id);
    return next;
  });

  const totalPatients = data.length;
  const totalDrugs = data.reduce((s, p) => s + p.drugs.size, 0);
  const tuTucCount = data.reduce((s, p) => s + [...p.drugs.values()].filter(d => d.tuTuc).length, 0);

  return (
    <div style={{ borderBottom: `1px solid ${C.border}`, background: 'rgba(188,140,255,0.05)' }}>
      {/* Panel header */}
      <div style={{ padding: '8px 12px', display: 'flex', alignItems: 'center', gap: 10, borderBottom: `1px solid rgba(188,140,255,0.2)`, flexWrap: 'wrap' }}>
        <span style={{ color: C.purple, fontWeight: 700, fontSize: 13 }}>💊 Phát thuốc uống — cả ngày</span>
        <span style={{ fontSize: 11, color: C.text3 }}>{totalPatients} người bệnh · {totalDrugs} loại</span>
        {tuTucCount > 0 && <span style={{ fontSize: 11, color: C.amber, background: C.amberBg, border: `1px solid ${C.amberBorder}`, borderRadius: 4, padding: '2px 8px' }}>Tự túc: {tuTucCount}</span>}
        <span style={{ fontSize: 11, color: C.text3, marginLeft: 'auto' }}>Bấm tên BN để xem chi tiết</span>
      </div>

      {/* Patient accordion rows */}
      {data.map(patient => {
        const isOpen = openSet.has(patient.patientId);
        const drugs = [...patient.drugs.values()];
        const hasTuTuc = drugs.some(d => d.tuTuc);
        return (
          <div key={patient.patientId} style={{ borderBottom: `1px solid rgba(188,140,255,0.12)` }}>
            {/* Patient header row — clickable */}
            <div onClick={() => toggle(patient.patientId)} style={{
              padding: '9px 12px', cursor: 'pointer', userSelect: 'none',
              display: 'flex', alignItems: 'center', gap: 8,
              background: isOpen ? 'rgba(188,140,255,0.08)' : 'transparent',
            }}>
              <span style={{ fontSize: 11, color: C.text3 }}>P.</span>
              <span style={{ fontSize: 12, fontWeight: 700, color: C.text, minWidth: 28 }}>{patient.room}</span>
              <span style={{ fontSize: 13, fontWeight: 700, color: C.text, flex: 1 }}>{patient.patientName}</span>
              {/* Summary badges when collapsed */}
              {!isOpen && (
                <span style={{ fontSize: 11, color: C.text3 }}>
                  {drugs.length} loại · {drugs.map(d => d.drugName).join(', ').slice(0, 40)}{drugs.map(d => d.drugName).join(', ').length > 40 ? '…' : ''}
                </span>
              )}
              {hasTuTuc && <span style={{ fontSize: 10, color: C.amber, background: C.amberBg, border: `1px solid ${C.amberBorder}`, borderRadius: 4, padding: '1px 6px' }}>TT</span>}
              <span style={{ color: C.text3, fontSize: 12 }}>{isOpen ? '▲' : '▼'}</span>
            </div>

            {/* Drug list — expanded */}
            {isOpen && (
              <div style={{ padding: '6px 12px 10px 12px', background: 'rgba(188,140,255,0.04)' }}>
                <div style={{ display: 'grid', gap: 5 }}>
                  {drugs.map((drug, i) => (
                    <div key={i} style={{
                      display: 'grid',
                      gridTemplateColumns: 'minmax(160px, 2fr) minmax(100px, auto) 60px minmax(100px, 1.2fr) auto',
                      gap: 8, alignItems: 'center', fontSize: 12,
                      padding: '5px 8px', borderRadius: 6,
                      background: drug.tuTuc ? C.amberBg : 'rgba(0,0,0,0.15)',
                      border: `1px solid ${drug.tuTuc ? C.amberBorder : C.border2}`,
                    }}>
                      <span style={{ color: C.text, fontWeight: 600 }}>{drug.drugName}</span>
                      <span style={{ color: C.text, fontFamily: FONT_MONO, textAlign: 'right', fontSize: 11 }}>
                        {drug.times.length > 1
                          ? <>{formatQty(drug.qtyPerDose)}×{drug.times.length} = <b>{formatQty(drug.totalQty)}</b> {drug.unit}</>
                          : <><b>{formatQty(drug.totalQty)}</b> {drug.unit}</>}
                      </span>
                      <span style={{ color: C.purple, background: 'rgba(188,140,255,0.15)', border: '1px solid rgba(188,140,255,0.35)', borderRadius: 4, padding: '2px 5px', fontSize: 10, fontWeight: 700, textAlign: 'center' }}>Uống</span>
                      <span style={{ color: C.text3, fontSize: 11 }}>
                        {drug.times.length ? drug.times.join(' · ') : 'Chưa rõ giờ'}
                        {drug.note ? <><br /><span style={{ color: C.text2 }}>{drug.note}</span></> : ''}
                      </span>
                      {drug.tuTuc
                        ? <span style={{ color: C.amber, background: C.amberBg, border: `1px solid ${C.amberBorder}`, borderRadius: 4, padding: '2px 7px', fontSize: 11, fontWeight: 700, whiteSpace: 'nowrap' }}>Tự túc</span>
                        : <span style={{ color: C.text3, fontSize: 11, whiteSpace: 'nowrap' }}>Cấp phát</span>
                      }
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

export { OralDispensePanel };
