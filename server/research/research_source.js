'use strict';

// Nguồn chuẩn của run (research_source.csv: Mã NC, Research key, khoảng lấy dữ liệu) và chuyển dữ liệu hành chánh thành dòng nghiên cứu.

const { parseAnyDate, firstNonEmpty, buildEncounterId, isoDate, rowAdmissionTime, rowDischargeTime } = require('./encounter_context');
const { read_index: readHchanhIndex, read_patient_all: readHchanhPatientAll } = require('../hchanh_data_contract');
const path = require('path');
const { ensureDir, readJsonSafe, writeJsonAtomic } = require('../utils/file');
const { writeCsv, patientCode, countCsvRows, readCsvTable, writeCsvUnion } = require('./table_io');
const collection = require('./collection');
const { mergeSameStayRows, mergeRowsPreferFilled } = require('./source_merge');
const fs = require('fs');
const { rowResearchCode } = require('./progress_snapshot');
const { nowIso } = require('./store_paths');

function hchanhProfileRow(payload, meta = {}) {
  const p = payload || {};
  const maBn = p.ma_bn || meta.ma_bn || '';
  return {
    'Mã BN': maBn,
    'URL bác sĩ': meta.record_doctor_url || meta.doctor_url || '',
    'URL điều dưỡng': meta.record_nursing_url || meta.nursing_url || '',
    'Họ tên': p.ho_ten || meta.ho_ten || '',
    'Giới': p.gioi_tinh || p.gioi || '',
    'Ngày sinh': p.ngay_sinh || '',
    'Tuổi': p.tuoi || '',
    'Địa chỉ': p.dia_chi || '',
    'Điện thoại': p.dien_thoai || p.sdt || '',
    'Số CMND': p.cmnd || p.cccd || p.so_cmnd || p.so_cmt || '',
    'Đối tượng': p.doi_tuong || '',
    'Số thẻ': p.bhyt_code || p.so_the_bhyt || '',
    'Loại': p.bhyt_loai || '',
    'Giá trị từ': p.bhyt_tu_ngay || '',
    'Giá trị đến': p.bhyt_den_ngay || '',
    'Ngày vào viện': p.ngay_vao_vien || p.ngay_vao || '',
    'Ngày ra viện': p.ngay_ra_vien || p.ngay_ra || '',
    'Thời gian điều trị': p.so_ngay_dieu_tri || '',
    'Chẩn đoán': p.chan_doan || '',
    'Chẩn đoán vào viện': p.chan_doan_vao || '',
    'Chẩn đoán ra viện': p.chan_doan_ra || '',
    'Phòng/Giường': p.phong || '',
    'Mạch vào viện': p.mach_vao_vien || '',
    'Nhiệt độ vào viện': p.nhiet_do_vao_vien || '',
    'HA tâm thu vào viện': p.huyet_ap_tam_thu_vao_vien || '',
    'HA tâm trương vào viện': p.huyet_ap_tam_truong_vao_vien || '',
    'Nhịp thở vào viện': p.nhip_tho_vao_vien || '',
    'Cân nặng vào viện': p.can_nang_vao_vien || '',
    'Chiều cao vào viện': p.chieu_cao_vao_vien || '',
    'Nguồn input': 'hchanh_profile',
  };
}

function hchanhDischargeRow(payload, meta = {}) {
  const p = payload || {};
  const benhKem = Array.isArray(p.benh_kem) ? p.benh_kem.join('; ') : String(p.benh_kem || '');
  return {
    'Mã BN': p.ma_bn || meta.ma_bn || '',
    'URL bác sĩ': meta.record_doctor_url || meta.doctor_url || '',
    'URL điều dưỡng': meta.record_nursing_url || meta.nursing_url || '',
    'Họ tên': meta.ho_ten || '',
    'Ngày vào viện': p.ngay_vao || p.ngay_vao_vien || '',
    'Ngày ra viện': p.raw_time || [p.gio_ra, p.ngay_ra].filter(Boolean).join(' ') || p.ngay_ra || '',
    'Thời gian điều trị': p.tong_so_ngay_dt || p.so_ngay_tai_khoa || '',
    'Chẩn đoán': p.chan_doan_chinh || p.chan_doan_ra || '',
    'Chẩn đoán vào viện': p.chan_doan_vao || '',
    'Chẩn đoán ra viện': p.chan_doan_ra || p.chan_doan_chinh || '',
    'Bệnh kèm': benhKem,
    'Biến chứng': p.bien_chung || '',
    'Tai biến': p.tai_bien || '',
    'Tình trạng ra': p.tinh_trang_ra || p.ket_qua || p.xu_tri || '',
    'ICD chính': p.chan_doan_chinh_icd || '',
    'Nguồn input': 'hchanh_discharge',
  };
}

function jsonShort(value, max = 3000) {
  try {
    const s = JSON.stringify(value ?? '', null, 0);
    return s.length > max ? `${s.slice(0, max)}…` : s;
  } catch (_) {
    return String(value || '').slice(0, max);
  }
}

// index.patients (Hành chánh) giữ 1 dòng mới nhất theo mã BN, không phân biệt
// theo đợt nằm viện. Nếu bệnh nhân tái nhập viện, index có thể đã cập nhật
// admission_time của đợt MỚI trong khi file discharge/surgery/order_history còn
// là dữ liệu của đợt CŨ (chưa ai fetch lại cho đợt mới). Chỉ nhận dữ liệu lấy
// TỪ lúc nhập khoa hiện tại trở về sau — tránh gán nhầm dữ liệu đợt cũ vào kho
// nghiên cứu (khác với Hành chánh, dữ liệu nghiên cứu phải đúng, không thể tự
// quét bù lại như module khác nên bắt buộc phải lọc ở đây).
function hchanhSharedDataMatchesEncounter(payload, meta) {
  const admissionAt = parseAnyDate(meta?.admission_time);
  // Từ khi write_patient_file() (server/hchanh_data_contract.js) đóng dấu đúng
  // đợt Hành chánh đang active LÚC GHI vào _meta.admission_time, so khớp trực
  // tiếp mốc này với đợt đang xét — chính xác hơn hẳn suy đoán qua so sánh
  // fetched_at với admission_time. Chỉ rơi về heuristic cũ khi bản dùng chung
  // là dữ liệu cũ (ghi trước khi có trường này).
  const stampedAdmissionAt = parseAnyDate(payload?._meta?.admission_time);
  if (admissionAt && stampedAdmissionAt) {
    return stampedAdmissionAt.getTime() === admissionAt.getTime();
  }
  const fetchedAt = parseAnyDate(payload?._meta?.fetched_at);
  // Thiếu mốc để so sánh nghĩa là không thể xác nhận dữ liệu thuộc đúng đợt
  // hiện tại. Loại thay vì mặc định coi là khớp — đúng nguyên tắc "dữ liệu
  // nghiên cứu phải đúng, không tự quét bù lại được" đã nêu ở trên; dữ liệu
  // legacy/thiếu mốc thời gian dễ là dữ liệu cũ nhất, nên càng không nên
  // mặc định tin tưởng.
  if (!fetchedAt || !admissionAt) return false;
  return fetchedAt.getTime() >= admissionAt.getTime();
}

function flattenHchanhIntoResearchRun(ctx, runDir) {
  const index = readHchanhIndex(ctx);
  const patients = Object.values(index?.patients || {});
  const profileRows = [];
  const dischargeRows = [];
  const surgeryRows = [];
  const orderRows = [];
  for (const meta of patients) {
    const maBn = String(meta?.ma_bn || '').trim();
    if (!maBn) continue;
    const all = readHchanhPatientAll(ctx, maBn) || {};
    if (all.profile && hchanhSharedDataMatchesEncounter(all.profile, meta)) profileRows.push(hchanhProfileRow(all.profile, meta));
    if (all.discharge && hchanhSharedDataMatchesEncounter(all.discharge, meta)) dischargeRows.push(hchanhDischargeRow(all.discharge, meta));
    const surgeries = (all.surgery && hchanhSharedDataMatchesEncounter(all.surgery, meta) && Array.isArray(all.surgery?.surgeries)) ? all.surgery.surgeries : [];
    for (const item of surgeries) {
      const detail = item.detail || {};
      surgeryRows.push({
        'Mã BN': maBn,
        'Ngày vào viện': meta.admission_time || '',
        'Ngày ra viện': meta.discharge_time || '',
        'Họ tên': item.ho_ten || meta.ho_ten || '',
        'Ngày phẫu thuật': detail.bat_dau || item.thoi_gian || '',
        'Kết thúc phẫu thuật': detail.ket_thuc || '',
        'Tên phẫu thuật': detail.dich_vu_phau_thuat || item.noi_dung_phau_thuat || '',
        'Đối tượng DV': detail.doi_tuong_dv || '',
        'Phương pháp phẫu thuật': detail.phuong_phap_pt || detail.phuong_phap_phau_thuat || '',
        'PPVC': detail.pp_vo_cam || detail.phuong_phap_vo_cam || '',
        'Phân loại PT': detail.phan_loai_pt || item.tinh_trang || '',
        'Trạng thái': item.trang_thai || '',
        'ICD9': detail.icd9 || '',
        'Chẩn đoán trước mổ': detail.chan_doan_truoc_pt || detail.chan_doan_truoc_mo || '',
        'ICD10 trước mổ': detail.icd10_truoc_pt || '',
        'Chẩn đoán sau mổ': detail.chan_doan_sau_pt || detail.chan_doan_sau_mo || '',
        'ICD10 sau mổ': detail.icd10_sau_pt || '',
        'Mô tả PPPT': detail.mo_ta_pppt || '',
        'Trình tự phẫu thuật': detail.trinh_tu_phau_thuat || '',
        'Phẫu thuật viên chính': detail.bs_mo_chinh || '',
        'Bác sĩ gây mê chính': detail.gay_me_chinh || '',
        'Phụ mổ 1': detail.ptv_phu_1 || '',
        'Phụ mổ 2': detail.ptv_phu_2 || '',
        'Điều dưỡng dụng cụ': detail.dd_dung_cu || '',
        'KTV phụ mê': detail.ktv_phu_me || '',
        'Diễn biến bệnh': detail.dien_bien_benh || '',
        'Dặn dò sau PT': detail.dan_do_sau_pt || '',
        'Bệnh kèm sau PT': Array.isArray(detail.benh_kem_theo_sau_pt) ? detail.benh_kem_theo_sau_pt.join(' · ') : (detail.benh_kem_theo_sau_pt || ''),
        'Người hoàn tất': detail.hoan_tat_text || '',
        'Phòng mổ': item.phong_mo || '',
        'Nguồn': 'hchanh_surgery',
        'Raw JSON': jsonShort(item),
      });
    }
    const historyRows = (all.order_history && hchanhSharedDataMatchesEncounter(all.order_history, meta) && Array.isArray(all.order_history?.rows)) ? all.order_history.rows : [];
    for (const item of historyRows) {
      orderRows.push({
        'Mã BN': maBn,
        'Ngày vào viện': meta.admission_time || '',
        'Ngày ra viện': meta.discharge_time || '',
        'Họ tên': meta.ho_ten || '',
        'TG y lệnh': item.tg_ylenh || item.ngay || '',
        'Ngày': item.ngay || '',
        'Bác sĩ': item.bac_si || '',
        'Diễn biến': item.dien_bien || '',
        'Tên y lệnh': item.ten_y_lenh || '',
        'Y lệnh khác': item.y_lenh_khac || '',
        'KQ': item.kq_text || '',
        'Trạng thái': item.status || '',
        'Nguồn': 'hchanh_order_history',
        'Raw JSON': jsonShort(item),
      });
    }
  }
  const dir = path.resolve(runDir);
  ensureDir(dir);
  if (profileRows.length) writeCsv(path.join(dir, 'hchanh_profile.csv'), Object.keys(profileRows[0]), profileRows);
  if (dischargeRows.length) writeCsv(path.join(dir, 'hchanh_discharge.csv'), Object.keys(dischargeRows[0]), dischargeRows);
  if (surgeryRows.length) writeCsv(path.join(dir, 'hchanh_surgery.csv'), Object.keys(surgeryRows[0]), surgeryRows);
  if (orderRows.length) writeCsv(path.join(dir, 'hchanh_order_history.csv'), Object.keys(orderRows[0]), orderRows);
  return { profile: profileRows.length, discharge: dischargeRows.length, surgery: surgeryRows.length, order_history: orderRows.length };
}

function researchHchanhSourceKey(row, sourceRunId = '') {
  const explicit = firstNonEmpty(row, ['Research key', 'research_key', 'source_key']);
  if (explicit) return String(explicit);
  // Không dùng sourceRunId để progress của cùng một lượt có thể tiếp tục qua nhiều lần chạy.
  return buildEncounterId(row, sourceRunId);
}

function researchHchanhMeta(row, sourceRunId = '') {
  const code = patientCode(row);
  // fetch_from_date/fetch_to_date là khoảng lấy dữ liệu đã đồng bộ theo run;
  // không ghi đè Ngày vào/ra viện thật của người bệnh.
  const admissionRaw = firstNonEmpty(row, ['fetch_from_date', 'Ngày vào viện', 'Ngay vao vien', 'Ngày nhập viện', 'Ngay nhap vien', 'T/G vào', 'TG vao', 'admission_date']);
  const dischargeRaw = firstNonEmpty(row, ['fetch_to_date', 'Ngày ra viện', 'Ngay ra vien', 'Ngày xuất viện', 'Ngay xuat vien', 'T/G ra', 'TG ra', 'discharge_date']);
  const actualAdmission = firstNonEmpty(row, ['Ngày vào viện', 'Ngay vao vien', 'Ngày nhập viện', 'Ngay nhap vien', 'T/G vào', 'TG vao', 'admission_date']);
  const actualDischarge = firstNonEmpty(row, ['Ngày ra viện', 'Ngay ra vien', 'Ngày xuất viện', 'Ngay xuat vien', 'T/G ra', 'TG ra', 'discharge_date']);
  return {
    source_key: researchHchanhSourceKey(row, sourceRunId),
    research_code: firstNonEmpty(row, ['Mã NC', 'Ma NC', 'research_code']),
    ma_bn: code,
    ho_ten: firstNonEmpty(row, ['Họ tên', 'Ho ten', 'Tên BN', 'Ten BN', 'patient_name']),
    date_from: isoDate(admissionRaw) || admissionRaw || '',
    date_to: isoDate(dischargeRaw) || dischargeRaw || '',
    admission_raw: actualAdmission || admissionRaw || '',
    // Chỉ ngày ra viện thật. Không lấy fetch_to_date (ngày cuối khoảng lấy dữ liệu, thường là ngày cuối
    // khoảng quét): ghi nó vào "Ngày ra viện" làm đợt kéo dài tới ngày đó (ca thật: 09/07 → 06/10).
    discharge_raw: actualDischarge || '',
    doctor_url: firstNonEmpty(row, ['URL bác sĩ', 'URL bac si', 'record_doctor_url', 'doctor_url']),
    nursing_url: firstNonEmpty(row, ['URL điều dưỡng', 'URL dieu duong', 'record_nursing_url', 'nursing_url']),
  };
}

function withResearchHchanhMeta(out, meta, sourceRunId) {
  return {
    ...out,
    'Mã NC': meta.research_code || out['Mã NC'] || '',
    'Research key': meta.source_key,
    'Nguồn input': out['Nguồn input'] || out['Nguồn'] || 'hchanh_auto',
    // Ghi ngày vào/ra viện thật để contextForRow build được encounter_id đúng khi normalize
    'Ngày vào viện': out['Ngày vào viện'] || meta.admission_raw || '',
    'Ngày ra viện':  out['Ngày ra viện']  || meta.discharge_raw  || '',
    'URL bác sĩ': out['URL bác sĩ'] || meta.doctor_url || '',
    'URL điều dưỡng': out['URL điều dưỡng'] || meta.nursing_url || '',
    'source_run_id': sourceRunId || '',
  };
}

function hchanhPayloadHasUsefulData(payload, fields = []) {
  if (!payload || typeof payload !== 'object') return false;
  const status = String(payload._fetch_status || '').toLowerCase();
  if (['error', 'no_url', 'no_session', 'timeout'].includes(status)) return false;
  if (String(payload._reason || '') === 'patient_not_completed_currently') return false;
  if (!fields.length) return !['empty'].includes(status);
  return fields.some(k => {
    const v = payload[k];
    if (Array.isArray(v)) return v.length > 0;
    return String(v ?? '').trim() !== '';
  });
}

function hchanhFetchOutputToRows(output, sourceRow, sourceRunId = '') {
  const sourceMeta = researchHchanhMeta(sourceRow, sourceRunId);
  const profileRows = [];
  const dischargeRows = [];
  const surgeryRows = [];
  const orderRows = [];
  const payload = output && typeof output === 'object' ? output : {};

  // Một BN có thể xuất hiện nhiều dòng nguồn (ví dụ chuyển khoa). Khi worker đã mở
  // đúng hồ sơ và đọc được ngày vào/ra thực tế, mọi bảng con của lần fetch đó phải
  // dùng cùng khoảng này; không được tiếp tục mang ngày của từng dòng nguồn.
  const actualAdmission = firstNonEmpty(payload.profile || {}, ['ngay_vao_vien', 'ngay_vao', 'admission_date'])
    || firstNonEmpty(payload.discharge || {}, ['ngay_vao_vien', 'ngay_vao', 'admission_date'])
    || sourceMeta.admission_raw || '';
  const actualDischarge = firstNonEmpty(payload.discharge || {}, ['raw_time', 'ngay_ra_vien', 'ngay_ra', 'discharge_date'])
    || firstNonEmpty(payload.profile || {}, ['ngay_ra_vien', 'ngay_ra', 'discharge_date'])
    || sourceMeta.discharge_raw || '';
  const meta = {
    ...sourceMeta,
    admission_raw: actualAdmission,
    discharge_raw: actualDischarge,
  };

  if (hchanhPayloadHasUsefulData(payload.profile, [
    'bhyt_code', 'ngay_vao_vien', 'ngay_sinh', 'dia_chi', 'doi_tuong', 'chan_doan_vao',
    'mach_vao_vien', 'nhiet_do_vao_vien', 'huyet_ap_tam_thu_vao_vien',
    'huyet_ap_tam_truong_vao_vien', 'nhip_tho_vao_vien',
    'can_nang_vao_vien', 'chieu_cao_vao_vien',
  ])) {
    profileRows.push(withResearchHchanhMeta(hchanhProfileRow(payload.profile, meta), meta, sourceRunId));
  }
  if (hchanhPayloadHasUsefulData(payload.discharge, [
    'xu_tri', 'tinh_trang_ra', 'ket_qua', 'chan_doan_chinh', 'chan_doan_ra', 'ngay_ra', 'raw_time', 'benh_kem',
  ])) {
    dischargeRows.push(withResearchHchanhMeta(hchanhDischargeRow(payload.discharge, meta), meta, sourceRunId));
  }

  const surgeries = Array.isArray(payload.surgery?.surgeries) ? payload.surgery.surgeries : [];
  for (const item of surgeries) {
    const detail = item?.detail || {};
    surgeryRows.push(withResearchHchanhMeta({
      'Mã BN': meta.ma_bn,
      'Họ tên': item?.ho_ten || meta.ho_ten || '',
      'Ngày phẫu thuật': detail.bat_dau || item?.thoi_gian || detail.ngay_phau_thuat || '',
      'Kết thúc phẫu thuật': detail.ket_thuc || '',
      'Tên phẫu thuật': detail.dich_vu_phau_thuat || item?.noi_dung_phau_thuat || detail.ten_phau_thuat || '',
      'Đối tượng DV': detail.doi_tuong_dv || '',
      'Phương pháp phẫu thuật': detail.phuong_phap_pt || detail.phuong_phap_phau_thuat || detail.pppt || '',
      'PPVC': detail.pp_vo_cam || detail.phuong_phap_vo_cam || detail.ppvc || '',
      'Phân loại PT': detail.phan_loai_pt || item?.tinh_trang || '',
      'Trạng thái': item?.trang_thai || '',
      'ICD9': detail.icd9 || '',
      'Chẩn đoán trước mổ': detail.chan_doan_truoc_pt || detail.chan_doan_truoc_mo || '',
      'ICD10 trước mổ': detail.icd10_truoc_pt || '',
      'Chẩn đoán sau mổ': detail.chan_doan_sau_pt || detail.chan_doan_sau_mo || '',
      'ICD10 sau mổ': detail.icd10_sau_pt || '',
      'Mô tả PPPT': detail.mo_ta_pppt || '',
      'Trình tự phẫu thuật': detail.trinh_tu_phau_thuat || '',
      'Phẫu thuật viên chính': detail.bs_mo_chinh || '',
      'Bác sĩ gây mê chính': detail.gay_me_chinh || '',
      'Phụ mổ 1': detail.ptv_phu_1 || '',
      'Phụ mổ 2': detail.ptv_phu_2 || '',
      'Điều dưỡng dụng cụ': detail.dd_dung_cu || '',
      'KTV phụ mê': detail.ktv_phu_me || '',
      'Diễn biến bệnh': detail.dien_bien_benh || '',
      'Dặn dò sau PT': detail.dan_do_sau_pt || '',
      'Bệnh kèm sau PT': Array.isArray(detail.benh_kem_theo_sau_pt) ? detail.benh_kem_theo_sau_pt.join(' · ') : (detail.benh_kem_theo_sau_pt || ''),
      'Người hoàn tất': detail.hoan_tat_text || '',
      'Phòng mổ': item?.phong_mo || '',
      'Nguồn': 'hchanh_auto_surgery',
      'Raw JSON': jsonShort(item),
    }, meta, sourceRunId));
  }

  const historyRows = Array.isArray(payload.order_history?.rows) ? payload.order_history.rows : [];
  for (const item of historyRows) {
    orderRows.push(withResearchHchanhMeta({
      'Mã BN': meta.ma_bn,
      'Họ tên': meta.ho_ten || '',
      'TG y lệnh': item?.tg_ylenh || item?.ngay || '',
      'Ngày': item?.ngay || '',
      'Bác sĩ': item?.bac_si || '',
      'Diễn biến': item?.dien_bien || '',
      'Tên y lệnh': item?.ten_y_lenh || '',
      'Y lệnh khác': item?.y_lenh_khac || '',
      'KQ': item?.kq_text || '',
      'Trạng thái': item?.status || '',
      'Nguồn': 'hchanh_auto_order_history',
      'Raw JSON': jsonShort(item),
    }, meta, sourceRunId));
  }

  return { profileRows, dischargeRows, surgeryRows, orderRows, meta };
}

function runDateContext(runDir, defaults = {}) {
  const manifest = readJsonSafe(path.join(runDir, 'manifest.json'), {}) || {};
  const from = String(manifest.from_date || defaults.from_date || defaults.scan_from_date || defaults.fallbackDateFrom || '').trim();
  const to = String(manifest.to_date || defaults.to_date || defaults.scan_to_date || defaults.fallbackDateTo || '').trim();
  return {
    from_date: isoDate(from) || from || '',
    to_date: isoDate(to) || to || '',
    manifest,
  };
}

function researchSourceCandidatePaths(runDir, fallbackPath = '') {
  // Thứ tự nguồn gốc thống nhất:
  // 1) research_source.csv nếu đã tạo
  // 2) du_lieu_ban_dau.csv: danh sách Hoàn tất được Bước 1 quét, cũng là input của Bước 2 XN/CĐHA
  // 3) cohort.csv/fallback: danh sách mẫu của nghiên cứu riêng
  // 4) raw sâu chỉ dùng dự phòng khi thiếu nguồn 1-3
  // 5) bảng chuẩn hóa chỉ là dự phòng cuối, không làm nguồn chính.
  return [
    path.join(runDir, 'research_source.csv'),
    path.join(runDir, 'du_lieu_ban_dau.csv'),
    fallbackPath,
    path.join(runDir, 'mau_nghien_cuu.csv'),
    path.join(runDir, 'du_lieu_goc.csv'),
    path.join(runDir, 'du_lieu_ban_dau_da_gop.csv'),
    path.join(runDir, 'patients.csv'),
    path.join(runDir, 'encounters.csv'),
    path.join(runDir, 'analysis_ready.csv'),
  ].filter(Boolean);
}

function rowFetchDateWindow(row, dateCtx = {}) {
  const admissionRaw = rowAdmissionTime(row) || firstNonEmpty(row, [
    'Ngày vào viện', 'Ngay vao vien', 'Ngày nhập viện', 'Ngay nhap vien',
    'T/G vào', 'TG vao', 'admission_date', 'ngay_vao_vien', 'ngay_vao', 'fetch_from_date',
  ]);
  const dischargeRaw = rowDischargeTime(row) || firstNonEmpty(row, [
    'Ngày ra viện', 'Ngay ra vien', 'Ngày xuất viện', 'Ngay xuat vien',
    'T/G ra', 'TG ra', 'discharge_date', 'ngay_ra_vien', 'ngay_ra', 'fetch_to_date',
  ]);
  const from = isoDate(admissionRaw) || isoDate(dateCtx.from_date) || admissionRaw || dateCtx.from_date || '';
  const to = isoDate(dischargeRaw) || isoDate(dateCtx.to_date) || dischargeRaw || dateCtx.to_date || from || '';
  return { from, to, admissionRaw, dischargeRaw };
}

// Kho thu thập trước nghiên cứu chỉ định danh mẫu bằng Mã BN + Research key.
// Mã NC thuộc về nghiên cứu cụ thể, vì vậy tuyệt đối không cấp hoặc kế thừa mã ở đây.
function normalizeResearchSourceRows(rows, { sourceFile = '', sourceRunId = '', dateCtx = {} } = {}) {
  const seen = new Map();
  const baseName = sourceFile ? path.basename(sourceFile) : '';
  for (const row of rows || []) {
    const code = patientCode(row);
    if (!code) continue;
    const win = rowFetchDateWindow(row, dateCtx);
    const key = researchHchanhSourceKey({ ...row, fetch_from_date: win.from, fetch_to_date: win.to }, sourceRunId);
    // Chỉ giữ mã đã có sẵn trên cohort của nghiên cứu; không tự sinh ở kho thu thập.
    const researchCode = firstNonEmpty(row, ['Mã NC', 'Ma NC', 'research_code']);
    const normalized = {
      ...row,
      'Mã NC': researchCode,
      research_code: researchCode,
      'Mã BN': code,
      'Họ tên': firstNonEmpty(row, ['Họ tên', 'Ho ten', 'Tên BN', 'Ten BN', 'patient_name']),
      fetch_from_date: win.from,
      fetch_to_date: win.to,
      source_scan_from_date: dateCtx.from_date || '',
      source_scan_to_date: dateCtx.to_date || '',
      source_file: baseName,
      source_run_id: sourceRunId || '',
      'Research key': key,
      list_row_signatures: collection.mergeSignatures(collection.listRowSignature(row)),
    };
    if (!seen.has(key)) seen.set(key, normalized);
    else {
      const prev = seen.get(key);
      seen.set(key, {
        ...mergeSameStayRows(prev, normalized),
        'Mã NC': prev['Mã NC'] || normalized['Mã NC'] || '',
        research_code: prev.research_code || normalized.research_code || '',
        list_row_signatures: collection.mergeSignatures(prev.list_row_signatures, normalized.list_row_signatures),
      });
    }
  }
  return Array.from(seen.values());
}

// Research key -> Mã NC từ research_source.csv cũ, chỉ lấy mã dùng cho đúng MỘT key
// (mã bị trùng giữa nhiều key là dữ liệu hỏng, không được giữ lại).
function previousResearchCodes(rows) {
  const byCode = new Map();
  for (const row of rows || []) {
    const key = firstNonEmpty(row, ['Research key']);
    const code = firstNonEmpty(row, ['Mã NC', 'Ma NC', 'research_code']);
    if (!key || !code) continue;
    if (!byCode.has(code)) byCode.set(code, new Set());
    byCode.get(code).add(key);
  }
  const out = new Map();
  for (const [code, keys] of byCode.entries()) {
    if (keys.size === 1) out.set([...keys][0], code);
  }
  return out;
}

function researchCodesConflict(rows) {
  const keyByCode = new Map();
  for (const row of rows || []) {
    const key = firstNonEmpty(row, ['Research key']);
    const code = firstNonEmpty(row, ['Mã NC', 'Ma NC', 'research_code']);
    if (!key || !code) continue;
    if (keyByCode.has(code) && keyByCode.get(code) !== key) return true;
    keyByCode.set(code, key);
  }
  return false;
}

function preferredResearchSourceSeedPath(runDir, fallbackPath = '') {
  const runPath = path.resolve(runDir);
  // Chỉ xét các file raw có thể là nguồn thật. Không xét patients.csv/encounters.csv
  // vì đó là output chuẩn hóa và luôn có mtime mới hơn research_source.csv.
  const candidates = [
    path.join(runPath, 'du_lieu_ban_dau.csv'),
    fallbackPath,
    path.join(runPath, 'mau_nghien_cuu.csv'),
    path.join(runPath, 'du_lieu_goc.csv'),
    path.join(runPath, 'du_lieu_ban_dau_da_gop.csv'),
  ].filter(Boolean);
  for (const file of candidates) {
    try {
      if (fs.statSync(file).isFile() && countCsvRows(file) > 0) return file;
    } catch (_) {}
  }
  return '';
}

function researchSourceNeedsRefresh(runDir, sourcePath, fallbackPath = '') {
  if (!sourcePath || !fs.existsSync(sourcePath)) return true;
  const seedPath = preferredResearchSourceSeedPath(runDir, fallbackPath);
  if (!seedPath) return false;
  try {
    const sourceStat = fs.statSync(sourcePath);
    const seedStat = fs.statSync(seedPath);
    return seedStat.mtimeMs > sourceStat.mtimeMs;
  } catch (_) {
    return true;
  }
}

function ensureResearchSourceRows(runDir, { fallbackPath = '', sourceRunId = '', dateDefaults = {}, force = false } = {}) {
  const runPath = path.resolve(runDir);
  ensureDir(runPath);
  const sourcePath = path.join(runPath, 'research_source.csv');
  const dateCtx = runDateContext(runPath, dateDefaults);

  const sourceStale = !force && researchSourceNeedsRefresh(runPath, sourcePath, fallbackPath);
  const existingRows = fs.existsSync(sourcePath)
    ? (readCsvTable(sourcePath, Number.MAX_SAFE_INTEGER).rows || []).filter(r => patientCode(r))
    : [];
  // Bỏ mã cũ phát sinh ở tầng thu thập khi mã đó không có trên file cohort nguồn.
  // Mã đã được cấp cho cohort nghiên cứu được giữ cache để các lần chạy không ghi lại liên tục.
  const seedForCodeCheck = preferredResearchSourceSeedPath(runPath, fallbackPath);
  const seedHasCodes = seedForCodeCheck
    ? (readCsvTable(seedForCodeCheck, Number.MAX_SAFE_INTEGER).rows || []).some(row => rowResearchCode(row))
    : false;
  const hasPrematureCodes = existingRows.some(row => rowResearchCode(row)) && !seedHasCodes;
  if (!force && !sourceStale && !hasPrematureCodes && existingRows.length) {
    const rows = existingRows;
    if (rows.length) {
      return { rows, file: sourcePath, base_file: firstNonEmpty(rows[0], ['source_file']) || path.basename(sourcePath), candidates: researchSourceCandidatePaths(runPath, fallbackPath), date_context: dateCtx };
    }
  }

  const candidates = researchSourceCandidatePaths(runPath, fallbackPath).filter(f => path.basename(f || '') !== 'research_source.csv');
  let pickedFile = '';
  let pickedRows = [];
  for (const file of candidates) {
    if (!file || !fs.existsSync(file)) continue;
    const parsed = readCsvTable(file, Number.MAX_SAFE_INTEGER);
    const rows = (parsed.rows || []).filter(r => patientCode(r));
    if (rows.length) {
      pickedFile = file;
      pickedRows = rows;
      break;
    }
  }
  if (!pickedRows.length) return { rows: [], file: '', base_file: '', candidates, date_context: dateCtx };

  const normalized = normalizeResearchSourceRows(pickedRows, {
    sourceFile: pickedFile, sourceRunId, dateCtx,
  });
  writeCsvUnion(sourcePath, normalized, [
    'Mã NC', 'Mã BN', 'Họ tên', 'Ngày vào viện', 'Ngày ra viện',
    'fetch_from_date', 'fetch_to_date', 'source_scan_from_date', 'source_scan_to_date',
    'source_file', 'source_run_id', 'Research key',
  ]);

  const manifestPath = path.join(runPath, 'manifest.json');
  const manifest = readJsonSafe(manifestPath, {}) || {};
  writeJsonAtomic(manifestPath, {
    ...manifest,
    updated_at: nowIso(),
    research_source_at: nowIso(),
    research_source_file: path.basename(pickedFile),
    research_source_rows: normalized.length,
    research_source_scan_from_date: dateCtx.from_date || '',
    research_source_scan_to_date: dateCtx.to_date || '',
  });

  return { rows: normalized, file: sourcePath, base_file: pickedFile, candidates, date_context: dateCtx };
}

function readResearchHchanhSourceRows(runDir, fallbackPath = '', options = {}) {
  // Tất cả nút tự động trong nghiên cứu phải dùng research_source.csv làm nguồn chung.
  // Nếu file này chưa có thì tạo từ du_lieu_ban_dau.csv/cohort.csv, tức cùng nguồn với Bước 2 XN/CĐHA.
  return ensureResearchSourceRows(runDir, {
    fallbackPath,
    sourceRunId: options.sourceRunId || path.basename(path.resolve(runDir)),
    dateDefaults: options.dateDefaults || {},
    force: options.force === true,
  });
}

function uniqueResearchHchanhRows(rows, sourceRunId = '') {
  const map = new Map();
  for (const row of rows || []) {
    const code = patientCode(row);
    if (!code) continue;
    const key = researchHchanhSourceKey(row, sourceRunId);
    if (!map.has(key)) map.set(key, row);
    else map.set(key, mergeRowsPreferFilled(map.get(key), row));
  }
  return Array.from(map.values());
}

function removeResearchSourceKey(rows, sourceKey) {
  return (rows || []).filter(r => String(r?.['Research key'] || r?.source_key || '') !== String(sourceKey || ''));
}

module.exports = {
  hchanhProfileRow,
  hchanhDischargeRow,
  jsonShort,
  hchanhSharedDataMatchesEncounter,
  flattenHchanhIntoResearchRun,
  researchHchanhSourceKey,
  researchHchanhMeta,
  withResearchHchanhMeta,
  hchanhPayloadHasUsefulData,
  hchanhFetchOutputToRows,
  runDateContext,
  researchSourceCandidatePaths,
  rowFetchDateWindow,
  normalizeResearchSourceRows,
  previousResearchCodes,
  researchCodesConflict,
  preferredResearchSourceSeedPath,
  researchSourceNeedsRefresh,
  ensureResearchSourceRows,
  readResearchHchanhSourceRows,
  uniqueResearchHchanhRows,
  removeResearchSourceKey,
};
