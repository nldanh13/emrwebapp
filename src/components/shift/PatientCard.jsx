import { IconAlertTriangle, IconCheck } from '@tabler/icons-react';
import { C, FS, STATUS, FLAG } from '../../tokens.js';
import { Mono } from '../shared.jsx';
import { getPatientNotices, PatientNoticePills } from '../patientStatusNotice.jsx';

function getWardAdmissionTime(p) {
  return String(p?.thoi_gian_vao_khoa ?? p?.tg_vao ?? p?.admission_time ?? '').trim();
}

function getDepartmentName(p) {
  return String(p?.ten_khoa_dieu_tri ?? p?.khoa_dieu_tri ?? p?.khoa_chuyen_den ?? p?.department_name ?? p?.department ?? '').trim();
}

// Một ô trạng thái việc (CS/DT/TT): xong = lục + dấu tích, có y lệnh mới cần làm lại = cam, chưa = xám.
function TaskChip({ label, title, done, stale, total, count }) {
  const multi = Number.isFinite(Number(total)) && Number(total) > 1;
  const tone = stale
    ? { bg: C.amberBg, border: C.amberBorder, color: C.amber }
    : done ? { bg: C.greenBg, border: C.greenBorder, color: C.green } : { bg: C.surface, border: C.border, color: C.text2 };
  const suffix = stale ? 'cần làm lại' : multi ? `${Number(count || 0)}/${Number(total)}` : (done ? 'xong' : 'chưa');
  return (
    <span title={`${title}: ${suffix}`} style={{
      display: 'inline-flex', alignItems: 'center', gap: 3, height: 22, padding: '0 7px', borderRadius: 4,
      border: `1px solid ${tone.border}`, background: tone.bg, color: tone.color, fontSize: FS.xs, fontWeight: 600, whiteSpace: 'nowrap',
    }}>
      {stale ? <IconAlertTriangle size={13} stroke={2} aria-hidden="true" /> : (done && !multi ? <IconCheck size={13} stroke={2.2} aria-hidden="true" /> : null)}
      {label}{multi && !stale ? ` ${Number(count || 0)}/${Number(total)}` : ''}
    </span>
  );
}

function Chip({ text, bg, color, border, icon: Icon = null }) {
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 3, height: 22, padding: '0 7px', borderRadius: 4,
      background: bg, color, border: `1px solid ${border || bg}`, fontSize: FS.xs, fontWeight: 600, whiteSpace: 'nowrap',
    }}>
      {Icon ? <Icon size={13} stroke={2} aria-hidden="true" /> : null}{text}
    </span>
  );
}

export default function PatientCard({ p, selected, onClick, showInputToggle = false, inputChecked = false, inputMode = 'rooms', onToggleInput }) {
  const st = STATUS[p.status] || STATUS.gray;
  const notices = getPatientNotices(p);
  const name = p.ho_ten || p.name;
  const room = p.so_phong || p.room;
  const admission = getWardAdmissionTime(p);
  const department = getDepartmentName(p);
  const checkboxTitle = inputMode === 'manual'
    ? 'Đánh dấu để đưa người bệnh này vào nhập hàng loạt'
    : 'Bỏ tích để loại người bệnh này khỏi nhập hàng loạt của phòng';
  const hasInfusion = p.has_inf || p.has_infusion;

  const onKeyDown = (event) => {
    if (event.target !== event.currentTarget) return;
    if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onClick?.(); }
  };

  return (
    <div
      role="button"
      tabIndex={0}
      aria-pressed={selected}
      onClick={onClick}
      onKeyDown={onKeyDown}
      style={{
        display: 'flex', gap: 10, padding: '10px 12px 10px 10px', cursor: 'pointer',
        background: selected ? C.blueBg : C.surface,
        boxShadow: selected ? `inset 0 0 0 1px ${C.blueBorder}` : 'none',
        borderBottom: `1px solid ${C.border2}`,
        WebkitTapHighlightColor: 'transparent',
      }}
    >
      {showInputToggle && (
        <label onClick={e => e.stopPropagation()} title={checkboxTitle} style={{ display: 'grid', placeItems: 'center', width: 22, height: 22, flexShrink: 0, cursor: 'pointer' }}>
          <input
            type="checkbox"
            checked={!!inputChecked}
            onChange={() => onToggleInput?.(p)}
            aria-label={`Nhập hàng loạt: ${name}`}
            style={{ width: 16, height: 16, margin: 0, accentColor: C.blue, cursor: 'pointer' }}
          />
        </label>
      )}
      <div style={{ minWidth: 0, flex: 1 }}>
        <PatientNoticePills notices={notices} compact />
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
          <div style={{ flex: 1, minWidth: 0, fontWeight: 600, fontSize: 14, color: C.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {name}
          </div>
          <span style={{ flexShrink: 0, fontSize: FS.xs, fontWeight: 650, color: st.text }}>{st.label}</span>
        </div>
        <div style={{ fontSize: FS.sm, color: C.text2, marginTop: 2 }}>
          {p.age && <>{p.age} tuổi · </>}
          {room && <>Phòng {room}</>}
          {p.next_care && <> · CS kế <Mono style={{ fontSize: FS.sm }}>{p.next_care}</Mono></>}
        </div>
        {(admission || department) && (
          <div style={{ fontSize: FS.xs, color: C.text3, marginTop: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {admission && <>Vào khoa <Mono style={{ fontSize: FS.xs }}>{admission}</Mono></>}
            {admission && department && ' · '}
            {department}
          </div>
        )}
        {(p.dx || p.diagnosis) && (
          <div style={{ fontSize: FS.sm, color: C.text2, marginTop: 3, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {p.dx || p.diagnosis}
          </div>
        )}
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 6 }}>
          <TaskChip label="CS" title="Chăm sóc" done={p.care_done} stale={p.care_stale_count > 0} total={p.care_total_dates || p.total_dates} count={p.care_done_count} />
          {hasInfusion && (p.has_infusion_incomplete
            ? <Chip text="DT thiếu thông tin" bg={C.redBg} color={C.red} border={C.redBorder} icon={IconAlertTriangle} />
            : <TaskChip label="DT" title="Dịch truyền" done={p.infus_done} stale={p.infus_stale_count > 0} total={p.infusion_total_dates} count={p.infus_done_count} />)}
          {p.has_procedure && <TaskChip label="TT" title="Thủ thuật" done={p.procedure_done} stale={p.procedure_stale_count > 0} total={p.procedure_total_dates} count={p.procedure_done_count} />}
          {p.workflow_scope === 'unknown' && <Chip text="Cần xem phân luồng" bg={C.amberBg} color={C.amber} border={C.amberBorder} />}
          {p.warning_count > 0 && <Chip text={`${p.warning_count} cảnh báo`} bg={C.amberBg} color={C.amber} border={C.amberBorder} icon={IconAlertTriangle} />}
          {(p.flags || []).map(f => { const fl = FLAG[f]; return fl ? <Chip key={f} text={fl.text} bg={fl.bg} color={fl.color} /> : null; })}
        </div>
      </div>
    </div>
  );
}
