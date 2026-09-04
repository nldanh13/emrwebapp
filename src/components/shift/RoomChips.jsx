import { C } from '../../tokens.js';
import { patientsInRoom } from './shiftUtils.js';

export default function RoomChips({ rooms, patients, selRoom, onSelect }) {
  return (
    <div className="room-chips" style={{
      display: 'flex', gap: 6, padding: '8px 12px',
      overflowX: 'auto', borderBottom: `1px solid ${C.border2}`,
      scrollbarWidth: 'none', WebkitOverflowScrolling: 'touch', flexShrink: 0,
    }}>
      <style>{`.room-chips::-webkit-scrollbar{display:none}`}</style>
      <button type="button" onClick={() => onSelect(null)} style={{
        padding: '5px 10px', borderRadius: 5, border: `1px solid ${C.border2}`, cursor: 'pointer',
        background: !selRoom ? C.blueBg : C.surface,
        color: !selRoom ? C.blue : C.text2,
        fontSize: 12, whiteSpace: 'nowrap', fontFamily: 'inherit',
      }}>
        Tất cả ({patients.length})
      </button>
      {rooms.map(r => {
        const pts = patientsInRoom(patients, r);
        const hasAlert = pts.some(p => p.status === 'amber' || p.status === 'red');
        return (
          <button type="button" key={r} onClick={() => onSelect(r)} style={{
            padding: '5px 10px', borderRadius: 5, border: `1px solid ${C.border2}`, cursor: 'pointer',
            background: selRoom === r ? C.blueBg : C.surface,
            color: selRoom === r ? C.blue : (hasAlert ? C.amber : C.text2),
            fontSize: 12, whiteSpace: 'nowrap', fontFamily: 'inherit',
            fontWeight: hasAlert ? 600 : 400,
          }}>
            {r} ({pts.length})
          </button>
        );
      })}
    </div>
  );
}
