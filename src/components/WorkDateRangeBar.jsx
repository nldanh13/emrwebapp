import { C } from '../tokens.js';
import { Btn } from './shared.jsx';
import { defaultWorkDateRange, sanitizeWorkDateRange, workDateRangeLabel } from '../utils/workDateRange.js';

export default function WorkDateRangeBar({ value, onChange }) {
  const range = sanitizeWorkDateRange(value);
  const label = workDateRangeLabel(range);
  const longHint = 'Mặc định tự lấy ngày hôm nay khi mở app; có thể chỉnh lại nếu cần. Áp dụng chung cho lấy dữ liệu. Riêng Hành chánh/VTYT: nếu chọn 1 ngày thì quét VTYT ngày kế tiếp; nếu chọn nhiều ngày thì lấy ngày cuối khoảng.';
  const inputStyle = {
    background: C.surface,
    border: `1px solid ${C.border}`,
    borderRadius: 5,
    padding: '5px 8px',
    color: C.text,
    fontSize: 12,
    fontFamily: 'inherit',
    height: 30,
  };

  const update = (patch) => {
    onChange?.(sanitizeWorkDateRange({ ...range, ...patch }));
  };

  return (
    <div style={{
      background: C.surface,
      borderBottom: `1px solid ${C.border}`,
      padding: '6px 12px',
      display: 'flex',
      alignItems: 'center',
      gap: 7,
      flexWrap: 'wrap',
      flexShrink: 0,
    }}>
      <span style={{ fontSize: 10, fontWeight: 800, color: C.text3, letterSpacing: '0.06em', whiteSpace: 'nowrap' }}>
        KHOẢNG NGÀY
      </span>
      <input
        type="date"
        value={range.from}
        onChange={e => update({ from: e.target.value })}
        style={inputStyle}
      />
      <span style={{ color: C.text3, fontSize: 12 }}>→</span>
      <input
        type="date"
        value={range.to}
        onChange={e => update({ to: e.target.value })}
        style={inputStyle}
      />
      <Btn variant="default" onClick={() => onChange?.(defaultWorkDateRange())} style={{ padding: '5px 9px', fontSize: 11, minHeight: 30 }}>
        Hôm nay
      </Btn>
      <span title={longHint} style={{ color: C.text2, fontSize: 10.5, whiteSpace: 'nowrap' }}>
        {label}
      </span>
      <span title={longHint} style={{ color: C.text3, fontSize: 10.5, cursor: 'help' }}>ⓘ</span>
    </div>
  );
}
