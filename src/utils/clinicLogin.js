// src/utils/clinicLogin.js — Tài khoản EMR phòng khám nhập ở trình duyệt này.
// Phòng khám (theo dõi Danh sách Khám bệnh) và Nghỉ ốm (quét ngoại trú) cùng đăng nhập Danh sách
// Khám bệnh, nên dùng chung bác sĩ đã chọn (accountName), tên đăng nhập và hai URL: nhập ở màn này
// thì màn kia đã điền sẵn.
// Chỉ lưu trên trình duyệt này; mật khẩu KHÔNG bao giờ lưu (mỗi màn tự hỏi, chỉ giữ trong phiên).

const CONFIG_KEY = 'emr_clinic_monitor_cfg_v1';

export const DEFAULT_CLINIC_CONFIG = Object.freeze({
  username: '',
  accountName: '',
  loginUrl: import.meta.env?.VITE_EMR_LOGIN_URL || '',
  listUrl: import.meta.env?.VITE_EMR_CLINIC_LIST_URL || '',
  intervalMinutes: 3,
  headless: true,
});

export function loadClinicConfig() {
  try {
    const saved = JSON.parse(localStorage.getItem(CONFIG_KEY) || '{}');
    const clean = saved && typeof saved === 'object' ? saved : {};
    delete clean.password;
    return { ...DEFAULT_CLINIC_CONFIG, ...clean };
  } catch {
    return { ...DEFAULT_CLINIC_CONFIG };
  }
}

/** Ghi phần không bí mật; gộp với bản đang lưu để màn này không xoá thiết lập riêng của màn kia. */
export function saveClinicConfig(patch) {
  try {
    const next = { ...loadClinicConfig(), ...(patch || {}) };
    const { username, accountName, loginUrl, listUrl, intervalMinutes, headless } = next;
    localStorage.setItem(CONFIG_KEY, JSON.stringify({ username, accountName, loginUrl, listUrl, intervalMinutes, headless }));
  } catch { /* trình duyệt chặn lưu trữ: lần sau nhập lại */ }
}
