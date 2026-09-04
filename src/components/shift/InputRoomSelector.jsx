import { useState } from 'react';
import { C } from '../../tokens.js';
import { Btn } from '../shared.jsx';

function roomSummary(selectedRooms, rooms) {
  if (!selectedRooms?.length) return 'Chưa chọn phòng';
  if (selectedRooms.length === rooms.length) return `Tất cả ${rooms.length} phòng`;
  if (selectedRooms.length <= 4) return selectedRooms.join(', ');
  return `${selectedRooms.slice(0, 4).join(', ')} +${selectedRooms.length - 4} phòng`;
}

export default function InputRoomSelector({
  rooms = [],
  selectedRooms = [],
  patientCounts = {},
  selectedPatientCount = 0,
  currentRoom = null,
  onToggleRoom,
  onSelectAll,
  onSelectOnlyCurrent,
  onClear,
  compact = false,
  inputMode = 'rooms',
  onSetInputMode,
  manualPatientCount = 0,
  excludedPatientCount = 0,
  onClearPatientScope,
}) {
  const [open, setOpen] = useState(false);
  const selectedSet = new Set(selectedRooms || []);
  const hasRooms = Array.isArray(rooms) && rooms.length > 0;
  if (!hasRooms) return null;

  const isManual = inputMode === 'manual';
  const currentRoomSelected = currentRoom && selectedSet.has(currentRoom);
  const summary = isManual ? `${manualPatientCount} BN chọn tay` : roomSummary(selectedRooms, rooms);
  const summaryColor = selectedPatientCount ? C.green : C.red;

  return (
    <div style={{
      background: selectedPatientCount ? C.greenBg : C.redBg,
      border: `1px solid ${selectedPatientCount ? C.greenBorder : C.redBorder}`,
      borderRadius: 8,
      padding: compact ? 8 : 10,
      marginBottom: compact ? 0 : 12,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <Btn
          variant={open ? 'success' : 'solidSuccess'}
          onClick={() => setOpen(v => !v)}
          style={{ padding: compact ? '5px 9px' : '6px 11px', fontSize: compact ? 11 : 12 }}
        >
          ☑ Phạm vi nhập
        </Btn>
        <div style={{ flex: '1 1 150px', minWidth: 120 }}>
          <div style={{ fontSize: 11, fontWeight: 800, color: C.text }}>
            Sẽ nhập: <span style={{ color: summaryColor }}>{summary}</span>
          </div>
          <div style={{ fontSize: 11, color: C.text2, marginTop: 2 }}>
            {isManual
              ? `${selectedPatientCount} BN được đưa vào nút “nhập tất cả”`
              : `${selectedRooms.length}/${rooms.length} phòng · ${selectedPatientCount} BN · loại trừ ${excludedPatientCount}`}
          </div>
        </div>
        {currentRoom && !isManual && (
          <Btn
            variant={currentRoomSelected && selectedRooms.length === 1 ? 'success' : 'default'}
            onClick={() => onSelectOnlyCurrent?.(currentRoom)}
            style={{ padding: '4px 8px', fontSize: 10 }}
          >
            Chỉ phòng {currentRoom}
          </Btn>
        )}
      </div>

      {open && (
        <>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 9 }}>
            <Btn variant={isManual ? 'default' : 'success'} onClick={() => onSetInputMode?.('rooms')} style={{ padding: '3px 8px', fontSize: 10 }}>Theo phòng</Btn>
            <Btn variant={isManual ? 'success' : 'default'} onClick={() => onSetInputMode?.('manual')} style={{ padding: '3px 8px', fontSize: 10 }}>Chọn từng BN</Btn>
            <Btn variant="default" onClick={onClearPatientScope} style={{ padding: '3px 8px', fontSize: 10 }}>Xoá chọn/loại trừ BN</Btn>
          </div>

          {!isManual && (
            <>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 8, marginBottom: 8 }}>
                <Btn variant="default" onClick={onSelectAll} style={{ padding: '3px 8px', fontSize: 10 }}>Chọn hết phòng</Btn>
                <Btn variant="default" onClick={onClear} style={{ padding: '3px 8px', fontSize: 10 }}>Bỏ hết phòng</Btn>
              </div>

              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                {rooms.map(room => {
                  const active = selectedSet.has(room);
                  const count = patientCounts?.[room] || 0;
                  return (
                    <button
                      type="button"
                      key={room}
                      onClick={() => onToggleRoom?.(room)}
                      style={{
                        display: 'inline-flex', alignItems: 'center', gap: 5,
                        padding: '5px 9px', borderRadius: 4, border: '1px solid',
                        borderColor: active ? C.greenBorder : C.border,
                        background: active ? C.greenBg : C.surface,
                        color: active ? C.green : C.text2,
                        cursor: 'pointer', fontSize: 11, fontFamily: 'inherit', fontWeight: 700,
                      }}
                      title={active ? `Sẽ nhập các ca phòng ${room}` : `Không nhập hàng loạt phòng ${room}`}
                    >
                      <span style={{
                        width: 12, height: 12, borderRadius: 3, border: '1px solid',
                        borderColor: active ? C.green : C.border,
                        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                        fontSize: 9, lineHeight: '12px', color: active ? C.green : C.text3,
                      }}>{active ? '✓' : ''}</span>
                      <span>{room}</span>
                      <span style={{ color: active ? C.green : C.text3 }}>({count})</span>
                    </button>
                  );
                })}
              </div>
            </>
          )}
        </>
      )}

      {!selectedPatientCount && (
        <div style={{ marginTop: 8, fontSize: 11, color: C.red }}>
          Chưa có BN nào trong phạm vi nhập nên các nút “nhập tất cả” sẽ bị khóa.
        </div>
      )}
      <div style={{ marginTop: 8, fontSize: 11, color: C.text2 }}>
        Theo phòng: chọn phòng rồi bấm nút trên từng BN để loại trừ ca không nhập. Chọn từng BN: chỉ các BN đã đánh dấu mới được nhập.
      </div>
    </div>
  );
}
