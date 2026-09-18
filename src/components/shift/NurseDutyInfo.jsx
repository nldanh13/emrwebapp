import { C } from '../../tokens.js';

export default function NurseDutyInfo({ lines = [] }) {
  if (!lines.length) return null;
  return (
    <div style={{ padding: '8px 14px', borderBottom: `1px solid ${C.border2}`, background: C.surface2, flexShrink: 0 }}>
      <div style={{ fontSize: 10.5, fontWeight: 700, color: C.text3, letterSpacing: '0.04em', marginBottom: 4 }}>
        ĐIỀU DƯỠNG THEO NGÀY
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
        {lines.map((line, idx) => (
          <div key={idx} style={{ fontSize: 11, color: C.text2, lineHeight: 1.5 }}>{line}</div>
        ))}
      </div>
    </div>
  );
}
