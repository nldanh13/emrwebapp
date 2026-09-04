import { useState } from 'react';
import { C, FONT_MONO } from '../../tokens.js';
import { groupRowsByPatient, isOddHour, rowMinutes, uniquePatientCount } from './reportUtils.js';
import { TimeBadge, RouteBadge, formatQty } from './ReportShared.jsx';

function DutySection({ title, subtitle, rows, date, muted = false, highlight = false }) {
  const patientCount = uniquePatientCount(rows);
  const oddCount = (rows || []).filter(isOddHour).length;
  return (
    <div style={{ border: `1px solid ${highlight ? C.greenBorder : C.border}`, borderRadius: 8, overflow: 'hidden', background: muted ? C.bg : C.surface }}>
      <div style={{ padding: '9px 12px', borderBottom: `1px solid ${C.border}`, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <span style={{ color: highlight ? C.green : C.text, fontWeight: 700 }}>{title}</span>
        {patientCount > 0 && <span style={{ color: C.text3, fontSize: 11 }}>{patientCount} người bệnh</span>}
        {oddCount > 0 && <span style={{ color: C.amber, background: C.amberBg, border: `1px solid ${C.amberBorder}`, borderRadius: 4, padding: '2px 7px', fontSize: 10 }}>Có giờ riêng</span>}
      </div>
      {subtitle && <div style={{ padding: '7px 12px', color: C.text2, fontSize: 11, borderBottom: `1px solid ${C.border2}` }}>{subtitle}</div>}
      {(rows || []).length ? <DutyDrugTable rows={rows} date={date} /> : <div style={{ color: C.text3, padding: 12, fontSize: 12 }}>Không có thuốc trong nhóm này.</div>}
    </div>
  );
}

function aggregateOralRows(oralRows) {
  const map = new Map();
  for (const row of oralRows) {
    const key = `${row.drugName.toLowerCase()}|${row.unit}`;
    if (!map.has(key)) {
      map.set(key, { ...row, times: [], totalQty: 0 });
    }
    const agg = map.get(key);
    if (row.time && row.time !== '—') agg.times.push(row.time);
    agg.totalQty += Number(row.quantity || 0);
  }
  return [...map.values()].map(d => ({
    ...d,
    times: [...new Set(d.times)].sort(),
    quantity: d.totalQty,
  })).sort((a, b) => String(a.drugName).localeCompare(String(b.drugName), 'vi'));
}

function DutyDrugTable({ rows, date }) {
  const [search, setSearch] = useState('');
  const [openSet, setOpenSet] = useState(new Set());
  const groups = groupRowsByPatient(rows);

  const toggle = (key) => setOpenSet(prev => {
    const next = new Set(prev);
    next.has(key) ? next.delete(key) : next.add(key);
    return next;
  });

  const filteredGroups = search.trim()
    ? groups.filter(g => {
        const q = search.trim().toLowerCase();
        return g.patientName.toLowerCase().includes(q) ||
               g.room.toLowerCase().includes(q) ||
               (g.patientId || '').toLowerCase().includes(q);
      })
    : groups;

  const expandAll = () => setOpenSet(new Set(filteredGroups.map(g => `${g.room}|${g.patientId || g.patientName}`)));
  const collapseAll = () => setOpenSet(new Set());

  return (
    <div>
      {/* Search + expand controls */}
      <div style={{ padding: '7px 10px', display: 'flex', gap: 8, alignItems: 'center', borderBottom: `1px solid ${C.border2}`, flexWrap: 'wrap' }}>
        <input
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="🔍 Tìm người bệnh..."
          style={{
            flex: 1, minWidth: 160, background: C.surface2, border: `1px solid ${C.border}`,
            borderRadius: 6, padding: '5px 10px', color: C.text, fontSize: 12,
            fontFamily: 'inherit', outline: 'none',
          }}
        />
        {search && (
          <span style={{ fontSize: 11, color: C.text3 }}>{filteredGroups.length} kết quả</span>
        )}
        {filteredGroups.length > 1 && (
          <>
            <button type="button" onClick={expandAll} style={{ fontSize: 11, background: 'none', border: `1px solid ${C.border}`, borderRadius: 3, padding: '3px 8px', cursor: 'pointer', color: C.text2, fontFamily: 'inherit' }}>Mở tất cả</button>
            <button type="button" onClick={collapseAll} style={{ fontSize: 11, background: 'none', border: `1px solid ${C.border}`, borderRadius: 3, padding: '3px 8px', cursor: 'pointer', color: C.text3, fontFamily: 'inherit' }}>Thu tất cả</button>
          </>
        )}
      </div>

      <div style={{ display: 'grid', gap: 8, padding: 10 }}>
        {filteredGroups.length === 0 && (
          <div style={{ padding: 12, fontSize: 12, color: C.text3, textAlign: 'center' }}>Không tìm thấy người bệnh.</div>
        )}
        {filteredGroups.map(group => {
          const key = `${group.room}|${group.patientId || group.patientName}`;
          const isOpen = openSet.has(key);

          const nonOralRows = group.rows.filter(r => r.route !== 'Uống');
          const oralAgg = aggregateOralRows(group.rows.filter(r => r.route === 'Uống'));
          const hasOral = oralAgg.length > 0;

          const ttmCount = nonOralRows.filter(x => x.route === 'TTM').length;
          const continuousTtmCount = nonOralRows.filter(x => x.route === 'TTM' && x.isContinuousInfusion).length;
          const oddCount = nonOralRows.filter(isOddHour).length;
          const routeSummary = [
            ...new Set(nonOralRows.map(r => r.route).filter(Boolean)),
            ...(hasOral ? ['Uống'] : []),
          ].join(' · ');

          return (
            <div key={key} style={{ border: `1px solid ${C.border2}`, borderRadius: 8, background: C.bg, overflow: 'hidden' }}>
              {/* Patient header — clickable */}
              <div onClick={() => toggle(key)} style={{
                display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px',
                borderBottom: isOpen ? `1px solid ${C.border2}` : 'none',
                flexWrap: 'wrap', cursor: 'pointer', userSelect: 'none',
                background: isOpen ? C.surface2 : 'transparent',
              }}>
                <span style={{ color: C.text3, fontSize: 11 }}>P.</span>
                <span style={{ color: C.text, fontWeight: 800, minWidth: 26 }}>{group.room}</span>
                <span style={{ color: C.text, fontWeight: 700, flex: 1 }}>{group.patientName}</span>
                {!isOpen && <span style={{ fontSize: 11, color: C.text3 }}>{routeSummary}</span>}
                {continuousTtmCount > 1 && <span style={{ color: C.green, background: C.greenBg, border: `1px solid ${C.greenBorder}`, borderRadius: 4, padding: '2px 7px', fontSize: 10 }}>TTM nối tiếp {continuousTtmCount}</span>}
                {!continuousTtmCount && ttmCount > 1 && <span style={{ color: C.green, background: C.greenBg, border: `1px solid ${C.greenBorder}`, borderRadius: 4, padding: '2px 7px', fontSize: 10 }}>TTM {ttmCount} cữ</span>}
                {oddCount > 0 && <span style={{ color: C.amber, background: C.amberBg, border: `1px solid ${C.amberBorder}`, borderRadius: 4, padding: '2px 7px', fontSize: 10 }}>Giờ riêng {oddCount}</span>}
                {hasOral && <span style={{ color: C.purple, background: 'rgba(188,140,255,0.12)', border: '1px solid rgba(188,140,255,0.3)', borderRadius: 4, padding: '2px 7px', fontSize: 10 }}>💊 {oralAgg.length} uống</span>}
                <span style={{ color: C.text3, fontSize: 12 }}>{isOpen ? '▲' : '▼'}</span>
              </div>

              {isOpen && (
                <>
                  {/* Non-oral rows */}
                  {nonOralRows.length > 0 && (
                    <div style={{ display: 'grid' }}>
                      {nonOralRows.map(row => (
                        <div key={row.id} style={{ display: 'grid', gridTemplateColumns: '78px minmax(170px, 1.4fr) 88px 70px minmax(180px, 1.2fr)', gap: 8, alignItems: 'center', padding: '7px 10px', borderTop: `1px solid ${C.border2}`, background: isOddHour(row) ? 'rgba(210,153,34,0.06)' : 'transparent' }}>
                          <TimeBadge row={row} />
                          <div>
                            <span style={{ color: C.text, fontWeight: 700 }}>{row.drugName}</span>
                            {row.tuTuc && <span style={{ marginLeft: 6, color: C.amber, fontSize: 10 }}>(TT)</span>}
                          </div>
                          <span style={{ color: C.text, fontFamily: FONT_MONO, textAlign: 'right' }}>{formatQty(row.quantity)} {row.unit}</span>
                          <RouteBadge route={row.route} />
                          <span style={{ color: C.text2 }}>{row.mixWith ? `Pha với: ${row.mixWith}` : row.note}{row.category === 'thuoc_tra' ? ' · ngưng/trả' : ''}</span>
                        </div>
                      ))}
                    </div>
                  )}

                  {/* Oral section — separated */}
                  {hasOral && (
                    <div style={{ borderTop: `1px dashed rgba(188,140,255,0.35)`, background: 'rgba(188,140,255,0.04)' }}>
                      <div style={{ padding: '4px 10px', fontSize: 10, fontWeight: 700, color: C.purple, letterSpacing: '0.06em' }}>
                        💊 THUỐC UỐNG — PHÁT CẢ NGÀY
                      </div>
                      {oralAgg.map((drug, i) => (
                        <div key={i} style={{ display: 'grid', gridTemplateColumns: 'minmax(170px, 1.4fr) 100px 60px minmax(120px, 1fr) 70px', gap: 8, alignItems: 'center', padding: '6px 10px', borderTop: `1px solid rgba(188,140,255,0.15)` }}>
                          <div>
                            <span style={{ color: C.text, fontWeight: 700 }}>{drug.drugName}</span>
                            {drug.tuTuc && <span style={{ marginLeft: 6, color: C.amber, fontSize: 10 }}>(TT)</span>}
                          </div>
                          <span style={{ color: C.text, fontFamily: FONT_MONO, textAlign: 'right', fontSize: 11 }}>
                            {drug.times.length > 1
                              ? <>{formatQty(drug.quantity / drug.times.length)}×{drug.times.length}=<b>{formatQty(drug.quantity)}</b> {drug.unit}</>
                              : <><b>{formatQty(drug.quantity)}</b> {drug.unit}</>}
                          </span>
                          <RouteBadge route="Uống" />
                          <span style={{ color: C.text3, fontSize: 11 }}>{drug.times.length ? drug.times.join(' · ') : 'Chưa rõ giờ'}</span>
                          <span style={{ fontSize: 11, textAlign: 'center' }}>
                            {drug.tuTuc
                              ? <span style={{ color: C.amber, fontWeight: 600 }}>Tự túc</span>
                              : <span style={{ color: C.text3 }}>Cấp phát</span>}
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                </>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function compareDutyRows(selectedDate) {
  return (a, b) => {
    const da = a.date === selectedDate ? 0 : 1;
    const db = b.date === selectedDate ? 0 : 1;
    if (da !== db) return da - db;
    const ta = rowMinutes(a);
    const tb = rowMinutes(b);
    if (ta !== tb) return ta - tb;
    return String(a.room || '').localeCompare(String(b.room || ''), 'vi', { numeric: true })
      || String(a.patientName || '').localeCompare(String(b.patientName || ''), 'vi')
      || String(a.drugName || '').localeCompare(String(b.drugName || ''), 'vi');
  };
}

export { DutySection, DutyDrugTable, aggregateOralRows, compareDutyRows };
