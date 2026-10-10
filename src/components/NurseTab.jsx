import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { C } from '../tokens.js';
import * as api from '../api.js';
import { useAuth } from '../hooks/useAuth.jsx';
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
import useIsMobile from '../hooks/useIsMobile.js';
import NurseDatePanel from './nurse/NurseDatePanel.jsx';
import NurseSchedulePanel from './nurse/NurseSchedulePanel.jsx';
import NurseRosterPanel from './nurse/NurseRosterPanel.jsx';
import NurseMobileView from './nurse/NurseMobileView.jsx';
import { SkeletonScreen } from './Skeleton.jsx';

export default function NurseTab({ toast }) {
  const isMobile = useIsMobile();
  const { user } = useAuth();
  // Ảnh chữ ký nằm chung file với tài khoản EMR theo điều dưỡng (chứa mật khẩu thật) nên chỉ
  // quản trị sửa. Không đăng nhập (chế độ local_only) vẫn cho sửa như trước.
  // Tài khoản EMR của từng điều dưỡng sửa ở Thiết lập tài khoản → Tài khoản EMR.
  const canEditSignatures = !user || user.role === 'admin';
  const [showNursePanel, setShowNursePanel] = useState(false);
  const [showDatePicker, setShowDatePicker] = useState(false);

  const [roster, setRoster] = useState([]);
  const [emrAccounts, setEmrAccounts] = useState({});
  const [schedule, setSchedule] = useState(() => normalizeScheduleShape({}));
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
        const apiDates = Array.isArray(d.available_dates) ? d.available_dates.map(toIsoDate).filter(Boolean) : [];
        const savedDates = Object.keys(nextSchedule.days || {}).map(toIsoDate).filter(Boolean);
        const uniqueDates = [...new Set(apiDates.length ? apiDates : savedDates)].sort();
        const dates = uniqueDates.length ? uniqueDates : buildDateRange(todayIso(), addDaysIso(todayIso(), 6));
        setRoster(nextRoster);
        setSchedule(nextSchedule);
        setVisibleDates(dates);
        setDateRange({ from: dates[0], to: dates[dates.length - 1] });
        setSelKey(dates[0] || todayIso());
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    if (!canEditSignatures) return;
    api.getNurseEmrAccounts()
      .then(d => {
        const byName = {};
        for (const row of d.accounts || []) byName[row.name] = row;
        setEmrAccounts(byName);
      })
      .catch(() => {});
  }, [canEditSignatures]);

  const saveTimer = useRef(null);
  const applyAccountsResponse = useCallback((accounts) => {
    const byName = {};
    for (const row of accounts || []) byName[row.name] = row;
    setEmrAccounts(byName);
  }, []);

  const uploadSignature = useCallback(async (name, imageDataUrl) => {
    try {
      const r = await api.saveNurseSignature(name, imageDataUrl);
      if (r.status !== 'ok') { toast?.(r.message, 'error'); return; }
      applyAccountsResponse(r.accounts);
      toast?.('Đã lưu chữ ký', 'ok');
    } catch (e) {
      toast?.(String(e.message), 'error');
    }
  }, [toast, applyAccountsResponse]);

  const removeSignature = useCallback(async (name) => {
    try {
      const r = await api.removeNurseSignature(name);
      if (r.status !== 'ok') { toast?.(r.message, 'error'); return; }
      applyAccountsResponse(r.accounts);
    } catch (e) {
      toast?.(String(e.message), 'error');
    }
  }, [toast, applyAccountsResponse]);

  // Lịch phòng khám sửa ở tab Lịch phòng khám: ở đây không gửi clinicSchedule để không ghi đè.
  const save = useCallback((nextRoster, nextSchedule) => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(async () => {
      setSaving(true);
      try {
        const r = await api.saveNurseSettings({
          roster: nextRoster,
          schedule: normalizeScheduleShape(nextSchedule),
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
    save(next, schedule);
  }, [newName, roster, schedule, save]);

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
    save(next, nextSched);

    // Bỏ luôn tài khoản EMR và chữ ký của người này — chỉ dòng của họ, không gửi cả danh sách
    // (bản đang giữ ở đây có thể cũ hơn phần vừa sửa ở Thiết lập tài khoản).
    if (Object.prototype.hasOwnProperty.call(emrAccounts, name)) {
      api.removeNurseEmrAccount(name)
        .then(r => { if (r?.status === 'ok') applyAccountsResponse(r.accounts); else toast?.(r?.message, 'error'); })
        .catch(e => toast?.(`Chưa bỏ được tài khoản EMR của ${name}: ${String(e.message || e)}`, 'error'));
    }
  }, [roster, schedule, save, emrAccounts, applyAccountsResponse, toast]);

  const updateScheduleForKey = useCallback((key, value) => {
    let nextSched;
    if (key === 'Default') {
      nextSched = { ...normalizeScheduleShape(schedule), Default: cloneShift(value) };
    } else {
      nextSched = setDateSchedule(schedule, key, value);
    }
    setSchedule(nextSched);
    save(roster, nextSched);
  }, [schedule, roster, save]);

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
    save(roster, nextSched);
  }, [schedule, visibleDates, roster, save]);

  const daySched = useMemo(() => getDaySchedule(schedule, selKey), [schedule, selKey]);
  const selectedIsDate = Boolean(selKey) && selKey !== 'Default';
  const prevDate = selectedIsDate ? addDaysIso(selKey, -1) : '';
  const prevWeekDate = selectedIsDate ? addDaysIso(selKey, -7) : '';

  if (loading) return <SkeletonScreen label="Đang tải lịch điều dưỡng" rows={8} cols={7} />;


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
      <div style={{ width: 210, borderRight: `1px solid ${C.border}`, overflow: 'auto', flexShrink: 0, background: C.surface }}>
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
      <div style={{ flex: 1, overflow: 'auto', background: C.surface }}>
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
        />
      </div>
      <div style={{ width: 280, borderLeft: `1px solid ${C.border}`, overflow: 'auto', flexShrink: 0, background: C.surface }}>
        <NurseRosterPanel
          roster={roster}
          newName={newName}
          setNewName={setNewName}
          onAddNurse={addNurse}
          onRemoveNurse={removeNurse}
          emrAccounts={emrAccounts}
          onUploadSignature={uploadSignature}
          onRemoveSignature={removeSignature}
          canEditSignatures={canEditSignatures}
        />
      </div>
    </div>
  );
}
