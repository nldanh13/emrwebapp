import { C, FS } from '../../tokens.js';
import { EmptyFilter, Th, Td, RouteBadge, formatQty } from './ReportShared.jsx';

function SummaryTable({ rows }) {
  if (!rows.length) return <EmptyFilter />;
  return (
    <div style={{ border: `1px solid ${C.border}`, borderRadius: 7, overflow: 'auto', background: C.surface }}>
      <h2 style={{ margin: 0, padding: '10px 12px', borderBottom: `1px solid ${C.border2}`, fontSize: FS.lg, fontWeight: 700, color: C.text }}>
        Tổng số lượng thuốc phải dùng
      </h2>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: FS.md }}>
        <thead>
          <tr style={{ textAlign: 'left', background: C.surface2 }}>
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
              <Td align="right" num>{formatQty(row.quantity)}</Td>
              <Td>{row.unit || '—'}</Td>
              <Td><RouteBadge route={row.route} /></Td>
              <Td align="right" num>{row.patientCount}</Td>
              <Td num>{row.timesText || '—'}</Td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export { SummaryTable };
