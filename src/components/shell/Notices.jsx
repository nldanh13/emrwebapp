import { IconAlertCircle, IconAlertTriangle, IconCircleCheck, IconInfoCircle, IconX } from '@tabler/icons-react';

const TONE_ICON = {
  error: IconAlertCircle,
  warn: IconAlertTriangle,
  ok: IconCircleCheck,
  info: IconInfoCircle,
  running: IconInfoCircle,
};

const RAW_API_LABEL = /^(GET|POST|PUT|PATCH|DELETE)\s+\/\S*/i;

// Nhãn thao tác dành cho người đọc: bỏ dạng kỹ thuật "POST /api/..." (vẫn giữ trong nhật ký hoạt động).
export function humanActionLabel(label) {
  const text = String(label || '').trim();
  if (!text || RAW_API_LABEL.test(text)) return 'thao tác vừa rồi';
  return text;
}

// Bỏ tiền tố kỹ thuật lẫn trong thông báo lỗi, vd "Lỗi: POST /api/x — nội dung".
export function humanMessage(message) {
  return String(message || '')
    .replace(/^Lỗi:\s*/i, '')
    .replace(/(^|\s)(GET|POST|PUT|PATCH|DELETE)\s+\/api\/\S+\s*(—|-|:)?\s*/gi, '$1')
    .trim();
}

// Một chồng thông báo duy nhất cho cả toast của màn hình lẫn thông báo hoạt động.
// Mỗi mục: { id, tone: 'error'|'warn'|'ok'|'info'|'running', title, detail }.
export default function Notices({ items, onDismiss }) {
  if (!items.length) return null;
  return (
    <div className="emr-notices" role="region" aria-label="Thông báo">
      {items.map(item => {
        const tone = TONE_ICON[item.tone] ? item.tone : 'info';
        const Icon = TONE_ICON[tone];
        return (
          <div key={item.id} className={`emr-notice emr-notice--${tone === 'running' ? 'info' : tone}`} role={tone === 'error' ? 'alert' : 'status'}>
            <Icon size={18} stroke={1.9} aria-hidden="true" />
            <div className="emr-notice__body">
              <div className="emr-notice__title">{item.title}</div>
              {item.detail && <div className="emr-notice__detail">{item.detail}</div>}
            </div>
            <button type="button" className="emr-notice__close" onClick={() => onDismiss(item.id)} aria-label="Đóng thông báo">
              <IconX size={15} stroke={1.9} />
            </button>
          </div>
        );
      })}
    </div>
  );
}
