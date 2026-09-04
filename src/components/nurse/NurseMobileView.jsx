import { C } from '../../tokens.js';
import { Btn } from '../shared.jsx';
import {
  addDaysIso,
  formatDmy,
  getDaySchedule,
  weekdayLabelFromIso,
} from './nurseScheduleUtils.js';

function MobileNursePanel({ roster, newName, setNewName, onAddNurse, onRemoveNurse }) {
  return (
    <div style={{ borderBottom: `1px solid ${C.border}`, flexShrink: 0, background: C.surface }}>
      <div style={{ padding: '10px 12px', display: 'flex', gap: 6 }}>
        <input value={newName} onChange={e => setNewName(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && onAddNurse()}
          placeholder="Tên điều dưỡng..."
          style={{ flex: 1, background: C.surface2, border: `1px solid ${C.border}`, borderRadius: 4, padding: '7px 10px', color: C.text, fontSize: 13, fontFamily: 'inherit', outline: 'none' }}
        />
        <Btn variant="primary" onClick={onAddNurse} style={{ padding: '6px 14px', fontSize: 15 }}>+</Btn>
      </div>
      {roster.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, padding: '4px 12px 12px' }}>
          {roster.map(name => (
            <div key={name} style={{
              display: 'flex', alignItems: 'center', gap: 6,
              background: C.surface2, border: `1px solid ${C.border}`, borderRadius: 6, padding: '5px 10px',
            }}>
              <span style={{ fontSize: 13, color: C.text }}>{name}</span>
              <button type="button" onClick={() => onRemoveNurse(name)} style={{ background: 'none', border: 'none', color: C.text3, cursor: 'pointer', fontSize: 14, padding: '0 2px' }}>✕</button>
            </div>
          ))}
        </div>
      )}
      {roster.length === 0 && <div style={{ padding: '4px 12px 12px', fontSize: 12, color: C.text3 }}>Chưa có điều dưỡng</div>}
    </div>
  );
}

function MobileDatePicker({ dateRange, setDateRange, onApplyRange }) {
  return (
    <div style={{ padding: '10px 12px', borderBottom: `1px solid ${C.border2}`, display: 'grid', gap: 6, flexShrink: 0, background: C.surface }}>
      <input type="date" value={dateRange.from}
        onChange={e => setDateRange(v => ({ ...v, from: e.target.value }))}
        style={{ background: C.surface2, border: `1px solid ${C.border}`, borderRadius: 4, padding: '6px 8px', color: C.text, fontSize: 13, fontFamily: 'inherit', outline: 'none' }}
      />
      <input type="date" value={dateRange.to}
        onChange={e => setDateRange(v => ({ ...v, to: e.target.value }))}
        style={{ background: C.surface2, border: `1px solid ${C.border}`, borderRadius: 4, padding: '6px 8px', color: C.text, fontSize: 13, fontFamily: 'inherit', outline: 'none' }}
      />
      <Btn variant="default" onClick={onApplyRange} style={{ justifyContent: 'center', fontSize: 13 }}>Hiển thị</Btn>
    </div>
  );
}

function shiftTone(shift) {
  if (shift === 'admin') return { bg: C.amberBg || C.surface2, border: C.amberBorder || C.border, color: C.amber || C.text };
  if (shift === 'work') return { bg: C.greenBg, border: C.greenBorder, color: C.green };
  return { bg: C.blueBg, border: C.blueBorder, color: C.blue };
}

function MobileShiftButton({ name, active, shift, onClick }) {
  const tone = shiftTone(shift);
  return (
    <button type="button" onClick={onClick} style={{
      padding: '8px 14px', borderRadius: 6, border: '1px solid', cursor: 'pointer',
      fontSize: 14, fontFamily: 'inherit', minHeight: 40,
      background: active ? tone.bg : C.surface,
      borderColor: active ? tone.border : C.border,
      color: active ? tone.color : C.text2,
      fontWeight: active ? 600 : 400,
    }}>{name}</button>
  );
}

function MobileShiftToggles({ entryKey, roster, schedule, onToggleShiftForKey, onCopyFromToKey }) {
  const ds = getDaySchedule(schedule, entryKey);
  const prevD = entryKey !== 'Default' ? addDaysIso(entryKey, -1) : '';
  const prevW = entryKey !== 'Default' ? addDaysIso(entryKey, -7) : '';

  return (
    <div style={{ padding: '12px 14px 16px', background: C.surface2, borderTop: `1px solid ${C.border2}` }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 14 }}>
        {entryKey !== 'Default' && (
          <>
            <Btn variant="default" onClick={() => onCopyFromToKey(entryKey, prevD)} style={{ fontSize: 11, padding: '4px 10px' }}>← Ngày trước</Btn>
            <Btn variant="default" onClick={() => onCopyFromToKey(entryKey, prevW)} style={{ fontSize: 11, padding: '4px 10px' }}>← Tuần trước</Btn>
            <Btn variant="default" onClick={() => onCopyFromToKey(entryKey, 'Default')} style={{ fontSize: 11, padding: '4px 10px' }}>Mặc định</Btn>
          </>
        )}
      </div>

      {[
        ['admin', 'ĐD HÀNH CHÁNH', C.amber || C.text],
        ['work', 'CA LÀM', C.green],
        ['oncall', 'CA TRỰC', C.blue],
      ].map(([shift, label, labelColor]) => (
        <div key={shift} style={{ marginBottom: shift === 'oncall' ? 0 : 14 }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: labelColor, letterSpacing: '0.07em', marginBottom: 8 }}>{label}</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            {roster.length === 0 && <div style={{ fontSize: 12, color: C.text3 }}>Thêm điều dưỡng ở trên</div>}
            {roster.map(name => {
              const active = (ds[shift] || []).includes(name);
              return (
                <MobileShiftButton
                  key={name}
                  name={name}
                  active={active}
                  shift={shift}
                  onClick={() => onToggleShiftForKey(entryKey, shift, name)}
                />
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}

function MobileScheduleEntry({ entryKey, title, subtitle, hasAny, isOpen, onToggleOpen, children }) {
  return (
    <div style={{ borderBottom: `1px solid ${C.border2}` }}>
      <div onClick={onToggleOpen} style={{
        padding: '13px 14px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 10,
        background: isOpen ? C.surface2 : 'transparent', userSelect: 'none',
      }}>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 14, fontWeight: isOpen ? 600 : 400, color: C.text }}>{title}</div>
          <div style={{ fontSize: 12, color: C.text2, marginTop: 3 }}>{subtitle}</div>
        </div>
        {hasAny && <span style={{ color: C.green, fontSize: 16 }}>✓</span>}
        <span style={{ color: C.text3, fontSize: 14 }}>{isOpen ? '▲' : '▼'}</span>
      </div>
      {isOpen && children}
    </div>
  );
}

function ScheduleSummary({ admin = [], work = [], oncall = [] }) {
  const hasAny = admin.length + work.length + oncall.length > 0;
  if (!hasAny) return <span style={{ color: C.text3 }}>Chưa phân công</span>;
  return (
    <>
      <span style={{ color: C.amber || C.text }}>HC: </span>{admin.join(', ') || '–'}{'  '}
      <span style={{ color: C.green }}>Làm: </span>{work.join(', ') || '–'}{'  '}
      <span style={{ color: C.blue }}>Trực: </span>{oncall.join(', ') || '–'}
    </>
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
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, overflow: 'hidden' }}>
      <div style={{
        display: 'flex', gap: 8, padding: '8px 12px', flexShrink: 0,
        borderBottom: `1px solid ${C.border}`, flexWrap: 'wrap', alignItems: 'center',
        background: C.surface,
      }}>
        <button type="button" onClick={() => { setShowNursePanel(v => !v); setShowDatePicker(false); }} style={{
          padding: '6px 12px', borderRadius: 6, border: `1px solid ${showNursePanel ? C.blueBorder : C.border}`,
          background: showNursePanel ? C.blueBg : 'transparent', color: showNursePanel ? C.blue : C.text2,
          cursor: 'pointer', fontSize: 13, fontFamily: 'inherit',
        }}>👥 Điều dưỡng ({roster.length})</button>

        <button type="button" onClick={() => { setShowDatePicker(v => !v); setShowNursePanel(false); }} style={{
          padding: '6px 12px', borderRadius: 6, border: `1px solid ${showDatePicker ? C.blueBorder : C.border}`,
          background: showDatePicker ? C.blueBg : 'transparent', color: showDatePicker ? C.blue : C.text2,
          cursor: 'pointer', fontSize: 13, fontFamily: 'inherit',
        }}>📅 {formatDmy(dateRange.from)} – {formatDmy(dateRange.to)}</button>

        {saving && <span style={{ fontSize: 11, color: C.text2 }}>Đang lưu...</span>}
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

      <div style={{ flex: 1, overflow: 'auto' }}>
        {visibleDates.map(iso => {
          const ds = getDaySchedule(schedule, iso);
          const isOpen = selectedKey === iso;
          const hasAny = (ds.admin.length + ds.work.length + ds.oncall.length) > 0;
          return (
            <MobileScheduleEntry
              key={iso}
              entryKey={iso}
              title={<>{weekdayLabelFromIso(iso)} &nbsp;·&nbsp; {formatDmy(iso)}</>}
              subtitle={<ScheduleSummary admin={ds.admin} work={ds.work} oncall={ds.oncall} />}
              hasAny={hasAny}
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
          const hasAny = admin.length + work.length + oncall.length > 0;
          return (
            <MobileScheduleEntry
              entryKey="Default"
              title="Mặc định"
              subtitle={<ScheduleSummary admin={admin} work={work} oncall={oncall} />}
              hasAny={hasAny}
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
