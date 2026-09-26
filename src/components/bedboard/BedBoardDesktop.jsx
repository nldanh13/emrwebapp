import { IconDeviceFloppy, IconHandClick, IconListSearch, IconPlus, IconReload, IconSearch, IconX } from '@tabler/icons-react';
import { C, FS } from '../../tokens.js';
import { Btn, Spinner } from '../shared.jsx';
import RoomCard from './RoomCard.jsx';
import { buildDefaultRooms, getPatientId, getPatientName, getWardMetaLine } from './bedBoardUtils.js';

const fieldStyle = {
  width: '100%', height: 34, background: C.surface, border: `1px solid ${C.border}`, borderRadius: 5,
  color: C.text, fontSize: FS.md, fontFamily: 'inherit',
};

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
  updatePatientNote,
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
  const total = patients.length;
  return (
    <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>

      {/* Trái: người bệnh chưa xếp phòng */}
      <aside aria-label="Người bệnh chưa xếp phòng" style={{ width: 260, borderRight: `1px solid ${C.border}`, display: 'flex', flexDirection: 'column', flexShrink: 0, background: C.surface }}>
        <div style={{ padding: 12, borderBottom: `1px solid ${C.border2}`, display: 'grid', gap: 8 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <h2 style={{ margin: 0, flex: 1, fontSize: FS.lg, fontWeight: 700, color: C.text }}>
              Chưa xếp phòng <span style={{ color: C.text3, fontWeight: 500 }}>{unassigned.length}</span>
            </h2>
            <button type="button" className="emr-icon-btn" onClick={loadData} disabled={loading} aria-label="Tải lại danh sách" title="Tải lại danh sách">
              <IconReload size={17} stroke={1.75} />
            </button>
          </div>
          <Btn variant="primary" icon={IconListSearch} loading={loading} onClick={handleScan} disabled={loading} style={{ width: '100%', minHeight: 34 }}>
            {loading ? 'Đang quét…' : 'Quét danh sách từ EMR'}
          </Btn>
          <label style={{ position: 'relative', display: 'block' }}>
            <IconSearch size={16} stroke={1.75} color={C.text3} style={{ position: 'absolute', left: 9, top: 9 }} aria-hidden="true" />
            <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Tìm tên hoặc mã người bệnh" aria-label="Tìm người bệnh" style={{ ...fieldStyle, padding: '0 10px 0 32px' }} />
          </label>
        </div>

        <div style={{ flex: 1, overflow: 'auto' }}>
          {loading && (
            <div style={{ padding: 12, color: C.text2, display: 'flex', gap: 6, alignItems: 'center', fontSize: FS.sm }}>
              <Spinner size={12} /> Đang tải…
            </div>
          )}
          {!loading && filtered.length === 0 && (
            <div style={{ padding: '24px 16px', fontSize: FS.sm, color: C.text2, textAlign: 'center', lineHeight: 1.5 }}>
              {total === 0 ? 'Chưa có danh sách. Bấm "Quét danh sách từ EMR".' : (search ? 'Không tìm thấy người bệnh phù hợp.' : 'Tất cả người bệnh đã được xếp phòng.')}
            </div>
          )}
          {filtered.map(p => {
            const id = getPatientId(p);
            const isSelected = selectedPxSet.has(id);
            const meta = getWardMetaLine(p);
            return (
              <label key={id} style={{
                display: 'flex', alignItems: 'flex-start', gap: 10, padding: '9px 12px', cursor: 'pointer',
                background: isSelected ? C.blueBg : 'transparent', borderBottom: `1px solid ${C.border2}`,
              }}>
                <input type="checkbox" checked={isSelected} onChange={() => toggleSelectPx(id)} style={{ width: 16, height: 16, margin: '2px 0 0', accentColor: C.blue, flexShrink: 0 }} />
                <span style={{ minWidth: 0, flex: 1 }}>
                  <span style={{ display: 'block', fontSize: FS.md, fontWeight: 600, color: C.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{getPatientName(p)}</span>
                  <span style={{ display: 'block', fontSize: FS.xs, color: C.text2, marginTop: 1, fontVariantNumeric: 'tabular-nums' }}>{id}</span>
                  {meta && <span title={meta} style={{ display: 'block', fontSize: FS.xs, color: C.text3, marginTop: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{meta}</span>}
                </span>
              </label>
            );
          })}
        </div>

        {unassigned.length > 0 && (
          <div style={{ padding: '8px 12px', borderTop: `1px solid ${C.border2}`, display: 'flex', gap: 6, alignItems: 'center' }}>
            <Btn onClick={selectAllUnassigned}>Chọn tất cả</Btn>
            {selCount > 0 && <Btn onClick={clearSelection}>Bỏ chọn</Btn>}
          </div>
        )}
      </aside>

      {/* Giữa: sơ đồ phòng */}
      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', padding: '10px 16px', borderBottom: `1px solid ${C.border2}`, background: selCount > 0 ? C.blueBg : C.surface }}>
          {selCount > 0 ? (
            <>
              <IconHandClick size={18} stroke={1.75} color={C.blue} aria-hidden="true" />
              <span style={{ flex: 1, fontSize: FS.md, color: C.blue, fontWeight: 600 }} role="status">
                Đang chọn {selCount} người bệnh — bấm "Xếp" ở phòng muốn xếp.
              </span>
              <Btn icon={IconX} onClick={clearSelection}>Bỏ chọn</Btn>
            </>
          ) : (
            <span style={{ flex: 1, fontSize: FS.md, color: C.text2 }}>
              <b style={{ color: C.text }}>{assigned.length}/{total}</b> người bệnh đã xếp phòng
              {unassigned.length > 0 && <> · <span style={{ color: C.amber, fontWeight: 600 }}>{unassigned.length} chưa xếp</span></>}
            </span>
          )}
          <Btn variant="solidPrimary" icon={IconDeviceFloppy} loading={saving} onClick={handleSaveOnly} disabled={saving}>
            {saving ? 'Đang lưu…' : 'Lưu xếp phòng'}
          </Btn>
        </div>

        <div style={{ flex: 1, overflow: 'auto', padding: 16 }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(190px, 1fr))', gap: 10, marginBottom: 14 }}>
            {Object.entries(roomConfig).sort(([a],[b]) => a.localeCompare(b)).map(([room, cap]) => (
              <RoomCard
                key={room}
                room={room}
                capacity={cap}
                patients={roomPatients(room)}
                selectedCount={selCount}
                onAssign={assignToRoom}
                onRemove={removeFromRoom}
                onUpdateNote={updatePatientNote}
                onClear={clearRoom}
                onDelete={deleteRoom}
                isDefault={buildDefaultRooms()[room] != null}
              />
            ))}
          </div>

          <form onSubmit={e => { e.preventDefault(); addRoom(); }} style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
            <input
              value={newRoom}
              onChange={e => setNewRoom(e.target.value)}
              placeholder="Tên phòng mới, vd P12"
              aria-label="Tên phòng mới"
              style={{ ...fieldStyle, width: 200, padding: '0 10px' }}
            />
            <Btn type="submit" icon={IconPlus}>Thêm phòng</Btn>
          </form>
        </div>
      </div>
    </div>
  );
}
