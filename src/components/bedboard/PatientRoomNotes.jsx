import { useState } from 'react';
import { IconChevronDown, IconChevronRight } from '@tabler/icons-react';
import { C, FS } from '../../tokens.js';
import { toInputDate, fromInputDate } from './bedBoardUtils.js';
import DateField from '../DateField.jsx';

const inputStyle = {
  width: '100%', background: C.surface, border: `1px solid ${C.border}`,
  borderRadius: 5, padding: '5px 8px', color: C.text, minHeight: 30,
  fontSize: FS.sm, fontFamily: 'inherit', outline: 'none', boxSizing: 'border-box',
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
          display: 'inline-flex', alignItems: 'center', gap: 3, minHeight: 24,
          background: 'none', border: 'none', cursor: 'pointer', padding: 0,
          fontSize: FS.xs, fontWeight: hasNote ? 600 : 500, color: hasNote ? C.amber : C.text2, fontFamily: 'inherit',
        }}
        aria-expanded={open}
        title="Ghi chú ngày chuyển phòng / giá ngoại lệ / đăng ký phòng"
      >
        {open ? <IconChevronDown size={13} stroke={2} aria-hidden="true" /> : <IconChevronRight size={13} stroke={2} aria-hidden="true" />}
        {hasNote ? 'Có ghi chú' : 'Ghi chú'}
      </button>

      {!open && hasNote && (
        <div style={{ fontSize: FS.xs, color: C.text2, marginTop: 2, lineHeight: 1.45 }}>
          {transferDate && <div>Chuyển phòng: {transferDate}</div>}
          {priceNote && <div>{priceNote}</div>}
          {occupancy && <div>Đăng ký phòng {occupancy} người</div>}
        </div>
      )}

      {open && (
        <div style={{ display: 'grid', gap: 4, marginTop: 3, padding: compact ? 0 : '4px 0 2px' }}>
          <label style={{ fontSize: FS.xs, color: C.text2, display: 'grid' }}>
            Ngày chuyển phòng
            <span style={{ marginTop: 2 }}>
              <DateField label="Ngày chuyển phòng" value={ddmmyyyyToInputDate(transferDate)} onChange={iso => onChange('NgayChuyenPhong', fromInputDate(iso))} />
            </span>
          </label>
          <label style={{ fontSize: FS.xs, color: C.text2, display: 'grid' }}>
            Ghi chú giá (vd: nằm P3 nhưng tính giá 250k)
            <input
              type="text"
              value={priceNote}
              onChange={e => onChange('GhiChuGiaPhong', e.target.value)}
              placeholder="vd: nằm P3 nhưng tính giá 250k"
              style={{ ...inputStyle, marginTop: 2 }}
            />
          </label>
          <label style={{ fontSize: FS.xs, color: C.text2, display: 'grid' }}>
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
