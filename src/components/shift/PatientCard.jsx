import { C, STATUS, FLAG } from '../../tokens.js';
import { Badge, Mono } from '../shared.jsx';
import { getPatientNotices, PatientNoticePills } from '../patientStatusNotice.jsx';


function getWardAdmissionTime(p) {
  return String(p?.thoi_gian_vao_khoa ?? p?.tg_vao ?? p?.admission_time ?? '').trim();
}

function getDepartmentName(p) {
  return String(p?.ten_khoa_dieu_tri ?? p?.khoa_dieu_tri ?? p?.khoa_chuyen_den ?? p?.department_name ?? p?.department ?? '').trim();
}

function taskBadge(label, done, stale, total, count) {
  if (stale) return `${label} !`;
  if (Number.isFinite(Number(total)) && Number(total) > 1) return `${label} ${Number(count || 0)}/${Number(total)}`;
  return `${label} ${done ? '✓' : '—'}`;
}

function taskColor(done, stale) {
  if (stale) return { bg: C.amberBg, color: C.amber };
  return done ? { bg: C.greenBg, color: C.green } : { bg: C.surface2, color: C.text2 };
}

export default function PatientCard({ p, selected, onClick, showInputToggle = false, inputChecked = false, inputMode = 'rooms', onToggleInput }) {
  const st = STATUS[p.status] || STATUS.gray;
  const notices = getPatientNotices(p);
  const toggleLabel = inputMode === 'manual'
    ? (inputChecked ? 'Đã chọn nhập' : 'Chọn nhập')
    : (inputChecked ? 'Sẽ nhập' : 'Đã loại');
  const toggleTitle = inputMode === 'manual'
    ? 'Bấm để chọn/bỏ chọn người bệnh này cho nhập hàng loạt'
    : 'Bấm để loại trừ/đưa lại người bệnh này trong phạm vi phòng đã chọn';
  return (
    <div onClick={onClick} style={{
      padding: '10px 14px', cursor: 'pointer',
      borderLeft: `3px solid ${st.border}`,
      background: selected ? C.surface2 : 'transparent',
      borderBottom: `1px solid ${C.border2}`,
      transition: 'background 0.1s',
      WebkitTapHighlightColor: 'transparent',
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 6 }}>
        <div style={{ minWidth: 0 }}>
          <PatientNoticePills notices={notices} compact />
          {p.workflow_scope === 'unknown' && (
            <div style={{ display: 'flex', marginBottom: 3 }}>
              <Badge text="Cần xem phân luồng" bg={C.amberBg} color={C.amber} size={10} />
            </div>
          )}
          <div style={{ fontWeight: 500, fontSize: 14, color: C.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {p.ho_ten || p.name}
          </div>
          <div style={{ fontSize: 12, color: C.text2, marginTop: 2 }}>
            {p.age && <>{p.age}t · </>}
            {(p.so_phong || p.room) && <>Phòng {p.so_phong || p.room} · </>}
            {p.next_care && <Mono>{p.next_care}</Mono>}
          </div>
          {(getWardAdmissionTime(p) || getDepartmentName(p)) && (
            <div style={{ fontSize: 11, color: C.text3, marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {getWardAdmissionTime(p) && <>Vào khoa <Mono>{getWardAdmissionTime(p)}</Mono></>}
              {getWardAdmissionTime(p) && getDepartmentName(p) && ' · '}
              {getDepartmentName(p)}
            </div>
          )}
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 3, flexShrink: 0 }}>
          {showInputToggle && (
            <button
              type="button"
              onClick={(event) => { event.stopPropagation(); onToggleInput?.(p); }}
              title={toggleTitle}
              style={{
                border: `1px solid ${inputChecked ? C.greenBorder : C.border}`,
                background: inputChecked ? C.greenBg : C.surface2,
                color: inputChecked ? C.green : C.text2,
                borderRadius: 4,
                padding: '2px 6px',
                cursor: 'pointer',
                fontSize: 10,
                fontFamily: 'inherit',
                fontWeight: 800,
                whiteSpace: 'nowrap',
              }}
            >{inputChecked ? '✓ ' : ''}{toggleLabel}</button>
          )}
          <Badge text={st.label} bg={st.bg} color={st.text} />
          {(() => { const c = taskColor(p.care_done, p.care_stale_count > 0); return <Badge text={taskBadge('CS', p.care_done, p.care_stale_count > 0, p.care_total_dates || p.total_dates, p.care_done_count)} bg={c.bg} color={c.color} />; })()}
          {(p.has_inf || p.has_infusion) && (() => { const c = taskColor(p.infus_done, p.infus_stale_count > 0); return <Badge text={taskBadge('DT', p.infus_done, p.infus_stale_count > 0, p.infusion_total_dates, p.infus_done_count)} bg={c.bg} color={c.color} />; })()}
          {p.has_procedure && (() => { const c = taskColor(p.procedure_done, p.procedure_stale_count > 0); return <Badge text={taskBadge('TT', p.procedure_done, p.procedure_stale_count > 0, p.procedure_total_dates, p.procedure_done_count)} bg={c.bg} color={c.color} />; })()}
          {p.workflow_scope === 'unknown' && <Badge text="Phân luồng ?" bg={C.amberBg} color={C.amber} />}
          {p.warning_count > 0 && <Badge text={`⚠ ${p.warning_count}`} bg={C.amberBg} color={C.amber} />}
        </div>
      </div>
      {(p.dx || p.diagnosis) && (
        <div style={{ fontSize: 12, color: C.text2, marginTop: 3, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {p.dx || p.diagnosis}
        </div>
      )}
      {p.flags?.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 3, marginTop: 5 }}>
          {p.flags.map(f => { const fl = FLAG[f]; return fl ? <Badge key={f} text={fl.text} bg={fl.bg} color={fl.color} size={10} /> : null; })}
        </div>
      )}
    </div>
  );
}
