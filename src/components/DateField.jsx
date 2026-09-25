import { useRef } from 'react';
import { IconCalendar } from '@tabler/icons-react';

// Ô chọn ngày luôn hiển thị dd/mm/yyyy, bất kể ngôn ngữ của trình duyệt (input type=date
// tự hiện theo locale, nên máy tiếng Anh sẽ ra mm/dd/yyyy). Bấm vào để mở lịch gốc của trình duyệt.
// value / onChange dùng chuỗi ISO yyyy-mm-dd như input type=date.

export function formatDmy(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ''));
  return m ? `${m[3]}/${m[2]}/${m[1]}` : '';
}

export default function DateField({ value, onChange, label, min, max, placeholder = 'dd/mm/yyyy' }) {
  const inputRef = useRef(null);
  const text = formatDmy(value);

  const openPicker = () => {
    const input = inputRef.current;
    if (!input) return;
    try {
      if (typeof input.showPicker === 'function') { input.showPicker(); return; }
    } catch { /* một số trình duyệt chặn showPicker; rơi xuống focus */ }
    input.focus();
    input.click();
  };

  return (
    <span className="emr-datefield">
      <button type="button" className="emr-datefield__button" onClick={openPicker} aria-label={label ? `${label}: ${text || 'chưa chọn'}` : undefined}>
        <IconCalendar size={16} stroke={1.75} aria-hidden="true" />
        <span>{text || placeholder}</span>
      </button>
      <input
        ref={inputRef}
        type="date"
        className="emr-datefield__native"
        value={value || ''}
        min={min}
        max={max}
        tabIndex={-1}
        aria-hidden="true"
        onChange={e => onChange?.(e.target.value)}
      />
    </span>
  );
}
