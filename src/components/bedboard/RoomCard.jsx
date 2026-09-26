import { IconArrowBarToDown, IconTrash, IconX } from '@tabler/icons-react';
import { C, FS } from '../../tokens.js';
import { getPatientId, getPatientName, getWardMetaLine, roomPriceTier, formatVND } from './bedBoardUtils.js';
import PatientRoomNotes from './PatientRoomNotes.jsx';

export default function RoomCard({ room, capacity, patients, selectedCount, onAssign, onRemove, onClear, onDelete, onUpdateNote, isDefault }) {
  const isFull = patients.length >= capacity;
  const canAssign = selectedCount > 0 && !isFull;
  return (
    <section aria-label={`Phòng ${room}`} style={{
      background: C.surface,
      border: `1px solid ${canAssign ? C.blueBorder : C.border}`,
      borderRadius: 7, overflow: 'hidden', minWidth: 0, display: 'flex', flexDirection: 'column',
    }}>
      <header style={{
        padding: '8px 8px 8px 12px', display: 'flex', justifyContent: 'space-between', gap: 8,
        alignItems: 'center', borderBottom: `1px solid ${C.border2}`, background: C.surface2,
      }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontWeight: 700, fontSize: 14, color: C.text }}>{room}</div>
          <div style={{ fontSize: FS.xs, color: C.text2, fontVariantNumeric: 'tabular-nums' }}>{formatVND(roomPriceTier(room))}/giường</div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          <span style={{ fontSize: FS.sm, fontWeight: 650, fontVariantNumeric: 'tabular-nums', color: isFull ? C.red : C.text2 }}>
            {patients.length}/{capacity}{isFull ? ' · Đầy' : ''}
          </span>
          {!isDefault && (
            <button type="button" className="emr-icon-btn" style={{ width: 28, height: 28 }} onClick={() => onDelete(room)} aria-label={`Xoá phòng ${room}`} title="Xoá phòng">
              <IconTrash size={15} stroke={1.75} />
            </button>
          )}
        </div>
      </header>

      {canAssign && (
        <button type="button" onClick={() => onAssign(room)} style={{
          display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
          width: '100%', minHeight: 34, background: C.blue, color: '#fff',
          border: 'none', cursor: 'pointer', fontSize: FS.sm, fontWeight: 650, fontFamily: 'inherit',
        }}>
          <IconArrowBarToDown size={15} stroke={2} aria-hidden="true" />
          Xếp {selectedCount > 1 ? `${selectedCount} người bệnh` : 'vào đây'}
        </button>
      )}

      <div style={{ padding: '4px 12px', flex: 1 }}>
        {patients.length === 0 && (
          <div style={{ fontSize: FS.sm, color: C.text3, padding: '8px 0' }}>Phòng trống</div>
        )}
        {patients.map((p, i) => {
          const id = getPatientId(p);
          const meta = getWardMetaLine(p);
          return (
            <div key={id} style={{ padding: '7px 0', borderTop: i > 0 ? `1px solid ${C.border2}` : 'none' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 4 }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: FS.md, fontWeight: 600, color: C.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {getPatientName(p)}
                  </div>
                  {meta && (
                    <div title={meta} style={{ fontSize: FS.xs, color: C.text3, marginTop: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {meta}
                    </div>
                  )}
                </div>
                <button type="button" className="emr-icon-btn" style={{ width: 28, height: 28, flexShrink: 0 }} onClick={() => onRemove(id)} aria-label={`Bỏ ${getPatientName(p)} khỏi phòng ${room}`} title="Bỏ khỏi phòng">
                  <IconX size={15} stroke={1.75} />
                </button>
              </div>
              {onUpdateNote && (
                <PatientRoomNotes patient={p} onChange={(field, value) => onUpdateNote(id, field, value)} compact />
              )}
            </div>
          );
        })}
      </div>

      {patients.length > 0 && (
        <button type="button" onClick={() => onClear(room)} style={{
          width: '100%', minHeight: 30, background: 'transparent',
          border: 'none', borderTop: `1px solid ${C.border2}`,
          cursor: 'pointer', fontSize: FS.xs, color: C.text2, fontFamily: 'inherit',
        }}>Làm trống phòng</button>
      )}
    </section>
  );
}
