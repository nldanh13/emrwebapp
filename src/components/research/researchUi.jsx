// Component giao diện nhỏ dùng chung trong màn hình Kho nghiên cứu (nhãn, thẻ, nút chế độ, bảng nhỏ, ô nhập).
import { text, lower, compactNumber } from './researchFormat.js';
import { C, FS } from '../../tokens.js';

function StatusPill({ value, state = '', wide = false }) {
  const v = text(value) || '—';
  const raw = lower(v || state);
  const isRunning = raw.includes('đang') || raw.includes('running');
  const isError = raw.includes('lỗi') || raw.includes('error') || raw.includes('fail') || raw.includes('timeout');
  const isMissing = raw.includes('một phần') || raw.includes('partial') || raw.includes('thiếu') || raw.includes('chưa');
  const isDone = raw.includes('đã lấy') || raw.includes('đủ') || raw.includes('done') || raw === 'ok';
  const color = isError ? C.red : isMissing ? C.amber : isDone ? C.green : isRunning ? C.blue : C.text3;
  const symbol = isError ? '!' : isMissing ? '–' : isDone ? '✓' : isRunning ? '…' : '·';
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 4,
      minWidth: wide ? 72 : 50, height: 19, padding: '0 6px', borderRadius: 4,
      border: `1px solid ${C.border2}`, background: C.surface, color,
      fontSize: FS.xs, fontWeight: 700, whiteSpace: 'nowrap', lineHeight: 1,
    }}><b style={{ fontSize: FS.xs }}>{symbol}</b>{v}</span>
  );
}

// ── tiny primitives ───────────────────────────────────────────────────────────
const inp = {
  height: 28, borderRadius: 5, border: `1px solid ${C.border}`,
  background: C.bg, color: C.text, padding: '0 8px',
  fontSize: FS.sm, fontFamily: 'inherit', outline: 'none',
  transition: 'border-color 0.15s',
};

function StatBadge({ label, value, tone = 'neutral' }) {
  const colors = {
    ok:      { c: C.green,  bg: C.greenBg,  b: C.greenBorder  },
    info:    { c: C.blue,   bg: C.blueBg,   b: C.blueBorder   },
    warn:    { c: C.amber,  bg: C.amberBg,  b: C.amberBorder  },
    danger:  { c: C.red,    bg: C.redBg,    b: C.redBorder    },
    neutral: { c: C.text3,  bg: C.surface2, b: C.border2      },
  };
  const s = colors[tone] || colors.neutral;
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 4,
      height: 20, padding: '0 7px', borderRadius: 5,
      border: `1px solid ${s.b}`, background: s.bg,
      fontSize: FS.xs, fontWeight: 700, color: s.c, whiteSpace: 'nowrap',
    }}>
      <span style={{ color: C.text3, fontWeight: 600 }}>{label}</span>
      <span>{compactNumber(value)}</span>
    </span>
  );
}

const actionBtn = { height: 28, padding: '0 10px', fontSize: FS.xs, whiteSpace: 'nowrap' };

function ModeButton({ active, title, hint, onClick }) {
  return (
    <button type="button" onClick={onClick}
      title={hint || title}
      style={{
        minWidth: 0, textAlign: 'center', cursor: 'pointer', height: 34,
        border: 0, borderBottom: `2px solid ${active ? C.blue : 'transparent'}`,
        background: 'transparent', color: active ? C.text : C.text3,
        padding: '0 12px', fontFamily: 'inherit',
      }}>
      <span style={{ fontSize: FS.sm, fontWeight: active ? 700 : 500, whiteSpace: 'nowrap' }}>{title}</span>
    </button>
  );
}

function SmallRowsTable({ columns = [], rows = [], max = 8 }) {
  const shown = rows.slice(0, max);
  if (!shown.length) return <div style={{ fontSize: FS.xs, color: C.text3, padding: '6px 0' }}>Không có dữ liệu.</div>;
  return (
    <div style={{ overflowX: 'auto', border: `1px solid ${C.border2}`, borderRadius: 8 }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: FS.xs }}>
        <thead style={{ background: C.surface2 }}>
          <tr>{columns.map(c => <th key={c.key} style={{ textAlign: 'left', padding: '6px 8px', color: C.text3, borderBottom: `1px solid ${C.border2}`, whiteSpace: 'nowrap' }}>{c.label}</th>)}</tr>
        </thead>
        <tbody>
          {shown.map((row, idx) => (
            <tr key={idx} style={{ borderTop: `1px solid ${C.border2}` }}>
              {columns.map(c => <td key={c.key} style={{ padding: '6px 8px', color: C.text2, verticalAlign: 'top', maxWidth: 280, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: c.long ? 'pre-wrap' : 'nowrap' }}>{c.render ? c.render(row) : (text(row?.[c.key]) || '—')}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
      {rows.length > max && <div style={{ padding: '5px 8px', fontSize: FS.xs, color: C.text3, borderTop: `1px solid ${C.border2}` }}>Hiển thị {max}/{rows.length} dòng đầu.</div>}
    </div>
  );
}

function SideItem({ label, sub, badge, active, onClick, children }) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        display: 'block', width: '100%', textAlign: 'left',
        border: 0, borderBottom: `1px solid ${C.border2}`,
        background: active ? `${C.blueBg}` : 'transparent',
        cursor: 'pointer', padding: '9px 12px',
        borderLeft: `2px solid ${active ? C.blue : 'transparent'}`,
        transition: 'background 0.1s, border-color 0.1s',
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 6 }}>
        <span style={{
          fontSize: FS.sm, fontWeight: 700, color: active ? C.blue : C.text,
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }}>{label}</span>
        {badge}
      </div>
      {sub && <div style={{ marginTop: 3, fontSize: FS.xs, color: C.text3, fontVariantNumeric: 'tabular-nums' }}>{sub}</div>}
      {children && <div style={{ marginTop: 5 }}>{children}</div>}
    </button>
  );
}

function SectionHead({ children }) {
  return (
    <div style={{
      padding: '8px 12px 5px',
      fontSize: FS.xs, fontWeight: 600, color: C.text3,
      borderBottom: `1px solid ${C.border2}`,
    }}>{children}</div>
  );
}

function EmptyState({ title, hint }) {
  return (
    <div style={{ padding: '40px 24px', textAlign: 'center' }}>
      <div style={{ fontSize: FS.md, fontWeight: 700, color: C.text }}>{title}</div>
      <div style={{ fontSize: FS.xs, color: C.text3, marginTop: 6, lineHeight: 1.5 }}>{hint}</div>
    </div>
  );
}

export {
  StatusPill,
  inp,
  StatBadge,
  actionBtn,
  ModeButton,
  SmallRowsTable,
  SideItem,
  SectionHead,
  EmptyState,
};
