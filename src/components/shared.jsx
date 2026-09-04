import { C, FONT_UI, mono } from '../tokens.js';

export function Badge({ text, bg, color, size = 11 }) {
  return (
    <span className="emr-badge" style={{
      display: 'inline-block', padding: '1px 6px', borderRadius: 4,
      fontSize: size, fontWeight: 600, lineHeight: '18px',
      background: bg, color,
    }}>{text}</span>
  );
}

export function Dot({ color, size = 8 }) {
  return (
    <span style={{
      display: 'inline-block', width: size, height: size,
      borderRadius: '50%', background: color, flexShrink: 0,
    }} />
  );
}

export function Mono({ children, style = {} }) {
  return <span style={{ ...mono, ...style }}>{children}</span>;
}

export function SectionLabel({ children }) {
  return (
    <div style={{
      fontSize: 10, fontWeight: 600, letterSpacing: '0.08em',
      color: C.text3, padding: '8px 12px 4px',
      textTransform: 'uppercase',
    }}>{children}</div>
  );
}

export function Divider({ margin = '6px 0' }) {
  return <div style={{ height: 1, background: C.border2, margin }} />;
}

export function Spinner({ size = 14 }) {
  return (
    <span style={{
      display: 'inline-block', width: size, height: size,
      border: `2px solid ${C.border}`,
      borderTopColor: C.blue,
      borderRadius: '50%',
      animation: 'spin 0.7s linear infinite',
    }} />
  );
}

export function Btn({ children, variant = 'default', onClick, disabled, style = {}, type = 'button', title }) {
  const base = {
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 5,
    padding: '6px 10px', minHeight: 30, borderRadius: 5, border: '1px solid',
    cursor: disabled ? 'not-allowed' : 'pointer', fontSize: 12, fontWeight: 600,
    fontFamily: FONT_UI,
    opacity: disabled ? 0.55 : 1,
    transition: 'filter 0.12s ease, opacity 0.1s ease, transform 0.08s ease',
    boxShadow: 'none',
  };
  const solidText = '#ffffff';
  const variants = {
    primary: { background: C.blueBg,   borderColor: C.blueBorder,  color: C.blue  },
    success: { background: C.greenBg,  borderColor: C.greenBorder, color: C.green },
    danger:  { background: C.redBg,    borderColor: C.redBorder,   color: C.red   },
    solidPrimary: { background: C.blue, borderColor: C.blue, color: solidText, boxShadow: 'none' },
    solidSuccess: { background: C.green, borderColor: C.green, color: solidText, boxShadow: 'none' },
    solidDanger: { background: C.red, borderColor: C.red, color: solidText, boxShadow: 'none' },
    solidWarn: { background: C.amber, borderColor: C.amber, color: '#fff', boxShadow: 'none' },
    secondary: { background: C.surface2, borderColor: C.border2, color: C.text },
    default: { background: C.surface, borderColor: C.border,   color: C.text2 },
  };
  return (
    <button
      className="emr-btn"
      type={type || 'button'}
      disabled={disabled}
      title={title}
      onClick={disabled ? undefined : onClick}
      style={{ ...base, ...(variants[variant] || variants.default), ...style }}
      onMouseDown={e => { if (!disabled) e.currentTarget.style.transform = 'translateY(1px)'; }}
      onMouseUp={e => { e.currentTarget.style.transform = 'none'; }}
      onMouseLeave={e => { e.currentTarget.style.transform = 'none'; }}
    >
      {children}
    </button>
  );
}

// CSS animation injected once — dùng requestAnimationFrame để đảm bảo DOM đã sẵn sàng
function injectSharedStyles() {
  if (document.getElementById('emr-shared-styles')) return;
  const s = document.createElement('style');
  s.id = 'emr-shared-styles';
  s.textContent = `
    @keyframes spin { to { transform: rotate(360deg); } }
    @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:0.4} }
    @keyframes fadeIn { from{opacity:0;transform:translateY(4px)} to{opacity:1;transform:none} }
    @keyframes slideIn { from{opacity:0;transform:translateX(8px)} to{opacity:1;transform:none} }
    @keyframes softPulse { 0%,100%{box-shadow:0 0 0 0 rgba(37,99,235,0.20)} 50%{box-shadow:0 0 0 6px rgba(37,99,235,0.00)} }
  `;
  (document.head || document.documentElement).appendChild(s);
}

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', injectSharedStyles);
  } else {
    injectSharedStyles();
  }
}
