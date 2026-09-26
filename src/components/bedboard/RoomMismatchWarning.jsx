import { useEffect, useState } from 'react';
import { IconAlertTriangle } from '@tabler/icons-react';
import { C, FS } from '../../tokens.js';
import { Btn } from '../shared.jsx';

// Dữ liệu y lệnh (FINAL_PATH) lưu phòng tại thời điểm "Lấy chi tiết". Nếu lúc
// đó xếp nhầm phòng rồi sửa lại trên board, phòng cũ vẫn còn nguyên trong dữ
// liệu đã lấy — không tự lan theo lần quét/lưu sau. Banner này phát hiện các
// BN đang lệch phòng như vậy và cho đồng bộ lại ngay, không cần lấy lại EMR.
export default function RoomMismatchWarning({ mismatches = [], fixing = false, onFix }) {
  const [selected, setSelected] = useState(() => new Set(mismatches.map(m => m.ma_bn)));
  const idsKey = mismatches.map(m => m.ma_bn).join('');

  useEffect(() => {
    setSelected(new Set(mismatches.map(m => m.ma_bn)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [idsKey]);

  if (!mismatches.length) return null;

  const toggle = (id) => {
    setSelected(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };

  return (
    <div style={{ borderBottom: `1px solid ${C.amberBorder}`, background: C.amberBg, flexShrink: 0 }}>
      <div role="alert" style={{ padding: '9px 16px', color: C.amber, fontSize: FS.sm, lineHeight: 1.5, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <IconAlertTriangle size={17} stroke={1.9} style={{ flexShrink: 0 }} aria-hidden="true" />
        <span style={{ flex: 1, minWidth: 220 }}>
          <b>{mismatches.length} người bệnh</b> đang có dữ liệu y lệnh lưu phòng khác phòng hiện tại trên board
          (thường do lỡ xếp nhầm phòng lúc quét rồi sửa lại). Chọn BN cần đồng bộ rồi bấm nút — không cần lấy lại dữ liệu từ EMR.
        </span>
        <Btn
          variant="solidPrimary"
          disabled={!selected.size}
          loading={fixing}
          onClick={() => onFix?.([...selected])}
          style={{ flexShrink: 0 }}
        >
          {fixing ? 'Đang đồng bộ…' : `Đồng bộ phòng (${selected.size})`}
        </Btn>
      </div>
      <div style={{ maxHeight: 170, overflowY: 'auto', borderTop: `1px solid ${C.amberBorder}`, background: C.surface }}>
        {mismatches.map(m => {
          const checked = selected.has(m.ma_bn);
          return (
            <label key={m.ma_bn} style={{
              display: 'flex', alignItems: 'center', gap: 8, padding: '7px 16px', minHeight: 36,
              borderBottom: `1px solid ${C.border2}`, cursor: 'pointer', fontSize: FS.sm,
              color: checked ? C.text : C.text3,
              background: checked ? 'transparent' : C.surface2,
              flexWrap: 'wrap',
            }}>
              <input
                type="checkbox"
                checked={checked}
                onChange={() => toggle(m.ma_bn)}
                style={{ cursor: 'pointer', flexShrink: 0, width: 16, height: 16, margin: 0, accentColor: C.blue }}
              />
              <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {m.ho_ten || m.ma_bn}
                <span style={{ color: C.text3 }}> ({m.ma_bn})</span>
              </span>
              <span style={{ fontSize: FS.xs, color: C.text2, flexShrink: 0 }}>
                dữ liệu: {(m.data_rooms || []).join(', ')} → board: <b style={{ color: C.amber }}>{m.current_room}</b>
              </span>
              <span style={{ fontSize: FS.xs, color: C.text2, flexShrink: 0 }}>{m.affected_days} ngày</span>
            </label>
          );
        })}
      </div>
    </div>
  );
}
