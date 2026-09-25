import { IconInfoCircle } from '@tabler/icons-react';
import { Btn } from './shared.jsx';
import DateField from './DateField.jsx';
import { defaultWorkDateRange, sanitizeWorkDateRange } from '../utils/workDateRange.js';

const LONG_HINT = 'Mặc định tự lấy ngày hôm nay khi mở app; có thể chỉnh lại nếu cần. Áp dụng chung cho lấy dữ liệu. Riêng Hành chánh/VTYT: nếu chọn 1 ngày thì quét VTYT ngày kế tiếp; nếu chọn nhiều ngày thì lấy ngày cuối khoảng.';

export default function WorkDateRangeBar({ value, onChange }) {
  const range = sanitizeWorkDateRange(value);
  const today = defaultWorkDateRange();
  const isToday = range.from === today.from && range.to === today.to;

  const update = (patch) => {
    onChange?.(sanitizeWorkDateRange({ ...range, ...patch }));
  };

  return (
    <div className="emr-datebar" role="group" aria-label="Khoảng ngày làm việc">
      <span className="emr-datebar__label">Khoảng ngày</span>
      <DateField label="Từ ngày" value={range.from} max={range.to} onChange={from => update({ from })} />
      <span className="emr-datebar__sep" aria-hidden="true">–</span>
      <DateField label="Đến ngày" value={range.to} min={range.from} onChange={to => update({ to })} />
      <Btn variant="default" disabled={isToday} onClick={() => onChange?.(today)} style={{ minHeight: 32, flexShrink: 0 }}>
        Hôm nay
      </Btn>
      <span className="emr-datebar__hint" title={LONG_HINT}>
        <IconInfoCircle size={15} stroke={1.75} aria-hidden="true" />
        Áp dụng cho mọi màn hình theo ngày
      </span>
    </div>
  );
}
