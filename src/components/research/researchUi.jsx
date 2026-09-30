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

const wizInp = { ...inp, width: '100%' };

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

function CoveragePanel({ coverage }) {
  if (!coverage?.exists) return null;
  const ex = coverage.extract || {};
  const total = Number(ex.total || 0);
  const ready = Number(ex.ready || 0);
  const missing = Math.max(0, total - ready);
  return (
    <div style={{
      padding: '7px 12px', borderBottom: `1px solid ${missing ? C.amberBorder : C.greenBorder}`,
      background: missing ? C.amberBg : C.greenBg,
      display: 'flex', alignItems: 'center', gap: 7, flexWrap: 'wrap', flexShrink: 0,
    }}>
      <span style={{ fontSize: FS.xs, fontWeight: 700, color: missing ? C.amber : C.green }}>Tiến độ dữ liệu</span>
      <StatBadge label="đủ" value={`${ready}/${total || 0}`} tone={missing ? 'warn' : 'ok'} />
      <StatBadge label="thiếu" value={missing} tone={missing ? 'warn' : 'ok'} />
      <StatBadge label="xem tay" value={ex.manual_review || 0} tone={ex.manual_review ? 'danger' : 'ok'} />
      {coverage.final_dataset_ready && <span style={{ fontSize: FS.xs, color: C.green }}>Đã đủ điều kiện tạo dataset cuối.</span>}
    </div>
  );
}

const actionBtn = { height: 28, padding: '0 10px', fontSize: FS.xs, whiteSpace: 'nowrap' };

function ActionGroup({ title, subtitle, tone = 'neutral', children, style = {} }) {
  const colors = {
    neutral: { bg: C.surface, border: C.border, title: C.text },
    info:    { bg: C.blueBg, border: C.blueBorder, title: C.blue },
    warn:    { bg: C.amberBg, border: C.amberBorder, title: C.amber },
    ok:      { bg: C.greenBg, border: C.greenBorder, title: C.green },
  };
  const t = colors[tone] || colors.neutral;
  return (
    <div style={{
      display: 'flex', flexDirection: 'column', gap: 5,
      minWidth: 150, padding: '7px 8px', borderRadius: 6,
      border: `1px solid ${t.border}`, background: t.bg,
      ...style,
    }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
        <span style={{ fontSize: FS.xs, fontWeight: 700, color: t.title }}>{title}</span>
        {subtitle && <span style={{ fontSize: FS.xs, color: C.text3, lineHeight: 1.25 }}>{subtitle}</span>}
      </div>
      <div style={{ display: 'flex', gap: 5, alignItems: 'center', flexWrap: 'wrap' }}>{children}</div>
    </div>
  );
}

function AdvancedActions({ label = 'Tác vụ phụ', children }) {
  return (
    <details style={{
      border: `1px solid ${C.border2}`, borderRadius: 6,
      background: C.surface2, padding: '6px 8px', alignSelf: 'stretch', minWidth: 180,
    }}>
      <summary style={{ cursor: 'pointer', fontSize: FS.xs, fontWeight: 700, color: C.text2, listStylePosition: 'inside' }}>
        {label}
      </summary>
      <div style={{ display: 'flex', gap: 5, alignItems: 'center', flexWrap: 'wrap', marginTop: 7 }}>
        {children}
      </div>
    </details>
  );
}

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
      <span style={{ fontSize: FS.xs, fontWeight: active ? 700 : 600, whiteSpace: 'nowrap' }}>{title}</span>
    </button>
  );
}

function SimpleCard({ title, value, hint, tone = 'neutral' }) {
  const colors = {
    neutral: { b: C.border2, bg: C.surface, c: C.text },
    info: { b: C.blueBorder, bg: C.blueBg, c: C.blue },
    ok: { b: C.greenBorder, bg: C.greenBg, c: C.green },
    warn: { b: C.amberBorder, bg: C.amberBg, c: C.amber },
  };
  const t = colors[tone] || colors.neutral;
  return (
    <div style={{ border: `1px solid ${t.b}`, background: t.bg, borderRadius: 7, padding: 12, minWidth: 160, flex: '1 1 180px' }}>
      <div style={{ fontSize: FS.xs, color: C.text3, fontWeight: 700 }}>{title}</div>
      <div style={{ fontSize: FS.stat, color: t.c, fontWeight: 700, marginTop: 3 }}>{value}</div>
      {hint && <div style={{ fontSize: FS.xs, color: C.text3, marginTop: 5, lineHeight: 1.4 }}>{hint}</div>}
    </div>
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
              {columns.map(c => <td key={c.key} style={{ padding: '6px 8px', color: C.text2, verticalAlign: 'top', maxWidth: 280, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: c.long ? 'pre-wrap' : 'nowrap' }}>{text(row?.[c.key]) || '—'}</td>)}
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

function WizLabel({ children }) {
  return <div style={{ fontSize: FS.xs, fontWeight: 700, color: C.text3, marginBottom: 4 }}>{children}</div>;
}

function WizField({ label, value, onChange, type = 'text', placeholder = '' }) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <WizLabel>{label}</WizLabel>
      <input type={type} value={value} placeholder={placeholder}
        onChange={e => onChange(e.target.value)}
        style={{ height: 28, borderRadius: 6, border: `1px solid ${C.border}`, background: C.bg, color: C.text, padding: '0 8px', fontSize: FS.sm, fontFamily: 'inherit', outline: 'none' }} />
    </label>
  );
}

function WizSelect({ label, value, onChange, options = [] }) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <WizLabel>{label}</WizLabel>
      <select value={value} onChange={e => onChange(e.target.value)}
        style={{ height: 28, borderRadius: 6, border: `1px solid ${C.border}`, background: C.bg, color: C.text, padding: '0 8px', fontSize: FS.sm, fontFamily: 'inherit', outline: 'none' }}>
        {options.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
      </select>
    </label>
  );
}

export {
  StatusPill,
  inp,
  wizInp,
  StatBadge,
  CoveragePanel,
  actionBtn,
  ActionGroup,
  AdvancedActions,
  ModeButton,
  SimpleCard,
  SmallRowsTable,
  SideItem,
  SectionHead,
  EmptyState,
  WizLabel,
  WizField,
  WizSelect,
};
