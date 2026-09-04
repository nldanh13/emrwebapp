import { getValue, getSelectText } from '../utils/dom.js';

export function hasFollowUpAppointment(root = document) {
  const text = root.querySelector('#select2-cbbHenKham-container')?.innerText?.trim();
  return text === 'Hẹn khám';
}

export function isFollowUpButtonVisible(root = document) {
  const btn = root.querySelector('#lblTheBaoHiem');
  if (!btn) return false;
  const style = window.getComputedStyle(btn);
  return style.display !== 'none' && style.visibility !== 'hidden';
}

export function parseFollowUpAppointment(root = document) {
  return {
    loai_kham: getSelectText('cbbLoaiKham', root),
    thoi_gian_hen_kham: getValue('#txtThoiGianHenKham', root),
    phong_kham: getSelectText('cbbHangDoiHenKham', root),
    chuyen_khoa: getSelectText('cbbChuyenKhoaHenKham', root),
    bac_si: getSelectText('cbbBacSy', root),
    chuan_bi: getSelectText('cbbChuanBi', root),
    ghi_chu: getValue('#txtGhiChuHenKham', root),
  };
}
