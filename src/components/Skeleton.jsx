// Khung xám giữ chỗ khi màn hình chưa có số liệu lần đầu (docs/UX_RULES.md mục 9): bố cục hiện
// đủ ngay, số liệu hiện CÙNG LÚC khi gói dữ liệu về — không hiện từng ô một, không nhảy bố cục.
import { C } from '../tokens.js';

export function SkeletonBlock({ width = '100%', height = 12, radius = 4, style = {} }) {
  return (
    <span aria-hidden="true" style={{
      display: 'block', width, height, borderRadius: radius,
      background: `linear-gradient(90deg, ${C.surface2} 0%, ${C.border2} 50%, ${C.surface2} 100%)`,
      backgroundSize: '200% 100%', animation: 'emr-skeleton 1.2s ease-in-out infinite', ...style,
    }} />
  );
}

export function SkeletonLines({ lines = 3, gap = 8 }) {
  return (
    <div style={{ display: 'grid', gap }}>
      {Array.from({ length: lines }, (_, i) => <SkeletonBlock key={i} width={i === lines - 1 ? '60%' : '100%'} />)}
    </div>
  );
}

// Khung xám dạng bảng: dòng tiêu đề + vài dòng dữ liệu, đúng chỗ bảng thật sẽ hiện.
export function SkeletonTable({ rows = 6, cols = 5 }) {
  const widths = ['70%', '100%', '55%', '85%', '40%', '65%'];
  return (
    <div style={{ display: 'grid', gap: 10 }}>
      <div style={{ display: 'grid', gridTemplateColumns: `repeat(${cols}, 1fr)`, gap: 12 }}>
        {Array.from({ length: cols }, (_, c) => <SkeletonBlock key={c} height={10} width="60%" />)}
      </div>
      {Array.from({ length: rows }, (_, r) => (
        <div key={r} style={{ display: 'grid', gridTemplateColumns: `repeat(${cols}, 1fr)`, gap: 12, paddingTop: 8, borderTop: `1px solid ${C.border}` }}>
          {Array.from({ length: cols }, (_, c) => <SkeletonBlock key={c} width={widths[(r + c) % widths.length]} />)}
        </div>
      ))}
    </div>
  );
}

// Khung xám cho cả màn hình lần đầu mở tab (UX_RULES mục 9): thanh công cụ, các ô số (tùy chọn)
// và bảng. label đọc cho trình đọc màn hình; mắt thường chỉ thấy khung, không thấy chữ "Đang tải".
export function SkeletonScreen({ label = 'Đang tải dữ liệu', stats = 0, rows = 6, cols = 5, style = {} }) {
  return (
    <div role="status" aria-busy="true" aria-label={label} style={{ padding: 16, display: 'grid', gap: 14, alignContent: 'start', ...style }}>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
        <SkeletonBlock width={180} height={18} />
        <span style={{ flex: 1 }} />
        <SkeletonBlock width={96} height={28} radius={6} />
        <SkeletonBlock width={96} height={28} radius={6} />
      </div>
      {stats > 0 && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 10 }}>
          {Array.from({ length: stats }, (_, i) => <SkeletonBlock key={i} height={56} radius={8} />)}
        </div>
      )}
      <div style={{ border: `1px solid ${C.border}`, borderRadius: 8, padding: 14, background: C.surface }}>
        <SkeletonTable rows={rows} cols={cols} />
      </div>
    </div>
  );
}

// Một lần cho cả app: keyframes của hiệu ứng khung xám.
if (typeof document !== 'undefined' && !document.getElementById('emr-skeleton-style')) {
  const style = document.createElement('style');
  style.id = 'emr-skeleton-style';
  style.textContent = '@keyframes emr-skeleton{0%{background-position:100% 0}100%{background-position:-100% 0}}';
  document.head.appendChild(style);
}
