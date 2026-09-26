import { IconCheck } from '@tabler/icons-react';
import { C, FS } from '../../tokens.js';

// Màu theo loại ca, dùng chung cho máy tính và điện thoại.
export const SHIFT_META = {
  admin: { label: 'Điều dưỡng hành chánh', short: 'HC', fg: C.amber, bg: C.amberBg, border: C.amberBorder },
  work: { label: 'Ca làm', short: 'Làm', fg: C.green, bg: C.greenBg, border: C.greenBorder },
  oncall: { label: 'Ca trực', short: 'Trực', fg: C.blue, bg: C.blueBg, border: C.blueBorder },
};

// Nút bật/tắt một điều dưỡng trong một ca.
export function ShiftToggle({ name, active, shift, onClick, large = false }) {
  const tone = SHIFT_META[shift] || SHIFT_META.oncall;
  return (
    <button type="button" aria-pressed={active} onClick={onClick} style={{
      display: 'inline-flex', alignItems: 'center', gap: 5,
      minHeight: large ? 40 : 34, padding: large ? '0 14px' : '0 12px', borderRadius: 5, border: '1px solid',
      cursor: 'pointer', fontSize: large ? 14 : FS.md, fontFamily: 'inherit',
      background: active ? tone.bg : C.surface,
      borderColor: active ? tone.border : C.border,
      color: active ? tone.fg : C.text2,
      fontWeight: active ? 650 : 450,
    }}>
      {active && <IconCheck size={15} stroke={2.2} aria-hidden="true" />}
      {name}
    </button>
  );
}

// Một nhóm ca: tiêu đề + số người + các nút tên.
export function ShiftBucket({ label, shift, roster, selected = [], onToggle, emptyText, hint, large = false }) {
  const tone = SHIFT_META[shift] || SHIFT_META.oncall;
  return (
    <section style={{ marginBottom: 16 }}>
      <h3 style={{ margin: 0, display: 'flex', alignItems: 'center', gap: 8, fontSize: FS.lg, fontWeight: 650, color: C.text }}>
        <span aria-hidden="true" style={{ width: 8, height: 8, borderRadius: 999, background: tone.fg }} />
        {label || tone.label}
        <span style={{ fontSize: FS.sm, fontWeight: 500, color: C.text2 }}>{selected.length} người</span>
      </h3>
      {hint && <div style={{ fontSize: FS.xs, color: C.text2, marginTop: 2 }}>{hint}</div>}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 8 }}>
        {roster.map(name => (
          <ShiftToggle key={name} name={name} shift={shift} active={selected.includes(name)} onClick={() => onToggle(shift, name)} large={large} />
        ))}
        {roster.length === 0 && <div style={{ fontSize: FS.sm, color: C.text2 }}>{emptyText}</div>}
      </div>
    </section>
  );
}
