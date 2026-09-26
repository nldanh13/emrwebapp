import { useState } from 'react';
import { IconAlertTriangle, IconChevronDown, IconChevronUp, IconUsers } from '@tabler/icons-react';
import { C, FS } from '../../tokens.js';
import { Btn, Segmented } from '../shared.jsx';

function roomSummary(selectedRooms, rooms) {
  if (!selectedRooms?.length) return 'chưa chọn phòng nào';
  if (selectedRooms.length === rooms.length) return `tất cả ${rooms.length} phòng`;
  if (selectedRooms.length <= 4) return `phòng ${selectedRooms.join(', ')}`;
  return `phòng ${selectedRooms.slice(0, 4).join(', ')} +${selectedRooms.length - 4}`;
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
  const empty = !selectedPatientCount;
  const scopeText = isManual
    ? `${manualPatientCount} người bệnh chọn tay`
    : `${roomSummary(selectedRooms, rooms)}${excludedPatientCount ? `, loại ${excludedPatientCount} người bệnh` : ''}`;

  return (
    <section aria-label="Phạm vi nhập hàng loạt" style={{
      border: `1px solid ${empty ? C.redBorder : C.border}`, background: empty ? C.redBg : C.surface,
      borderRadius: 7, padding: compact ? '8px 10px' : '10px 12px', marginBottom: compact ? 0 : 14,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        {empty
          ? <IconAlertTriangle size={18} stroke={1.9} color={C.red} aria-hidden="true" />
          : <IconUsers size={18} stroke={1.75} color={C.text2} aria-hidden="true" />}
        <div style={{ flex: '1 1 180px', minWidth: 0 }}>
          <div style={{ fontSize: FS.md, fontWeight: 650, color: empty ? C.red : C.text }}>
            {empty ? 'Chưa có người bệnh nào để nhập hàng loạt' : `Sẽ nhập ${selectedPatientCount} người bệnh`}
          </div>
          <div style={{ fontSize: FS.xs, color: C.text2, marginTop: 1 }}>{scopeText}</div>
        </div>
        {currentRoom && !isManual && !(currentRoomSelected && selectedRooms.length === 1) && (
          <Btn onClick={() => onSelectOnlyCurrent?.(currentRoom)}>Chỉ phòng {currentRoom}</Btn>
        )}
        <Btn icon={open ? IconChevronUp : IconChevronDown} onClick={() => setOpen(v => !v)} aria-expanded={open}>
          Đổi phạm vi
        </Btn>
      </div>

      {open && (
        <div style={{ marginTop: 10, paddingTop: 10, borderTop: `1px solid ${empty ? C.redBorder : C.border2}`, display: 'grid', gap: 10 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <Segmented
              label="Cách chọn phạm vi"
              value={isManual ? 'manual' : 'rooms'}
              onChange={onSetInputMode}
              options={[{ value: 'rooms', label: 'Theo phòng' }, { value: 'manual', label: 'Chọn từng người bệnh' }]}
            />
            {(manualPatientCount > 0 || excludedPatientCount > 0) && (
              <Btn onClick={onClearPatientScope}>Xoá đánh dấu người bệnh</Btn>
            )}
          </div>
          <div style={{ fontSize: FS.xs, color: C.text2, lineHeight: 1.45 }}>
            {isManual
              ? 'Chỉ những người bệnh được tích ô trong danh sách mới được nhập.'
              : 'Nhập mọi người bệnh trong các phòng đã chọn; bỏ tích ô trên thẻ để loại riêng từng người.'}
          </div>

          {!isManual && (
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
              {rooms.map(room => {
                const active = selectedSet.has(room);
                const count = patientCounts?.[room] || 0;
                return (
                  <label key={room} style={{
                    display: 'inline-flex', alignItems: 'center', gap: 6, height: 30, padding: '0 10px', borderRadius: 5, cursor: 'pointer',
                    border: `1px solid ${active ? C.blueBorder : C.border}`, background: active ? C.blueBg : C.surface,
                    color: active ? C.blue : C.text2, fontSize: FS.sm, fontWeight: 600,
                  }}>
                    <input type="checkbox" checked={active} onChange={() => onToggleRoom?.(room)} style={{ margin: 0, accentColor: C.blue }} />
                    {room}
                    <span style={{ color: active ? C.blue : C.text3, fontWeight: 500 }}>{count}</span>
                  </label>
                );
              })}
              <Btn variant="default" onClick={onSelectAll} style={{ height: 30 }}>Chọn hết</Btn>
              <Btn variant="default" onClick={onClear} style={{ height: 30 }}>Bỏ hết</Btn>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
