import { IconArrowBarToDown, IconDeviceFloppy, IconListSearch, IconReload, IconSearch, IconX } from '@tabler/icons-react';
import { C, FS } from '../../tokens.js';
import { Btn, Spinner } from '../shared.jsx';
import { getPatientId, getPatientName, getWardMetaLine, roomPriceTier, formatVND } from './bedBoardUtils.js';
import PatientRoomNotes from './PatientRoomNotes.jsx';

export default function BedBoardMobile({
  rooms,
  roomConfig,
  roomPatients,
  inspectRoom,
  setInspectRoom,
  selCount,
  assignToRoom,
  clearSelection,
  removeFromRoom,
  updatePatientNote,
  selectedPxSet,
  toggleSelectPx,
  loading,
  handleScan,
  loadData,
  search,
  setSearch,
  unassigned,
  assigned,
  filtered,
  saving,
  handleSaveOnly,
  selectAllUnassigned,
}) {
  const inspecting = inspectRoom ? { room: inspectRoom, pts: roomPatients(inspectRoom), cap: roomConfig[inspectRoom] || 0 } : null;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1 }}>

      {/* Quét + tìm */}
      <div style={{ padding: 12, borderBottom: `1px solid ${C.border}`, background: C.surface, display: 'grid', gap: 8 }}>
        <div style={{ display: 'flex', gap: 6 }}>
          <Btn variant="primary" icon={IconListSearch} loading={loading} onClick={handleScan} disabled={loading} style={{ flex: 1, minHeight: 40 }}>
            {loading ? 'Đang quét…' : 'Quét danh sách từ EMR'}
          </Btn>
          <button type="button" className="emr-icon-btn" onClick={loadData} disabled={loading} aria-label="Tải lại danh sách" style={{ border: `1px solid ${C.border}` }}>
            <IconReload size={18} stroke={1.75} />
          </button>
        </div>
        <label style={{ position: 'relative', display: 'block' }}>
          <IconSearch size={17} stroke={1.75} color={C.text3} style={{ position: 'absolute', left: 10, top: 11 }} aria-hidden="true" />
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Tìm tên hoặc mã người bệnh" aria-label="Tìm người bệnh"
            style={{ width: '100%', height: 40, background: C.surface, border: `1px solid ${C.border}`, borderRadius: 5, padding: '0 10px 0 34px', color: C.text, fontSize: 14, fontFamily: 'inherit' }} />
        </label>
        <div style={{ fontSize: FS.sm, color: C.text2 }} role="status">
          {selCount > 0
            ? <b style={{ color: C.blue }}>Đang chọn {selCount} người bệnh — bấm phòng để xếp</b>
            : <><b style={{ color: C.text }}>{assigned.length}</b> đã xếp · <span style={{ color: unassigned.length ? C.amber : C.text2, fontWeight: unassigned.length ? 600 : 400 }}>{unassigned.length} chưa xếp</span></>}
        </div>
      </div>

      {/* Phòng */}
      <div style={{ padding: 12, borderBottom: `1px solid ${C.border2}`, background: C.surface }}>
        <div style={{ fontSize: FS.sm, color: C.text2, marginBottom: 8 }}>
          {selCount > 0 ? 'Chọn phòng để xếp:' : 'Bấm phòng để xem và chỉnh:'}
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(104px, 1fr))', gap: 6 }}>
          {rooms.map(([room, cap]) => {
            const pts = roomPatients(room);
            const full = pts.length >= cap;
            const isInspecting = inspectRoom === room;
            const assignable = selCount > 0 && !full;
            return (
              <button type="button" key={room} aria-pressed={isInspecting} disabled={selCount > 0 && full} onClick={() => {
                if (assignable) { assignToRoom(room); setInspectRoom(null); }
                else setInspectRoom(isInspecting ? null : room);
              }} style={{
                display: 'grid', gap: 1, textAlign: 'left', minHeight: 48, padding: '6px 10px', borderRadius: 6,
                border: `1px solid ${isInspecting || assignable ? C.blueBorder : C.border}`,
                background: isInspecting ? C.blueBg : C.surface,
                color: C.text, cursor: selCount > 0 && full ? 'not-allowed' : 'pointer', fontFamily: 'inherit',
                opacity: selCount > 0 && full ? 0.55 : 1,
              }}>
                <span style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 4 }}>
                  <b style={{ fontSize: 14, color: isInspecting ? C.blue : C.text }}>{room}</b>
                  <span style={{ fontSize: FS.xs, fontWeight: 650, color: full ? C.red : C.text2, fontVariantNumeric: 'tabular-nums' }}>{pts.length}/{cap}{full ? ' Đầy' : ''}</span>
                </span>
                <span style={{ fontSize: FS.xs, color: C.text3 }}>{formatVND(roomPriceTier(room))}</span>
              </button>
            );
          })}
        </div>
        {selCount > 0 && <Btn icon={IconX} onClick={clearSelection} style={{ marginTop: 8, minHeight: 36 }}>Bỏ chọn</Btn>}

        {inspecting && (
          <div style={{ marginTop: 12, padding: 12, borderRadius: 7, background: C.surface, border: `1px solid ${C.blueBorder}` }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
              <b style={{ fontSize: 14, color: C.text }}>Phòng {inspecting.room} · {inspecting.pts.length}/{inspecting.cap}</b>
              <button type="button" className="emr-icon-btn" onClick={() => setInspectRoom(null)} aria-label="Đóng phòng"><IconX size={18} stroke={1.75} /></button>
            </div>
            {inspecting.pts.length === 0 && <div style={{ fontSize: FS.sm, color: C.text2 }}>Phòng trống</div>}
            {inspecting.pts.map(p => {
              const id = getPatientId(p);
              const meta = getWardMetaLine(p);
              return (
                <div key={id} style={{ padding: '8px 0', borderTop: `1px solid ${C.border2}` }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 14, fontWeight: 600, color: C.text }}>{getPatientName(p)}</div>
                      <div style={{ fontSize: FS.xs, color: C.text2, fontVariantNumeric: 'tabular-nums' }}>{id}</div>
                      {meta && <div style={{ fontSize: FS.xs, color: C.text3, marginTop: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{meta}</div>}
                    </div>
                    <Btn variant="danger" onClick={() => removeFromRoom(id)} style={{ minHeight: 36 }}>Bỏ khỏi phòng</Btn>
                  </div>
                  {updatePatientNote && (
                    <PatientRoomNotes patient={p} onChange={(field, value) => updatePatientNote(id, field, value)} />
                  )}
                </div>
              );
            })}
            {selCount > 0 && inspecting.pts.length < inspecting.cap && (
              <Btn variant="solidPrimary" icon={IconArrowBarToDown} onClick={() => assignToRoom(inspecting.room)} style={{ width: '100%', marginTop: 8, minHeight: 40 }}>
                Xếp {selCount} người bệnh vào {inspecting.room}
              </Btn>
            )}
          </div>
        )}
      </div>

      {/* Người bệnh chưa xếp */}
      <div style={{ background: C.bg }}>
        {loading && (
          <div style={{ padding: 16, color: C.text2, display: 'flex', gap: 8, alignItems: 'center', fontSize: FS.sm }}>
            <Spinner size={13} /> Đang tải…
          </div>
        )}
        {!loading && filtered.length === 0 && (
          <div style={{ padding: 24, textAlign: 'center', fontSize: FS.md, color: C.text2 }}>
            {unassigned.length === 0 && assigned.length === 0 ? 'Chưa có danh sách. Bấm "Quét danh sách từ EMR".' : (search ? 'Không tìm thấy người bệnh phù hợp.' : 'Tất cả người bệnh đã được xếp phòng.')}
          </div>
        )}
        {!loading && unassigned.length > 0 && (
          <div style={{ padding: '8px 12px', display: 'flex', gap: 8, alignItems: 'center', borderBottom: `1px solid ${C.border2}`, background: C.surface }}>
            <b style={{ flex: 1, fontSize: FS.md, color: C.text }}>Chưa xếp phòng</b>
            <Btn onClick={selectAllUnassigned} style={{ minHeight: 36 }}>Chọn tất cả ({unassigned.length})</Btn>
          </div>
        )}
        {filtered.map(p => {
          const id = getPatientId(p);
          const isSelected = selectedPxSet.has(id);
          const meta = getWardMetaLine(p);
          return (
            <label key={id} style={{
              display: 'flex', alignItems: 'flex-start', gap: 12, padding: '12px 14px', cursor: 'pointer',
              borderBottom: `1px solid ${C.border2}`, background: isSelected ? C.blueBg : C.surface,
            }}>
              <input type="checkbox" checked={isSelected} onChange={() => toggleSelectPx(id)} style={{ width: 20, height: 20, margin: '1px 0 0', accentColor: C.blue, flexShrink: 0 }} />
              <span style={{ flex: 1, minWidth: 0 }}>
                <span style={{ display: 'block', fontSize: 14, color: C.text, fontWeight: 600 }}>{getPatientName(p)}</span>
                <span style={{ display: 'block', fontSize: FS.xs, color: C.text2, marginTop: 2, fontVariantNumeric: 'tabular-nums' }}>{id}</span>
                {meta && <span style={{ display: 'block', fontSize: FS.xs, color: C.text3, marginTop: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{meta}</span>}
              </span>
            </label>
          );
        })}
      </div>

      {/* Lưu — dính đáy vùng nội dung, phía trên thanh điều hướng dưới */}
      <div style={{ position: 'sticky', bottom: 0, padding: '10px 12px', borderTop: `1px solid ${C.border}`, background: C.surface }}>
        <Btn variant="solidPrimary" icon={IconDeviceFloppy} loading={saving} onClick={handleSaveOnly} disabled={saving} style={{ width: '100%', minHeight: 42, fontSize: 14 }}>
          {saving ? 'Đang lưu…' : 'Lưu xếp phòng'}
        </Btn>
      </div>
    </div>
  );
}
