import { C } from '../../tokens.js';
import { Btn, SectionLabel } from '../shared.jsx';
import { formatDmy, getDaySchedule, weekdayLabelFromIso } from './nurseScheduleUtils.js';

export default function NurseDatePanel({
  isMobile = false,
  dateRange,
  setDateRange,
  onApplyRange,
  visibleDates = [],
  schedule,
  selectedKey,
  setSelectedKey,
}) {
  return (
    <div style={isMobile ? { padding: '0 0 16px' } : {}}>
      <SectionLabel>Khoảng lịch</SectionLabel>
      <div style={{ padding: '8px 10px', borderBottom: `1px solid ${C.border2}`, display: 'grid', gap: 6 }}>
        <input type="date" value={dateRange.from}
          onChange={e => setDateRange(v => ({ ...v, from: e.target.value }))}
          style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 4, padding: '4px 6px', color: C.text, fontSize: 11, fontFamily: 'inherit', outline: 'none' }}
        />
        <input type="date" value={dateRange.to}
          onChange={e => setDateRange(v => ({ ...v, to: e.target.value }))}
          style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 4, padding: '4px 6px', color: C.text, fontSize: 11, fontFamily: 'inherit', outline: 'none' }}
        />
        <Btn variant="default" onClick={onApplyRange} style={{ justifyContent: 'center', fontSize: 11 }}>Hiển thị</Btn>
      </div>
      <SectionLabel>Ngày</SectionLabel>
      {visibleDates.map(iso => {
        const ds = getDaySchedule(schedule, iso);
        const selected = selectedKey === iso;
        return (
          <div key={iso} onClick={() => setSelectedKey(iso)} style={{
            padding: '8px 10px', cursor: 'pointer', fontSize: 12,
            background: selected ? C.surface2 : 'transparent',
            borderBottom: `1px solid ${C.border2}`,
            color: selected ? C.text : C.text2,
            fontWeight: selected ? 700 : 450,
          }}>
            <div style={{ fontVariantNumeric: 'tabular-nums', fontSize: 11 }}>{formatDmy(iso)}</div>
            <div style={{ color: C.text2, marginTop: 1 }}>{weekdayLabelFromIso(iso)}</div>
            <div style={{ fontSize: 10, color: C.text3, marginTop: 2 }}>{ds.admin.length} HC · {ds.work.length} làm · {ds.oncall.length} trực</div>
          </div>
        );
      })}
      <div onClick={() => setSelectedKey('Default')} style={{
        padding: '8px 10px', cursor: 'pointer', fontSize: 12,
        background: selectedKey === 'Default' ? C.surface2 : 'transparent',
        borderBottom: `1px solid ${C.border2}`,
        color: selectedKey === 'Default' ? C.text : C.text2,
        fontWeight: selectedKey === 'Default' ? 500 : 400,
      }}>
        <div>Mặc định</div>
        <div style={{ fontSize: 10, color: C.text3, marginTop: 2 }}>{(schedule.Default?.admin?.length || 0)} HC · {(schedule.Default?.work?.length || 0)} làm · {(schedule.Default?.oncall?.length || 0)} trực</div>
      </div>
    </div>
  );
}
