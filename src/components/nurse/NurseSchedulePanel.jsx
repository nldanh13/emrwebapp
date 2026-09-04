import { C } from '../../tokens.js';
import { Btn } from '../shared.jsx';
import { formatDmy, weekdayLabelFromIso } from './nurseScheduleUtils.js';

function shiftTone(shift) {
  if (shift === 'admin') return { bg: C.amberBg || C.surface2, border: C.amberBorder || C.border, color: C.amber || C.text };
  if (shift === 'work') return { bg: C.greenBg, border: C.greenBorder, color: C.green };
  return { bg: C.blueBg, border: C.blueBorder, color: C.blue };
}

function ShiftBucket({ label, shift, roster, daySchedule, onToggleShift, emptyText, hint }) {
  const tone = shiftTone(shift);
  return (
    <div style={{ marginBottom: 14 }}>
      <div style={{ fontSize: 11, fontWeight: 600, color: C.text3, letterSpacing: '0.02em', marginBottom: 5 }}>
        {label}
      </div>
      {hint && <div style={{ fontSize: 11, color: C.text3, marginBottom: 8 }}>{hint}</div>}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
        {roster.map(name => {
          const active = (daySchedule[shift] || []).includes(name);
          return (
            <button type="button" key={name} onClick={() => onToggleShift(shift, name)} style={{
              padding: '6px 12px', borderRadius: 4, border: '1px solid',
              cursor: 'pointer', fontSize: 13, fontFamily: 'inherit',
              background: active ? tone.bg : 'transparent',
              borderColor: active ? tone.border : C.border,
              color: active ? tone.color : C.text2,
              minHeight: 36,
            }}>{name}</button>
          );
        })}
        {roster.length === 0 && <div style={{ fontSize: 12, color: C.text3 }}>{emptyText}</div>}
      </div>
    </div>
  );
}

export default function NurseSchedulePanel({
  isMobile = false,
  selectedKey,
  selectedIsDate,
  saving = false,
  roster = [],
  daySchedule,
  prevDate,
  prevWeekDate,
  onToggleShift,
  onCopyFrom,
  onApplyDefaultToEmptyVisibleDays,
  // Lịch phòng khám
  clinicRoster = [],
  clinicDaySchedule,
  onToggleClinicShift,
}) {
  return (
    <div style={{ flex: 1, overflow: 'auto', padding: isMobile ? '10px 10px 20px' : 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 14 }}>
        <div style={{ fontSize: 15, fontWeight: 600, color: C.text }}>
          {selectedIsDate ? `${formatDmy(selectedKey)} · ${weekdayLabelFromIso(selectedKey)}` : 'Mẫu mặc định'}
        </div>
        {saving && <span style={{ fontSize: 11, color: C.text2 }}>Đang lưu...</span>}
      </div>
      {selectedIsDate && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 14 }}>
          <Btn variant="default" onClick={() => onCopyFrom(prevDate)}>Copy từ ngày trước</Btn>
          <Btn variant="default" onClick={() => onCopyFrom(prevWeekDate)}>Copy từ tuần trước</Btn>
          <Btn variant="default" onClick={() => onCopyFrom('Default')}>Áp dụng mẫu mặc định</Btn>
          <Btn variant="default" onClick={onApplyDefaultToEmptyVisibleDays}>Áp dụng mặc định cho ngày trống</Btn>
        </div>
      )}

      <ShiftBucket
        label="Điều dưỡng hành chánh"
        shift="admin"
        roster={roster}
        daySchedule={daySchedule}
        onToggleShift={onToggleShift}
        emptyText={isMobile ? 'Thêm điều dưỡng ở tab "Danh sách"' : 'Thêm điều dưỡng ở cột bên phải'}
        hint="Vị trí hành chánh bệnh phòng trong giờ hành chính."
      />
      <ShiftBucket
        label="Ca làm"
        shift="work"
        roster={roster}
        daySchedule={daySchedule}
        onToggleShift={onToggleShift}
        emptyText={isMobile ? 'Thêm điều dưỡng ở tab "Danh sách"' : 'Thêm điều dưỡng ở cột bên phải'}
      />
      <ShiftBucket
        label="Ca trực"
        shift="oncall"
        roster={roster}
        daySchedule={daySchedule}
        onToggleShift={onToggleShift}
        emptyText={isMobile ? 'Thêm điều dưỡng ở tab "Danh sách"' : 'Thêm điều dưỡng ở cột bên phải'}
      />

      {/* ── Lịch điều dưỡng phòng khám ── */}
      <div style={{ margin: '18px 0 10px', borderTop: `1px dashed ${C.border}`, paddingTop: 14 }}>
        <div style={{ fontSize: 12, fontWeight: 700, color: C.text2, marginBottom: 6, letterSpacing: '0.04em' }}>
          Phòng khám
        </div>
        <div style={{ fontSize: 11, color: C.text3, marginBottom: 10, lineHeight: 1.5 }}>
          Điều dưỡng phụ trách phòng khám trong ngày.
        </div>
        <ShiftBucket
          label="ĐIỀU DƯỠNG Phòng khám"
          shift="work"
          roster={clinicRoster.length ? clinicRoster : roster}
          daySchedule={clinicDaySchedule || { admin: [], work: [], oncall: [] }}
          onToggleShift={onToggleClinicShift}
          emptyText={isMobile ? 'Thêm điều dưỡng ở tab "Danh sách"' : 'Thêm điều dưỡng ở cột bên phải'}
          hint="Ai trực phòng khám hôm nay sẽ được điền vào phiếu chăm sóc."
        />
      </div>

      <div style={{ marginTop: 14, paddingTop: 8, borderTop: `1px solid ${C.border2}`, color: C.text3, fontSize: 10.5, lineHeight: 1.45 }}>
        Ưu tiên lịch đúng ngày; nếu trống mới dùng mẫu mặc định.
      </div>
    </div>
  );
}
