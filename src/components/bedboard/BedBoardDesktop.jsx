import { C } from '../../tokens.js';
import { Btn, Spinner } from '../shared.jsx';
import RoomCard from './RoomCard.jsx';
import { buildDefaultRooms, getPatientId, getPatientName, getWardMetaLine } from './bedBoardUtils.js';

export default function BedBoardDesktop({
  roomConfig,
  roomPatients,
  selectedPxSet,
  toggleSelectPx,
  selectAllUnassigned,
  clearSelection,
  selCount,
  assignToRoom,
  removeFromRoom,
  clearRoom,
  deleteRoom,
  loading,
  handleScan,
  loadData,
  search,
  setSearch,
  unassigned,
  assigned,
  filtered,
  patients,
  newRoom,
  setNewRoom,
  addRoom,
  saving,
  handleSaveOnly,
}) {
  return (
    <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>

      {/* ── Left: Unassigned list ── */}
      <div style={{ width: 210, borderRight: `1px solid ${C.border}`, display: 'flex', flexDirection: 'column', flexShrink: 0 }}>
        <div style={{ padding: '8px 10px', borderBottom: `1px solid ${C.border2}` }}>
          <div style={{ fontSize: 10, fontWeight: 600, letterSpacing: '0.07em', color: C.text3, marginBottom: 6 }}>
            Chưa xếp phòng ({unassigned.length})
          </div>
          <div style={{ display: 'flex', gap: 5, marginBottom: 6 }}>
            <Btn variant="primary" onClick={handleScan} disabled={loading}
              style={{ flex: 1, justifyContent: 'center', fontSize: 11, padding: '4px 6px' }}>
              {loading ? <><Spinner size={9} /> Đang quét...</> : '⟳ Quét BN'}
            </Btn>
            <Btn variant="default" onClick={loadData} disabled={loading}
              style={{ padding: '4px 8px', fontSize: 11 }}>
              ↺
            </Btn>
          </div>
          <input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Tìm bệnh nhân..."
            style={{
              width: '100%', background: C.surface2, border: `1px solid ${C.border}`,
              borderRadius: 4, padding: '4px 8px', color: C.text,
              fontSize: 11, fontFamily: 'inherit', outline: 'none',
            }}
          />
        </div>

        <div style={{ flex: 1, overflow: 'auto' }}>
          {loading && (
            <div style={{ padding: 12, color: C.text2, display: 'flex', gap: 6, alignItems: 'center' }}>
              <Spinner size={11} /> Đang tải...
            </div>
          )}
          {!loading && filtered.length === 0 && (
            <div style={{ padding: 12, fontSize: 11, color: C.text3, textAlign: 'center' }}>
              {patients.length === 0 ? 'Chưa có dữ liệu\nHãy Quét BN trước' : 'Tất cả đã xếp phòng'}
            </div>
          )}
          {filtered.map(p => {
            const id = getPatientId(p);
            const isSelected = selectedPxSet.has(id);
            return (
              <div
                key={id}
                onClick={() => toggleSelectPx(id)}
                style={{
                  padding: '7px 10px', cursor: 'pointer',
                  background: isSelected ? C.blueBg : 'transparent',
                  borderBottom: `1px solid ${C.border2}`,
                  borderLeft: `2px solid ${isSelected ? C.blue : 'transparent'}`,
                  display: 'flex', alignItems: 'center', gap: 7,
                  transition: 'background 0.1s',
                }}
              >
                <div style={{
                  width: 14, height: 14, borderRadius: 3, flexShrink: 0,
                  border: `1.5px solid ${isSelected ? C.blue : C.border}`,
                  background: isSelected ? C.blue : 'transparent',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                }}>
                  {isSelected && <span style={{ color: '#fff', fontSize: 9, lineHeight: 1 }}>✓</span>}
                </div>
                <div>
                  <div style={{ fontSize: 12, color: C.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {getPatientName(p)}
                  </div>
                  <div style={{ fontSize: 10, color: C.text2, marginTop: 1, fontVariantNumeric: 'tabular-nums' }}>
                    {id}
                  </div>
                  {getWardMetaLine(p) && (
                    <div style={{ fontSize: 10, color: C.text3, marginTop: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {getWardMetaLine(p)}
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>

        {/* Status bar */}
        <div style={{ padding: '7px 10px', borderTop: `1px solid ${C.border}`, fontSize: 10, color: C.text2, background: C.surface }}>
          <div>{assigned.length}/{patients.length} đã xếp phòng</div>
          {selCount > 0 && <div style={{ color: C.blue, marginTop: 2 }}>✔ Đang chọn {selCount} BN → chọn phòng</div>}
        </div>

        {/* Select all / clear */}
        {unassigned.length > 0 && (
          <div style={{ padding: '5px 8px', borderTop: `1px solid ${C.border2}`, display: 'flex', gap: 4, flexWrap: 'wrap' }}>
            <button type="button" onClick={selectAllUnassigned} style={{
              fontSize: 10, background: 'none', border: `1px solid ${C.border}`, borderRadius: 3,
              padding: '2px 6px', cursor: 'pointer', color: C.text2, fontFamily: 'inherit',
            }}>Chọn tất cả</button>
            {selCount > 0 && (
              <button type="button" onClick={clearSelection} style={{
                fontSize: 10, background: 'none', border: `1px solid ${C.border}`, borderRadius: 3,
                padding: '2px 6px', cursor: 'pointer', color: C.text3, fontFamily: 'inherit',
              }}>Bỏ chọn</button>
            )}
          </div>
        )}
      </div>

      {/* ── Center: Room grid ── */}
      <div style={{ flex: 1, overflow: 'auto', padding: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 10, fontWeight: 600, letterSpacing: '0.07em', color: C.text3 }}>
            Sơ đồ phòng
          </span>
          <span style={{ fontSize: 10, color: C.text3 }}>
            Chọn BN bên trái rồi chọn phòng.
          </span>
        </div>
        {/* Room cards grid */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))', gap: 8, marginBottom: 12 }}>
          {Object.entries(roomConfig).sort(([a],[b]) => a.localeCompare(b)).map(([room, cap]) => {
            const pts = roomPatients(room);
            const isDefault = buildDefaultRooms()[room] != null;
            return (
              <RoomCard
                key={room}
                room={room}
                capacity={cap}
                patients={pts}
                selectedCount={selCount}
                onAssign={assignToRoom}
                onRemove={removeFromRoom}
                onClear={clearRoom}
                onDelete={deleteRoom}
                isDefault={isDefault}
              />
            );
          })}
        </div>

        {/* Add room */}
        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <input
            value={newRoom}
            onChange={e => setNewRoom(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && addRoom()}
            placeholder="Thêm phòng (P12...)"
            style={{
              background: C.surface, border: `1px solid ${C.border}`,
              borderRadius: 4, padding: '4px 8px', color: C.text,
              fontSize: 11, fontFamily: 'inherit', outline: 'none', width: 140,
            }}
          />
          <Btn variant="default" onClick={addRoom}>+ Thêm phòng</Btn>
        </div>
      </div>

      {/* ── Right: Actions panel ── */}
      <div style={{ width: 150, borderLeft: `1px solid ${C.border}`, padding: 12, display: 'flex', flexDirection: 'column', gap: 8, flexShrink: 0 }}>
        <div style={{ fontSize: 10, fontWeight: 600, letterSpacing: '0.07em', color: C.text3, marginBottom: 4 }}>
          Hành động
        </div>

        <Btn
          variant="default"
          onClick={handleSaveOnly}
          disabled={saving}
          style={{ width: '100%', justifyContent: 'center' }}
        >
          {saving ? <><Spinner size={10} /> Đang lưu...</> : 'Lưu xếp phòng'}
        </Btn>

        <div style={{ height: 1, background: C.border2, margin: '4px 0' }} />

        <div style={{ fontSize: 10, color: C.text3 }}>
          <div>{assigned.length} BN đã xếp phòng</div>
          <div>{unassigned.length} BN chưa xếp</div>
        </div>
      </div>
    </div>
  );
}
