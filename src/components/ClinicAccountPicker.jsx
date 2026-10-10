// src/components/ClinicAccountPicker.jsx — Chọn bác sĩ để đăng nhập EMR ở Phòng khám / Nghỉ ốm.
// Danh sách bác sĩ khai ở Thiết lập tài khoản → Tài khoản EMR → Bác sĩ phòng khám. Chọn một bác sĩ thì
// không phải gõ tài khoản/mật khẩu: giao diện gửi account_name, máy chủ tự điền (mật khẩu không về đây).
// Chọn "Nhập tài khoản khác" thì gõ tay như trước.
import { useCallback, useEffect, useState } from 'react';
import * as api from '../api.js';
import { useOnTabReturn } from '../hooks/useTabActivity.js';

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
  const load = useCallback(async () => {
    try {
      const r = await api.getClinicDoctorAccounts();
      setDoctors(Array.isArray(r?.doctors) ? r.doctors : []);
    } catch { /* máy chủ cũ chưa có danh sách: vẫn gõ tay được */ }
  }, []);
  useEffect(() => { load(); }, [load]);
  useOnTabReturn(() => load());

  const known = !value || doctors.some(d => d.name === value);
  return (
    <select value={value || ''} onChange={e => onChange(e.target.value)} disabled={disabled}
      aria-label="Đăng nhập EMR bằng tài khoản bác sĩ" style={style}>
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
