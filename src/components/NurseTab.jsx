import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { C } from '../tokens.js';
import { Spinner } from './shared.jsx';
import * as api from '../api.js';
import {
  DAY_KEYS,
  addDaysIso,
  buildDateRange,
  cloneShift,
  filterNameFromShift,
  getDaySchedule,
  normalizeScheduleShape,
  setDateSchedule,
  toIsoDate,
  todayIso,
} from './nurse/nurseScheduleUtils.js';
import useIsMobile from './nurse/useIsMobile.js';
import NurseDatePanel from './nurse/NurseDatePanel.jsx';
import NurseSchedulePanel from './nurse/NurseSchedulePanel.jsx';
import NurseRosterPanel from './nurse/NurseRosterPanel.jsx';
import NurseMobileView from './nurse/NurseMobileView.jsx';

export default function NurseTab({ toast }) {
  const isMobile = useIsMobile();
  const [showNursePanel, setShowNursePanel] = useState(false);
  const [showDatePicker, setShowDatePicker] = useState(false);

  const [roster, setRoster] = useState([]);
  const [schedule, setSchedule] = useState(() => normalizeScheduleShape({}));
  const [clinicSchedule, setClinicSchedule] = useState(() => normalizeScheduleShape({}));
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [newName, setNewName] = useState('');
  const [dateRange, setDateRange] = useState(() => ({ from: todayIso(), to: addDaysIso(todayIso(), 6) }));
  const [visibleDates, setVisibleDates] = useState(() => buildDateRange(todayIso(), addDaysIso(todayIso(), 6)));
  const [selKey, setSelKey] = useState(todayIso());

  useEffect(() => {
    api.getNurseSettings()
      .then(d => {
        const nextRoster = d.roster || [];
        const nextSchedule = normalizeScheduleShape(d.schedule || {});
        const nextClinicSchedule = normalizeScheduleShape(d.clinicSchedule || {});
        const apiDates = Array.isArray(d.available_dates) ? d.available_dates.map(toIsoDate).filter(Boolean) : [];
        const savedDates = Object.keys(nextSchedule.days || {}).map(toIsoDate).filter(Boolean);
        const uniqueDates = [...new Set(apiDates.length ? apiDates : savedDates)].sort();
        const dates = uniqueDates.length ? uniqueDates : buildDateRange(todayIso(), addDaysIso(todayIso(), 6));
        setRoster(nextRoster);
        setSchedule(nextSchedule);
        setClinicSchedule(nextClinicSchedule);
        setVisibleDates(dates);
        setDateRange({ from: dates[0], to: dates[dates.length - 1] });
        setSelKey(dates[0] || todayIso());
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  const saveTimer = useRef(null);

  const save = useCallback((nextRoster, nextSchedule, nextClinicSchedule) => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(async () => {
      setSaving(true);
      try {
        const r = await api.saveNurseSettings({
          roster: nextRoster,
          schedule: normalizeScheduleShape(nextSchedule),
          clinicSchedule: normalizeScheduleShape(nextClinicSchedule),
        });
        if (r.status === 'ok') toast?.('Đã lưu lịch điều dưỡng', 'ok');
        else toast?.(r.message, 'error');
      } catch (e) {
        toast?.(String(e.message), 'error');
      } finally {
        setSaving(false);
      }
    }, 400);
  }, [toast]);

  const applyRange = useCallback(() => {
    const dates = buildDateRange(dateRange.from, dateRange.to);
    setVisibleDates(dates);
    if (!dates.includes(selKey)) setSelKey(dates[0] || 'Default');
  }, [dateRange, selKey]);

  const addNurse = useCallback(() => {
    const name = newName.trim();
    if (!name || roster.includes(name)) return;
    const next = [...roster, name].sort((a, b) => a.localeCompare(b, 'vi'));
    setRoster(next);
    setNewName('');
    save(next, schedule, clinicSchedule);
  }, [newName, roster, schedule, clinicSchedule, save]);

  const removeNurse = useCallback((name) => {
    const next = roster.filter(n => n !== name);
    const oldSchedule = normalizeScheduleShape(schedule);
    const nextSched = { days: {} };
    for (const d of DAY_KEYS) nextSched[d] = filterNameFromShift(oldSchedule[d], name);
    for (const [iso, dayValue] of Object.entries(oldSchedule.days || {})) {
      nextSched.days[iso] = filterNameFromShift(dayValue, name);
    }
    setRoster(next);
    setSchedule(nextSched);
    save(next, nextSched, clinicSchedule);
  }, [roster, schedule, clinicSchedule, save]);

  const updateScheduleForKey = useCallback((key, value) => {
    let nextSched;
    if (key === 'Default') {
      nextSched = { ...normalizeScheduleShape(schedule), Default: cloneShift(value) };
    } else {
      nextSched = setDateSchedule(schedule, key, value);
    }
    setSchedule(nextSched);
    save(roster, nextSched, clinicSchedule);
  }, [schedule, roster, clinicSchedule, save]);

  // ── Clinic schedule ──────────────────────────────────────────────────────────
  const updateClinicScheduleForKey = useCallback((key, value) => {
    let nextSched;
    if (key === 'Default') {
      nextSched = { ...normalizeScheduleShape(clinicSchedule), Default: cloneShift(value) };
    } else {
      nextSched = setDateSchedule(clinicSchedule, key, value);
    }
    setClinicSchedule(nextSched);
    save(roster, schedule, nextSched);
  }, [clinicSchedule, roster, schedule, save]);

  const toggleClinicShift = useCallback((shift, name) => {
    const current = getDaySchedule(clinicSchedule, selKey);
    const prev = current[shift] || [];
    const nextBucket = prev.includes(name) ? prev.filter(n => n !== name) : [...prev, name];
    updateClinicScheduleForKey(selKey, { ...current, [shift]: nextBucket });
  }, [clinicSchedule, selKey, updateClinicScheduleForKey]);

  const toggleShiftForKey = useCallback((key, shift, name) => {
    const current = getDaySchedule(schedule, key);
    const prev = current[shift] || [];
    const nextBucket = prev.includes(name) ? prev.filter(n => n !== name) : [...prev, name];
    updateScheduleForKey(key, { ...current, [shift]: nextBucket });
  }, [schedule, updateScheduleForKey]);

  const toggleShift = useCallback((shift, name) => {
    toggleShiftForKey(selKey, shift, name);
  }, [selKey, toggleShiftForKey]);

  const copyFromToKey = useCallback((targetKey, sourceKey) => {
    const copied = getDaySchedule(schedule, sourceKey);
    updateScheduleForKey(targetKey, copied);
  }, [schedule, updateScheduleForKey]);

  const copyFrom = useCallback((sourceKey) => {
    copyFromToKey(selKey, sourceKey);
  }, [selKey, copyFromToKey]);

  const applyDefaultToEmptyVisibleDays = useCallback(() => {
    const oldSchedule = normalizeScheduleShape(schedule);
    const def = cloneShift(oldSchedule.Default);
    const nextSched = { ...oldSchedule, days: { ...(oldSchedule.days || {}) } };
    for (const iso of visibleDates) {
      const current = cloneShift(nextSched.days[iso]);
      if ((current.admin.length || current.work.length || current.oncall.length)) continue;
      nextSched.days[iso] = cloneShift(def);
    }
    setSchedule(nextSched);
    save(roster, nextSched, clinicSchedule);
  }, [schedule, visibleDates, roster, clinicSchedule, save]);

  const daySched = useMemo(() => getDaySchedule(schedule, selKey), [schedule, selKey]);
  const clinicDaySched = useMemo(() => getDaySchedule(clinicSchedule, selKey), [clinicSchedule, selKey]);
  const selectedIsDate = Boolean(selKey) && selKey !== 'Default';
  const prevDate = selectedIsDate ? addDaysIso(selKey, -1) : '';
  const prevWeekDate = selectedIsDate ? addDaysIso(selKey, -7) : '';

  if (loading) return <div style={{ padding: 24, color: C.text2 }}><Spinner /> Đang tải...</div>;


  if (isMobile) {
    return (
      <NurseMobileView
        showNursePanel={showNursePanel}
        setShowNursePanel={setShowNursePanel}
        showDatePicker={showDatePicker}
        setShowDatePicker={setShowDatePicker}
        roster={roster}
        newName={newName}
        setNewName={setNewName}
        onAddNurse={addNurse}
        onRemoveNurse={removeNurse}
        dateRange={dateRange}
        setDateRange={setDateRange}
        onApplyRange={applyRange}
        saving={saving}
        visibleDates={visibleDates}
        schedule={schedule}
        selectedKey={selKey}
        setSelectedKey={setSelKey}
        onToggleShiftForKey={toggleShiftForKey}
        onCopyFromToKey={copyFromToKey}
      />
    );
  }

  return (
    <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>
      <div style={{ width: 178, borderRight: `1px solid ${C.border}`, overflow: 'auto', flexShrink: 0 }}>
        <NurseDatePanel
          dateRange={dateRange}
          setDateRange={setDateRange}
          onApplyRange={applyRange}
          visibleDates={visibleDates}
          schedule={schedule}
          selectedKey={selKey}
          setSelectedKey={setSelKey}
        />
      </div>
      <div style={{ flex: 1, overflow: 'auto' }}>
        <NurseSchedulePanel
          selectedKey={selKey}
          selectedIsDate={selectedIsDate}
          saving={saving}
          roster={roster}
          daySchedule={daySched}
          prevDate={prevDate}
          prevWeekDate={prevWeekDate}
          onToggleShift={toggleShift}
          onCopyFrom={copyFrom}
          onApplyDefaultToEmptyVisibleDays={applyDefaultToEmptyVisibleDays}
          clinicDaySchedule={clinicDaySched}
          onToggleClinicShift={toggleClinicShift}
        />
      </div>
      <div style={{ width: 220, borderLeft: `1px solid ${C.border}`, overflow: 'auto', flexShrink: 0 }}>
        <NurseRosterPanel
          roster={roster}
          newName={newName}
          setNewName={setNewName}
          onAddNurse={addNurse}
          onRemoveNurse={removeNurse}
        />
      </div>
    </div>
  );
}
