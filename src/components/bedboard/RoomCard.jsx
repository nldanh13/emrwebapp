import { C } from '../../tokens.js';
import { getPatientId, getPatientName, getWardMetaLine } from './bedBoardUtils.js';

export default function RoomCard({ room, capacity, patients, selectedCount, onAssign, onRemove, onClear, onDelete, isDefault }) {
  const isFull = patients.length >= capacity;
  return (
    <div style={{
      background: C.surface,
      border: `1px solid ${selectedCount > 0 ? C.blueBorder : C.border}`,
      borderRadius: 6, overflow: 'hidden', minWidth: 0,
    }}>
      <div style={{
        padding: '6px 10px', display: 'flex', justifyContent: 'space-between',
        alignItems: 'center', borderBottom: `1px solid ${C.border2}`,
        background: C.surface2,
      }}>
        <span style={{ fontWeight: 600, fontSize: 12, color: C.text }}>{room}</span>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{
            fontSize: 10, fontVariantNumeric: 'tabular-nums',
            color: isFull ? C.red : C.text2,
          }}>{patients.length}/{capacity}</span>
          {!isDefault && (
            <button type="button" onClick={() => onDelete(room)} style={{
              background: 'none', border: 'none', cursor: 'pointer',
              color: C.text3, fontSize: 11, padding: 0, lineHeight: 1,
            }}>✕</button>
          )}
        </div>
      </div>

      {selectedCount > 0 && !isFull && (
        <button type="button" onClick={() => onAssign(room)} style={{
          width: '100%', padding: '5px', background: C.blueBg,
          border: 'none', borderBottom: `1px solid ${C.border2}`,
          cursor: 'pointer', fontSize: 11, color: C.blue, fontFamily: 'inherit',
        }}>
          + Xếp {selectedCount > 1 ? `${selectedCount} BN` : ''} vào đây
        </button>
      )}

      {/* Patients in room */}
      <div style={{ padding: '5px 8px', minHeight: 32 }}>
        {patients.length === 0 && (
          <div style={{ fontSize: 10, color: C.text3, padding: '4px 0' }}>Trống</div>
        )}
        {patients.map(p => {
          const id = getPatientId(p);
          return (
            <div key={id} style={{
              display: 'flex', justifyContent: 'space-between', alignItems: 'center',
              padding: '2px 0', borderBottom: `1px solid ${C.border2}`,
            }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 11, color: C.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {getPatientName(p)}
                </div>
                {getWardMetaLine(p) && (
                  <div style={{ fontSize: 9, color: C.text3, marginTop: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {getWardMetaLine(p)}
                  </div>
                )}
              </div>
              <button type="button" onClick={() => onRemove(id)} style={{
                background: 'none', border: 'none', cursor: 'pointer',
                color: C.text3, fontSize: 10, padding: '0 2px', flexShrink: 0,
              }}>✕</button>
            </div>
          );
        })}
      </div>

      {patients.length > 0 && (
        <button type="button" onClick={() => onClear(room)} style={{
          width: '100%', padding: '4px', background: 'transparent',
          border: 'none', borderTop: `1px solid ${C.border2}`,
          cursor: 'pointer', fontSize: 10, color: C.text3, fontFamily: 'inherit',
        }}>Làm trống</button>
      )}
    </div>
  );
}
