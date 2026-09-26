import { useEffect, useMemo, useState } from 'react';
import { IconClock, IconSun, IconMoon } from '@tabler/icons-react';
import { C, FS } from '../../tokens.js';
import {
  addDaysDmy, getDaySchedule, dayTypeOf, firstName,
  normalizeTime, timeToMinutes, isMorningRow, isAfterWorkOrEarlyNext,
  isOddHour, todayDmy, parseDmy, rowMinutes,
} from './reportUtils.js';
import { Chip, EmptyFilter, MedRow, PatientMedGroup, SelectBox, TimeBadge, formatQty } from './ReportShared.jsx';
import { RouteFilterStrip } from './RouteFilters.jsx';

const MORNING_DISPENSE_END = 13 * 60;
const NON_ORAL_ROUTES = new Set(['TMC', 'TTM', 'TB', 'TDD', 'Khác']);
const WEEKDAY_VI = ['Chủ Nhật', 'Thứ Hai', 'Thứ Ba', 'Thứ Tư', 'Thứ Năm', 'Thứ Sáu', 'Thứ Bảy'];
const MAIN_DUTY_SLOTS = [
  { id: '08:00', label: 'Cữ 08:00', minutes: 8 * 60 },
  { id: '16:00', label: 'Cữ 16:00', minutes: 16 * 60 },
  { id: '20:00', label: 'Cữ 20:00', minutes: 20 * 60 },
  { id: '22:00', label: 'Cữ 22:00', minutes: 22 * 60 },
];
const UNKNOWN_DUTY_SLOT = { id: 'unknown', label: 'Chưa rõ giờ', minutes: null };
const DUTY_SLOT_TABS = [...MAIN_DUTY_SLOTS, UNKNOWN_DUTY_SLOT];
const FOUR_DOSE_SLOTS = [0, 6 * 60, 12 * 60, 18 * 60];
const FOUR_DOSE_TOLERANCE = 20;
const CONTINUOUS_SEQUENCE_GAP = 150;

function compareDutyRows(selectedDate) {
  return (a, b) => {
    const da = a.date === selectedDate ? 0 : 1;
    const db = b.date === selectedDate ? 0 : 1;
    if (da !== db) return da - db;
    const ta = rowMinutes(a);
    const tb = rowMinutes(b);
    if (ta !== tb) return ta - tb;
    return String(a.room || '').localeCompare(String(b.room || ''), 'vi', { numeric: true })
      || String(a.patientName || '').localeCompare(String(b.patientName || ''), 'vi')
      || String(a.drugName || '').localeCompare(String(b.drugName || ''), 'vi');
  };
}

function currentClock() {
  const now = new Date();
  const minutes = now.getHours() * 60 + now.getMinutes();
  return {
    minutes,
    text: `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`,
  };
}

function weekdayLabel(dmy) {
  const d = parseDmy(dmy);
  if (!d) return '';
  return WEEKDAY_VI[d.getDay()] || '';
}

function scheduleFlags(dayCfg) {
  const adminCount = Array.isArray(dayCfg?.admin) ? dayCfg.admin.filter(Boolean).length : 0;
  const workCount = Array.isArray(dayCfg?.work) ? dayCfg.work.filter(Boolean).length : 0;
  const oncallCount = Array.isArray(dayCfg?.oncall) ? dayCfg.oncall.filter(Boolean).length : 0;
  const daytimeCount = adminCount + workCount;
  const isDuty = !daytimeCount && oncallCount > 0;
  const hasBoth = daytimeCount > 0 && oncallCount > 0;
  const isEmpty = !daytimeCount && !oncallCount;

  return {
    isDuty,
    hasBoth,
    isEmpty,
    isWorkDay: !isDuty,
    label: isDuty ? 'Ngày trực' : 'Ngày làm việc bình thường',
  };
}

function scenarioOf(todayFlag, tomorrowFlag) {
  if (!todayFlag.isDuty) {
    return {
      id: 'work_to_duty',
      title: 'Người làm bàn giao cho Người trực',
      short: 'Soạn thuốc sau giờ hành chính cho ca trực.',
      tone: 'blue',
    };
  }
  if (tomorrowFlag.isDuty) {
    return {
      id: 'duty_to_duty',
      title: 'Người trực bàn giao cho Người trực',
      short: 'Chuẩn bị thuốc cữ sáng ngày mai.',
      tone: 'amber',
    };
  }
  return {
    id: 'duty_to_work',
    title: 'Người trực bàn giao cho Người làm',
    short: 'Chỉ thực hiện cữ còn lại, không soạn thuốc sáng mai.',
    tone: 'green',
  };
}

function toneStyle(tone) {
  if (tone === 'green') return { color: C.green, bg: C.greenBg, border: C.greenBorder };
  if (tone === 'amber') return { color: C.amber, bg: C.amberBg, border: C.amberBorder };
  return { color: C.blue, bg: C.blueBg, border: C.blueBorder };
}

function rowKey(row) {
  return String(row?.id || `${row?.date}|${row?.time}|${row?.patientId}|${row?.drugName}|${row?.route}`);
}

function patientKey(row) {
  return String(row?.patientId || row?.patientName || '').trim();
}

function roomOf(row) {
  return String(row?.room || '—').trim() || '—';
}

function isNonOralAction(row) {
  return row?.route !== 'Uống' && row?.route !== 'Ngưng/Trả' && NON_ORAL_ROUTES.has(row?.route || 'Khác');
}

function isFutureOrCurrentRow(row, selectedDate, currentMinutes) {
  const cutoff = Number(row?.dischargeCutoffMinutes);
  const isToday = selectedDate === todayDmy();
  if (Number.isFinite(cutoff) && row?.date === selectedDate && isToday && currentMinutes > cutoff) return false;

  const m = rowMinutes(row);
  if (!Number.isFinite(m) || m >= 9999) return row?.date === selectedDate;

  if (row?.date === selectedDate) {
    if (selectedDate !== todayDmy()) return true;
    return m >= currentMinutes;
  }

  // Các cữ 00:00–06:59 của y lệnh ngày đang xem được extractTimes gắn sang
  // ngày kế tiếp. Chúng vẫn thuộc phần ca đêm cần thực hiện và không được rơi mất.
  const nextDate = addDaysDmy(selectedDate, 1);
  return row?.date === nextDate && m < 7 * 60;
}

function sortByRoomPatient(rows, selectedDate) {
  return [...(rows || [])].sort(compareDutyRows(selectedDate));
}

function buildRooms(rows) {
  return [...new Set((rows || []).map(roomOf).filter(Boolean))]
    .sort((a, b) => String(a).localeCompare(String(b), 'vi', { numeric: true }));
}

function groupByPatient(rows) {
  const map = new Map();
  for (const row of rows || []) {
    const key = `${roomOf(row)}|${patientKey(row) || row.patientName}`;
    if (!map.has(key)) {
      map.set(key, {
        key,
        room: roomOf(row),
        patientName: row.patientName || '—',
        patientId: row.patientId || '',
        rows: [],
      });
    }
    map.get(key).rows.push(row);
  }
  return [...map.values()].map(g => ({ ...g, rows: sortByRoomPatient(g.rows, '') }))
    .sort((a, b) => String(a.room).localeCompare(String(b.room), 'vi', { numeric: true })
      || String(a.patientName).localeCompare(String(b.patientName), 'vi'));
}

function groupOralByPatient(rows) {
  const patients = new Map();
  for (const row of rows || []) {
    const pKey = `${roomOf(row)}|${patientKey(row) || row.patientName}`;
    if (!patients.has(pKey)) {
      patients.set(pKey, {
        key: pKey,
        doneKey: `oral|${row.date}|${patientKey(row) || row.patientName}`,
        room: roomOf(row),
        patientName: row.patientName || '—',
        patientId: row.patientId || '',
        drugs: new Map(),
      });
    }
    const patient = patients.get(pKey);
    const dKey = `${String(row.drugName || '').toLowerCase()}|${row.unit || ''}|${row.tuTuc ? 'tt' : ''}`;
    if (!patient.drugs.has(dKey)) {
      patient.drugs.set(dKey, {
        drugName: row.drugName,
        unit: row.unit,
        quantity: 0,
        times: new Set(),
        tuTuc: row.tuTuc,
        note: row.note || '',
      });
    }
    const drug = patient.drugs.get(dKey);
    drug.quantity += Number(row.quantity || 0);
    if (row.time && row.time !== '—') drug.times.add(row.time);
  }

  return [...patients.values()].map(p => ({
    ...p,
    drugs: [...p.drugs.values()].map(d => ({ ...d, times: [...d.times].sort() }))
      .sort((a, b) => String(a.drugName).localeCompare(String(b.drugName), 'vi')),
  })).sort((a, b) => String(a.room).localeCompare(String(b.room), 'vi', { numeric: true })
    || String(a.patientName).localeCompare(String(b.patientName), 'vi'));
}

function applyFilters(rows, { roomFilter }) {
  return (rows || []).filter(row => roomFilter === 'all' || roomOf(row) === roomFilter);
}

function applyPatientFilters(groups, { roomFilter }) {
  return (groups || []).filter(group => roomFilter === 'all' || group.room === roomFilter);
}

function SmartHeader({ date, nextDate, todaySched, nextSched, scenario, clock }) {
  const todayFlag = scheduleFlags(todaySched);
  const tomorrowFlag = scheduleFlags(nextSched);
  const style = toneStyle(scenario.tone);
  const todayNames = [
    ...(todaySched?.admin?.length ? [`HC: ${todaySched.admin.join(', ')}`] : []),
    ...(todaySched?.work?.length ? [`Làm: ${todaySched.work.join(', ')}`] : []),
    ...(todaySched?.oncall?.length ? [`Trực: ${todaySched.oncall.join(', ')}`] : []),
  ].join(' · ');
  const tomorrowNames = [
    ...(nextSched?.admin?.length ? [`HC: ${nextSched.admin.join(', ')}`] : []),
    ...(nextSched?.work?.length ? [`Làm: ${nextSched.work.join(', ')}`] : []),
    ...(nextSched?.oncall?.length ? [`Trực: ${nextSched.oncall.join(', ')}`] : []),
  ].join(' · ');

  const DayIcon = todayFlag.isDuty ? IconMoon : IconSun;
  return (
    <section aria-label="Kịch bản bàn giao" style={{ border: `1px solid ${style.border}`, background: style.bg, borderRadius: 7, padding: '12px 14px' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', flexWrap: 'wrap', gap: '2px 10px' }}>
        <h2 style={{ margin: 0, fontSize: FS.xl, fontWeight: 700, color: style.color }}>{scenario.title}</h2>
        <span style={{ fontSize: FS.md, color: C.text }}>{scenario.short}</span>
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 16px', marginTop: 8, fontSize: FS.sm, color: C.text2 }}>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
          <IconClock size={15} stroke={1.75} aria-hidden="true" /> Bây giờ {clock.text}
        </span>
        <span>
          <DayIcon size={15} stroke={1.75} aria-hidden="true" style={{ verticalAlign: '-3px', marginRight: 5 }} />
          Hôm nay {weekdayLabel(date)} {date}: <b style={{ color: C.text, fontWeight: 650 }}>{todayFlag.label.toLowerCase()}</b>
        </span>
        <span>
          Ngày mai {weekdayLabel(nextDate)}: <b style={{ color: tomorrowFlag.isDuty ? C.amber : C.text, fontWeight: 650 }}>{tomorrowFlag.label.toLowerCase()}</b>
        </span>
      </div>
      <div style={{ display: 'grid', gap: 2, marginTop: 6, fontSize: FS.xs, color: C.text2 }}>
        <span>Hôm nay: {todayNames || 'chưa phân công'}</span>
        <span>Ngày mai: {tomorrowNames || 'chưa phân công, xem là ngày làm việc bình thường'}</span>
      </div>
    </section>
  );
}

function QuickFilters({ rooms, roomFilter, setRoomFilter }) {
  return (
    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', justifyContent: 'flex-end' }}>
      <SelectBox label="Lọc theo phòng" value={roomFilter} onChange={setRoomFilter}>
        <option value="all">Tất cả phòng</option>
        {rooms.map(room => <option key={room} value={room}>Phòng {room}</option>)}
      </SelectBox>
    </div>
  );
}

function Panel({ title, subtitle, children, right }) {
  return (
    <section style={{ border: `1px solid ${C.border}`, background: C.surface, borderRadius: 7, overflow: 'hidden', minWidth: 0 }}>
      <header style={{ padding: '10px 12px', borderBottom: `1px solid ${C.border2}`, display: 'flex', gap: 8, alignItems: 'flex-start', justifyContent: 'space-between', flexWrap: 'wrap' }}>
        <div style={{ flex: '1 1 220px', minWidth: 0 }}>
          <h3 style={{ margin: 0, color: C.text, fontWeight: 700, fontSize: FS.lg }}>{title}</h3>
          {subtitle && <div style={{ color: C.text2, fontSize: FS.xs, marginTop: 3, lineHeight: 1.45 }}>{subtitle}</div>}
        </div>
        {right}
      </header>
      {children}
    </section>
  );
}

function CountNote({ children }) {
  return <span style={{ color: C.text2, fontSize: FS.sm, whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' }}>{children}</span>;
}

function OralDispenseGroup({ oralGroups }) {
  if (!oralGroups.length) return null;
  return (
    <Panel
      title="Nhóm 1: Phát thuốc uống"
      subtitle="Thuốc uống chỉ gom thành một danh sách phát trong ngày, không tách thành nhiều cữ chiều/tối."
    >
      <div style={{ display: 'grid', gap: 8, padding: 10 }}>
        {oralGroups.map(group => (
          <PatientMedGroup key={group.key} room={group.room} patientName={group.patientName} meta={`${group.drugs.length} thuốc uống`}>
            {group.drugs.map((drug, idx) => (
              <MedRow
                key={`${group.key}-${idx}`}
                name={drug.drugName}
                tuTuc={drug.tuTuc}
                quantity={formatQty(drug.quantity)}
                unit={drug.unit}
                route="Uống"
                note={drug.times.length ? `Giờ uống: ${drug.times.join(' · ')}` : 'Uống cả ngày'}
              />
            ))}
          </PatientMedGroup>
        ))}
      </div>
    </Panel>
  );
}

function distanceOnClock(a, b) {
  const diff = Math.abs(Number(a) - Number(b));
  return Math.min(diff, 24 * 60 - diff);
}

function nearestDutySlotId(row) {
  const minutes = rowMinutes(row);
  if (!Number.isFinite(minutes) || minutes >= 9999) return UNKNOWN_DUTY_SLOT.id;
  let best = MAIN_DUTY_SLOTS[0];
  let bestDistance = Infinity;
  for (const slot of MAIN_DUTY_SLOTS) {
    const distance = distanceOnClock(minutes, slot.minutes);
    if (distance < bestDistance || (distance === bestDistance && slot.minutes > best.minutes)) {
      best = slot;
      bestDistance = distance;
    }
  }
  return best.id;
}

function isNearFourDoseSlot(minutes) {
  return FOUR_DOSE_SLOTS.some(target => distanceOnClock(minutes, target) <= FOUR_DOSE_TOLERANCE);
}

function fourDoseKey(row) {
  return [
    patientKey(row) || row.patientName || '',
    String(row.drugName || '').toLowerCase(),
    row.route || '',
    row.unit || '',
    row.category || '',
  ].join('|');
}

function splitFourDoseRows(rows) {
  const byDrug = new Map();
  for (const row of rows || []) {
    const minutes = rowMinutes(row);
    if (!Number.isFinite(minutes) || minutes >= 9999) continue;
    const key = fourDoseKey(row);
    if (!byDrug.has(key)) byDrug.set(key, []);
    byDrug.get(key).push(row);
  }

  const fourDoseIds = new Set();
  for (const groupRows of byDrug.values()) {
    const matched = FOUR_DOSE_SLOTS.filter(slot =>
      groupRows.some(row => distanceOnClock(rowMinutes(row), slot) <= FOUR_DOSE_TOLERANCE)
    );
    if (matched.length < 3) continue;
    for (const row of groupRows) {
      if (isNearFourDoseSlot(rowMinutes(row))) fourDoseIds.add(rowKey(row));
    }
  }

  return {
    regularRows: (rows || []).filter(row => !fourDoseIds.has(rowKey(row))),
    fourDoseRows: (rows || []).filter(row => fourDoseIds.has(rowKey(row))),
  };
}

function isContinuousCandidate(row) {
  return row?.route === 'TTM' || row?.category === 'dich_truyen';
}

function assignRowsToDutySlots(rows) {
  const assigned = (rows || []).map(row => ({
    ...row,
    _dutySlot: nearestDutySlotId(row),
    _dutySlotNote: '',
  }));

  const byPatientDate = new Map();
  for (const row of assigned) {
    if (!isContinuousCandidate(row)) continue;
    const key = `${patientKey(row) || row.patientName}|${row.date || ''}`;
    if (!byPatientDate.has(key)) byPatientDate.set(key, []);
    byPatientDate.get(key).push(row);
  }

  for (const patientRows of byPatientDate.values()) {
    const sorted = patientRows
      .filter(row => Number.isFinite(rowMinutes(row)) && rowMinutes(row) < 9999)
      .sort((a, b) => rowMinutes(a) - rowMinutes(b));
    let sequenceSlot = '';
    let previousMinutes = null;
    for (const row of sorted) {
      const minutes = rowMinutes(row);
      if (previousMinutes == null || Math.abs(minutes - previousMinutes) > CONTINUOUS_SEQUENCE_GAP) {
        sequenceSlot = nearestDutySlotId(row);
      } else if (sequenceSlot) {
        const oldSlot = row._dutySlot;
        row._dutySlot = sequenceSlot;
        if (oldSlot !== sequenceSlot) row._dutySlotNote = `Thuốc truyền nối tiếp, gộp theo cữ bắt đầu ${sequenceSlot}`;
      }
      previousMinutes = minutes;
    }
  }

  return assigned;
}

function FourDosePanel({ rows }) {
  if (!rows.length) return null;
  return (
    <Panel
      title="Thuốc 4 cữ riêng"
      subtitle="Các thuốc dạng 4 cữ/ngày, thường 00:00 - 06:00 - 12:00 - 18:00, được để riêng để tránh nhầm với 4 cữ gom chính."
      right={<CountNote>{rows.length} dòng</CountNote>}
    >
      <MedicationRowsTable groups={groupByPatient(rows)} />
    </Panel>
  );
}

function TimelineMedicationPanel({ rows, activeTime, setActiveTime }) {
  const { regularRows, fourDoseRows } = useMemo(() => splitFourDoseRows(rows), [rows]);
  const assignedRows = useMemo(() => assignRowsToDutySlots(regularRows), [regularRows]);
  const slotCounts = useMemo(() => {
    const counts = new Map(DUTY_SLOT_TABS.map(slot => [slot.id, 0]));
    for (const row of assignedRows) counts.set(row._dutySlot, (counts.get(row._dutySlot) || 0) + 1);
    return counts;
  }, [assignedRows]);

  useEffect(() => {
    if (!DUTY_SLOT_TABS.some(slot => slot.id === activeTime)) {
      const firstWithRows = DUTY_SLOT_TABS.find(slot => (slotCounts.get(slot.id) || 0) > 0);
      setActiveTime(firstWithRows?.id || DUTY_SLOT_TABS[0].id);
    }
  }, [activeTime, setActiveTime, slotCounts]);

  const selectedTime = DUTY_SLOT_TABS.some(slot => slot.id === activeTime) ? activeTime : DUTY_SLOT_TABS[0].id;
  const selectedRows = assignedRows.filter(row => row._dutySlot === selectedTime);
  const patientGroups = groupByPatient(selectedRows);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <Panel
        title="Nhóm 2: Lịch tiêm/truyền"
        subtitle="Bốn cữ chính: 08:00, 16:00, 20:00, 22:00. Các giờ lẻ được gộp vào cữ gần nhất; y lệnh chưa xác định giờ nằm ở nhóm riêng."
        right={<CountNote>{assignedRows.length} dòng thuốc</CountNote>}
      >
        <div role="group" aria-label="Chọn cữ" style={{ display: 'flex', gap: 6, flexWrap: 'wrap', padding: 10, borderBottom: `1px solid ${C.border2}` }}>
          {DUTY_SLOT_TABS.map(slot => (
            <Chip key={slot.id} active={selectedTime === slot.id} onClick={() => setActiveTime(slot.id)}>
              {slot.label} <span style={{ color: selectedTime === slot.id ? C.blue : C.text2, fontVariantNumeric: 'tabular-nums' }}>{slotCounts.get(slot.id) || 0}</span>
            </Chip>
          ))}
        </div>
        {patientGroups.length ? (
          <MedicationRowsTable groups={patientGroups} />
        ) : (
          <div style={{ color: C.text2, padding: 12, fontSize: FS.sm }}>Không có thuốc trong cữ này.</div>
        )}
      </Panel>
      <FourDosePanel rows={fourDoseRows} />
    </div>
  );
}

function MedicationRowsTable({ groups }) {
  if (!groups.length) return <div style={{ color: C.text2, padding: 12, fontSize: FS.sm }}>Không có thuốc trong nhóm này.</div>;
  return (
    <div style={{ display: 'grid', gap: 8, padding: 10 }}>
      {groups.map(group => (
        <PatientMedGroup key={group.key} room={group.room} patientName={group.patientName} meta={`${group.rows.length} dòng`}>
          {group.rows.map(row => {
            const slotNote = row._dutySlotNote || (row._dutySlot && row.time !== row._dutySlot ? `Gộp vào cữ ${row._dutySlot}` : '');
            return (
              <MedRow
                key={rowKey(row)}
                time={<TimeBadge row={row} />}
                name={row.drugName}
                tuTuc={row.tuTuc}
                quantity={formatQty(row.quantity)}
                unit={row.unit}
                route={row.route}
                note={slotNote || (row.mixWith ? `Pha với: ${row.mixWith}` : row.note)}
                odd={isOddHour(row)}
              />
            );
          })}
        </PatientMedGroup>
      ))}
    </div>
  );
}

function PrepPanel({ scenario, prepRows, nextDate }) {
  if (scenario.id === 'duty_to_work') {
    return (
      <Panel
        title="Soạn thuốc và bàn giao"
        subtitle="Khu vực tự động đổi nội dung theo kịch bản bàn giao."
      >
        <div style={{ margin: 10, border: `1px solid ${C.greenBorder}`, background: C.greenBg, color: C.green, borderRadius: 7, padding: 14, fontWeight: 650, fontSize: FS.md }}>
          Bạn là ca trực cuối. Không cần soạn thuốc cữ sáng ngày mai.
        </div>
      </Panel>
    );
  }

  const title = scenario.id === 'work_to_duty'
    ? 'Danh sách thuốc Tiêm/Truyền cần soạn cho ca trực đêm'
    : `Danh sách thuốc cữ sáng mai (${nextDate}) cần chuẩn bị`;
  const subtitle = scenario.id === 'work_to_duty'
    ? 'Tự động lọc TMC, TTM, TB, TDD, dịch truyền/thuốc khác sau giờ hành chính; không đưa thuốc uống vào danh sách soạn trực đêm.'
    : 'Tự động lấy cữ sáng ngày mai, gồm cả thuốc uống và thuốc tiêm/truyền.';

  return (
    <Panel title={title} subtitle={subtitle} right={<CountNote>{prepRows.length} dòng</CountNote>}>
      <MedicationRowsTable groups={groupByPatient(prepRows)} />
    </Panel>
  );
}

function DutyReport({ date, rows, nextMorningRows, nurseState, routeOptions, selectedRoutes, onToggleRoute, onClearRoutes }) {
  const [roomFilter, setRoomFilter] = useState('all');
  const [activeTime, setActiveTime] = useState('');

  const schedule = nurseState?.schedule || {};
  const todaySched = getDaySchedule(schedule, date);
  const nextDate = addDaysDmy(date, 1);
  const nextSched = getDaySchedule(schedule, nextDate);
  const todayFlag = scheduleFlags(todaySched);
  const tomorrowFlag = scheduleFlags(nextSched);
  const scenario = scenarioOf(todayFlag, tomorrowFlag);
  const [clock, setClock] = useState(() => currentClock());

  useEffect(() => {
    const tick = () => setClock(currentClock());
    tick();
    const timer = window.setInterval(tick, 30 * 1000);
    return () => window.clearInterval(timer);
  }, []);

  const oralVisibleNow = date === todayDmy() && clock.minutes < MORNING_DISPENSE_END;

  const oralRows = useMemo(() => (rows || []).filter(row => row.route === 'Uống' && row.date === date), [rows, date]);
  const oralGroupsRaw = useMemo(() => groupOralByPatient(oralRows), [oralRows]);

  const actionRowsRaw = useMemo(() => (rows || [])
    .filter(row => isNonOralAction(row))
    .filter(row => isFutureOrCurrentRow(row, date, clock.minutes)), [rows, date, clock.minutes]);

  const prepRowsRaw = useMemo(() => {
    if (scenario.id === 'work_to_duty') {
      return (rows || [])
        .filter(row => isNonOralAction(row))
        // Nếu BN ra viện trong ngày và y lệnh không có giờ, không được tự đưa
        // y lệnh đó vào danh sách SOẠN CA ĐÊM vì không chứng minh được là sau giờ HC.
        .filter(row => !(row?.noTime && row?.dischargeCutoffMinutes != null))
        .filter(row => isAfterWorkOrEarlyNext(row, date));
    }
    if (scenario.id === 'duty_to_duty') {
      return nextMorningRows || [];
    }
    return [];
  }, [rows, nextMorningRows, scenario.id, date]);

  const rooms = useMemo(() => buildRooms([...rows, ...(nextMorningRows || [])]), [rows, nextMorningRows]);

  useEffect(() => {
    if (roomFilter !== 'all' && !rooms.includes(roomFilter)) setRoomFilter('all');
  }, [rooms, roomFilter]);

  const oralGroups = oralVisibleNow ? applyPatientFilters(oralGroupsRaw, { roomFilter }) : [];
  const actionRows = applyFilters(actionRowsRaw, { roomFilter });
  const prepRows = applyFilters(prepRowsRaw, { roomFilter });

  const todayType = dayTypeOf(todaySched);
  const nextType = dayTypeOf(nextSched);
  const workNurse = firstName(todaySched.work) || firstName(todaySched.admin) || 'Người làm';
  const oncallNurse = firstName(todaySched.oncall) || 'Người trực';

  if (!rows.length && !nextMorningRows?.length) return <EmptyFilter />;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <SmartHeader date={date} nextDate={nextDate} todaySched={todaySched} nextSched={nextSched} scenario={scenario} clock={clock} />

      <div style={{ border: `1px solid ${C.border}`, borderRadius: 7, background: C.surface, padding: 12 }}>
        <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start', justifyContent: 'space-between', flexWrap: 'wrap' }}>
          <div style={{ flex: '1 1 260px', minWidth: 0 }}>
            <h3 style={{ margin: 0, color: C.text, fontWeight: 700, fontSize: FS.lg }}>Lọc nhanh khi đi buồng</h3>
            <div style={{ color: C.text2, fontSize: FS.xs, marginTop: 3, lineHeight: 1.45 }}>
              {todayType === 'admin' && <>Ngày có người làm và người trực: <b style={{ color: C.text }}>{workNurse}</b> làm/hành chánh trong giờ hành chính; <b style={{ color: C.text }}>{oncallNurse}</b> nhận phần bàn giao.</>}
              {todayType === 'oncall_only' && <>Ngày chỉ có người trực: hệ thống chỉ giữ các cữ còn lại trong ca và tự quyết định có soạn sáng mai hay không.</>}
              {todayType !== 'admin' && todayType !== 'oncall_only' && <>Lịch chưa đủ người làm/người trực; hệ thống vẫn áp dụng quy tắc mặc định theo danh sách hiện có.</>}
              {nextType === 'empty' && <> Ngày mai không phân công ai nên được xem là ngày làm việc bình thường.</>}
            </div>
          </div>
          <QuickFilters rooms={rooms} roomFilter={roomFilter} setRoomFilter={setRoomFilter} />
        </div>
        <RouteFilterStrip options={routeOptions || []} selectedRoutes={selectedRoutes || []} onToggle={onToggleRoute} onClear={onClearRoutes} />
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(360px, 100%), 1fr))', gap: 12, alignItems: 'start' }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12, minWidth: 0 }}>
          <Panel
            title="Việc cần thực hiện"
            subtitle="Nhiệm vụ trong ca của mình: phát thuốc uống buổi sáng và thực hiện các cữ tiêm/truyền còn lại."
            right={<CountNote>{actionRows.length} dòng tiêm/truyền</CountNote>}
          >
            {!oralVisibleNow && oralRows.length > 0 && (
              <div style={{ margin: 10, border: `1px solid ${C.border2}`, background: C.surface2, color: C.text2, borderRadius: 7, padding: 10, fontSize: FS.sm }}>
                Nhóm phát thuốc uống chỉ hiển thị vào buổi sáng. Các cữ uống chiều/tối được ẩn để không làm rối màn hình.
              </div>
            )}
          </Panel>
          <OralDispenseGroup oralGroups={oralGroups} />
          <TimelineMedicationPanel rows={actionRows} activeTime={activeTime} setActiveTime={setActiveTime} />
        </div>

        <div style={{ minWidth: 0 }}>
          <PrepPanel scenario={scenario} prepRows={prepRows} nextDate={nextDate} />
        </div>
      </div>
    </div>
  );
}

export { DutyReport, scheduleFlags, scenarioOf };
