import { useEffect, useMemo, useState } from 'react';
import { C, FONT_MONO } from '../../tokens.js';
import {
  addDaysDmy, getDaySchedule, dayTypeOf, firstName,
  normalizeTime, timeToMinutes, isMorningRow, isAfterWorkOrEarlyNext,
  isOddHour, todayDmy, parseDmy, rowMinutes,
} from './reportUtils.js';
import { EmptyFilter, RouteBadge, TimeBadge, formatQty } from './ReportShared.jsx';
import { RouteFilterStrip } from './RouteFilters.jsx';
import { compareDutyRows } from './DutyDrugTable.jsx';

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

  return (
    <div style={{ border: `1px solid ${style.border}`, background: style.bg, borderRadius: 6, padding: 12 }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, color: C.text, fontSize: 13, lineHeight: 1.55 }}>
        <b>Ca trực hiện tại:</b>
        <span>{clock.text} - {weekdayLabel(date)}, {date}</span>
        <span style={{ color: style.color, fontWeight: 800 }}>({todayFlag.label})</span>
        <span style={{ color: C.text3 }}>•</span>
        <b>Trạng thái ca ngày mai:</b>
        <span>{weekdayLabel(nextDate)}</span>
        <span style={{ color: tomorrowFlag.isDuty ? C.amber : C.green, fontWeight: 800 }}>({tomorrowFlag.label})</span>
      </div>
      <div style={{ marginTop: 7, color: C.text, fontSize: 13, lineHeight: 1.55 }}>
        👉 <b>Áp dụng: Kịch bản &quot;{scenario.title}&quot;</b> <span style={{ color: C.text2 }}>{scenario.short}</span>
      </div>
      {(todayNames || tomorrowNames) && (
        <div style={{ marginTop: 7, display: 'flex', gap: 8, flexWrap: 'wrap', color: C.text3, fontSize: 11 }}>
          {todayNames && <span>Hôm nay: {todayNames}</span>}
          {tomorrowNames ? <span>Ngày mai: {tomorrowNames}</span> : <span>Ngày mai: chưa phân công — xem là ngày làm việc bình thường</span>}
        </div>
      )}
    </div>
  );
}

function QuickFilters({ rooms, roomFilter, setRoomFilter }) {
  return (
    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', justifyContent: 'flex-end' }}>
      <select
        value={roomFilter}
        onChange={e => setRoomFilter(e.target.value)}
        style={{ background: C.surface2, border: `1px solid ${C.border}`, color: C.text, borderRadius: 7, padding: '6px 9px', fontSize: 12, outline: 'none' }}
      >
        <option value="all">Tất cả phòng/giường</option>
        {rooms.map(room => <option key={room} value={room}>Phòng/Giường {room}</option>)}
      </select>
    </div>
  );
}

function Panel({ title, subtitle, children, right }) {
  return (
    <div style={{ border: `1px solid ${C.border}`, background: C.surface, borderRadius: 6, overflow: 'hidden', minWidth: 0 }}>
      <div style={{ padding: '10px 12px', borderBottom: `1px solid ${C.border}`, display: 'flex', gap: 8, alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap' }}>
        <div>
          <div style={{ color: C.text, fontWeight: 800 }}>{title}</div>
          {subtitle && <div style={{ color: C.text3, fontSize: 11, marginTop: 3, lineHeight: 1.4 }}>{subtitle}</div>}
        </div>
        {right}
      </div>
      {children}
    </div>
  );
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
          <div key={group.key} style={{ border: `1px solid ${C.border2}`, background: C.bg, borderRadius: 8, overflow: 'hidden' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px', borderBottom: `1px solid ${C.border2}`, flexWrap: 'wrap' }}>
              <span style={{ color: C.text3, fontSize: 11 }}>P.</span>
              <b style={{ color: C.text }}>{group.room}</b>
              <b style={{ color: C.text, flex: 1 }}>{group.patientName}</b>
              <span style={{ color: C.text3, fontSize: 11 }}>{group.drugs.length} thuốc uống</span>
            </div>
            <div style={{ display: 'grid' }}>
              {group.drugs.map((drug, idx) => (
                <div key={`${group.key}-${idx}`} style={{ display: 'grid', gridTemplateColumns: 'minmax(180px,1.3fr) 90px 70px minmax(110px,1fr)', gap: 8, padding: '7px 10px', borderTop: idx ? `1px solid ${C.border2}` : 'none' }}>
                  <span style={{ color: C.text, fontWeight: 700 }}>{drug.drugName}{drug.tuTuc && <span style={{ marginLeft: 6, color: C.amber, fontSize: 10 }}>(TT)</span>}</span>
                  <span style={{ color: C.text, textAlign: 'right', fontFamily: FONT_MONO }}>{formatQty(drug.quantity)} {drug.unit}</span>
                  <RouteBadge route="Uống" />
                  <span style={{ color: C.text3, fontSize: 11 }}>{drug.times.length ? drug.times.join(' · ') : 'Cả ngày'}</span>
                </div>
              ))}
            </div>
          </div>
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
      right={<span style={{ color: C.text3, fontSize: 11 }}>{rows.length} dòng</span>}
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
        title="Nhóm 2: Lịch Tiêm / Truyền"
        subtitle="Bốn cữ chính: 08:00, 16:00, 20:00, 22:00. Các giờ lẻ được gộp vào cữ gần nhất; y lệnh chưa xác định giờ nằm ở nhóm riêng."
        right={<span style={{ color: C.text3, fontSize: 11 }}>{assignedRows.length} dòng thuốc</span>}
      >
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', padding: 10, borderBottom: `1px solid ${C.border2}` }}>
          {DUTY_SLOT_TABS.map(slot => (
            <button
              key={slot.id}
              type="button"
              onClick={() => setActiveTime(slot.id)}
              style={{
                border: `1px solid ${selectedTime === slot.id ? C.blueBorder : C.border}`,
                background: selectedTime === slot.id ? C.blueBg : 'transparent', color: selectedTime === slot.id ? C.blue : C.text2,
                borderRadius: 4, padding: '6px 10px', cursor: 'pointer', fontSize: 12, fontWeight: 700, fontFamily: 'inherit',
              }}
            >
              {slot.label} ({slotCounts.get(slot.id) || 0})
            </button>
          ))}
        </div>
        {patientGroups.length ? (
          <MedicationRowsTable groups={patientGroups} />
        ) : (
          <div style={{ color: C.text3, padding: 12, fontSize: 12 }}>Không có thuốc trong cữ này.</div>
        )}
      </Panel>
      <FourDosePanel rows={fourDoseRows} />
    </div>
  );
}

function MedicationRowsTable({ groups }) {
  if (!groups.length) return <div style={{ color: C.text3, padding: 12, fontSize: 12 }}>Không có thuốc trong nhóm này.</div>;
  return (
    <div style={{ display: 'grid', gap: 8, padding: 10 }}>
      {groups.map(group => (
        <div key={group.key} style={{ border: `1px solid ${C.border2}`, borderRadius: 8, background: C.bg, overflow: 'hidden' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px', borderBottom: `1px solid ${C.border2}`, flexWrap: 'wrap' }}>
            <span style={{ color: C.text3, fontSize: 11 }}>P.</span>
            <b style={{ color: C.text }}>{group.room}</b>
            <b style={{ color: C.text, flex: 1 }}>{group.patientName}</b>
            <span style={{ color: C.text3, fontSize: 11 }}>{group.rows.length} dòng</span>
          </div>
          <div style={{ display: 'grid' }}>
            {group.rows.map(row => {
              const key = rowKey(row);
              const slotNote = row._dutySlotNote || (row._dutySlot && row.time !== row._dutySlot ? `Gộp vào cữ ${row._dutySlot}` : '');
              return (
                <div key={key} style={{ display: 'grid', gridTemplateColumns: '76px minmax(160px,1.4fr) 86px 68px minmax(150px,1fr)', gap: 8, alignItems: 'center', padding: '7px 10px', borderTop: `1px solid ${C.border2}`, background: isOddHour(row) ? 'rgba(210,153,34,0.06)' : 'transparent' }}>
                  <TimeBadge row={row} />
                  <span style={{ color: C.text, fontWeight: 700 }}>{row.drugName}{row.tuTuc && <span style={{ marginLeft: 6, color: C.amber, fontSize: 10 }}>(TT)</span>}</span>
                  <span style={{ color: C.text, fontFamily: FONT_MONO, textAlign: 'right' }}>{formatQty(row.quantity)} {row.unit}</span>
                  <RouteBadge route={row.route} />
                  <span style={{ color: C.text2, fontSize: 11 }}>{slotNote || (row.mixWith ? `Pha với: ${row.mixWith}` : row.note)}</span>
                </div>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}

function PrepPanel({ scenario, prepRows, nextDate }) {
  if (scenario.id === 'duty_to_work') {
    return (
      <Panel
        title="SOẠN THUỐC & BÀN GIAO"
        subtitle="Khu vực tự động đổi nội dung theo kịch bản bàn giao."
      >
        <div style={{ margin: 10, border: `1px solid ${C.greenBorder}`, background: C.greenBg, color: C.green, borderRadius: 8, padding: 14, fontWeight: 800 }}>
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
    <Panel title={title} subtitle={subtitle} right={<span style={{ color: C.text3, fontSize: 11 }}>{prepRows.length} dòng</span>}>
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

      <div style={{ border: `1px solid ${C.border}`, borderRadius: 6, background: C.surface, padding: 12 }}>
        <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start', justifyContent: 'space-between', flexWrap: 'wrap' }}>
          <div>
            <div style={{ color: C.text, fontWeight: 800 }}>Bộ lọc nhanh khi đi buồng</div>
            <div style={{ color: C.text3, fontSize: 11, marginTop: 3 }}>
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

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(360px, 1fr))', gap: 12, alignItems: 'start' }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12, minWidth: 0 }}>
          <Panel
            title="VIỆC CẦN THỰC HIỆN"
            subtitle="Nhiệm vụ trong ca của mình: phát thuốc uống buổi sáng và thực hiện các cữ tiêm/truyền còn lại."
            right={<span style={{ color: C.text3, fontSize: 11 }}>{actionRows.length} dòng tiêm/truyền</span>}
          >
            {!oralVisibleNow && oralRows.length > 0 && (
              <div style={{ margin: 10, border: `1px solid ${C.border2}`, background: C.bg, color: C.text3, borderRadius: 8, padding: 10, fontSize: 12 }}>
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

function OddHourPanel({ rows, date }) {
  const oddRows = [...(rows || [])].filter(isOddHour).sort(compareDutyRows(date));
  if (!oddRows.length) return null;
  const groups = new Map();
  for (const row of oddRows) {
    const key = `${row.date || date}|${row.time}`;
    if (!groups.has(key)) groups.set(key, { timeText: row.timeText, reason: row.separatedHourReason || '', rows: [] });
    groups.get(key).rows.push(row);
  }
  const items = [...groups.values()].sort((a, b) => (timeToMinutes(normalizeTime(a.timeText)) ?? 9999) - (timeToMinutes(normalizeTime(b.timeText)) ?? 9999));
  return (
    <div style={{ marginTop: 10, border: `1px solid ${C.amberBorder}`, background: C.amberBg, borderRadius: 8, overflow: 'hidden' }}>
      <div style={{ padding: '8px 10px', color: C.amber, fontWeight: 700, fontSize: 12 }}>
        Giờ riêng cần chú ý
      </div>
      <div style={{ display: 'grid', gap: 8, padding: '0 10px 10px' }}>
        {items.map(group => (
          <div key={`odd-group-${group.timeText}`} style={{ border: `1px solid ${C.amberBorder}`, borderRadius: 7, background: 'rgba(0,0,0,0.10)', overflow: 'hidden' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '7px 9px', borderBottom: `1px solid ${C.amberBorder}` }}>
              <span style={{ color: C.amber, fontFamily: FONT_MONO, fontWeight: 800 }}>{group.timeText}</span>
              {group.reason && <span style={{ color: C.text2, fontSize: 11 }}>{group.reason}</span>}
            </div>
            <div style={{ display: 'grid' }}>
              {group.rows.map(row => (
                <div key={`odd-${row.id}`} style={{ display: 'grid', gridTemplateColumns: '70px minmax(150px, 1.2fr) minmax(180px, 1.4fr) 86px minmax(140px, 1fr)', gap: 8, alignItems: 'center', padding: '6px 9px', borderTop: `1px solid ${C.border2}`, color: C.text, fontSize: 12 }}>
                  <span style={{ color: C.text2 }}>P.{row.room}</span>
                  <span>{row.patientName}</span>
                  <span style={{ fontWeight: 700 }}>{row.drugName}</span>
                  <span style={{ color: C.text, fontFamily: FONT_MONO, textAlign: 'right' }}>{formatQty(row.quantity)} {row.unit}</span>
                  <RouteBadge route={row.route} />
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function DutyNextMorningSection({ rows, date, nextDate, shouldPrepare, nextType, nurse }) {
  const scenario = shouldPrepare
    ? { id: 'duty_to_duty', title: 'Người trực bàn giao cho Người trực', tone: 'amber' }
    : { id: 'duty_to_work', title: 'Người trực bàn giao cho Người làm', tone: 'green' };
  return <PrepPanel scenario={scenario} prepRows={shouldPrepare ? rows : []} nextDate={nextDate} />;
}

export { DutyReport, OddHourPanel, DutyNextMorningSection, scheduleFlags, scenarioOf };
