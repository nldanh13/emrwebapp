import { C } from '../../tokens.js';
import { Btn, Badge, Spinner } from '../shared.jsx';

export function formatNumber(value) {
  const n = Number(value || 0);
  if (!Number.isFinite(n)) return '0';
  return n.toLocaleString('vi-VN');
}

export function fmtTime(msOrIso) {
  if (!msOrIso) return '—';
  const date = typeof msOrIso === 'number' ? new Date(msOrIso) : new Date(msOrIso);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString('vi-VN', { hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit', year: 'numeric' });
}

export function PageHeader({ title, subtitle, right }) {
  return (
    <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
      <div style={{ minWidth: 250 }}>
        <div style={{ fontSize: 18, fontWeight: 800, letterSpacing: '-0.025em', color: C.text }}>{title}</div>
        {subtitle && <div style={{ fontSize: 12, color: C.text2, marginTop: 4, lineHeight: 1.45 }}>{subtitle}</div>}
      </div>
      {right && <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>{right}</div>}
    </div>
  );
}

export function DataCard({ title, value, hint, tone = 'neutral', icon = '◇', footer }) {
  const toneMap = {
    neutral: { bg: C.surface, fg: C.text, accent: C.text3, border: C.border },
    blue: { bg: C.blueBg, fg: C.blue, accent: C.blue, border: C.blueBorder },
    green: { bg: C.greenBg, fg: C.green, accent: C.green, border: C.greenBorder },
    amber: { bg: C.amberBg, fg: C.amber, accent: C.amber, border: C.amberBorder },
    red: { bg: C.redBg, fg: C.red, accent: C.red, border: C.redBorder },
    purple: { bg: C.purpleBg, fg: C.purple, accent: C.purple, border: C.purpleBorder },
    cyan: { bg: C.cyanBg, fg: C.cyan, accent: C.cyan, border: C.cyanBorder },
  }[tone] || {};
  return (
    <div style={{ background: C.surface, borderRight: `1px solid ${C.border2}`, padding: '5px 14px 6px 0', minWidth: 120 }}>
      <div style={{ fontSize: 10, color: C.text3, fontWeight: 700 }}>{title}</div>
      <div style={{ marginTop: 2, fontSize: 22, lineHeight: 1.05, color: toneMap.fg, fontWeight: 850, letterSpacing: '-0.025em' }}>{value}</div>
      {hint && <div style={{ marginTop: 4, color: C.text3, fontSize: 10.5, lineHeight: 1.4 }}>{hint}</div>}
      {footer && <div style={{ marginTop: 7 }}>{footer}</div>}
    </div>
  );
}

export function Panel({ title, hint, right, children, style = {} }) {
  return (
    <section style={{ background: C.surface, borderTop: `1px solid ${C.border2}`, overflow: 'hidden', ...style }}>
      {(title || right || hint) && (
        <div style={{ padding: '9px 2px 8px', borderBottom: `1px solid ${C.border2}`, display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'flex-start' }}>
          <div>
            {title && <div style={{ color: C.text, fontSize: 14, fontWeight: 700 }}>{title}</div>}
            {hint && <div style={{ color: C.text2, fontSize: 11, marginTop: 4, lineHeight: 1.45 }}>{hint}</div>}
          </div>
          {right && <div style={{ flexShrink: 0, display: 'flex', gap: 7, alignItems: 'center' }}>{right}</div>}
        </div>
      )}
      <div style={{ padding: '10px 2px' }}>{children}</div>
    </section>
  );
}

export function Pipeline({ steps = [] }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 8 }}>
      {steps.map((step, idx) => {
        const done = step.status === 'done';
        const warn = step.status === 'warn';
        const active = step.status === 'active';
        const color = warn ? C.amber : done ? C.green : active ? C.blue : C.text3;
        const bg = warn ? C.amberBg : done ? C.greenBg : active ? C.blueBg : C.surface2;
        const border = warn ? C.amberBorder : done ? C.greenBorder : active ? C.blueBorder : C.border;
        return (
          <div key={step.id || step.title} style={{ position: 'relative', background: C.surface, border: `1px solid ${border}`, borderRadius: 5, padding: 9, minHeight: 72 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
              <div style={{ width: 22, height: 22, borderRadius: 4, display: 'grid', placeItems: 'center', background: bg, color, fontWeight: 700, border: `1px solid ${border}` }}>{done ? '✓' : idx + 1}</div>
              <div style={{ fontSize: 12, fontWeight: 700, color: C.text }}>{step.title}</div>
            </div>
            <div style={{ marginTop: 9, fontSize: 11, color: C.text2, lineHeight: 1.45 }}>{step.hint}</div>
            {step.badge && <div style={{ marginTop: 9 }}><Badge text={step.badge} bg={bg} color={color} /></div>}
          </div>
        );
      })}
    </div>
  );
}

export function LoadingBlock({ text = 'Đang tải dữ liệu...' }) {
  return <div style={{ padding: 18, display: 'flex', gap: 8, alignItems: 'center', color: C.text2, fontSize: 12 }}><Spinner size={13} /> {text}</div>;
}

export function EmptyBlock({ title = 'Chưa có dữ liệu', hint = 'Hãy chạy bước lấy dữ liệu trước.' }) {
  return (
    <div style={{ border: `1px dashed ${C.border}`, borderRadius: 6, padding: 18, textAlign: 'center', color: C.text2, background: C.surface2 }}>
      <div style={{ fontWeight: 700, color: C.text }}>{title}</div>
      <div style={{ fontSize: 12, marginTop: 6 }}>{hint}</div>
    </div>
  );
}

export function RowList({ items = [], renderItem }) {
  if (!items.length) return <EmptyBlock />;
  return <div style={{ display: 'grid', gap: 8 }}>{items.map((item, idx) => renderItem(item, idx))}</div>;
}

export function GhostButton({ children, onClick, disabled }) {
  return <Btn onClick={onClick} disabled={disabled} style={{ background: C.surface2 }}>{children}</Btn>;
}
