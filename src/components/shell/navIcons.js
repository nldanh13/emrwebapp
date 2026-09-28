// Icon (Tabler) cho từng mục điều hướng. Khoá = id trong config/feature_registry.json → navigation.
// Mục chưa khai ở đây dùng icon mặc định, không bao giờ quay về ký tự Unicode.
import {
  IconArrowsExchange,
  IconBed,
  IconCalendarUser,
  IconChecklist,
  IconClipboardHeart,
  IconDatabaseSearch,
  IconDownload,
  IconFileCertificate,
  IconLayoutGrid,
  IconPackage,
  IconPill,
  IconReportMedical,
  IconScan,
  IconSignature,
  IconStethoscope,
  IconTimeline,
  IconUserCog,
  IconCalendarOff,
} from '@tabler/icons-react';

const NAV_ICONS = {
  acquire: IconDownload,
  bed: IconBed,
  ward: IconClipboardHeart,
  nurse: IconCalendarUser,
  report: IconReportMedical,
  hchanh: IconFileCertificate,
  'hchanh-vtyt': IconPackage,
  'discharge-sign': IconSignature,
  'records-check': IconChecklist,
  'sick-leave': IconCalendarOff,
  clinic: IconStethoscope,
  'patient-journey': IconTimeline,
  research: IconDatabaseSearch,
  'vtyt-catalog': IconPackage,
  'medication-catalog': IconPill,
  'emr-structure-scan': IconScan,
  'account-settings': IconUserCog,
  functions: IconLayoutGrid,
};

export function navIcon(id) {
  return NAV_ICONS[id] || IconArrowsExchange;
}

// Nhãn ngắn cho thanh điều hướng dưới trên điện thoại (chỗ hẹp).
export const SHORT_LABELS = {
  acquire: 'Lấy dữ liệu',
  bed: 'Xếp phòng',
  ward: 'Nhập BP',
  hchanh: 'Kiểm HSBA',
  'hchanh-vtyt': 'Nhập VTYT',
  report: 'Báo cáo',
  'records-check': 'Trả HSBA',
  nurse: 'Lịch ĐD',
};

// Màn hình hằng ngày hiện ở thanh dưới trên điện thoại (theo PRODUCT.md); còn lại nằm trong "Tất cả".
export const MOBILE_PRIMARY_TABS = ['ward', 'bed', 'hchanh', 'report'];
