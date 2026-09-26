import { useEffect, useMemo, useState } from 'react';
import { IconChevronDown, IconChevronUp } from '@tabler/icons-react';
import { C, FS } from '../../tokens.js';
import { Segmented } from '../shared.jsx';
import { addDaysDmy, getDaySchedule, parseDmy, todayDmy } from './reportUtils.js';
import { EmptyFilter, RouteBadge, SelectBox, TuTucMark, formatQty } from './ReportShared.jsx';
import { RouteFilterStrip } from './RouteFilters.jsx';
import { absMinutes, buildDutyPlan, isAdmittedDuringDuty, isWeekend } from './dutyPlan.js';

const WEEKDAY_VI = ['Chủ nhật', 'Thứ 2', 'Thứ 3', 'Thứ 4', 'Thứ 5', 'Thứ 6', 'Thứ 7'];
const REST_STORAGE_KEY = 'emr_report_rest_days_v1';
const ROLE_STORAGE_KEY = 'emr_report_role_v1';

function nowMinutes() {
  const d = new Date();
  return d.getHours() * 60 + d.getMinutes();
}

function weekdayLabel(dmy) {
  const d = parseDmy(dmy);
  return d ? WEEKDAY_VI[d.getDay()] : '';
}

function shortDate(dmy) {
  return String(dmy || '').slice(0, 5);
}

// Ngày chỉ có người trực trong Lịch điều dưỡng = ngày nghỉ.
function scheduleFlags(dayCfg) {
  const count = key => (Array.isArray(dayCfg?.[key]) ? dayCfg[key].filter(Boolean).length : 0);
  const daytime = count('admin') + count('work');
  const oncall = count('oncall');
  return { isDuty: !daytime && oncall > 0, isEmpty: !daytime && !oncall };
}

function readJson(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key) || '') ?? fallback; } catch { return fallback; }
}
function writeJson(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* bỏ qua khi trình duyệt chặn */ }
}

function roomOf(row) {
  return String(row?.room || '—').trim() || '—';
}

// ── Hiển thị ────────────────────────────────────────────────────────────────

function Section({ title, hint, count, children, tone }) {
  return (
    <section style={{ border: `1px solid ${tone === 'amber' ? C.amberBorder : C.border}`, background: C.surface, borderRadius: 7, overflow: 'hidden', minWidth: 0 }}>
      <header style={{ padding: '10px 12px', borderBottom: `1px solid ${C.border2}`, background: tone === 'amber' ? C.amberBg : C.surface }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
          <h3 style={{ margin: 0, fontSize: FS.lg, fontWeight: 700, color: tone === 'amber' ? C.amber : C.text }}>{title}</h3>
          {count != null && <span style={{ fontSize: FS.sm, color: C.text2, fontVariantNumeric: 'tabular-nums' }}>{count}</span>}
        </div>
        {hint && <div style={{ fontSize: FS.xs, color: C.text2, marginTop: 2 }}>{hint}</div>}
      </header>
      {children}
    </section>
  );
}

function Empty({ children }) {
  return <div style={{ padding: '10px 12px', fontSize: FS.sm, color: C.text2 }}>{children}</div>;
}

// Một dòng: Phòng · Người bệnh · Thuốc × SL · Đường dùng.
function MedLine({ row }) {
  return (
    <div className="emr-med-line">
      <span className="emr-med-line__room">{roomOf(row)}</span>
      <span className="emr-med-line__name">{row.patientName}</span>
      <span className="emr-med-line__drug">
        <b style={{ fontWeight: 650 }}>{row.drugName}</b>{row.tuTuc && <TuTucMark />}
        <span style={{ color: C.text2, fontVariantNumeric: 'tabular-nums' }}> × {formatQty(row.quantity)} {row.unit}</span>
        {row.mixWith && <span style={{ color: C.text2 }}> · pha {row.mixWith}</span>}
      </span>
      <span className="emr-med-line__route"><RouteBadge route={row.route} /></span>
    </div>
  );
}

// Gom theo giờ dùng: "08:00", "02:00 · 27/09"…
function TimeList({ rows, date, empty }) {
  const groups = useMemo(() => {
    const map = new Map();
    for (const row of rows) {
      const key = row.noTime ? 'Chưa rõ giờ' : `${row.time}${row.date !== date ? ` · ${shortDate(row.date)}` : ''}`;
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(row);
    }
    return [...map.entries()];
  }, [rows, date]);
  if (!rows.length) return <Empty>{empty}</Empty>;
  return (
    <div>
      {groups.map(([label, list]) => (
        <div key={label}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, padding: '6px 12px', background: C.surface2, borderTop: `1px solid ${C.border2}` }}>
            <b style={{ fontSize: FS.md, color: C.text, fontVariantNumeric: 'tabular-nums' }}>{label}</b>
            <span style={{ fontSize: FS.xs, color: C.text2 }}>{list.length} thuốc</span>
          </div>
          {list.map(row => <MedLine key={row.id} row={row} />)}
        </div>
      ))}
    </div>
  );
}

// Thuốc uống: mỗi người bệnh một dòng, gom mọi giờ uống trong ngày.
function OralList({ rows, empty }) {
  const patients = useMemo(() => {
    const map = new Map();
    for (const row of rows) {
      const pKey = `${roomOf(row)}|${row.patientId || row.patientName}`;
      if (!map.has(pKey)) map.set(pKey, { key: pKey, room: roomOf(row), name: row.patientName, drugs: new Map() });
      const drugs = map.get(pKey).drugs;
      const dKey = `${String(row.drugName).toLowerCase()}|${row.unit}|${row.tuTuc ? 'tt' : ''}`;
      if (!drugs.has(dKey)) drugs.set(dKey, { name: row.drugName, unit: row.unit, tuTuc: row.tuTuc, qty: 0, times: new Set() });
      const drug = drugs.get(dKey);
      drug.qty += Number(row.quantity || 0);
      if (!row.noTime && row.time) drug.times.add(row.time);
    }
    return [...map.values()].sort((a, b) => a.room.localeCompare(b.room, 'vi', { numeric: true }) || String(a.name).localeCompare(String(b.name), 'vi'));
  }, [rows]);
  if (!patients.length) return <Empty>{empty}</Empty>;
  return (
    <div>
      {patients.map(p => (
        <div key={p.key} className="emr-oral-line">
          <span className="emr-med-line__room">{p.room}</span>
          <span className="emr-med-line__name">{p.name}</span>
          <span className="emr-oral-line__drugs">
            {[...p.drugs.values()].map((d, i) => (
              <span key={i} style={{ display: 'inline-block', marginRight: 12 }}>
                <b style={{ fontWeight: 650 }}>{d.name}</b>{d.tuTuc && <TuTucMark />}
                <span style={{ color: C.text2, fontVariantNumeric: 'tabular-nums' }}> × {formatQty(d.qty)} {d.unit}{d.times.size ? ` (${[...d.times].sort().join(', ')})` : ''}</span>
              </span>
            ))}
          </span>
        </div>
      ))}
    </div>
  );
}

function PastToggle({ rows, date }) {
  const [open, setOpen] = useState(false);
  if (!rows.length) return null;
  return (
    <div style={{ borderTop: `1px solid ${C.border2}` }}>
      <button type="button" onClick={() => setOpen(v => !v)} aria-expanded={open} style={{
        display: 'flex', alignItems: 'center', gap: 6, width: '100%', minHeight: 36, padding: '0 12px',
        border: 0, background: 'transparent', color: C.text2, fontSize: FS.sm, cursor: 'pointer', fontFamily: 'inherit',
      }}>
        {open ? <IconChevronUp size={15} stroke={1.9} aria-hidden="true" /> : <IconChevronDown size={15} stroke={1.9} aria-hidden="true" />}
        Đã qua giờ: {rows.length} thuốc
      </button>
      {open && <TimeList rows={rows} date={date} />}
    </div>
  );
}

// ── Màn chính ───────────────────────────────────────────────────────────────

function DutyReport({ date, rows, nextDayRows = [], admissions = {}, nurseState, routeOptions, selectedRoutes, onToggleRoute, onClearRoutes }) {
  const schedule = nurseState?.schedule || {};
  const nextDate = addDaysDmy(date, 1);
  const isToday = date === todayDmy();
  const [now, setNow] = useState(nowMinutes);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(nowMinutes()), 30 * 1000);
    return () => window.clearInterval(timer);
  }, []);

  // Ngày nghỉ: tự đoán theo T7/CN hoặc Lịch điều dưỡng chỉ có người trực; người dùng sửa được, nhớ theo ngày.
  const [restOverrides, setRestOverrides] = useState(() => readJson(REST_STORAGE_KEY, {}));
  const autoRest = dmy => isWeekend(dmy) || scheduleFlags(getDaySchedule(schedule, dmy)).isDuty;
  const isRest = dmy => (typeof restOverrides[dmy] === 'boolean' ? restOverrides[dmy] : autoRest(dmy));
  const setRest = (dmy, value) => setRestOverrides(prev => {
    const next = { ...prev, [dmy]: value };
    writeJson(REST_STORAGE_KEY, next);
    return next;
  });
  const todayRest = isRest(date);
  const tomorrowRest = isRest(nextDate);

  const [role, setRoleState] = useState(() => {
    const saved = readJson(ROLE_STORAGE_KEY, '');
    if (saved === 'work' || saved === 'duty') return saved;
    const m = nowMinutes();
    return m >= 7 * 60 && m < 17 * 60 ? 'work' : 'duty';
  });
  const setRole = value => { setRoleState(value); writeJson(ROLE_STORAGE_KEY, value); };

  const [roomFilter, setRoomFilter] = useState('all');
  const rooms = useMemo(() => [...new Set([...rows, ...nextDayRows].map(roomOf))]
    .sort((a, b) => a.localeCompare(b, 'vi', { numeric: true })), [rows, nextDayRows]);
  useEffect(() => {
    if (roomFilter !== 'all' && !rooms.includes(roomFilter)) setRoomFilter('all');
  }, [rooms, roomFilter]);
  const byRoom = list => (roomFilter === 'all' ? list : list.filter(row => roomOf(row) === roomFilter));

  const newPatientKeys = useMemo(() => new Set(Object.entries(admissions)
    .filter(([, value]) => isAdmittedDuringDuty(value, date, todayRest))
    .map(([key]) => key)), [admissions, date, todayRest]);

  const plan = useMemo(() => buildDutyPlan({
    date, rows: byRoom(rows), nextDayRows: byRoom(nextDayRows), role, todayRest, tomorrowRest,
    nowMinutes: now, isToday, newPatientKeys,
  }), [date, rows, nextDayRows, role, todayRest, tomorrowRest, now, isToday, newPatientKeys, roomFilter]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!rows.length && !nextDayRows.length) return <EmptyFilter />;

  const fromNow = isToday ? ' từ giờ hiện tại' : '';
  const checkbox = (label, checked, onChange) => (
    <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: FS.sm, color: C.text, cursor: 'pointer' }}>
      <input type="checkbox" checked={checked} onChange={e => onChange(e.target.checked)} style={{ width: 16, height: 16, accentColor: C.blue }} />
      {label}
    </label>
  );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ border: `1px solid ${C.border}`, borderRadius: 7, background: C.surface, padding: 12, display: 'grid', gap: 10 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px 16px', flexWrap: 'wrap' }}>
          <Segmented
            label="Vai trò"
            value={role}
            onChange={setRole}
            options={[{ value: 'work', label: 'Người làm bệnh phòng' }, { value: 'duty', label: 'Người trực' }]}
          />
          {role === 'duty' && checkbox(`Hôm nay (${weekdayLabel(date)}) là ngày nghỉ`, todayRest, v => setRest(date, v))}
          {role === 'duty' && checkbox(`Ngày mai (${weekdayLabel(nextDate)} ${shortDate(nextDate)}) là ngày nghỉ`, tomorrowRest, v => setRest(nextDate, v))}
          <span style={{ flex: '1 1 0' }} />
          <SelectBox label="Lọc theo phòng" value={roomFilter} onChange={setRoomFilter}>
            <option value="all">Tất cả phòng</option>
            {rooms.map(room => <option key={room} value={room}>Phòng {room}</option>)}
          </SelectBox>
        </div>
        <div style={{ fontSize: FS.xs, color: C.text2 }}>
          {role === 'work'
            ? 'Ca làm 07:00–11:00 và 13:00–17:00. Cữ 11:00–13:00 và từ 17:00 bàn giao cho người trực.'
            : todayRest
              ? 'Trực ngày nghỉ: thuốc sáng (07:00–10:59) và thuốc uống người bệnh cũ đã làm từ hôm trước.'
              : 'Trực ngày làm: 11:00–13:00 và từ 17:00 đến 07:00 sáng mai.'}
        </div>
        <RouteFilterStrip options={routeOptions || []} selectedRoutes={selectedRoutes || []} onToggle={onToggleRoute} onClear={onClearRoutes} />
      </div>

      {role === 'work' ? (
        <div className="emr-duty-grid">
          <div style={{ display: 'grid', gap: 12, alignContent: 'start', minWidth: 0 }}>
            <Section title="Thuốc uống" hint="Phát cho cả ngày." count={`${new Set(plan.oral.map(r => r.patientId || r.patientName)).size} người bệnh`}>
              <OralList rows={plan.oral} empty="Không có thuốc uống trong ngày." />
            </Section>
            <Section title="Cữ trong ca làm" hint={`Tiêm, truyền và đường khác${fromNow}.`} count={`${plan.mine.length} thuốc`}>
              <TimeList rows={plan.mine} date={date} empty="Không còn cữ nào trong ca làm." />
              <PastToggle rows={plan.past} date={date} />
            </Section>
            {plan.noTime.length > 0 && (
              <Section title="Chưa rõ giờ" hint="Y lệnh không ghi giờ, cần hỏi lại bác sĩ." count={`${plan.noTime.length} thuốc`} tone="amber">
                <TimeList rows={plan.noTime} date={date} />
              </Section>
            )}
          </div>
          <Section title="Bàn giao ca trực" hint="Trực trưa 11:00–13:00 và từ 17:00 đến 07:00 sáng mai." count={`${plan.handover.length} thuốc`}>
            <TimeList rows={plan.handover} date={date} empty="Không có cữ nào cần bàn giao." />
          </Section>
        </div>
      ) : (
        <div className="emr-duty-grid">
          <div style={{ display: 'grid', gap: 12, alignContent: 'start', minWidth: 0 }}>
            <Section title="Cữ trong ca trực" hint={`${todayRest ? 'Từ 11:00' : 'Trực trưa 11:00–13:00 và từ 17:00'} đến 23:59${fromNow}.`} count={`${plan.mine.length} thuốc`}>
              <TimeList rows={plan.mine} date={date} empty="Không còn cữ nào trong ca trực hôm nay." />
              <PastToggle rows={plan.past} date={date} />
            </Section>
            <Section title="Trước 7h sáng mai" hint={`Cữ 00:00–06:59 ngày ${shortDate(nextDate)}.`} count={`${plan.earlyTomorrow.length} thuốc`}>
              <TimeList rows={plan.earlyTomorrow} date={date} empty="Không có cữ nào trước 7h sáng mai." />
            </Section>
            <Section title="Thuốc uống người bệnh mới vào" hint="Người bệnh vào khoa trong tua trực, chưa được phát thuốc uống." count={`${new Set(plan.oral.map(r => r.patientId || r.patientName)).size} người bệnh`}>
              <OralList rows={plan.oral} empty="Không có người bệnh mới vào trong tua trực." />
            </Section>
            {plan.noTime.length > 0 && (
              <Section title="Chưa rõ giờ" hint="Y lệnh không ghi giờ, cần hỏi lại bác sĩ." count={`${plan.noTime.length} thuốc`} tone="amber">
                <TimeList rows={plan.noTime} date={date} />
              </Section>
            )}
          </div>
          {tomorrowRest ? (
            <div style={{ display: 'grid', gap: 12, alignContent: 'start', minWidth: 0 }}>
              <Section title="Làm thuốc sáng mai" hint={`Ngày mai nghỉ: làm các cữ 07:00–10:59 ngày ${shortDate(nextDate)}.`} count={`${plan.nextMorning.length} thuốc`}>
                <TimeList rows={plan.nextMorning} date={nextDate} empty="Không có cữ sáng mai." />
              </Section>
              <Section title="Thuốc uống ngày mai" hint="Phát trước cho cả ngày mai." count={`${new Set(plan.nextOral.map(r => r.patientId || r.patientName)).size} người bệnh`}>
                <OralList rows={plan.nextOral} empty="Chưa có y lệnh thuốc uống ngày mai." />
              </Section>
            </div>
          ) : (
            <Section title="Sáng mai" hint="Ngày mai là ngày làm: người làm bệnh phòng sẽ làm thuốc sáng.">
              <Empty>Không cần làm thuốc sáng mai. Chỉ cần làm các cữ trước 7h ở mục bên cạnh.</Empty>
            </Section>
          )}
        </div>
      )}
    </div>
  );
}

// Giữ để hiển thị thứ tự đúng khi cần tính phút tuyệt đối ở nơi khác.
export { DutyReport, scheduleFlags, absMinutes };
