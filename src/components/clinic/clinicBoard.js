// src/components/clinic/clinicBoard.js — gom dữ liệu Danh sách Khám bệnh (worker clinic_monitor.py)
// thành 3 khung của màn Phòng khám: lượt khám, việc cần làm, xin nghỉ ốm. Hàm thuần, có test.
import { isLikelyWorkingAge } from '../../utils/workingAge.js';

// Trạng thái EMR → 3 nhóm người dùng nhìn: Chờ khám / Đang thực hiện / Hoàn tất khám.
export function stageBucket(row) {
  if (row?.stage === 'cho_kham') return 'cho_kham';
  if (row?.stage === 'xong') return 'xong';
  return 'dang';
}

export function stageCounts(rows = []) {
  const out = { cho_kham: 0, dang: 0, xong: 0, total: rows.length };
  for (const r of rows) out[stageBucket(r)] += 1;
  return out;
}

// Người bệnh chờ hoàn tất khám, chia theo kết quả kiểm tra đơn thuốc trên màn khám.
//   ready:   đã có thuốc (hoặc chuyển viện), đủ điều kiện → bấm Hoàn tất
//   noDrug:  Cho về nhưng bác sĩ chưa kê thuốc
//   pending: còn chờ (đang kiểm tra, chưa đủ giờ, thiếu cân nặng, bác sĩ chưa nhập đủ, lỗi)
export function completionGroups(rows = []) {
  const out = { ready: [], noDrug: [], pending: [] };
  for (const r of rows) {
    if (!r?.eligible) continue;
    const status = r.check?.status;
    if (status === 'done') continue;
    if (status === 'ready' || (status === 'need_weight' && r.weight_entered)) out.ready.push(r);
    else if (status === 'no_drug') out.noDrug.push(r);
    else out.pending.push(r);
  }
  return out;
}

export function drugLabel(row) {
  const check = row?.check;
  if (!check) return 'Đang kiểm tra thuốc…';
  if (check.status === 'no_drug') return 'Chưa có thuốc';
  if (typeof check.drugs === 'number') return check.drugs > 0 ? `Có ${check.drugs} thuốc` : 'Không cần thuốc';
  return '';
}

const TASK_DONE = new Set(['done', 'exists']);

// Việc cần làm theo chỉ định: thủ thuật (TT), phẫu thuật (PT), Sổ biên bản hội chẩn (SBBHC).
// Mỗi việc: { key, kind, row, label, status, tone } — tone: 'ok' | 'warn' | 'error' | 'muted'.
export function todoItems(rows = []) {
  const items = [];
  for (const r of rows) {
    if (!r || r.stage === 'cho_kham') continue;
    const id = r.khambenhid || `${r.ma_bn}-${r.thoi_gian}`;
    if (r.pending_tt > 0 && r.stage !== 'xong') {
      const t = r.tt_task;
      let status = r.procedure_task ? 'Chưa làm' : 'Làm cùng lúc hoàn tất khám';
      let tone = 'warn';
      if (t?.status === 'waiting') { status = t.message || 'Chờ đủ giờ'; tone = 'muted'; }
      else if (t?.status === 'error' || t?.status === 'session') { status = t.message || 'Lỗi'; tone = 'error'; }
      else if (t?.status && t.status !== 'done') { status = t.message || t.status; tone = 'warn'; }
      if (!r.procedure_task && r.case === 'nhap_vien') status = 'Nhập viện: làm ở luồng nhập viện';
      if (!r.procedure_task && r.case === 'ngoai_tru') status = 'Làm cùng điều trị ngoại trú';
      items.push({ key: `${id}:tt`, kind: 'tt', row: r, label: `Thủ thuật (${r.pending_tt})`, status, tone });
    }
    if (r.pending_pt > 0) {
      const nt = r.ngoaitru_state;
      const status = r.ngoaitru
        ? (nt?.status === 'done' ? 'Đã kết thúc mổ' : (nt?.message || 'Chưa làm'))
        : 'Chưa có xử trí điều trị ngoại trú';
      const tone = nt?.status === 'error' ? 'error' : (nt?.status === 'done' ? 'ok' : 'warn');
      if (nt?.status !== 'done') items.push({ key: `${id}:pt`, kind: 'pt', row: r, label: `Phẫu thuật (${r.pending_pt})`, status, tone });
    }
    if (r.bbhc?.length && !TASK_DONE.has(r.bbhc_state?.status)) {
      const st = r.bbhc_state;
      const status = st?.status === 'draft' ? 'Đã soạn nháp, chờ duyệt'
        : st?.status === 'error' ? (st.message || 'Lỗi') : 'Chưa soạn nháp';
      const tone = st?.status === 'error' ? 'error' : 'warn';
      items.push({ key: `${id}:sbbhc`, kind: 'sbbhc', row: r, label: `SBBHC: ${r.bbhc.join(', ')}`, status, tone });
    }
  }
  return items;
}

export function todoCounts(items = []) {
  const out = { tt: 0, pt: 0, sbbhc: 0 };
  for (const it of items) out[it.kind] += 1;
  return out;
}

// Cùng cách máy chủ đặt khóa (server/routes/clinic.js, sanitizeSickLeavePatient).
export function sickLeaveKey(row) {
  if (row?.khambenhid) return row.khambenhid;
  const m = String(row?.thoi_gian || '').match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  const d = new Date();
  const day = m ? `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`
    : `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  return `${row?.ma_bn}:${day}`;
}

// Gợi ý để đánh dấu xin nghỉ ốm: đã vào khám, còn tuổi lao động, chưa đánh dấu.
export function sickLeaveSuggestions(rows = [], markedKeys = new Set(), refYear = new Date().getFullYear()) {
  return rows.filter(r => r && r.stage !== 'cho_kham' && !markedKeys.has(sickLeaveKey(r))
    && isLikelyWorkingAge(r.nam_sinh, '', refYear));
}

export function sickLeavePayload(row) {
  return {
    khambenhid: row.khambenhid || '',
    ma_bn: row.ma_bn || '',
    ho_ten: row.ho_ten || '',
    nam_sinh: row.nam_sinh || '',
    thoi_gian: row.thoi_gian || '',
    chan_doan: row.details?.cd_chinh || row.details?.so_bo || '',
  };
}
