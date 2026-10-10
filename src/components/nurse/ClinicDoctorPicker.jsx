// Chọn bác sĩ phòng khám của một ngày (theo thứ tự bấm). Người số 1 có tài khoản EMR là tài khoản
// Phòng khám / Nghỉ ốm đăng nhập khi chọn "Bác sĩ theo lịch", và là BS mổ chính cho người bệnh ngoại trú.
import { IconX } from '@tabler/icons-react';
import { C, FS } from '../../tokens.js';

export default function ClinicDoctorPicker({ doctors, selected, onChange }) {
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
