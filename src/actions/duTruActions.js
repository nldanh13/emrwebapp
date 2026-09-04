import { DU_TRU_ACTION, LOAI_HANG, RUN_MODES } from '../config/constants.js';
import { formatVNDateTime, addDays } from '../utils/date.js';
import { setRadioValue, setSelectValue, setValue } from '../utils/dom.js';

function requireExecute(mode, action) {
  if (mode !== RUN_MODES.EXECUTE) {
    return { blocked: true, status: 'preview_only', message: `Không thực hiện ${action}; cần mode = RUN_MODES.EXECUTE.` };
  }
  return { blocked: false };
}

export function getTomorrowRange(now = new Date()) {
  const tomorrow = addDays(now, 1);
  return { from: formatVNDateTime(tomorrow, 0, 0), to: formatVNDateTime(tomorrow, 23, 59) };
}

export function getThuocLeRange(now = new Date()) {
  return { from: '00:00 01/01/2026', to: formatVNDateTime(now, 23, 59) };
}

export function setTongHopDuTruTimeRange({ from, to }, root = document) {
  const candidatesFrom = ['#dtTuNgay', '#dtTuNgayVT', '#dtTuNgayYL'];
  const candidatesTo = ['#dtDenNgay', '#dtDenNgayVT', '#dtDenNgayYL'];
  const okFrom = candidatesFrom.some((selector) => setValue(selector, from, root));
  const okTo = candidatesTo.some((selector) => setValue(selector, to, root));
  return { status: okFrom && okTo ? 'ok' : 'warning', from, to };
}

export function setTongHopDuTruOptions({ loaiHang = LOAI_HANG.THUOC, loaiThaoTac = DU_TRU_ACTION.LINH }, root = document) {
  return {
    loaiHang: setSelectValue('#cboLoaiHang', loaiHang, root),
    loaiThaoTac: setRadioValue('rdoLoai', loaiThaoTac, root),
  };
}

export function submitTongHopDuTru({ mode = RUN_MODES.PREVIEW } = {}, root = document) {
  const gate = requireExecute(mode, 'bấm Tổng hợp dự trù');
  if (gate.blocked) return gate;
  const btn = root.querySelector('#btnSubmit');
  if (!btn) return { status: 'error', message: 'Không tìm thấy nút Tổng hợp.' };
  btn.click();
  return { status: 'ok' };
}

export function chuyenDuyetTongHop({ mode = RUN_MODES.PREVIEW } = {}, root = document) {
  const gate = requireExecute(mode, 'bấm Chuyển duyệt');
  if (gate.blocked) return gate;
  const btn = root.querySelector('#btnCHUYENDUYET');
  if (!btn || btn.disabled || btn.style.display === 'none') return { status: 'error', message: 'Nút Chuyển duyệt chưa sẵn sàng.' };
  btn.click();
  return { status: 'ok' };
}
