import { IconCalendar, IconChevronDown, IconChevronUp, IconCopy, IconPlus, IconTemplate, IconTrash, IconUsers } from '@tabler/icons-react';
import { C, FS } from '../../tokens.js';
import { Btn, Spinner } from '../shared.jsx';
import DateField from '../DateField.jsx';
import {
  addDaysIso,
  formatDmy,
  getDaySchedule,
  weekdayLabelFromIso,
} from './nurseScheduleUtils.js';
import { SHIFT_META, ShiftBucket } from './ShiftToggle.jsx';

function MobileNursePanel({ roster, newName, setNewName, onAddNurse, onRemoveNurse }) {
  const remove = name => {
    if (window.confirm(`Xoá ${name} khỏi danh sách? Tên cũng bị gỡ khỏi mọi ca đã phân công.`)) onRemoveNurse(name);
  };
  return (
    <div style={{ borderBottom: `1px solid ${C.border}`, background: C.surface }}>
      <form onSubmit={e => { e.preventDefault(); onAddNurse(); }} style={{ padding: '10px 12px', display: 'flex', gap: 6 }}>
        <input value={newName} onChange={e => setNewName(e.target.value)}
          placeholder="Tên điều dưỡng" aria-label="Tên điều dưỡng mới"
          style={{ flex: 1, minWidth: 0, height: 40, background: C.surface, border: `1px solid ${C.border}`, borderRadius: 5, padding: '0 10px', color: C.text, fontSize: FS.lg, fontFamily: 'inherit' }}
        />
        <Btn type="submit" variant="primary" icon={IconPlus} disabled={!newName.trim()} style={{ minHeight: 40 }}>Thêm</Btn>
      </form>
      {roster.length > 0 ? (
        <ul style={{ margin: 0, padding: '0 12px 8px', listStyle: 'none' }}>
          {roster.map(name => (
            <li key={name} style={{ display: 'flex', alignItems: 'center', gap: 6, borderTop: `1px solid ${C.border2}`, minHeight: 44 }}>
              <span style={{ flex: 1, fontSize: FS.lg, color: C.text }}>{name}</span>
              <button type="button" className="emr-icon-btn emr-icon-btn--danger" onClick={() => remove(name)} aria-label={`Xoá ${name}`}>
                <IconTrash size={17} stroke={1.75} />
              </button>
            </li>
          ))}
        </ul>
      ) : <div style={{ padding: '0 12px 12px', fontSize: FS.sm, color: C.text2 }}>Chưa có điều dưỡng.</div>}
      <div style={{ padding: '0 12px 12px', fontSize: FS.xs, color: C.text2 }}>Tài khoản EMR và chữ ký chỉnh trên máy tính.</div>
    </div>
  );
}

function MobileDatePicker({ dateRange, setDateRange, onApplyRange }) {
  return (
    <div style={{ padding: '10px 12px', borderBottom: `1px solid ${C.border}`, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, background: C.surface }}>
      <DateField label="Từ ngày" value={dateRange.from} onChange={iso => setDateRange(v => ({ ...v, from: iso }))} />
      <DateField label="Đến ngày" value={dateRange.to} onChange={iso => setDateRange(v => ({ ...v, to: iso }))} />
      <Btn variant="primary" onClick={onApplyRange} style={{ gridColumn: '1 / -1', justifyContent: 'center', minHeight: 40 }}>Hiển thị</Btn>
    </div>
  );
}

function MobileShiftToggles({ entryKey, roster, schedule, onToggleShiftForKey, onCopyFromToKey }) {
  const ds = getDaySchedule(schedule, entryKey);
  const prevD = entryKey !== 'Default' ? addDaysIso(entryKey, -1) : '';
  const prevW = entryKey !== 'Default' ? addDaysIso(entryKey, -7) : '';
  const emptyText = 'Chưa có điều dưỡng. Bấm "Điều dưỡng" ở trên để thêm.';

  return (
    <div style={{ padding: '12px 14px 4px', background: C.surface2, borderTop: `1px solid ${C.border2}` }}>
      {entryKey !== 'Default' && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 14 }}>
          <Btn icon={IconCopy} onClick={() => onCopyFromToKey(entryKey, prevD)} style={{ minHeight: 36 }}>Chép ngày trước</Btn>
          <Btn icon={IconCopy} onClick={() => onCopyFromToKey(entryKey, prevW)} style={{ minHeight: 36 }}>Chép tuần trước</Btn>
          <Btn icon={IconTemplate} onClick={() => onCopyFromToKey(entryKey, 'Default')} style={{ minHeight: 36 }}>Mẫu mặc định</Btn>
        </div>
      )}
      {['admin', 'work', 'oncall'].map(shift => (
        <ShiftBucket
          key={shift}
          shift={shift}
          roster={roster}
          selected={ds[shift] || []}
          onToggle={(sh, name) => onToggleShiftForKey(entryKey, sh, name)}
          emptyText={emptyText}
          large
        />
      ))}
    </div>
  );
}

function MobileScheduleEntry({ title, subtitle, isOpen, onToggleOpen, children }) {
  return (
    <div style={{ borderBottom: `1px solid ${C.border2}`, background: C.surface }}>
      <button type="button" onClick={onToggleOpen} aria-expanded={isOpen} style={{
        width: '100%', padding: '12px 14px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 10, textAlign: 'left',
        border: 0, fontFamily: 'inherit', background: isOpen ? C.blueBg : 'transparent', color: C.text,
      }}>
        <span style={{ flex: 1, minWidth: 0 }}>
          <span style={{ display: 'block', fontSize: FS.lg, fontWeight: 650, color: isOpen ? C.blue : C.text }}>{title}</span>
          <span style={{ display: 'block', fontSize: FS.sm, color: C.text2, marginTop: 3 }}>{subtitle}</span>
        </span>
        {isOpen ? <IconChevronUp size={18} stroke={1.75} color={C.text2} aria-hidden="true" /> : <IconChevronDown size={18} stroke={1.75} color={C.text2} aria-hidden="true" />}
      </button>
      {isOpen && children}
    </div>
  );
}

function ScheduleSummary({ admin = [], work = [], oncall = [] }) {
  const hasAny = admin.length + work.length + oncall.length > 0;
  if (!hasAny) return <span style={{ color: C.amber }}>Chưa phân công</span>;
  return (
    <span style={{ display: 'grid', gap: 1 }}>
      {[['admin', admin], ['work', work], ['oncall', oncall]].map(([shift, names]) => (
        <span key={shift}>
          <b style={{ color: SHIFT_META[shift].fg, fontWeight: 650 }}>{SHIFT_META[shift].short}:</b> {names.join(', ') || '—'}
        </span>
      ))}
    </span>
  );
}

export default function NurseMobileView({
  showNursePanel,
  setShowNursePanel,
  showDatePicker,
  setShowDatePicker,
  roster = [],
  newName,
  setNewName,
  onAddNurse,
  onRemoveNurse,
  dateRange,
  setDateRange,
  onApplyRange,
  saving,
  visibleDates = [],
  schedule,
  selectedKey,
  setSelectedKey,
  onToggleShiftForKey,
  onCopyFromToKey,
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1 }}>
      <div style={{
        display: 'flex', gap: 8, padding: '8px 12px',
        borderBottom: `1px solid ${C.border}`, flexWrap: 'wrap', alignItems: 'center',
        background: C.surface,
      }}>
        <Btn icon={IconUsers} variant={showNursePanel ? 'primary' : 'default'} aria-expanded={showNursePanel}
          onClick={() => { setShowNursePanel(v => !v); setShowDatePicker(false); }} style={{ minHeight: 38 }}>
          Điều dưỡng ({roster.length})
        </Btn>
        <Btn icon={IconCalendar} variant={showDatePicker ? 'primary' : 'default'} aria-expanded={showDatePicker}
          onClick={() => { setShowDatePicker(v => !v); setShowNursePanel(false); }} style={{ minHeight: 38 }}>
          {formatDmy(dateRange.from)} – {formatDmy(dateRange.to)}
        </Btn>
        {saving && <span role="status" style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: FS.xs, color: C.text2 }}><Spinner size={12} /> Đang lưu…</span>}
      </div>

      {showNursePanel && (
        <MobileNursePanel
          roster={roster}
          newName={newName}
          setNewName={setNewName}
          onAddNurse={onAddNurse}
          onRemoveNurse={onRemoveNurse}
        />
      )}

      {showDatePicker && (
        <MobileDatePicker
          dateRange={dateRange}
          setDateRange={setDateRange}
          onApplyRange={() => { onApplyRange(); setShowDatePicker(false); }}
        />
      )}

      <div>
        {visibleDates.map(iso => {
          const ds = getDaySchedule(schedule, iso);
          const isOpen = selectedKey === iso;
          return (
            <MobileScheduleEntry
              key={iso}
              entryKey={iso}
              title={`${weekdayLabelFromIso(iso)}, ${formatDmy(iso)}`}
              subtitle={<ScheduleSummary admin={ds.admin} work={ds.work} oncall={ds.oncall} />}
              isOpen={isOpen}
              onToggleOpen={() => setSelectedKey(isOpen ? null : iso)}
            >
              <MobileShiftToggles
                entryKey={iso}
                roster={roster}
                schedule={schedule}
                onToggleShiftForKey={onToggleShiftForKey}
                onCopyFromToKey={onCopyFromToKey}
              />
            </MobileScheduleEntry>
          );
        })}

        {(() => {
          const isOpen = selectedKey === 'Default';
          const def = schedule.Default || {};
          const admin = def.admin || [];
          const work = def.work || [];
          const oncall = def.oncall || [];
          return (
            <MobileScheduleEntry
              entryKey="Default"
              title="Mẫu mặc định"
              subtitle={<ScheduleSummary admin={admin} work={work} oncall={oncall} />}
              isOpen={isOpen}
              onToggleOpen={() => setSelectedKey(isOpen ? null : 'Default')}
            >
              <MobileShiftToggles
                entryKey="Default"
                roster={roster}
                schedule={schedule}
                onToggleShiftForKey={onToggleShiftForKey}
                onCopyFromToKey={onCopyFromToKey}
              />
            </MobileScheduleEntry>
          );
        })()}
      </div>
    </div>
  );
}
