// src/features/hchanh/model.js — View/data model riêng cho tab Hành chánh.

export const DISCHARGE_FULL_FILES = ['profile', 'discharge', 'billing', 'bed_days', 'surgery', 'order_history'];

export const SCOPE_FILES = {
  discharge: DISCHARGE_FULL_FILES,
  surgery:   ['profile', 'surgery'],
  admission: ['profile'],
  daily:     ['profile'],
};

export const SCOPE_LABEL = {
  discharge: 'Lấy dữ liệu ra viện',
  surgery:   'Lấy dữ liệu PTTT',
  admission: 'Lấy dữ liệu nhập khoa',
  daily:     'Cập nhật hôm nay',
};

export function getHchanhPatientKey(card) {
  return String(card?.ma_bn || card?.patientId || card?.key || '').trim();
}
