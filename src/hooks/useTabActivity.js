// Mọi tab được giữ lại (ẩn) sau lần mở đầu: chuyển tab không dựng lại màn hình, không tải lại từ đầu,
// không mất thao tác đang làm dở. Màn hình biết mình đang hiện hay ẩn qua context này.
//   useTabActive()       true khi tab đang hiện (dùng để tạm dừng tự làm mới định kỳ khi ẩn).
//   useOnTabReturn(fn)   gọi fn khi người dùng quay lại tab (ẩn → hiện), không gọi ở lần mở đầu;
//                        dùng để cập nhật ngầm dữ liệu có thể đã đổi ở tab khác.
// Xem docs/UX_RULES.md.
import { createContext, useContext, useEffect, useRef } from 'react';

export const TabActivityContext = createContext({ id: '', active: true });

export function useTabActive() {
  return useContext(TabActivityContext).active;
}

export function useOnTabReturn(fn) {
  const { active } = useContext(TabActivityContext);
  const prev = useRef(active);
  const fnRef = useRef(fn);
  fnRef.current = fn;
  useEffect(() => {
    if (active && !prev.current) fnRef.current?.();
    prev.current = active;
  }, [active]);
}

// Còn thay đổi chưa lưu: trình duyệt hỏi lại khi tải lại/đóng trang (chuyển tab trong app thì không
// mất vì tab được giữ lại).
export function useUnsavedChangesGuard(dirty) {
  useEffect(() => {
    if (!dirty) return undefined;
    const onBeforeUnload = (e) => { e.preventDefault(); e.returnValue = ''; return ''; };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [dirty]);
}
