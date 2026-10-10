// src/components/ClinicAccountPicker.jsx — Chọn bác sĩ để đăng nhập EMR ở Phòng khám / Nghỉ ốm.
// Danh sách bác sĩ khai ở Thiết lập tài khoản → Tài khoản EMR → Bác sĩ phòng khám. Chọn một bác sĩ thì
// không phải gõ tài khoản/mật khẩu: giao diện gửi account_name, máy chủ tự điền (mật khẩu không về đây).
// "Bác sĩ theo Lịch phòng khám" (@lich, mặc định): máy chủ lấy bác sĩ xếp trong tab Lịch phòng khám
// của ngày làm việc. Chọn "Nhập tài khoản khác" thì gõ tay như trước.
import { useCallback, useEffect, useState } from 'react';
import * as api from '../api.js';
import { useOnTabReturn } from '../hooks/useTabActivity.js';

/** Giá trị accountName nghĩa là "bác sĩ theo Lịch phòng khám" (máy chủ hiểu cùng giá trị này). */
export const SCHEDULED_DOCTOR = '@lich';

/** Nhãn lựa chọn "theo lịch": ghi rõ hôm nay là ai để biết sẽ đăng nhập bằng tài khoản nào. */
export function scheduledOptionLabel(today) {
  const base = 'Bác sĩ theo Lịch phòng khám';
  if (!today) return base;
  if (today.account_name) return `${base} (hôm nay: ${today.account_name})`;
  if (today.names?.length) return `${base} (hôm nay: ${today.names.join(', ')} chưa có tài khoản EMR)`;
  return `${base} (hôm nay chưa xếp bác sĩ)`;
}

/** Đăng nhập được chưa: đã chọn bác sĩ, hoặc gõ đủ tài khoản + mật khẩu. */
export function hasClinicLogin({ accountName, username, password } = {}) {
  return Boolean(accountName || (String(username || '').trim() && password));
}

/** Phần đăng nhập gửi lên máy chủ: chọn bác sĩ thì chỉ gửi tên, không gửi tài khoản/mật khẩu gõ tay. */
export function clinicLoginPayload({ accountName, username, password } = {}) {
  return accountName
    ? { account_name: accountName, username: '', password: '' }
    : { username: String(username || '').trim(), password: password || '' };
}

export default function ClinicAccountPicker({ value, onChange, disabled, style }) {
  const [doctors, setDoctors] = useState([]);
  const [today, setToday] = useState(null);
  const load = useCallback(async () => {
    try {
      const r = await api.getClinicDoctorAccounts();
      setDoctors(Array.isArray(r?.doctors) ? r.doctors : []);
      setToday(r?.scheduled_today || null);
    } catch { /* máy chủ cũ chưa có danh sách: vẫn gõ tay được */ }
  }, []);
  useEffect(() => { load(); }, [load]);
  useOnTabReturn(() => load());

  const known = !value || value === SCHEDULED_DOCTOR || doctors.some(d => d.name === value);
  return (
    <select value={value || ''} onChange={e => onChange(e.target.value)} disabled={disabled}
      aria-label="Đăng nhập EMR bằng tài khoản bác sĩ" style={style}>
      <option value={SCHEDULED_DOCTOR}>{scheduledOptionLabel(today)}</option>
      <option value="">Nhập tài khoản khác…</option>
      {!known && <option value={value}>{value} (không còn trong danh sách)</option>}
      {doctors.map(d => (
        <option key={d.name} value={d.name} disabled={!d.ready}>
          {d.name}{d.emr_username ? ` · ${d.emr_username}` : ''}{d.ready ? '' : ' (thiếu mật khẩu)'}
        </option>
      ))}
    </select>
  );
}
