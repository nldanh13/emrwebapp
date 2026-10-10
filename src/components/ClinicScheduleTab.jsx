// src/components/ClinicScheduleTab.jsx — Lịch phòng khám: xếp bác sĩ và điều dưỡng phòng khám theo ngày.
// - Bác sĩ đầu tiên (có tài khoản EMR) của ngày là tài khoản Phòng khám / Nghỉ ốm đăng nhập khi chọn
//   "Bác sĩ theo Lịch phòng khám", và là BS mổ chính khi kết thúc mổ cho người bệnh ngoại trú.
// - Điều dưỡng phòng khám được điền vào phiếu chăm sóc.
// Mỗi loại (bác sĩ, điều dưỡng) tra riêng: đúng ngày → theo thứ → mẫu mặc định (giống máy chủ và
// worker/clinic_input_care.py). Tự lưu; chỉ gửi clinicSchedule nên không đụng Lịch điều dưỡng.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { IconCloudCheck, IconCopy, IconTemplate, IconX } from '@tabler/icons-react';
import { C, FS } from '../tokens.js';
import { Btn, SectionLabel, Spinner } from './shared.jsx';
import * as api from '../api.js';
import { useOnTabReturn } from '../hooks/useTabActivity.js';
import { SkeletonScreen } from './Skeleton.jsx';
import { ShiftBucket } from './nurse/ShiftToggle.jsx';
import {
  addDaysIso, buildDateRange, cloneShift, formatDmy, normalizeScheduleShape, todayIso, weekdayKeyFromIso, weekdayLabelFromIso,
} from './nurse/nurseScheduleUtils.js';

const DAYS_SHOWN = 14;
const KINDS = ['doctor', 'work'];

/** Tên của một loại cho một ngày, kèm nơi lấy: 'day' | 'weekday' | 'default' | ''. */
export function clinicNamesFor(schedule, key, kind) {
  const sched = normalizeScheduleShape(schedule);
  const pick = (day) => (Array.isArray(day?.[kind]) ? day[kind].filter(Boolean) : []);
  if (key === 'Default') return { names: pick(sched.Default), from: pick(sched.Default).length ? 'default' : '' };
  const exact = pick(sched.days?.[key]);
  if (exact.length) return { names: exact, from: 'day' };
  const weekly = pick(sched[weekdayKeyFromIso(key)]);
  if (weekly.length) return { names: weekly, from: 'weekday' };
  const def = pick(sched.Default);
  return { names: def, from: def.length ? 'default' : '' };
}

/** Lịch mới sau khi đặt danh sách tên của một loại cho một ngày (chỉ đổi đúng loại đó). */
export function setClinicNames(schedule, key, kind, names) {
  const sched = normalizeScheduleShape(schedule);
  const apply = (day) => {
    const next = cloneShift(day);
    if (kind === 'doctor') { if (names.length) next.doctor = [...names]; else delete next.doctor; }
    else next[kind] = [...names];
    return next;
  };
  if (key === 'Default') return { ...sched, Default: apply(sched.Default) };
  return { ...sched, days: { ...sched.days, [key]: apply(sched.days?.[key]) } };
}

const FROM_LABEL = { weekday: 'theo lịch thứ trong tuần', default: 'theo mẫu mặc định' };

function DayButton({ selected, onClick, title, subtitle, doctors }) {
  return (
    <button type="button" onClick={onClick} aria-current={selected ? 'true' : undefined} style={{
      display: 'block', width: '100%', textAlign: 'left', padding: '8px 12px', cursor: 'pointer', fontFamily: 'inherit',
      border: 0, borderBottom: `1px solid ${C.border2}`, background: selected ? C.blueBg : 'transparent',
    }}>
      <span style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
        <b style={{ fontSize: FS.md, fontWeight: selected ? 700 : 600, color: selected ? C.blue : C.text, fontVariantNumeric: 'tabular-nums' }}>{title}</b>
        {subtitle && <span style={{ fontSize: FS.xs, color: selected ? C.blue : C.text2 }}>{subtitle}</span>}
      </span>
      <span style={{ display: 'block', fontSize: FS.xs, color: doctors.length ? C.text2 : C.amber, marginTop: 2 }}>
        {doctors.length ? doctors.join(', ') : 'Chưa xếp bác sĩ'}
      </span>
    </button>
  );
}

function DoctorPicker({ doctors, selected, onChange }) {
  const listed = doctors.map(d => d.name);
  const extra = selected.filter(n => !listed.includes(n));
  const toggle = (name) => onChange(selected.includes(name) ? selected.filter(n => n !== name) : [...selected, name]);
  const chip = (name, active, hint) => (
    <button key={name} type="button" aria-pressed={active} onClick={() => toggle(name)} title={hint} style={{
      display: 'inline-flex', alignItems: 'center', gap: 5, padding: '5px 10px', borderRadius: 999, cursor: 'pointer',
      fontFamily: 'inherit', fontSize: FS.sm, fontWeight: 600,
      border: `1px solid ${active ? C.blue : C.border}`, background: active ? C.blueBg : C.surface, color: active ? C.blue : C.text,
    }}>
      {active && <span style={{ fontVariantNumeric: 'tabular-nums' }}>{selected.indexOf(name) + 1}.</span>}
      {name}
      {hint && <span style={{ fontWeight: 400, fontSize: FS.xs, color: C.amber }}>({hint})</span>}
      {active && !listed.includes(name) && <IconX size={13} aria-hidden="true" />}
    </button>
  );
  return (
    <section style={{ marginBottom: 16 }}>
      <h3 style={{ margin: 0, fontSize: FS.lg, fontWeight: 600, color: C.text }}>
        Bác sĩ phòng khám <span style={{ fontSize: FS.sm, fontWeight: 500, color: C.text2 }}>{selected.length} người</span>
      </h3>
      <div style={{ fontSize: FS.xs, color: C.text2, marginTop: 2, lineHeight: 1.5 }}>
        Bấm theo thứ tự: người số 1 là tài khoản EMR phòng khám đăng nhập hôm đó và là BS mổ chính khi kết thúc mổ
        cho người bệnh ngoại trú. Người số 1 chưa có tài khoản thì dùng người kế tiếp.
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 8 }}>
        {doctors.map(d => chip(d.name, selected.includes(d.name), d.ready ? '' : 'chưa có tài khoản EMR'))}
        {extra.map(n => chip(n, true, 'chưa có tài khoản EMR'))}
        {!doctors.length && !extra.length && (
          <div style={{ fontSize: FS.sm, color: C.text2 }}>
            Chưa có bác sĩ nào. Thêm ở Thiết lập tài khoản → Tài khoản EMR → Bác sĩ phòng khám.
          </div>
        )}
      </div>
    </section>
  );
}

function timeLabel(d) {
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export default function ClinicScheduleTab({ toast }) {
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [roster, setRoster] = useState([]);
  const [doctors, setDoctors] = useState([]);
  const [schedule, setSchedule] = useState(() => normalizeScheduleShape({}));
  const [selKey, setSelKey] = useState(todayIso());
  const [saveState, setSaveState] = useState({ kind: 'idle', at: null, message: '' });
  const saveTimer = useRef(null);
  const pending = useRef(null);

  const load = useCallback(async () => {
    if (pending.current) return; // đang chờ tự lưu: không ghi đè chỗ vừa sửa
    try {
      const [settings, accounts] = await Promise.all([
        api.getNurseSettings(),
        api.getClinicDoctorAccounts().catch(() => ({ doctors: [] })),
      ]);
      setRoster(Array.isArray(settings?.roster) ? settings.roster : []);
      setSchedule(normalizeScheduleShape(settings?.clinicSchedule || {}));
      setDoctors(Array.isArray(accounts?.doctors) ? accounts.doctors : []);
      setLoadError('');
    } catch (e) {
      setLoadError(String(e?.message || e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);
  useOnTabReturn(() => load());
  useEffect(() => () => clearTimeout(saveTimer.current), []);

  const flush = useCallback(async () => {
    const next = pending.current;
    if (!next) return;
    setSaveState({ kind: 'saving', at: null, message: '' });
    try {
      const r = await api.saveNurseSettings({ clinicSchedule: next });
      if (pending.current === next) pending.current = null;
      if (r?.status && r.status !== 'ok') throw new Error(r.message || 'Máy chủ không lưu được lịch.');
      setSaveState({ kind: 'saved', at: new Date(), message: '' });
    } catch (e) {
      setSaveState({ kind: 'error', at: null, message: String(e?.message || e) });
      toast?.(`Chưa lưu được Lịch phòng khám: ${e?.message || e}. Kiểm tra kết nối rồi sửa lại một ô để lưu lại.`, 'error');
    }
  }, [toast]);

  const update = useCallback((next) => {
    setSchedule(next);
    pending.current = next;
    setSaveState({ kind: 'dirty', at: null, message: '' });
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(flush, 400);
  }, [flush]);

  const dates = useMemo(() => buildDateRange(todayIso(), addDaysIso(todayIso(), DAYS_SHOWN - 1)), []);
  const isDate = selKey !== 'Default';
  const doctorInfo = clinicNamesFor(schedule, selKey, 'doctor');
  const nurseInfo = clinicNamesFor(schedule, selKey, 'work');

  const setNames = (kind, names) => update(setClinicNames(schedule, selKey, kind, names));
  const copyFrom = (sourceKey) => {
    let next = schedule;
    for (const kind of KINDS) next = setClinicNames(next, selKey, kind, clinicNamesFor(schedule, sourceKey, kind).names);
    update(next);
  };

  if (loading) return <SkeletonScreen label="Đang tải lịch phòng khám" rows={8} cols={4} />;

  const today = todayIso();
  return (
    <div style={{ display: 'flex', flex: 1, overflow: 'hidden', flexWrap: 'wrap' }}>
      <div style={{ width: 230, maxWidth: '100%', borderRight: `1px solid ${C.border}`, overflow: 'auto', flexShrink: 0, background: C.surface }}>
        <SectionLabel>Ngày</SectionLabel>
        <nav aria-label="Chọn ngày">
          {dates.map(iso => (
            <DayButton key={iso} selected={selKey === iso} onClick={() => setSelKey(iso)}
              title={formatDmy(iso)} subtitle={`${weekdayLabelFromIso(iso)}${iso === today ? ' · hôm nay' : ''}`}
              doctors={clinicNamesFor(schedule, iso, 'doctor').names} />
          ))}
          <DayButton selected={selKey === 'Default'} onClick={() => setSelKey('Default')} title="Mẫu mặc định"
            subtitle="ngày chưa xếp riêng" doctors={clinicNamesFor(schedule, 'Default', 'doctor').names} />
        </nav>
      </div>
      <div style={{ flex: 1, minWidth: 280, overflow: 'auto', background: C.surface, padding: 16 }}>
        {loadError && (
          <div role="alert" style={{ marginBottom: 12, padding: '9px 12px', borderRadius: 7, background: C.redBg, border: `1px solid ${C.redBorder}`, fontSize: FS.sm, color: C.red }}>
            Không tải được Lịch phòng khám: {loadError}. Chuyển sang tab khác rồi quay lại để thử lại.
          </div>
        )}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 12 }}>
          <h2 style={{ margin: 0, fontSize: FS.xl, fontWeight: 700, color: C.text }}>
            {isDate ? `${weekdayLabelFromIso(selKey)}, ${formatDmy(selKey)}` : 'Mẫu mặc định'}
          </h2>
          <span role="status" style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: FS.xs, color: saveState.kind === 'error' ? C.red : C.text2 }}>
            {saveState.kind === 'saving' && <><Spinner size={12} /> Đang lưu…</>}
            {saveState.kind === 'dirty' && 'Chưa lưu, đang chờ tự lưu…'}
            {saveState.kind === 'saved' && <><IconCloudCheck size={15} stroke={1.75} color={C.green} aria-hidden="true" /> Đã tự lưu lúc {timeLabel(saveState.at)}</>}
            {saveState.kind === 'error' && `Chưa lưu: ${saveState.message}`}
            {saveState.kind === 'idle' && <><IconCloudCheck size={15} stroke={1.75} color={C.green} aria-hidden="true" /> Tự lưu khi thay đổi</>}
          </span>
        </div>
        {isDate ? (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 18 }}>
            <Btn icon={IconCopy} onClick={() => copyFrom(addDaysIso(selKey, -1))}>Chép từ ngày trước</Btn>
            <Btn icon={IconCopy} onClick={() => copyFrom(addDaysIso(selKey, -7))}>Chép từ tuần trước</Btn>
            <Btn icon={IconTemplate} onClick={() => copyFrom('Default')}>Dùng mẫu mặc định</Btn>
          </div>
        ) : (
          <p style={{ margin: '0 0 14px', fontSize: FS.sm, color: C.text2 }}>Dùng cho những ngày chưa xếp riêng.</p>
        )}
        {FROM_LABEL[doctorInfo.from] && isDate && (
          <div style={{ marginBottom: 8, fontSize: FS.xs, color: C.text2 }}>
            Bác sĩ ngày này đang lấy {FROM_LABEL[doctorInfo.from]}; bấm chọn để xếp riêng cho ngày này.
          </div>
        )}
        <DoctorPicker doctors={doctors} selected={doctorInfo.names} onChange={names => setNames('doctor', names)} />
        <div style={{ paddingTop: 12, borderTop: `1px solid ${C.border2}` }}>
          <ShiftBucket
            label="Điều dưỡng phòng khám"
            shift="work"
            roster={roster}
            selected={nurseInfo.names}
            onToggle={(_shift, name) => setNames('work', nurseInfo.names.includes(name) ? nurseInfo.names.filter(n => n !== name) : [...nurseInfo.names, name])}
            emptyText="Chưa có điều dưỡng. Thêm tên ở tab Lịch điều dưỡng."
            hint={`Tên được điền vào phiếu chăm sóc.${isDate && FROM_LABEL[nurseInfo.from] ? ` Đang lấy ${FROM_LABEL[nurseInfo.from]}.` : ''}`}
          />
        </div>
        <div style={{ color: C.text2, fontSize: FS.xs }}>
          Ưu tiên lịch đúng ngày; ngày nào trống mới dùng mẫu mặc định. Bỏ hết tên của một ngày thì ngày đó lại theo mẫu.
        </div>
      </div>
    </div>
  );
}
