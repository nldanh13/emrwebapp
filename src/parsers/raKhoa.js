import { EXIT_TYPES } from '../config/constants.js';
import { getValue, getSelectText } from '../utils/dom.js';

export function isRaKhoaEditable(root = document) {
  const saveBtn = root.querySelector('#btnSaveXuTri');
  const xuTri = root.querySelector('#cbbXuTri');
  const thoiGianRa = root.querySelector('#txtThoiGianRa');
  return Boolean(saveBtn && !saveBtn.disabled && xuTri && !xuTri.disabled && thoiGianRa && !thoiGianRa.disabled);
}

export function getRaKhoaStatus(root = document) {
  if (isRaKhoaEditable(root)) {
    return { status: 'draft', label: 'Chưa hoàn tất', message: 'Thông tin Ra Khoa còn chỉnh sửa được.' };
  }
  return { status: 'completed', label: 'Đã hoàn tất', message: 'Thông tin Ra Khoa đã khóa hoặc chỉ đọc.' };
}

export function parseRaKhoaInfo(root = document) {
  return {
    status: getRaKhoaStatus(root),
    admission: {
      thoi_gian_vao_vien: getValue('#txtThoiGianVaoVien', root),
      thoi_gian_vao_khoa: getValue('#txtThoiGianVaoKhoa', root),
      khoa_chuyen_den: getSelectText('cboKhoaChuyenDen', root),
      loai_benh_an: getSelectText('cboLoaiBenhAn', root),
      ma_benh_an: getValue('#txtMaBenhAn', root),
      chan_doan_vao_khoa: Array.from(root.querySelectorAll('#tblChanDoan tbody tr')).map((row) => row.innerText.trim().replace(/\s+/g, ' ')),
    },
    discharge: {
      loai_xu_tri: getSelectText('cbbXuTri', root),
      loai_noi_tru: getSelectText('cbbLoaiNoiTru', root),
      thoi_gian_ra: getValue('#txtThoiGianRa', root),
      so_ngay_dieu_tri_tai_khoa: getValue('#txtSoNgayDT', root),
      tong_so_ngay_dieu_tri: getValue('#txtTongSoNgayDT', root),
      tinh_trang_ra_vien: getSelectText('cboTinhTrangRaVien', root),
      ket_qua_dieu_tri: getSelectText('cboKetQuaDT', root),
      ly_do_cho_ve: getSelectText('cboLydoChove', root),
      bac_si_dieu_tri: getSelectText('cboBacsi', root),
      hen_tai_kham: getSelectText('cbbHenKham', root),
      phan_loai_hsba: getSelectText('cboPhanLoaiHSBA', root),
      nghi_ngoai_tru_tu: getValue('#txtTGBDNGHINGTSAUDT', root),
      nghi_ngoai_tru_den: getValue('#txtTGKTNGHINGTSAUDT', root),
      so_ngay_nghi_ngoai_tru: getValue('#txtSNNGHINGTSAUDT', root),
    },
    diagnosis: {
      chan_doan_ra_vien: getValue('#txtChanDoanPhanBiet', root),
      chan_doan_chinh_icd10: getSelectText('cboChanDoan', root),
      benh_kem_theo_icd10: getSelectText('cboBenhKemTheo', root),
      bien_chung: getSelectText('cboBienchung', root),
      tai_bien: getSelectText('cboTaibien', root),
    },
    documents: {
      x_quang: getValue('#txtHoSoXQuang', root),
      ct_scanner: getValue('#txtHoSoCT', root),
      sieu_am: getValue('#txtHoSoSieuAm', root),
      khac: getValue('#txtHoSoKhac', root),
      toan_bo_ho_so: getValue('#txtToanBoHoSo', root),
      nguoi_giao_ho_so: getSelectText('cboNguoiGiaoHS', root),
      nguoi_nhan_ho_so: getSelectText('cboNguoiNhanHS', root),
    },
  };
}

export function isExitCase(raKhoaInfo) {
  const value = raKhoaInfo?.discharge?.loai_xu_tri || '';
  return EXIT_TYPES.some((x) => value.includes(x));
}

export function getVTYTSearchRange(patient = {}, raKhoaInfo = {}) {
  if (isExitCase(raKhoaInfo)) {
    return {
      mode: 'full_ctch_episode',
      from: raKhoaInfo.admission?.thoi_gian_vao_khoa || patient.thoiGianVaoKhoa || '',
      to: raKhoaInfo.discharge?.thoi_gian_ra || patient.thoiGianKiemTra || '',
      reason: 'Ra viện/chuyển khoa nên kiểm VTYT từ lúc vào khoa CTCH-TK đến lúc ra khoa.',
    };
  }

  return {
    mode: 'current_orders',
    from: patient.thoiGianYLenhGanNhat || patient.ngayHienTaiBatDau || '',
    to: patient.thoiGianKiemTra || '',
    reason: 'Đang điều trị nên kiểm/nhập theo y lệnh hiện hành.',
  };
}
