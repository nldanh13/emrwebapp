import { C, FS } from '../../tokens.js';
import { patientsInRoom } from './shiftUtils.js';

export default function RoomChips({ rooms, patients, selRoom, onSelect }) {
  return (
    <div className="emr-hscroll" role="group" aria-label="Lọc theo phòng" style={{
      display: 'flex', gap: 6, padding: '8px 12px',
      overflowX: 'auto', borderBottom: `1px solid ${C.border2}`, flexShrink: 0, background: C.surface,
    }}>
      <button type="button" onClick={() => onSelect(null)} aria-pressed={!selRoom} style={{
        minHeight: 36, padding: '0 12px', borderRadius: 5, border: `1px solid ${!selRoom ? C.blueBorder : C.border}`, cursor: 'pointer',
        background: !selRoom ? C.blueBg : C.surface,
        color: !selRoom ? C.blue : C.text2, fontWeight: !selRoom ? 650 : 550,
        fontSize: FS.sm, whiteSpace: 'nowrap', fontFamily: 'inherit',
      }}>
        Tất cả ({patients.length})
      </button>
      {rooms.map(r => {
        const pts = patientsInRoom(patients, r);
        const attention = pts.filter(p => p.status === 'amber' || p.status === 'red').length;
        const active = selRoom === r;
        return (
          <button type="button" key={r} onClick={() => onSelect(r)} aria-pressed={active} title={attention ? `${attention} người bệnh cần xem` : undefined} style={{
            display: 'inline-flex', alignItems: 'center', gap: 6,
            minHeight: 36, padding: '0 12px', borderRadius: 5, border: `1px solid ${active ? C.blueBorder : C.border}`, cursor: 'pointer',
            background: active ? C.blueBg : C.surface,
            color: active ? C.blue : C.text, fontWeight: active ? 650 : 550,
            fontSize: FS.sm, whiteSpace: 'nowrap', fontFamily: 'inherit',
          }}>
            {r} <span style={{ color: active ? C.blue : C.text3, fontWeight: 500 }}>{pts.length}</span>
            {attention > 0 && <span style={{ width: 7, height: 7, borderRadius: 99, background: C.amber }} aria-label={`${attention} cần xem`} />}
          </button>
        );
      })}
    </div>
  );
}
