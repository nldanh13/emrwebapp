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

// Một lần cho cả app: keyframes của hiệu ứng khung xám.
if (typeof document !== 'undefined' && !document.getElementById('emr-skeleton-style')) {
  const style = document.createElement('style');
  style.id = 'emr-skeleton-style';
  style.textContent = '@keyframes emr-skeleton{0%{background-position:100% 0}100%{background-position:-100% 0}}';
  document.head.appendChild(style);
}
