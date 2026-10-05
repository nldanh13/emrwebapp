import { useMemo, useRef } from 'react';
import { TabActivityContext } from '../../hooks/useTabActivity.js';

// Tab đã mở được giữ lại: ẩn bằng display:none, báo cho màn hình biết đang hiện hay ẩn.
// Tab đang ẩn giữ nguyên phần tử đã vẽ lần cuối (cùng tham chiếu) nên React bỏ qua, không vẽ lại
// mỗi khi App cập nhật (đồng hồ, thông báo...); quay lại tab thì nhận props mới nhất.
export default function KeepAliveTab({ id, active, children }) {
  const shown = useRef(children);
  const wasActive = useRef(active);
  if (active || wasActive.current) shown.current = children; // lần vẽ ngay sau khi rời tab: nhận active=false
  wasActive.current = active;
  const value = useMemo(() => ({ id, active }), [id, active]);
  return (
    <div data-tab={id} style={{ display: active ? 'contents' : 'none' }}>
      <TabActivityContext.Provider value={value}>{shown.current}</TabActivityContext.Provider>
    </div>
  );
}

