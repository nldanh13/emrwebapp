import { IconCalendarUser, IconInfoCircle } from '@tabler/icons-react';
import { C, FS } from '../../tokens.js';

// Dải ngữ cảnh đầu màn hình Nhập bệnh phòng: phạm vi người bệnh đang hiện + điều dưỡng theo ngày.
// Tiêu đề màn hình đã có ở thanh trên nên không lặp lại ở đây; mô tả dài nằm trong tooltip.
export default function NurseDutyInfo({ lines = [], scopeInfo = '', hint = '' }) {
  if (!lines.length && !scopeInfo) return null;
  return (
    <div style={{ padding: '9px 16px', borderBottom: `1px solid ${C.border2}`, background: C.surface, flexShrink: 0, display: 'grid', gap: 4 }}>
      {scopeInfo && (
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 7, fontSize: FS.sm, color: C.text2, lineHeight: 1.45 }}>
          <IconInfoCircle size={16} stroke={1.75} color={C.text3} style={{ flexShrink: 0, marginTop: 1 }} aria-hidden="true" />
          <span title={hint || undefined}>{scopeInfo}</span>
        </div>
      )}
      {lines.map((line, idx) => (
        <div key={idx} style={{ display: 'flex', alignItems: 'flex-start', gap: 7, fontSize: FS.sm, color: C.text2, lineHeight: 1.45 }}>
          <IconCalendarUser size={16} stroke={1.75} color={C.text3} style={{ flexShrink: 0, marginTop: 1 }} aria-label="Điều dưỡng theo ngày" />
          <span>{line}</span>
        </div>
      ))}
    </div>
  );
}
