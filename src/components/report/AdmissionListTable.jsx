import { C, FS } from '../../tokens.js';
import { Th, Td } from './ReportShared.jsx';

export default function AdmissionListTable({ rows }) {
  if (!rows.length) {
    return (
      <div style={{ color: C.text2, fontSize: FS.md, padding: 20, background: C.surface, border: `1px solid ${C.border2}`, borderRadius: 7, lineHeight: 1.5 }}>
        Ngày này chưa có người bệnh trong khoa. Vào <b>Lấy dữ liệu</b> để quét danh sách người bệnh trước.
      </div>
    );
  }
  const missing = rows.filter(row => !row.admissionDate).length;
  return (
    <div style={{ border: `1px solid ${C.border}`, borderRadius: 7, overflow: 'auto', background: C.surface }}>
      <h2 style={{ margin: 0, padding: '10px 12px', borderBottom: `1px solid ${C.border2}`, fontSize: FS.lg, fontWeight: 700, color: C.text }}>
        Danh sách người bệnh theo ngày vào viện
      </h2>
      {missing > 0 && (
        <div style={{ padding: '8px 12px', color: C.amber, fontSize: FS.sm, borderBottom: `1px solid ${C.border2}` }}>
          {missing} người bệnh chưa có ngày vào, được xếp cuối danh sách. Có thể quét lại danh sách ở <b>Lấy dữ liệu</b> để bổ sung.
        </div>
      )}
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: FS.md }}>
        <thead>
          <tr style={{ textAlign: 'left', background: C.surface2 }}>
            <Th>STT</Th>
            <Th>Ngày vào viện</Th>
            <Th>Họ tên người bệnh</Th>
            <Th>Ghi chú</Th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row, idx) => (
            <tr key={row.id} style={{ borderTop: `1px solid ${C.border2}` }}>
              <Td num>{idx + 1}</Td>
              <Td num>
                {row.admissionDate || '—'}
                {row.admissionTime && <div style={{ color: C.text2, fontSize: FS.xs }}>{row.admissionTime}</div>}
              </Td>
              <Td style={{ fontWeight: 600 }}>{row.patientName}</Td>
              <Td style={{ color: C.text2, fontSize: FS.sm }}>Để trống, ghi tay trên bản in</Td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
