import { C } from '../../tokens.js';
import { TIME_GROUPS } from './reportUtils.js';
import { EmptyFilter, Th, Td, TimeBadge, RouteBadge, formatQty } from './ReportShared.jsx';

function groupLabel(id) {
  const g = TIME_GROUPS.find(x => x.id === id);
  return g ? `${g.label}${g.range ? ` (${g.range})` : ''}` : id;
}

function DetailByGroup({ groups }) {
  if (!groups.length) return <EmptyFilter />;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {groups.map(([group, rows]) => (
        <div key={group} style={{ border: `1px solid ${C.border}`, borderRadius: 8, overflow: 'hidden', background: C.surface }}>
          <div style={{ padding: '9px 12px', borderBottom: `1px solid ${C.border}`, display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ color: C.green, fontWeight: 700 }}>{groupLabel(group)}</span>
            <span style={{ color: C.text3, fontSize: 11 }}>{rows.length} lượt</span>
          </div>
          <DrugTable rows={rows} />
        </div>
      ))}
    </div>
  );
}

function DrugTable({ rows }) {
  return (
    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
      <thead>
        <tr style={{ color: C.text3, textAlign: 'left', background: C.bg }}>
          <Th>Thời gian</Th>
          <Th>Phòng</Th>
          <Th>Người bệnh</Th>
          <Th>Thuốc</Th>
          <Th align="right">SL</Th>
          <Th>Đường dùng</Th>
          <Th>Ghi chú</Th>
        </tr>
      </thead>
      <tbody>
        {rows.map(row => (
          <tr key={row.id} style={{ borderTop: `1px solid ${C.border2}` }}>
            <Td><TimeBadge row={row} /></Td>
            <Td mono>{row.room}</Td>
            <Td>{row.patientName}</Td>
            <Td>
              <span style={{ color: C.text, fontWeight: 600 }}>{row.drugName}</span>
              {row.tuTuc && <span style={{ marginLeft: 6, color: C.amber, fontSize: 10 }}>(TT)</span>}
            </Td>
            <Td align="right" mono>{formatQty(row.quantity)} {row.unit}</Td>
            <Td><RouteBadge route={row.route} /></Td>
            <Td style={{ color: C.text2 }}>{row.mixWith ? `Pha với: ${row.mixWith}` : row.note}</Td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function SummaryTable({ rows }) {
  if (!rows.length) return <EmptyFilter />;
  return (
    <div style={{ border: `1px solid ${C.border}`, borderRadius: 8, overflow: 'hidden', background: C.surface }}>
      <div style={{ padding: '9px 12px', borderBottom: `1px solid ${C.border}` }}>
        <span style={{ color: C.green, fontWeight: 700 }}>Thống kê tổng số lượng thuốc phải dùng</span>
      </div>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
        <thead>
          <tr style={{ color: C.text3, textAlign: 'left', background: C.bg }}>
            <Th>Thuốc</Th>
            <Th align="right">Tổng SL</Th>
            <Th>Đơn vị</Th>
            <Th>Đường dùng</Th>
            <Th align="right">Số NB</Th>
            <Th>Giờ dùng</Th>
          </tr>
        </thead>
        <tbody>
          {rows.map(row => (
            <tr key={`${row.drugName}|${row.route}|${row.unit}`} style={{ borderTop: `1px solid ${C.border2}` }}>
              <Td style={{ fontWeight: 600 }}>{row.drugName}</Td>
              <Td align="right" mono>{formatQty(row.quantity)}</Td>
              <Td>{row.unit || '—'}</Td>
              <Td><RouteBadge route={row.route} /></Td>
              <Td align="right" mono>{row.patientCount}</Td>
              <Td mono>{row.timesText || '—'}</Td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export { DetailByGroup, DrugTable, SummaryTable };
