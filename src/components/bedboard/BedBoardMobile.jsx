import { C } from '../../tokens.js';
import { Btn, Spinner } from '../shared.jsx';
import { getPatientId, getPatientName, getWardMetaLine } from './bedBoardUtils.js';

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
  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, overflow: 'hidden' }}>

      {/* ── Sticky top: scan + search ── */}
      <div style={{ padding: '8px 12px', borderBottom: `1px solid ${C.border}`, background: C.surface, flexShrink: 0 }}>
        <div style={{ display: 'flex', gap: 6, marginBottom: 8 }}>
          <Btn variant="primary" onClick={handleScan} disabled={loading}
            style={{ flex: 1, justifyContent: 'center', fontSize: 13, padding: '7px 8px' }}>
            {loading ? <><Spinner size={11} /> Đang quét...</> : '⟳ Quét BN'}
          </Btn>
          <Btn variant="default" onClick={loadData} disabled={loading} style={{ padding: '7px 12px', fontSize: 13 }}>↺</Btn>
        </div>
        <input value={search} onChange={e => setSearch(e.target.value)}
          placeholder="Tìm bệnh nhân..."
          style={{ width: '100%', background: C.surface2, border: `1px solid ${C.border}`, borderRadius: 6, padding: '7px 10px', color: C.text, fontSize: 13, fontFamily: 'inherit', outline: 'none' }}
        />
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 6, fontSize: 11, color: C.text3 }}>
          <span>{unassigned.length} chưa xếp · {assigned.length} đã xếp</span>
          {selCount > 0
            ? <span style={{ color: C.blue, fontWeight: 600 }}>✔ Đang chọn {selCount} BN</span>
            : <span>Bấm BN để chọn</span>
          }
        </div>
      </div>

      <div style={{ padding: '8px 12px', borderBottom: `1px solid ${C.border2}`, background: C.surface, flexShrink: 0 }}>
        <div style={{ fontSize: 11, color: selCount > 0 ? C.blue : C.text3, marginBottom: 6, fontWeight: 600 }}>
          {selCount > 0 ? `→ Xếp ${selCount} BN vào phòng:` : 'Phòng — bấm để xem/chỉnh sửa:'}
        </div>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {rooms.map(([room, cap]) => {
            const pts = roomPatients(room);
            const full = pts.length >= cap;
            const isInspecting = inspectRoom === room;
            const hasPatients = pts.length > 0;

            let borderColor = C.border;
            let bgColor = 'transparent';
            let textColor = C.text2;
            if (isInspecting) { borderColor = C.amberBorder; bgColor = C.amberBg; textColor = C.amber; }
            else if (selCount > 0 && !full) { borderColor = C.blueBorder; bgColor = 'transparent'; textColor = C.text; }
            else if (hasPatients) { borderColor = C.greenBorder; bgColor = C.greenBg; textColor = C.green; }
            if (full) { borderColor = C.redBorder; bgColor = C.redBg; textColor = C.red; }

            return (
              <button type="button" key={room} onClick={() => {
                if (selCount > 0 && !full) {
                  assignToRoom(room);
                  setInspectRoom(null);
                } else {
                  setInspectRoom(isInspecting ? null : room);
                }
              }} style={{
                padding: '6px 10px', borderRadius: 6, border: `1px solid ${borderColor}`,
                background: bgColor, color: textColor,
                cursor: full && selCount > 0 ? 'not-allowed' : 'pointer',
                fontSize: 13, fontFamily: 'inherit', fontWeight: 600,
                display: 'flex', alignItems: 'center', gap: 4,
              }}>
                {room}
                <span style={{ fontSize: 10, opacity: 0.8 }}>{pts.length}/{cap}</span>
              </button>
            );
          })}
          {selCount > 0 && (
            <button type="button" onClick={clearSelection} style={{
              padding: '6px 10px', borderRadius: 6, border: `1px solid ${C.border}`,
              background: 'transparent', color: C.text3, cursor: 'pointer', fontSize: 12, fontFamily: 'inherit',
            }}>✕ Bỏ chọn</button>
          )}
        </div>

        {/* Inspect panel */}
        {inspectRoom && (() => {
          const pts = roomPatients(inspectRoom);
          const cap = roomConfig[inspectRoom] || 0;
          return (
            <div style={{
              marginTop: 10, padding: '10px 12px', borderRadius: 8,
              background: C.surface2, border: `1px solid ${C.amberBorder}`,
            }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                <span style={{ fontSize: 13, fontWeight: 700, color: C.amber }}>
                  {inspectRoom} — {pts.length}/{cap} BN
                </span>
                <button type="button" onClick={() => setInspectRoom(null)} style={{
                  background: 'none', border: 'none', color: C.text3, cursor: 'pointer', fontSize: 16, padding: '0 4px',
                }}>✕</button>
              </div>
              {pts.length === 0 && <div style={{ fontSize: 12, color: C.text3 }}>Phòng trống</div>}
              {pts.map(p => {
                const id = getPatientId(p);
                return (
                  <div key={id} style={{
                    display: 'flex', alignItems: 'center', gap: 8,
                    padding: '7px 0', borderBottom: `1px solid ${C.border2}`,
                  }}>
                    <div style={{ flex: 1 }}>
                      <div style={{ fontSize: 13, color: C.text }}>{getPatientName(p)}</div>
                      <div style={{ fontSize: 11, color: C.text3, fontVariantNumeric: 'tabular-nums' }}>{id}</div>
                      {getWardMetaLine(p) && (
                        <div style={{ fontSize: 11, color: C.text3, marginTop: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {getWardMetaLine(p)}
                        </div>
                      )}
                    </div>
                    <button type="button" onClick={() => removeFromRoom(id)} style={{
                      background: C.redBg, border: `1px solid ${C.redBorder}`,
                      color: C.red, borderRadius: 6, padding: '5px 10px',
                      cursor: 'pointer', fontSize: 12, fontFamily: 'inherit',
                    }}>Xóa khỏi phòng</button>
                  </div>
                );
              })}
              {selCount > 0 && pts.length < cap && (
                <button type="button" onClick={() => assignToRoom(inspectRoom)} style={{
                  marginTop: 8, width: '100%', padding: '8px', borderRadius: 6,
                  background: C.blueBg, border: `1px solid ${C.blueBorder}`,
                  color: C.blue, cursor: 'pointer', fontSize: 13, fontFamily: 'inherit', fontWeight: 600,
                }}>+ Xếp {selCount} BN đang chọn vào {inspectRoom}</button>
              )}
            </div>
          );
        })()}
      </div>

      {/* ── Patient list ── */}
      <div style={{ flex: 1, overflow: 'auto', background: C.bg }}>
        {loading && (
          <div style={{ padding: 16, color: C.text2, display: 'flex', gap: 8, alignItems: 'center' }}>
            <Spinner size={12} /> Đang tải...
          </div>
        )}
        {!loading && filtered.length === 0 && unassigned.length === 0 && assigned.length === 0 && (
          <div style={{ padding: 20, textAlign: 'center', fontSize: 13, color: C.text3 }}>
            Chưa có dữ liệu. Hãy Quét BN trước.
          </div>
        )}

        {!loading && unassigned.length > 0 && (
          <div style={{ padding: '6px 14px', display: 'flex', gap: 8, alignItems: 'center', borderBottom: `1px solid ${C.border2}`, background: C.surface }}>
            <button type="button" onClick={selectAllUnassigned} style={{
              fontSize: 12, background: 'none', border: `1px solid ${C.border}`, borderRadius: 4,
              padding: '3px 10px', cursor: 'pointer', color: C.text2, fontFamily: 'inherit',
            }}>Chọn tất cả ({unassigned.length})</button>
            {selCount > 0 && (
              <button type="button" onClick={clearSelection} style={{
                fontSize: 12, background: 'none', border: `1px solid ${C.border}`, borderRadius: 4,
                padding: '3px 10px', cursor: 'pointer', color: C.text3, fontFamily: 'inherit',
              }}>Bỏ chọn</button>
            )}
          </div>
        )}

        {/* Unassigned */}
        {filtered.map(p => {
          const id = getPatientId(p);
          const isSelected = selectedPxSet.has(id);
          return (
            <div key={id} onClick={() => toggleSelectPx(id)} style={{
              padding: '11px 14px', cursor: 'pointer', borderBottom: `1px solid ${C.border2}`,
              background: isSelected ? C.blueBg : 'transparent',
              borderLeft: `3px solid ${isSelected ? C.blue : 'transparent'}`,
              display: 'flex', alignItems: 'center', gap: 10,
            }}>
              <div style={{
                width: 20, height: 20, borderRadius: 4, flexShrink: 0,
                border: `1.5px solid ${isSelected ? C.blue : C.border}`,
                background: isSelected ? C.blue : 'transparent',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
              }}>
                {isSelected && <span style={{ color: '#fff', fontSize: 12, lineHeight: 1 }}>✓</span>}
              </div>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 14, color: C.text, fontWeight: isSelected ? 600 : 400 }}>{getPatientName(p)}</div>
                <div style={{ fontSize: 11, color: C.text3, marginTop: 2, fontVariantNumeric: 'tabular-nums' }}>{id}</div>
                {getWardMetaLine(p) && (
                  <div style={{ fontSize: 11, color: C.text3, marginTop: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {getWardMetaLine(p)}
                  </div>
                )}
              </div>
            </div>
          );
        })}

      </div>

      {/* ── Sticky bottom: save only ── */}
      <div style={{ padding: '10px 12px', borderTop: `1px solid ${C.border}`, background: C.surface, flexShrink: 0 }}>
        <Btn variant="default" onClick={handleSaveOnly}
          disabled={saving}
          style={{ width: '100%', justifyContent: 'center', fontSize: 13, padding: '8px 6px' }}>
          {saving ? <><Spinner size={11} /> Đang lưu...</> : 'Lưu xếp phòng'}
        </Btn>
        <div style={{ fontSize: 11, color: C.text3, marginTop: 6, textAlign: 'center' }}>
          Lấy y lệnh thực hiện ở mục Lấy dữ liệu.
        </div>
      </div>
    </div>
  );
}
