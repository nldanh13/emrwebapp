// src/components/NurseTab.jsx — Lịch làm việc: một màn cho lịch điều dưỡng khoa (hành chánh, ca làm, ca
// trực) và lịch phòng khám (điều dưỡng, bác sĩ). Trên là bảng tổng quan một tuần (mở lên là tuần này,
// chọn sẵn hôm nay); bấm một ngày để sửa ngày đó ở khung bên dưới. Cột phải: danh sách điều dưỡng,
// ảnh chữ ký.
// Lưu: tự lưu ~0,4 giây sau lần sửa cuối, gửi roster + schedule + clinicSchedule (màn này giữ cả hai lịch).
// Quay lại tab thì tải lại (danh sách điều dưỡng có thể vừa đổi ở Thiết lập tài khoản), trừ khi đang chờ lưu.
import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { IconCalendarRepeat, IconChevronLeft, IconChevronRight, IconCloudCheck, IconCopy, IconTemplate } from '@tabler/icons-react';
import { C, FS } from '../tokens.js';
import { Btn, Spinner } from './shared.jsx';
import * as api from '../api.js';
import { useAuth } from '../hooks/useAuth.jsx';
import { useOnTabReturn } from '../hooks/useTabActivity.js';
import {
  DAY_KEYS,
  addDaysIso,
  buildDateRange,
  cloneShift,
  filterNameFromShift,
  formatDmy,
  getDaySchedule,
  normalizeScheduleShape,
  setDateSchedule,
  todayIso,
  weekdayLabelFromIso,
} from './nurse/nurseScheduleUtils.js';
import { FROM_LABEL, clinicNamesFor, nurseDayFor, setClinicNames, weekStartIso } from './nurse/clinicSchedule.js';
import useIsMobile from '../hooks/useIsMobile.js';
import NurseRosterPanel from './nurse/NurseRosterPanel.jsx';
import NurseMobileView from './nurse/NurseMobileView.jsx';
import ScheduleWeekGrid from './nurse/ScheduleWeekGrid.jsx';
import ClinicDoctorPicker from './nurse/ClinicDoctorPicker.jsx';
import { ShiftBucket } from './nurse/ShiftToggle.jsx';
import DateField from './DateField.jsx';
import { SkeletonScreen } from './Skeleton.jsx';

const EMPTY_TEXT = 'Chưa có điều dưỡng. Thêm tên ở cột bên phải.';

function SectionTitle({ children, hint }) {
  return (
    <div style={{ margin: '18px 0 10px', paddingTop: 14, borderTop: `1px solid ${C.border2}` }}>
      <div style={{ fontSize: FS.lg, fontWeight: 700, color: C.text }}>{children}</div>
      {hint && <div style={{ fontSize: FS.xs, color: C.text2, marginTop: 2 }}>{hint}</div>}
    </div>
  );
}

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
  const [doctors, setDoctors] = useState([]);
  const [emrAccounts, setEmrAccounts] = useState({});
  const [schedule, setSchedule] = useState(() => normalizeScheduleShape({}));
  const [clinicSchedule, setClinicSchedule] = useState(() => normalizeScheduleShape({}));
  const [loading, setLoading] = useState(true);
  const [saveState, setSaveState] = useState('idle'); // idle | pending | saving | saved | error
  const [newName, setNewName] = useState('');
  const [weekStart, setWeekStart] = useState(() => weekStartIso(todayIso()));
  const [selKey, setSelKey] = useState(todayIso());
  // Điện thoại: giữ cách chọn khoảng ngày như cũ, mặc định từ hôm nay.
  const [dateRange, setDateRange] = useState(() => ({ from: todayIso(), to: addDaysIso(todayIso(), 6) }));
  const [mobileDates, setMobileDates] = useState(() => buildDateRange(todayIso(), addDaysIso(todayIso(), 6)));

  const latest = useRef({ roster: [], schedule: normalizeScheduleShape({}), clinicSchedule: normalizeScheduleShape({}) });
  const saveTimer = useRef(null);

  const load = useCallback(async () => {
    if (saveTimer.current) return; // đang chờ tự lưu: không ghi đè chỗ vừa sửa
    try {
      const [d, acc] = await Promise.all([
        api.getNurseSettings(),
        api.getClinicDoctorAccounts().catch(() => ({ doctors: [] })),
      ]);
      const next = {
        roster: d.roster || [],
        schedule: normalizeScheduleShape(d.schedule || {}),
        clinicSchedule: normalizeScheduleShape(d.clinicSchedule || {}),
      };
      latest.current = next;
      setRoster(next.roster);
      setSchedule(next.schedule);
      setClinicSchedule(next.clinicSchedule);
      setDoctors(Array.isArray(acc?.doctors) ? acc.doctors : []);
    } catch (e) {
      toast?.(`Không tải được lịch: ${String(e?.message || e)}. Chuyển sang tab khác rồi quay lại để thử lại.`, 'error');
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => { load(); }, [load]);
  useOnTabReturn(() => load());

  useEffect(() => {
    if (!canEditSignatures) return;
    api.getNurseEmrAccounts()
      .then(d => {
        const byName = {};
        for (const row of d.accounts || []) if (row.kind !== 'doctor') byName[row.name] = row;
        setEmrAccounts(byName);
      })
      .catch(() => {});
  }, [canEditSignatures]);

  const applyAccountsResponse = useCallback((accounts) => {
    const byName = {};
    for (const row of accounts || []) if (row.kind !== 'doctor') byName[row.name] = row;
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

  /** Đổi một phần (roster / schedule / clinicSchedule) rồi hẹn tự lưu cả ba. */
  const update = useCallback((patch) => {
    latest.current = { ...latest.current, ...patch };
    if (patch.roster) setRoster(patch.roster);
    if (patch.schedule) setSchedule(patch.schedule);
    if (patch.clinicSchedule) setClinicSchedule(patch.clinicSchedule);
    setSaveState('pending');
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(async () => {
      saveTimer.current = null;
      setSaveState('saving');
      const cur = latest.current;
      try {
        const r = await api.saveNurseSettings({
          roster: cur.roster,
          schedule: normalizeScheduleShape(cur.schedule),
          clinicSchedule: normalizeScheduleShape(cur.clinicSchedule),
        });
        if (r.status !== 'ok') throw new Error(r.message || 'Máy chủ không lưu được lịch.');
        setSaveState(saveTimer.current ? 'pending' : 'saved');
      } catch (e) {
        setSaveState('error');
        toast?.(`Chưa lưu được lịch: ${String(e.message || e)}. Kiểm tra kết nối rồi sửa lại một ô để lưu lại.`, 'error');
      }
    }, 400);
  }, [toast]);

  useEffect(() => () => clearTimeout(saveTimer.current), []);

  const addNurse = useCallback(() => {
    const name = newName.trim();
    if (!name || roster.includes(name)) return;
    setNewName('');
    update({ roster: [...roster, name].sort((a, b) => a.localeCompare(b, 'vi')) });
  }, [newName, roster, update]);

  const removeNurse = useCallback((name) => {
    const oldSchedule = normalizeScheduleShape(schedule);
    const nextSched = { days: {} };
    for (const d of DAY_KEYS) nextSched[d] = filterNameFromShift(oldSchedule[d], name);
    for (const [iso, dayValue] of Object.entries(oldSchedule.days || {})) {
      nextSched.days[iso] = filterNameFromShift(dayValue, name);
    }
    update({ roster: roster.filter(n => n !== name), schedule: nextSched });

    // Bỏ luôn tài khoản EMR và chữ ký của người này — chỉ dòng của họ, không gửi cả danh sách.
    if (Object.prototype.hasOwnProperty.call(emrAccounts, name)) {
      api.removeNurseEmrAccount(name)
        .then(r => { if (r?.status === 'ok') applyAccountsResponse(r.accounts); else toast?.(r?.message, 'error'); })
        .catch(e => toast?.(`Chưa bỏ được tài khoản EMR của ${name}: ${String(e.message || e)}`, 'error'));
    }
  }, [roster, schedule, update, emrAccounts, applyAccountsResponse, toast]);

  // ── Lịch điều dưỡng khoa ─────────────────────────────────────────────────────
  const setNurseDay = useCallback((key, value) => {
    const next = key === 'Default'
      ? { ...normalizeScheduleShape(schedule), Default: cloneShift(value) }
      : setDateSchedule(schedule, key, value);
    update({ schedule: next });
  }, [schedule, update]);

  const toggleShiftForKey = useCallback((key, shift, name) => {
    const current = getDaySchedule(schedule, key);
    const prev = current[shift] || [];
    setNurseDay(key, { ...current, [shift]: prev.includes(name) ? prev.filter(n => n !== name) : [...prev, name] });
  }, [schedule, setNurseDay]);

  // ── Lịch phòng khám ──────────────────────────────────────────────────────────
  const setClinic = useCallback((kind, names) => {
    update({ clinicSchedule: setClinicNames(clinicSchedule, selKey, kind, names) });
  }, [clinicSchedule, selKey, update]);

  /** Chép cả lịch khoa và lịch phòng khám từ ngày khác (hoặc mẫu) sang ngày đang chọn. */
  const copyFrom = useCallback((sourceKey) => {
    let nextClinic = clinicSchedule;
    for (const kind of ['doctor', 'work']) nextClinic = setClinicNames(nextClinic, selKey, kind, clinicNamesFor(clinicSchedule, sourceKey, kind).names);
    update({ schedule: setDateSchedule(schedule, selKey, getDaySchedule(schedule, sourceKey)), clinicSchedule: nextClinic });
  }, [schedule, clinicSchedule, selKey, update]);

  const weekDates = useMemo(() => buildDateRange(weekStart, addDaysIso(weekStart, 6)), [weekStart]);

  const applyDefaultToEmptyDays = useCallback((dates) => {
    const oldSchedule = normalizeScheduleShape(schedule);
    const def = cloneShift(oldSchedule.Default);
    const nextSched = { ...oldSchedule, days: { ...(oldSchedule.days || {}) } };
    for (const iso of dates) {
      const current = cloneShift(nextSched.days[iso]);
      if ((current.admin.length || current.work.length || current.oncall.length)) continue;
      nextSched.days[iso] = cloneShift(def);
    }
    update({ schedule: nextSched });
  }, [schedule, update]);

  const goWeek = (delta) => {
    const next = addDaysIso(weekStart, 7 * delta);
    setWeekStart(next);
    setSelKey(k => (k === 'Default' ? k : addDaysIso(k, 7 * delta)));
  };
  const goToDate = (iso) => {
    if (!iso) return;
    setWeekStart(weekStartIso(iso));
    setSelKey(iso);
  };

  if (loading) return <SkeletonScreen label="Đang tải lịch làm việc" rows={8} cols={7} />;

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
        onApplyRange={() => setMobileDates(buildDateRange(dateRange.from, dateRange.to))}
        saving={saveState === 'saving'}
        visibleDates={mobileDates}
        schedule={schedule}
        selectedKey={selKey}
        setSelectedKey={setSelKey}
        onToggleShiftForKey={toggleShiftForKey}
        onCopyFromToKey={(target, source) => setNurseDay(target, getDaySchedule(schedule, source))}
      />
    );
  }

  const selectedIsDate = selKey !== 'Default';
  const nurseInfo = nurseDayFor(schedule, selKey);
  const daySched = getDaySchedule(schedule, selKey);
  const doctorInfo = clinicNamesFor(clinicSchedule, selKey, 'doctor');
  const clinicNurseInfo = clinicNamesFor(clinicSchedule, selKey, 'work');
  const today = todayIso();
  const inheritedNote = (info) => (selectedIsDate && FROM_LABEL[info.from] ? ` Đang lấy ${FROM_LABEL[info.from]}; bấm chọn để xếp riêng ngày này.` : '');

  return (
    <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>
      <div style={{ flex: 1, overflow: 'auto', background: C.bg, padding: 14 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', marginBottom: 10 }}>
          <Btn icon={IconChevronLeft} onClick={() => goWeek(-1)} aria-label="Tuần trước">Tuần trước</Btn>
          <Btn onClick={() => goToDate(today)} disabled={weekStart === weekStartIso(today) && selKey === today}>Hôm nay</Btn>
          <Btn onClick={() => goWeek(1)} aria-label="Tuần sau">Tuần sau <IconChevronRight size={15} stroke={1.75} aria-hidden="true" /></Btn>
          <div style={{ fontSize: FS.md, fontWeight: 700, color: C.text, margin: '0 6px' }}>
            {formatDmy(weekDates[0]).slice(0, 5)} – {formatDmy(weekDates[6])}
          </div>
          <div style={{ width: 150 }}><DateField label="Đến ngày" value={selectedIsDate ? selKey : ''} onChange={goToDate} /></div>
          <div style={{ flex: 1 }} />
          <Btn icon={IconCalendarRepeat} onClick={() => applyDefaultToEmptyDays(weekDates)} title="Áp mẫu mặc định cho các ngày trong tuần chưa phân công điều dưỡng">
            Điền mẫu cho ngày trống
          </Btn>
          <Btn icon={IconTemplate} variant={selKey === 'Default' ? 'primary' : 'default'} onClick={() => setSelKey('Default')}>Mẫu mặc định</Btn>
        </div>

        <ScheduleWeekGrid dates={weekDates} schedule={schedule} clinicSchedule={clinicSchedule} selectedKey={selKey} onSelect={setSelKey} />
        <div style={{ fontSize: FS.xs, color: C.text3, margin: '6px 2px 0' }}>
          Chữ nhạt: lấy theo mẫu, chưa xếp riêng ngày đó. Bấm một ngày để sửa.
        </div>

        <section aria-label="Sửa lịch ngày đang chọn" style={{ marginTop: 14, padding: 16, background: C.surface, border: `1px solid ${C.border2}`, borderRadius: 8 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <h2 style={{ margin: 0, fontSize: FS.xl, fontWeight: 700, color: C.text }}>
              {selectedIsDate ? `${weekdayLabelFromIso(selKey)}, ${formatDmy(selKey)}${selKey === today ? ' (hôm nay)' : ''}` : 'Mẫu mặc định'}
            </h2>
            <span role="status" style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: FS.xs, color: saveState === 'error' ? C.red : C.text2 }}>
              {saveState === 'saving' && <><Spinner size={12} /> Đang lưu…</>}
              {saveState === 'pending' && 'Chưa lưu, đang chờ tự lưu…'}
              {saveState === 'error' && 'Chưa lưu được. Sửa lại một ô để lưu lại.'}
              {(saveState === 'idle' || saveState === 'saved') && <><IconCloudCheck size={15} stroke={1.75} color={C.green} aria-hidden="true" /> {saveState === 'saved' ? 'Đã tự lưu' : 'Tự lưu khi thay đổi'}</>}
            </span>
          </div>
          {selectedIsDate ? (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 10 }}>
              <Btn icon={IconCopy} onClick={() => copyFrom(addDaysIso(selKey, -1))}>Chép từ ngày trước</Btn>
              <Btn icon={IconCopy} onClick={() => copyFrom(addDaysIso(selKey, -7))}>Chép từ tuần trước</Btn>
              <Btn icon={IconTemplate} onClick={() => copyFrom('Default')}>Dùng mẫu mặc định</Btn>
            </div>
          ) : (
            <p style={{ margin: '6px 0 0', fontSize: FS.sm, color: C.text2 }}>Dùng cho những ngày chưa xếp riêng.</p>
          )}

          <SectionTitle hint={inheritedNote(nurseInfo).trim() || undefined}>Điều dưỡng khoa</SectionTitle>
          <ShiftBucket shift="admin" roster={roster} selected={daySched.admin || []} onToggle={(shift, name) => toggleShiftForKey(selKey, shift, name)}
            emptyText={EMPTY_TEXT} hint="Vị trí hành chánh bệnh phòng trong giờ hành chính." />
          <ShiftBucket shift="work" roster={roster} selected={daySched.work || []} onToggle={(shift, name) => toggleShiftForKey(selKey, shift, name)} emptyText={EMPTY_TEXT} />
          <ShiftBucket shift="oncall" roster={roster} selected={daySched.oncall || []} onToggle={(shift, name) => toggleShiftForKey(selKey, shift, name)} emptyText={EMPTY_TEXT} />

          <SectionTitle hint={inheritedNote(doctorInfo).trim() || undefined}>Phòng khám</SectionTitle>
          <ClinicDoctorPicker doctors={doctors} selected={doctorInfo.names} onChange={names => setClinic('doctor', names)} />
          <ShiftBucket
            label="Điều dưỡng phòng khám"
            shift="work"
            roster={roster}
            selected={clinicNurseInfo.names}
            onToggle={(_shift, name) => setClinic('work', clinicNurseInfo.names.includes(name) ? clinicNurseInfo.names.filter(n => n !== name) : [...clinicNurseInfo.names, name])}
            emptyText={EMPTY_TEXT}
            hint={`Tên được điền vào phiếu chăm sóc.${inheritedNote(clinicNurseInfo)}`}
          />
          <div style={{ color: C.text2, fontSize: FS.xs }}>
            Ưu tiên lịch đúng ngày; ngày nào trống mới dùng mẫu mặc định.
          </div>
        </section>
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
