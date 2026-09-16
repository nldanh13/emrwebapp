import { useState } from 'react';
import { C } from '../../tokens.js';
import { toInputDate, fromInputDate } from './bedBoardUtils.js';

const inputStyle = {
  width: '100%', background: C.surface, border: `1px solid ${C.border}`,
  borderRadius: 4, padding: '3px 6px', color: C.text,
  fontSize: 10, fontFamily: 'inherit', outline: 'none', boxSizing: 'border-box',
};

function ddmmyyyyToInputDate(v) {
  const [dd, mm, yyyy] = String(v || '').split('/').map(Number);
  if (!dd || !mm || !yyyy) return '';
  return toInputDate(new Date(yyyy, mm - 1, dd));
}

// Ghi chú theo lần xếp phòng của 1 BN — không tính vào giá phòng tự động (giá vẫn
// theo roomPriceTier(room)), chỉ ghi lại để người xếp phòng/kế toán đối chiếu khi có
// ngoại lệ: đổi phòng giữa chừng, tính giá khác phòng đang nằm thực tế, hoặc đăng ký
// theo gói phòng 2/4 người.
export default function PatientRoomNotes({ patient, onChange, compact = false }) {
  const [open, setOpen] = useState(false);
  const transferDate = patient?.NgayChuyenPhong || '';
  const priceNote = patient?.GhiChuGiaPhong || '';
  const occupancy = patient?.DangKyPhong || '';
  const hasNote = transferDate || priceNote || occupancy;

  return (
    <div style={{ marginTop: hasNote || open ? 3 : 0 }}>
      <button
        type="button"
        onClick={() => setOpen(v => !v)}
        style={{
          background: 'none', border: 'none', cursor: 'pointer', padding: 0,
          fontSize: 9, color: hasNote ? C.amber : C.text3, fontFamily: 'inherit',
        }}
        title="Ghi chú ngày chuyển phòng / giá ngoại lệ / đăng ký phòng"
      >
        {open ? '▾' : '▸'} {hasNote ? 'Ghi chú ✓' : 'Ghi chú'}
      </button>

      {!open && hasNote && (
        <div style={{ fontSize: 9, color: C.text3, marginTop: 2, lineHeight: 1.4 }}>
          {transferDate && <div>Chuyển phòng: {transferDate}</div>}
          {priceNote && <div>{priceNote}</div>}
          {occupancy && <div>Đăng ký phòng {occupancy} người</div>}
        </div>
      )}

      {open && (
        <div style={{ display: 'grid', gap: 4, marginTop: 3, padding: compact ? 0 : '4px 0 2px' }}>
          <label style={{ fontSize: 9, color: C.text3 }}>
            Ngày chuyển phòng
            <input
              type="date"
              value={ddmmyyyyToInputDate(transferDate)}
              onChange={e => onChange('NgayChuyenPhong', fromInputDate(e.target.value))}
              style={{ ...inputStyle, marginTop: 2 }}
            />
          </label>
          <label style={{ fontSize: 9, color: C.text3 }}>
            Ghi chú giá (vd: nằm P3 nhưng tính giá 250k)
            <input
              type="text"
              value={priceNote}
              onChange={e => onChange('GhiChuGiaPhong', e.target.value)}
              placeholder="vd: nằm P3 nhưng tính giá 250k"
              style={{ ...inputStyle, marginTop: 2 }}
            />
          </label>
          <label style={{ fontSize: 9, color: C.text3 }}>
            Đăng ký phòng
            <select
              value={occupancy}
              onChange={e => onChange('DangKyPhong', e.target.value)}
              style={{ ...inputStyle, marginTop: 2 }}
            >
              <option value="">—</option>
              <option value="2">2 người</option>
              <option value="4">4 người</option>
            </select>
          </label>
        </div>
      )}
    </div>
  );
}
