import { C, FS } from '../../tokens.js';
import { Th, Td } from './ReportShared.jsx';

export default function OtherOrderTable({ rows }) {
  if (!rows.length) {
    return (
      <div style={{ color: C.text2, fontSize: FS.md, padding: 20, background: C.surface, border: `1px solid ${C.border2}`, borderRadius: 7, lineHeight: 1.5 }}>
        Ngày này chưa có Y lệnh khác. Nếu chắc chắn có, vào <b>Lấy dữ liệu</b> và chạy lại <b>Xử lý &amp; phân loại</b>; không cần lấy lại từ EMR.
      </div>
    );
  }
  return (
    <div style={{ border: `1px solid ${C.border}`, borderRadius: 7, overflow: 'auto', background: C.surface }}>
      <h2 style={{ margin: 0, padding: '10px 12px', borderBottom: `1px solid ${C.border2}`, fontSize: FS.lg, fontWeight: 700, color: C.text }}>
        Y lệnh khác
      </h2>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: FS.md }}>
        <thead>
          <tr style={{ textAlign: 'left', background: C.surface2 }}>
            <Th>Phòng</Th>
            <Th>Người bệnh</Th>
            <Th>Giờ phiếu</Th>
            <Th>Y lệnh khác</Th>
          </tr>
        </thead>
        <tbody>
          {rows.map(row => (
            <tr key={row.id} style={{ borderTop: `1px solid ${C.border2}` }}>
              <Td>{row.room || '—'}</Td>
              <Td style={{ fontWeight: 600 }}>{row.patientName}</Td>
              <Td num>
                {row.time || '—'}
                {row.doctor && <div style={{ color: C.text2, fontSize: FS.xs }}>{row.doctor}</div>}
              </Td>
              <Td style={{ whiteSpace: 'pre-wrap' }}>{row.text}</Td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
