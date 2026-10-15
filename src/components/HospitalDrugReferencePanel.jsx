// Offline Select2 medicine-code snapshot provided by the hospital user.
// Viewing this panel never calls the live EMR or changes the working catalog.
import { useMemo, useState } from 'react';
import { C, FS } from '../tokens.js';
import { Btn } from './shared.jsx';
import { hospitalDrugReference, findHospitalDrugStatus, searchHospitalDrugs } from '../utils/hospitalDrugReference.js';

const cell = { padding: '9px 10px', fontSize: FS.sm, borderBottom: `1px solid ${C.border2}`, verticalAlign: 'top' };

export default function HospitalDrugReferencePanel({ medications, onSetup, onEdit }) {
  const [query, setQuery] = useState('');
  const [onlyMissing, setOnlyMissing] = useState(false);
  const records = hospitalDrugReference.medications;
  const visible = useMemo(() => searchHospitalDrugs(records, query).filter(r =>
    !onlyMissing || findHospitalDrugStatus(r, medications).state === 'missing'
  ), [records, query, onlyMissing, medications]);
  const linked = records.filter(r => findHospitalDrugStatus(r, medications).state === 'linked').length;
  const ambiguousNames = new Map();
  for (const row of records) {
    const name = row.name.toLocaleLowerCase('vi-VN');
    ambiguousNames.set(name, (ambiguousNames.get(name) || 0) + 1);
  }
  return (
    <section aria-label="Danh mục thuốc bệnh viện tham khảo" style={{ display: 'grid', gap: 10 }}>
      <div style={{ padding: 12, border: `1px solid ${C.blueBorder}`, background: C.blueBg, borderRadius: 6,
        fontSize: FS.sm, color: C.text2, lineHeight: 1.55 }}>
        <b>{records.length} mã thuốc tham khảo</b> từ {hospitalDrugReference.rows_in_source} dòng của danh sách EMR bạn cung cấp;
        bỏ {hospitalDrugReference.duplicate_rows_omitted} dòng trùng mã. Đã liên kết {linked} mã với thuốc đang dùng.
        <div>
          Danh mục này <b>chỉ để tra cứu</b>, không được tự dùng để kê thuốc hoặc tạo phiếu tiêm/truyền.
          Tên, hàm lượng, đường dùng ghi trong danh sách nguồn phải đối chiếu tại bệnh viện.
          <b> Tồn kho và đơn giá là số liệu tại thời điểm sao chép, không phải số liệu hiện tại.</b>
        </div>
        <div>
          Bấm <b>Tạo cấu hình</b> chỉ mở biểu mẫu để bạn kiểm tra rồi tự lưu; không tự suy ra đường TMC/TTM,
          thể tích thuốc gốc, hoàn nguyên, dung môi hoặc tốc độ truyền.
        </div>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
        <input aria-label="Tìm danh mục thuốc bệnh viện" placeholder="Tìm theo mã, tên, hoạt chất, hàm lượng..."
          value={query} onChange={e => setQuery(e.target.value)}
          style={{ flex: '1 1 290px', minWidth: 0, padding: '8px 10px',
            border: `1px solid ${C.border}`, borderRadius: 6, color: C.text, background: C.surface, fontSize: FS.md }} />
        <label style={{ display: 'flex', alignItems: 'center', gap: 5, color: C.text2, fontSize: FS.sm }}>
          <input type="checkbox" checked={onlyMissing} onChange={e => setOnlyMissing(e.target.checked)} />
          Chỉ mã chưa có tên trong danh mục
        </label>
        <span style={{ fontSize: FS.xs, color: C.text3 }}>{visible.length} kết quả</span>
      </div>
      <div style={{ overflow: 'auto', maxHeight: 620, borderTop: `1px solid ${C.border2}` }}>
        <table style={{ width: '100%', minWidth: 850, borderCollapse: 'collapse' }}>
          <thead>
            <tr style={{ background: C.surface2 }}>
              {['Mã BV', 'Tên thuốc / hàm lượng', 'ĐVT / quy cách', 'Hoạt chất nguồn', 'Đường dùng ghi trong nguồn', 'Cấu hình'].map(h =>
                <th key={h} style={{ ...cell, fontWeight: 700, color: C.text2, textAlign: 'left', position: 'sticky', top: 0,
                  background: C.surface2, zIndex: 1 }}>{h}</th>
              )}
            </tr>
          </thead>
          <tbody>
            {visible.map(row => {
              const status = findHospitalDrugStatus(row, medications);
              const collision = (ambiguousNames.get(row.name.toLocaleLowerCase('vi-VN')) || 0) > 1;
              return (
                <tr key={row.code}>
                  <td style={cell}><code>{row.code}</code></td>
                  <td style={{ ...cell, fontWeight: 600, color: C.text }}>
                    {row.name}
                    <div style={{ fontSize: FS.xs, fontWeight: 400, color: C.text2 }}>{row.strength || 'Chưa rõ hàm lượng'}</div>
                    {collision && <div style={{ color: C.amber, fontWeight: 400, fontSize: FS.xs }}>Có nhiều mã cùng tên; đối chiếu mã và hàm lượng</div>}
                  </td>
                  <td style={cell}>{row.unit || '—'}
                    <div style={{ fontSize: FS.xs, color: C.text3 }}>{row.presentation || '—'}</div>
                  </td>
                  <td style={{ ...cell, maxWidth: 240, overflowWrap: 'anywhere' }}>{row.ingredient || '—'}</td>
                  <td style={cell}>{row.route_label || '—'}</td>
                  <td style={cell}>
                    {status.state === 'linked'
                      ? <div style={{ fontSize: FS.xs, color: C.text2 }}>Đã liên kết mã này</div>
                      : status.state === 'same_name'
                        ? <div style={{ fontSize: FS.xs, color: C.amber, marginBottom: 4 }}>Trùng tên thuốc đang có. Không ghi đè.</div>
                        : null}
                    {status.state !== 'missing'
                      ? <Btn variant="default" onClick={() => onEdit(status.medication)}>Xem cấu hình cũ</Btn>
                      : <Btn variant="secondary" onClick={() => onSetup(row)}>Tạo cấu hình</Btn>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {!visible.length && <div style={{ padding: 16, fontSize: FS.sm, color: C.text3 }}>Không có mã thuốc phù hợp.</div>}
      </div>
    </section>
  );
}
