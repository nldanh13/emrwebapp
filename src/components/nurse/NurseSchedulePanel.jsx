import { IconCalendarRepeat, IconCloudCheck, IconCopy, IconTemplate } from '@tabler/icons-react';
import { C, FS } from '../../tokens.js';
import { Btn, Spinner } from '../shared.jsx';
import { formatDmy, weekdayLabelFromIso } from './nurseScheduleUtils.js';
import { useState } from 'react';
import { ShiftBucket } from './ShiftToggle.jsx';

const EMPTY_TEXT = 'Chưa có điều dưỡng. Thêm tên ở cột bên phải.';

export default function NurseSchedulePanel({
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
  onSetClinicDoctors,
}) {
  return (
    <div style={{ padding: 16, maxWidth: 920 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 12 }}>
        <h2 style={{ margin: 0, fontSize: FS.xl, fontWeight: 700, color: C.text }}>
          {selectedIsDate ? `${weekdayLabelFromIso(selectedKey)}, ${formatDmy(selectedKey)}` : 'Mẫu mặc định'}
        </h2>
        <span role="status" style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: FS.xs, color: C.text2 }}>
          {saving
            ? <><Spinner size={12} /> Đang lưu…</>
            : <><IconCloudCheck size={15} stroke={1.75} color={C.green} aria-hidden="true" /> Tự lưu khi thay đổi</>}
        </span>
      </div>
      {!selectedIsDate && (
        <p style={{ margin: '0 0 14px', fontSize: FS.sm, color: C.text2 }}>
          Dùng cho những ngày chưa phân công riêng.
        </p>
      )}
      {selectedIsDate && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 18 }}>
          <Btn icon={IconCopy} onClick={() => onCopyFrom(prevDate)}>Chép từ ngày trước</Btn>
          <Btn icon={IconCopy} onClick={() => onCopyFrom(prevWeekDate)}>Chép từ tuần trước</Btn>
          <Btn icon={IconTemplate} onClick={() => onCopyFrom('Default')}>Dùng mẫu mặc định</Btn>
          <Btn icon={IconCalendarRepeat} onClick={onApplyDefaultToEmptyVisibleDays} title="Áp mẫu mặc định cho mọi ngày đang hiện mà chưa phân công">
            Điền mẫu cho các ngày trống
          </Btn>
        </div>
      )}

      <ShiftBucket
        shift="admin"
        roster={roster}
        selected={daySchedule.admin || []}
        onToggle={onToggleShift}
        emptyText={EMPTY_TEXT}
        hint="Vị trí hành chánh bệnh phòng trong giờ hành chính."
      />
      <ShiftBucket shift="work" roster={roster} selected={daySchedule.work || []} onToggle={onToggleShift} emptyText={EMPTY_TEXT} />
      <ShiftBucket shift="oncall" roster={roster} selected={daySchedule.oncall || []} onToggle={onToggleShift} emptyText={EMPTY_TEXT} />

      {/* Lịch điều dưỡng phòng khám */}
      <div style={{ marginTop: 8, paddingTop: 16, borderTop: `1px solid ${C.border2}` }}>
        <ShiftBucket
          label="Phòng khám"
          shift="work"
          roster={clinicRoster.length ? clinicRoster : roster}
          selected={(clinicDaySchedule || {}).work || []}
          onToggle={onToggleClinicShift}
          emptyText={EMPTY_TEXT}
          hint="Điều dưỡng phụ trách phòng khám trong ngày; tên được điền vào phiếu chăm sóc."
        />
        {onSetClinicDoctors && (
          <ClinicDoctorInput
            key={selectedKey}
            value={(clinicDaySchedule || {}).doctor || []}
            onSave={onSetClinicDoctors}
          />
        )}
      </div>

      <div style={{ marginTop: 4, color: C.text2, fontSize: FS.xs }}>
        Ưu tiên lịch đúng ngày; ngày nào trống mới dùng mẫu mặc định.
      </div>
    </div>
  );
}


// Bác sĩ phòng khám trong ngày (không nằm trong danh sách điều dưỡng nên gõ tay).
// Dùng làm BS mổ chính và Gây mê chính khi kết thúc mổ cho người bệnh điều trị ngoại trú.
function ClinicDoctorInput({ value, onSave }) {
  const [text, setText] = useState(value.join(', '));
  const commit = () => {
    const names = text.split(/[,;\n]+/).map(s => s.trim()).filter(Boolean);
    if (names.join('|') !== value.join('|')) onSave(names);
  };
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 4, margin: '4px 0 12px', fontSize: FS.sm, fontWeight: 650, color: C.text }}>
      Bác sĩ phòng khám
      <input value={text} onChange={e => setText(e.target.value)} onBlur={commit}
        onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); commit(); } }}
        placeholder="Họ tên bác sĩ, ví dụ Hồ Điền"
        style={{ height: 32, padding: '0 8px', border: `1px solid ${C.border}`, borderRadius: 5, fontFamily: 'inherit', fontSize: FS.md, color: C.text, background: C.surface, maxWidth: 420 }} />
      <span style={{ fontWeight: 400, fontSize: FS.xs, color: C.text2 }}>
        BS mổ chính và Gây mê chính khi kết thúc mổ cho người bệnh điều trị ngoại trú. Nhiều tên: người đầu tiên được dùng.
      </span>
    </label>
  );
}
