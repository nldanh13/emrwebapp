import { C, FS } from '../../tokens.js';
import { isOddHour } from './reportUtils.js';
import { routeInfo } from '../../config/routes.js';

// Nút lọc bật/tắt (đường dùng, cữ thuốc…).
function Chip({ active, children, onClick, title }) {
  return (
    <button
      type="button"
      title={title}
      aria-pressed={active}
      onClick={onClick}
      style={{
        height: 30, padding: '0 10px', borderRadius: 5, cursor: 'pointer', flexShrink: 0,
        border: `1px solid ${active ? C.blueBorder : C.border2}`,
        background: active ? C.blueBg : C.surface, color: active ? C.blue : C.text,
        fontSize: FS.sm, fontWeight: active ? 650 : 500, fontFamily: 'inherit', whiteSpace: 'nowrap',
      }}
    >{children}</button>
  );
}

function SelectBox({ value, onChange, children, style = {}, label }) {
  return (
    <select
      value={value}
      aria-label={label}
      onChange={e => onChange(e.target.value)}
      style={{
        height: 32, background: C.surface, border: `1px solid ${C.border}`, color: C.text,
        borderRadius: 5, padding: '0 8px', fontFamily: 'inherit', fontSize: FS.sm, ...style,
      }}
    >{children}</select>
  );
}

function EmptyFilter() {
  return (
    <div style={{ color: C.text2, fontSize: FS.md, padding: 16, background: C.surface, border: `1px solid ${C.border2}`, borderRadius: 7 }}>
      Không có thuốc phù hợp với bộ lọc đang chọn.
    </div>
  );
}

function Th({ children, align = 'left' }) {
  return <th scope="col" style={{ padding: '8px 10px', fontWeight: 650, fontSize: FS.xs, color: C.text2, textAlign: align, whiteSpace: 'nowrap' }}>{children}</th>;
}

function Td({ children, align = 'left', num = false, style = {} }) {
  return (
    <td style={{ padding: '8px 10px', textAlign: align, verticalAlign: 'top', color: C.text, fontVariantNumeric: num ? 'tabular-nums' : undefined, ...style }}>
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
        display: 'inline-flex', alignItems: 'center', gap: 4, width: 'fit-content', whiteSpace: 'nowrap',
        color: odd ? C.amber : C.text,
        background: odd ? C.amberBg : C.surface2,
        border: `1px solid ${odd ? C.amberBorder : C.border2}`,
        borderRadius: 4, padding: '1px 6px', fontVariantNumeric: 'tabular-nums', fontSize: FS.sm, fontWeight: 650,
      }}
    >
      {row.timeText}
      {odd && <span style={{ fontSize: FS.xs, fontWeight: 500 }}>riêng</span>}
    </span>
  );
}

// Màu nhãn đường dùng lấy từ config/routes.json (trường "tone").
const TONES = {
  green: [C.green, C.greenBg, C.greenBorder],
  blue: [C.blue, C.blueBg, C.blueBorder],
  amber: [C.amber, C.amberBg, C.amberBorder],
  purple: [C.purple, C.purpleBg, C.purpleBorder],
  gray: [C.text2, C.surface2, C.border2],
};

function RouteBadge({ route }) {
  const [fg, bg, border] = TONES[routeInfo(route).tone] || TONES.gray;
  return <span style={{ display: 'inline-block', color: fg, background: bg, border: `1px solid ${border}`, borderRadius: 4, padding: '0 6px', lineHeight: 1.6, fontSize: FS.xs, fontWeight: 650, whiteSpace: 'nowrap' }}>{route || 'Khác'}</span>;
}

function TuTucMark() {
  return <span title="Thuốc tự túc" style={{ marginLeft: 6, color: C.amber, fontSize: FS.xs, fontWeight: 600 }}>(TT)</span>;
}

function formatQty(value) {
  const n = Number(value || 0);
  if (!Number.isFinite(n)) return '0';
  if (Math.abs(n - Math.round(n)) < 0.00001) return String(Math.round(n));
  return String(Number(n.toFixed(2)));
}

// Một dòng thuốc: giờ · tên thuốc · số lượng · đường dùng, ghi chú xuống dòng.
// Dùng flex-wrap để không tràn ngang trên điện thoại.
function MedRow({ time, name, tuTuc, quantity, unit, route, note, odd = false }) {
  return (
    <div style={{ padding: '7px 12px', borderTop: `1px solid ${C.border2}`, background: odd ? C.amberBg : 'transparent' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '4px 10px', flexWrap: 'wrap' }}>
        {time}
        <span style={{ flex: '1 1 160px', minWidth: 0, color: C.text, fontWeight: 650, fontSize: FS.md }}>
          {name}{tuTuc && <TuTucMark />}
        </span>
        <span style={{ color: C.text, fontVariantNumeric: 'tabular-nums', fontSize: FS.md, whiteSpace: 'nowrap' }}>{quantity} {unit}</span>
        <RouteBadge route={route} />
      </div>
      {note && <div style={{ color: C.text2, fontSize: FS.xs, marginTop: 2 }}>{note}</div>}
    </div>
  );
}

// Khung một người bệnh trong danh sách thuốc.
function PatientMedGroup({ room, patientName, meta, children }) {
  return (
    <section style={{ border: `1px solid ${C.border2}`, borderRadius: 7, background: C.surface, overflow: 'hidden' }}>
      <header style={{ display: 'flex', alignItems: 'baseline', gap: 8, padding: '8px 12px', background: C.surface2, flexWrap: 'wrap' }}>
        <span style={{ color: C.text2, fontSize: FS.sm, fontWeight: 650, fontVariantNumeric: 'tabular-nums' }}>{room}</span>
        <b style={{ color: C.text, fontSize: FS.md, flex: 1, minWidth: 0 }}>{patientName}</b>
        {meta && <span style={{ color: C.text2, fontSize: FS.xs }}>{meta}</span>}
      </header>
      {children}
    </section>
  );
}

export {
  Chip,
  SelectBox,
  EmptyFilter,
  Th,
  Td,
  TimeBadge,
  RouteBadge,
  TuTucMark,
  MedRow,
  PatientMedGroup,
  formatQty,
};
