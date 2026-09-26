import { C, FS } from '../../tokens.js';
import { Btn, SectionLabel } from '../shared.jsx';
import DateField from '../DateField.jsx';
import { formatDmy, getDaySchedule, todayIso, weekdayLabelFromIso } from './nurseScheduleUtils.js';

function countLine(ds) {
  return `${ds.admin?.length || 0} HC · ${ds.work?.length || 0} làm · ${ds.oncall?.length || 0} trực`;
}

function DayButton({ selected, onClick, title, subtitle, counts, empty }) {
  return (
    <button type="button" onClick={onClick} aria-current={selected ? 'true' : undefined} style={{
      display: 'block', width: '100%', textAlign: 'left', padding: '8px 12px', cursor: 'pointer', fontFamily: 'inherit',
      border: 0, borderBottom: `1px solid ${C.border2}`,
      background: selected ? C.blueBg : 'transparent',
    }}>
      <span style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
        <b style={{ fontSize: FS.md, fontWeight: selected ? 700 : 600, color: selected ? C.blue : C.text, fontVariantNumeric: 'tabular-nums' }}>{title}</b>
        {subtitle && <span style={{ fontSize: FS.xs, color: selected ? C.blue : C.text2 }}>{subtitle}</span>}
      </span>
      <span style={{ display: 'block', fontSize: FS.xs, color: empty ? C.amber : C.text2, marginTop: 2 }}>
        {empty ? 'Chưa phân công' : counts}
      </span>
    </button>
  );
}

export default function NurseDatePanel({
  dateRange,
  setDateRange,
  onApplyRange,
  visibleDates = [],
  schedule,
  selectedKey,
  setSelectedKey,
}) {
  const today = todayIso();
  const def = schedule.Default || {};
  const defEmpty = !((def.admin?.length || 0) + (def.work?.length || 0) + (def.oncall?.length || 0));
  return (
    <div>
      <SectionLabel>Khoảng lịch</SectionLabel>
      <div style={{ padding: '4px 12px 10px', borderBottom: `1px solid ${C.border2}`, display: 'grid', gap: 6 }}>
        <DateField label="Từ ngày" value={dateRange.from} onChange={iso => setDateRange(v => ({ ...v, from: iso }))} />
        <DateField label="Đến ngày" value={dateRange.to} onChange={iso => setDateRange(v => ({ ...v, to: iso }))} />
        <Btn onClick={onApplyRange} style={{ justifyContent: 'center' }}>Hiển thị</Btn>
      </div>
      <SectionLabel>Ngày</SectionLabel>
      <nav aria-label="Chọn ngày">
        {visibleDates.map(iso => {
          const ds = getDaySchedule(schedule, iso);
          const empty = !(ds.admin.length + ds.work.length + ds.oncall.length);
          return (
            <DayButton
              key={iso}
              selected={selectedKey === iso}
              onClick={() => setSelectedKey(iso)}
              title={formatDmy(iso)}
              subtitle={`${weekdayLabelFromIso(iso)}${iso === today ? ' · hôm nay' : ''}`}
              counts={countLine(ds)}
              empty={empty}
            />
          );
        })}
        <DayButton
          selected={selectedKey === 'Default'}
          onClick={() => setSelectedKey('Default')}
          title="Mẫu mặc định"
          counts={countLine(def)}
          empty={defEmpty}
        />
      </nav>
    </div>
  );
}
