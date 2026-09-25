// Định nghĩa chung các thao tác nhập hàng loạt ở màn hình Nhập bệnh phòng, dùng cho cả
// giao diện máy tính (EmptyDetail) và điện thoại (ShiftMobileView) để nhãn/icon luôn khớp.
import { IconClipboardHeart, IconDroplet, IconFirstAidKit, IconPackage, IconPrinter } from '@tabler/icons-react';

export const WARD_BULK_ACTIONS = [
  {
    id: 'care', feature: 'care', icon: IconClipboardHeart, label: 'Chăm sóc',
    detail: 'Kiểm tra, nhập thiếu, sửa sai',
    running: { check: 'check-care', run: 'care' },
  },
  {
    id: 'infusion', feature: 'infusion', icon: IconDroplet, label: 'Dịch truyền',
    detail: 'Kiểm tra, nhập thiếu, sửa sai',
    running: { check: 'check-infus', run: 'infus' },
  },
  {
    id: 'procedure', feature: 'procedure', icon: IconFirstAidKit, label: 'Thủ thuật',
    detail: 'Kiểm tra, nhập thiếu, sửa sai',
    running: { check: 'check-procedure', run: 'procedure' },
  },
  {
    id: 'vtyt', feature: 'material', icon: IconPackage, label: 'VTYT',
    detail: 'Nhập theo quy tắc',
    hint: 'Chỉ nhập khi có phẫu thuật (băng thun/băng dính theo vị trí) hoặc thay kim luồn (combo kim luồn), theo quy tắc VTYT đã cấu hình.',
    running: { check: 'check-vtyt', run: 'vtyt' },
  },
];

export const WARD_PRINT_ACTION = {
  id: 'print', icon: IconPrinter, label: 'In hồ sơ ra viện', running: { run: 'print-discharge-bundle-all' },
};

// Trạng thái chạy của một thao tác: 'check' (đang kiểm tra y lệnh), 'run' (đang nhập) hoặc ''.
export function actionPhase(action, running) {
  if (!running) return '';
  if (action.running.check && running === action.running.check) return 'check';
  if (running === action.running.run) return 'run';
  return '';
}

export function phaseLabel(phase) {
  if (phase === 'check') return 'Đang kiểm tra y lệnh…';
  if (phase === 'run') return 'Đang nhập…';
  return '';
}
