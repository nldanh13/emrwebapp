import { C, FONT_MONO } from '../../tokens.js';
import { isOddHour } from './reportUtils.js';

function Chip({ active, children, onClick, title }) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      style={{
        border: 0, borderBottom: `2px solid ${active ? C.blue : 'transparent'}`,
        background: 'transparent', color: active ? C.text : C.text3,
        borderRadius: 0, padding: '6px 8px 5px', cursor: 'pointer', fontSize: 11.5,
        fontFamily: 'inherit', whiteSpace: 'nowrap',
      }}
    >{children}</button>
  );
}

function StatCard({ label, value }) {
  return (
    <div style={{ background: 'transparent', borderRight: `1px solid ${C.border2}`, padding: '5px 14px 6px 0' }}>
      <div style={{ color: C.text3, fontSize: 10, fontWeight: 700 }}>{label}</div>
      <div style={{ color: C.text, fontWeight: 700, fontSize: 18, marginTop: 3 }}>{value}</div>
    </div>
  );
}

function SelectBox({ value, onChange, children, style = {} }) {
  return (
    <select
      value={value}
      onChange={e => onChange(e.target.value)}
      style={{
        background: C.surface, border: `1px solid ${C.border}`, color: C.text,
        borderRadius: 6, padding: '6px 9px', fontFamily: 'inherit', fontSize: 12,
        outline: 'none', ...style,
      }}
    >{children}</select>
  );
}

function EmptyFilter() {
  return (
    <div style={{ color: C.text3, padding: '18px 0', borderTop: `1px dashed ${C.border}` }}>
      Không có thuốc phù hợp với bộ lọc đang chọn.
    </div>
  );
}

function Th({ children, align = 'left' }) {
  return <th style={{ padding: '8px 10px', fontWeight: 600, textAlign: align, whiteSpace: 'nowrap' }}>{children}</th>;
}

function Td({ children, align = 'left', mono = false, style = {} }) {
  return (
    <td style={{ padding: '8px 10px', textAlign: align, verticalAlign: 'top', color: C.text, fontFamily: mono ? FONT_MONO : undefined, ...style }}>
      {children}
    </td>
  );
}

function TimeBadge({ row }) {
  const odd = isOddHour(row);
  return (
    <span
      title={odd ? (row.separatedHourReason || 'Giờ riêng: không đi cùng giờ thuốc chung') : ''}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 4, width: 'fit-content',
        color: odd ? C.amber : C.text,
        background: odd ? C.amberBg : 'transparent',
        border: `1px solid ${odd ? C.amberBorder : C.border2}`,
        borderRadius: 4, padding: '2px 6px', fontFamily: FONT_MONO, fontSize: 10.5, fontWeight: 700,
      }}
    >
      {row.timeText}
      {odd && <span style={{ fontFamily: 'inherit', fontSize: 10 }}>riêng</span>}
    </span>
  );
}

function RouteBadge({ route }) {
  const color = route === 'TTM' ? C.green : route === 'TMC' ? C.blue : route === 'TB' ? C.amber : route === 'TDD' ? C.amber : route === 'Uống' ? C.purple : route === 'Ngưng/Trả' ? C.text3 : C.text2;
  return <span style={{ color, background: 'rgba(255,255,255,0.04)', border: `1px solid ${C.border}`, borderRadius: 4, padding: '2px 6px', fontSize: 11, fontWeight: 700 }}>{route || 'Khác'}</span>;
}

function formatQty(value) {
  const n = Number(value || 0);
  if (!Number.isFinite(n)) return '0';
  if (Math.abs(n - Math.round(n)) < 0.00001) return String(Math.round(n));
  return String(Number(n.toFixed(2)));
}

export {
  Chip,
  StatCard,
  SelectBox,
  EmptyFilter,
  Th,
  Td,
  TimeBadge,
  RouteBadge,
  formatQty,
};
