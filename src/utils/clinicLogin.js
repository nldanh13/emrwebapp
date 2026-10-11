// src/utils/clinicLogin.js — Tài khoản EMR phòng khám nhập ở trình duyệt này.
// Phòng khám (theo dõi Danh sách Khám bệnh) và Nghỉ ốm (quét ngoại trú) cùng đăng nhập Danh sách
// Khám bệnh, nên dùng chung bác sĩ đã chọn (accountName), tên đăng nhập và địa chỉ đăng nhập: nhập ở
// màn này thì màn kia đã điền sẵn. Địa chỉ đăng nhập chỉ cần khi máy chủ chưa khai url_login
// (useEmrUrlDefault); URL Danh sách Khám bệnh không hỏi nữa, worker tự dựng sau khi đăng nhập.
// Chỉ lưu trên trình duyệt này; mật khẩu KHÔNG bao giờ lưu (mỗi màn tự hỏi, chỉ giữ trong phiên).

const CONFIG_KEY = 'emr_clinic_monitor_cfg_v1';

export const DEFAULT_CLINIC_CONFIG = Object.freeze({
  username: '',
  // Mặc định đăng nhập bằng bác sĩ theo Lịch phòng khám ('@lich', xem ClinicAccountPicker.jsx).
  accountName: '@lich',
  loginUrl: import.meta.env?.VITE_EMR_LOGIN_URL || '',
  intervalMinutes: 3,
  headless: true,
  // Tự nhập thủ thuật (và soạn nháp SBBHC) ngay khi có chỉ định; mặc định tắt, bấm tay mới làm.
  autoTasks: false,
});

export function loadClinicConfig() {
  try {
    const saved = JSON.parse(localStorage.getItem(CONFIG_KEY) || '{}');
    const clean = saved && typeof saved === 'object' ? saved : {};
    delete clean.password;
    delete clean.listUrl; // bản lưu cũ: không gửi URL danh sách cũ (có thể sai), để worker tự dựng
    // Bản lưu từ trước khi có chọn bác sĩ mà đã gõ tên đăng nhập: giữ cách gõ tay như cũ.
    if (!Object.prototype.hasOwnProperty.call(clean, 'accountName') && clean.username) clean.accountName = '';
    return { ...DEFAULT_CLINIC_CONFIG, ...clean };
  } catch {
    return { ...DEFAULT_CLINIC_CONFIG };
  }
}

/** Ghi phần không bí mật; gộp với bản đang lưu để màn này không xoá thiết lập riêng của màn kia. */
export function saveClinicConfig(patch) {
  try {
    const next = { ...loadClinicConfig(), ...(patch || {}) };
    const { username, accountName, loginUrl, intervalMinutes, headless, autoTasks } = next;
    localStorage.setItem(CONFIG_KEY, JSON.stringify({ username, accountName, loginUrl, intervalMinutes, headless, autoTasks }));
  } catch { /* trình duyệt chặn lưu trữ: lần sau nhập lại */ }
}
