// Bảng tổng quan một tuần: mỗi cột một ngày, mỗi dòng một vị trí (hành chánh, ca làm, ca trực, điều dưỡng
// phòng khám, bác sĩ phòng khám). Tên lấy theo mẫu (không xếp riêng ngày đó) hiện chữ nhạt.
// Bấm vào cột để sửa ngày đó.
import { C, FS } from '../../tokens.js';
import { formatDmy, todayIso, weekdayLabelFromIso } from './nurseScheduleUtils.js';
import { clinicNamesFor, nurseDayFor } from './clinicSchedule.js';

const ROWS = [
  { id: 'admin', label: 'Hành chánh', get: (s, c, iso) => fromNurse(s, iso, 'admin') },
  { id: 'work', label: 'Ca làm', get: (s, c, iso) => fromNurse(s, iso, 'work') },
  { id: 'oncall', label: 'Ca trực', get: (s, c, iso) => fromNurse(s, iso, 'oncall') },
  { id: 'clinic-nurse', label: 'ĐD phòng khám', get: (s, c, iso) => clinicNamesFor(c, iso, 'work') },
  { id: 'clinic-doctor', label: 'BS phòng khám', get: (s, c, iso) => clinicNamesFor(c, iso, 'doctor') },
];

function fromNurse(schedule, iso, shift) {
  const { day, from } = nurseDayFor(schedule, iso);
  return { names: day[shift] || [], from };
}

export default function ScheduleWeekGrid({ dates, schedule, clinicSchedule, selectedKey, onSelect }) {
  const today = todayIso();
  const cellBase = { padding: '6px 8px', borderBottom: `1px solid ${C.border2}`, verticalAlign: 'top', fontSize: FS.sm };
  return (
    <div style={{ overflowX: 'auto', border: `1px solid ${C.border2}`, borderRadius: 8, background: C.surface }}>
      <table aria-label="Lịch tuần" style={{ width: '100%', borderCollapse: 'collapse', tableLayout: 'fixed', minWidth: 760 }}>
        <colgroup><col style={{ width: 118 }} />{dates.map(d => <col key={d} />)}</colgroup>
        <thead>
          <tr>
            <th style={{ ...cellBase, background: C.surface2 }} />
            {dates.map(iso => {
              const selected = iso === selectedKey;
              return (
                <th key={iso} style={{ ...cellBase, padding: 0, background: selected ? C.blueBg : C.surface2 }}>
                  <button type="button" onClick={() => onSelect(iso)} aria-current={selected ? 'date' : undefined}
                    aria-label={`Sửa lịch ${weekdayLabelFromIso(iso)} ${formatDmy(iso)}`}
                    style={{ width: '100%', padding: '6px 8px', border: 0, background: 'transparent', cursor: 'pointer', textAlign: 'left', fontFamily: 'inherit' }}>
                    <div style={{ fontSize: FS.xs, color: selected ? C.blue : C.text2, fontWeight: 600 }}>
                      {weekdayLabelFromIso(iso)}{iso === today ? ' · hôm nay' : ''}
                    </div>
                    <div style={{ fontSize: FS.md, color: selected ? C.blue : C.text, fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>
                      {formatDmy(iso).slice(0, 5)}
                    </div>
                  </button>
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {ROWS.map(row => (
            <tr key={row.id}>
              <th scope="row" style={{ ...cellBase, textAlign: 'left', color: C.text2, fontWeight: 600, fontSize: FS.xs, background: C.surface2 }}>{row.label}</th>
              {dates.map(iso => {
                const { names, from } = row.get(schedule, clinicSchedule, iso);
                const inherited = from && from !== 'day';
                return (
                  <td key={iso} onClick={() => onSelect(iso)} title={inherited ? 'Theo mẫu, chưa xếp riêng ngày này' : undefined}
                    style={{ ...cellBase, cursor: 'pointer', background: iso === selectedKey ? C.blueBg : 'transparent', color: inherited ? C.text3 : C.text, lineHeight: 1.45 }}>
                    {names.length ? names.map(n => <div key={n} style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{n}</div>)
                      : <span style={{ color: row.id === 'clinic-doctor' ? C.amber : C.text3 }}>—</span>}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
