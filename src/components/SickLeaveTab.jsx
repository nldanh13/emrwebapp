import { useCallback, useEffect, useMemo, useState } from 'react';
import { C } from '../tokens.js';
import { Badge, Btn, Spinner } from './shared.jsx';
import * as api from '../api.js';
import { getPatientDischargeDates } from '../utils/dischargePrint.js';
import { sanitizeWorkDateRange, dmyToInputDate, workDateRangeToDmy, workDateRangeLabel } from '../utils/workDateRange.js';
import { getSessionId } from '../hooks/useSession.js';
import BhytPortalPanel from './BhytPortalPanel.jsx';

const DEFAULT_CLINIC_LOGIN_URL = import.meta.env.VITE_EMR_LOGIN_URL || '';
const DEFAULT_CLINIC_LIST_URL = import.meta.env.VITE_EMR_CLINIC_LIST_URL || '';

function normalizeText(value) {
  return String(value || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/đ/g, 'd').replace(/Đ/g, 'D')
    .toLowerCase().replace(/\s+/g, ' ').trim();
}

function asBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(reader.error || new Error('Không đọc được file'));
    reader.readAsDataURL(file);
  });
}

// Ô tìm trên EMR chỉ nhận họ tên đầy đủ + khoảng thời gian, không có ô ngày sinh
// (và không có mã tra cứu chung giữa danh sách BHXH và HIS) — nên chỉ khớp theo
// tên đã chuẩn hoá làm gợi ý, không tự nhận là đúng; luôn để người dùng tự đối
// chiếu ngày sinh trong file BHXH với từng kết quả EMR trả về trước khi tin.
function ageFromDob(dobDmy) {
  const m = String(dobDmy || '').trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) return null;
  return new Date().getFullYear() - Number(m[3]);
}

// Tuổi nghỉ hưu theo Bộ luật Lao động 2019 (Nghị định 135/2020/NĐ-CP): tăng dần
// mỗi năm cho đến khi đạt mốc cuối — Nam 60y3m (2021) +3 tháng/năm → 62 (từ 2028);
// Nữ 55y4m (2021) +4 tháng/năm → 60 (từ 2035). Dùng làm ngưỡng lọc "còn tuổi lao
// động" khi quét EMR (chỉ có năm sinh, không có ngày/tháng) — không phải căn cứ
// pháp lý chính xác tuyệt đối, chỉ để loại bớt người rõ ràng ngoài tuổi lao động.
function laborRetirementAgeYears(year, isFemale) {
  const y = Math.max(2021, Math.min(Number(year) || 2021, isFemale ? 2035 : 2028));
  const months = isFemale ? (55 * 12 + 4 + (y - 2021) * 4) : (60 * 12 + 3 + (y - 2021) * 3);
  return months / 12;
}

// Chỉ có năm sinh trên danh sách quét EMR (không có ngày/tháng sinh) nên tuổi tính
// được có thể lệch tới 1 năm — nới biên 1 tuổi hai đầu để tránh loại nhầm ca sát
// ngưỡng. Thiếu năm sinh/giới tính thì không loại (để người dùng tự xem, tránh bỏ sót).
function isLikelyWorkingAge(namSinh, gioiTinh, refYear) {
  const birthYear = Number(String(namSinh || '').trim());
  if (!birthYear || birthYear < 1900 || birthYear > refYear) return true;
  const age = refYear - birthYear;
  const isFemale = /^n[uữ]/.test(normalizeText(gioiTinh || ''));
  const retireAge = laborRetirementAgeYears(refYear, isFemale);
  return age >= 14 && age <= retireAge + 1;
}

// Giống isLikelyWorkingAge() nhưng dùng tuổi trực tiếp (cột "Tuổi" trong bảng
// tblNoiTru của tab Phòng khám) thay vì ước tính từ năm sinh — chính xác hơn nên
// không cần nới biên như bản kia.
function isLikelyWorkingAgeByAge(tuoi, gioiTinh, refYear) {
  const age = Number(String(tuoi || '').trim());
  if (!Number.isFinite(age) || age <= 0) return true;
  const isFemale = /^n[uữ]/.test(normalizeText(gioiTinh || ''));
  const retireAge = laborRetirementAgeYears(refYear, isFemale);
  return age >= 14 && age <= retireAge;
}

function dateOnly(value) {
  const m = String(value || '').match(/(\d{1,2}\/\d{1,2}\/\d{4})/);
  return m ? m[1] : '';
}

// Ô tìm bệnh nhân trên EMR chỉ nhận họ tên đầy đủ + khoảng thời gian (không có ô
// ngày sinh) — dùng đúng khoảng ngày đã có sẵn trong dòng BHXH làm gợi ý tìm, để
// khỏi phải tự bịa khoảng ngày khi hướng dẫn người dùng tìm lại trên EMR.
function searchWindowFor(row) {
  if (row.ngay_vao_vien || row.ngay_ra_vien) {
    return { from: dateOnly(row.ngay_vao_vien), to: dateOnly(row.ngay_ra_vien) };
  }
  if (row.dieu_tri_tu_ngay || row.dieu_tri_den_ngay) {
    return { from: dateOnly(row.dieu_tri_tu_ngay), to: dateOnly(row.dieu_tri_den_ngay) };
  }
  return { from: '', to: '' };
}

function matchInpatientCandidates(row, patients) {
  const name = normalizeText(row.ho_ten);
  if (!name) return [];
  return (patients || [])
    .filter(p => normalizeText(p.ho_ten || p.name) === name)
    .map(p => ({
      ma_bn: patientIdOf(p),
      so_phong: p.so_phong || p.room || '',
      tuoi: p.tuoi || p.age || '',
      ngay_vao: p.thoi_gian_vao_khoa || p.tg_vao || '',
      chan_doan: p.chan_doan || '',
    }));
}

function matchOutpatientCandidates(row, draft) {
  const rows = Array.isArray(draft?.carePreview?.rows) ? draft.carePreview.rows : [];
  const name = normalizeText(row.ho_ten);
  if (!name) return [];
  return rows
    .filter(r => normalizeText(r?.ho_ten) === name)
    .map(r => ({ ma_bn: r.ma_bn, ngay_lam: r.ngay_lam, khoa: r.khoa_chuyen_den }));
}

// Giống hệt careRowKey() trong ClinicTab.jsx — phải khớp key để tra đúng
// careEdits[...] (y lệnh/diễn biến đã lưu) ứng với từng dòng preview.
function careRowKey(row = {}, index = 0) {
  const stayId = String(row.noitruid || '').trim();
  if (stayId) return `stay:${stayId}`;
  const patientTime = `${String(row.ma_bn || '').trim()}::${String(row.care_time_str || row.tg_vao || '').trim()}`;
  return patientTime !== '::' ? `patient:${patientTime}` : `row:${index}`;
}

function patientIdOf(p) {
  return String(p?.ma_bn || p?.id || '').trim();
}

function buildInpatientCandidates(patients, range) {
  const out = [];
  for (const p of (patients || [])) {
    const id = patientIdOf(p);
    if (!id) continue;
    for (const dmy of getPatientDischargeDates(p)) {
      const iso = dmyToInputDate(dmy);
      if (!iso || iso < range.from || iso > range.to) continue;
      out.push({
        key: `${id}::${dmy}`,
        ma_bn: id,
        ho_ten: p.ho_ten || p.name || '',
        so_phong: p.so_phong || p.room || '',
        ngay_vao: p.thoi_gian_vao_khoa || p.tg_vao || '',
        ngay_ra: dmy,
        chan_doan: p.chan_doan || '',
        bac_si: p.bac_si || '',
        so_the_bhyt: p.so_the_bhyt || p.bhyt || '',
      });
    }
  }
  return out.sort((a, b) => a.ho_ten.localeCompare(b.ho_ten, 'vi') || a.key.localeCompare(b.key));
}

function buildOutpatientCandidates(draft, range) {
  const rows = Array.isArray(draft?.carePreview?.rows) ? draft.carePreview.rows : [];
  const edits = draft?.careEdits && typeof draft.careEdits === 'object' ? draft.careEdits : {};
  const refYear = new Date().getFullYear();
  const out = [];
  rows.forEach((row, idx) => {
    const id = String(row?.ma_bn || '').trim();
    if (!id) return;
    // Còn tuổi lao động là điều kiện cần (loại trẻ em/người đã nghỉ hưu) — bảng
    // tblNoiTru của tab Phòng khám đã có sẵn cột "Tuổi"/"GT", không cần lấy thêm.
    if (!isLikelyWorkingAgeByAge(row.tuoi, row.gioi_tinh, refYear)) return;
    // "Giấy chứng nhận nghỉ việc hưởng BHXH" là 1 form/popup riêng trên EMR (mở qua
    // "Thông tin Khác"), KHÔNG phải chữ trong y lệnh/diễn biến — nên không có từ khoá
    // nào để quét ra (đã xác nhận thực tế không tìm thấy). Vì vậy không lọc theo chữ
    // nữa, chỉ còn lọc tuổi; người dùng tự rà soát trong danh sách còn lại.
    const edit = edits[careRowKey(row, idx)] || {};
    const reasonText = [edit?.orderInfo?.ten_y_lenh, edit?.orderInfo?.suggested_dien_bien, edit?.draft, edit?.savedValue]
      .filter(Boolean).join(' · ');
    const iso = dmyToInputDate(row.ngay_lam);
    if (iso && (iso < range.from || iso > range.to)) return;
    out.push({
      key: `${id}::${row.ngay_lam || row.tg_vao || idx}`,
      ma_bn: id,
      ho_ten: row.ho_ten || '',
      tuoi: row.tuoi || '',
      gioi_tinh: row.gioi_tinh || '',
      ngay_lam: row.ngay_lam || '',
      tg_vao: row.tg_vao || row.thoi_gian_vao_khoa || '',
      khoa_chuyen_den: row.khoa_chuyen_den || '',
      ly_do: reasonText,
    });
  });
  return out.sort((a, b) => a.ho_ten.localeCompare(b.ho_ten, 'vi') || a.key.localeCompare(b.key));
}

// Dòng quét trực tiếp từ EMR (mode date_range) có tên cột động, tự dò theo
// tiêu đề bảng thật trên trang — không biết trước field nào sẽ có "ngay_lam"
// hay "tg_vao" như carePreview.rows đã chuẩn hoá sẵn. Vì vậy quét từ khoá
// nghỉ ốm trên TOÀN BỘ giá trị chuỗi của dòng — nhưng "Giấy chứng nhận nghỉ việc
// hưởng BHXH" là 1 form/popup riêng trên EMR, KHÔNG phải chữ trong y lệnh/diễn
// biến/danh sách khám bệnh, nên quét từ khoá không tìm ra gì (đã xác nhận thực
// tế). Chỉ còn lọc "còn tuổi lao động" (cột "Năm sinh" đã có sẵn trong dữ liệu
// quét) để bớt trẻ em/người đã nghỉ hưu; phần còn lại người dùng tự rà soát.
function buildScannedOutpatientCandidates(rows) {
  const refYear = new Date().getFullYear();
  return (rows || [])
    .filter(row => row && String(row.ma_bn || '').trim())
    .map((row, idx) => ({ row, idx }))
    .filter(({ row }) => isLikelyWorkingAge(row.nam_sinh, row.gioi_tinh, refYear))
    .map(({ row, idx }) => ({
      key: `scan-ngt::${row.ma_bn}::${row.ngay_lam || row.tg_vao || row.access_id || idx}`,
      ma_bn: row.ma_bn,
      ho_ten: row.ho_ten || '',
      nam_sinh: row.nam_sinh || '',
      trang_thai: row.trang_thai || '',
      chan_doan: row.chan_doan_hover || row.chan_doan || '',
      raw: row,
    }))
    .sort((a, b) => a.ho_ten.localeCompare(b.ho_ten, 'vi') || a.key.localeCompare(b.key));
}

const SCANNED_OUTPATIENT_FIELDS = [
  { label: 'Mã BN', value: it => it.ma_bn },
  { label: 'Họ tên', value: it => it.ho_ten },
  { label: 'Năm sinh', value: it => it.nam_sinh },
  { label: 'Trạng thái', value: it => it.trang_thai },
  { label: 'Chẩn đoán', value: it => it.chan_doan },
];

const INPATIENT_FIELDS = [
  { label: 'Mã BN', value: it => it.ma_bn },
  { label: 'Phòng', value: it => it.so_phong },
  { label: 'Ngày vào', value: it => it.ngay_vao },
  { label: 'Ngày ra', value: it => it.ngay_ra },
  { label: 'Chẩn đoán', value: it => it.chan_doan },
  { label: 'Bác sĩ', value: it => it.bac_si },
  { label: 'BHYT', value: it => it.so_the_bhyt },
];

const OUTPATIENT_FIELDS = [
  { label: 'Mã BN', value: it => it.ma_bn },
  { label: 'Họ tên', value: it => it.ho_ten },
  { label: 'Tuổi', value: it => it.tuoi },
  { label: 'Giới tính', value: it => it.gioi_tinh },
  { label: 'Ngày khám', value: it => it.ngay_lam },
  { label: 'Giờ vào', value: it => it.tg_vao },
  { label: 'Khoa', value: it => it.khoa_chuyen_den },
  { label: 'Lý do/y lệnh', value: it => it.ly_do },
];

// BHXH trả về 2 tên cột khác nhau cho "ghi chú rà soát" tuỳ sheet (ngoại trú:
// "Ghi chú bổ sung", nội trú: cột tự sinh key vì tên không có trong bảng ánh xạ cố định)
// — gộp lại 1 chỗ đọc để không phải sửa 2 nơi nếu BHXH đổi tên cột.
function reviewNoteOf(item) {
  return String(item?.ra_soat_ghi_chu_bo_sung || item?.ghi_chu_bo_sung || '').trim();
}

// Cờ "cần sửa": BHXH báo lỗi qua so_loi_ra_soat > 0 hoặc chữ "Thiếu/thiếu" trong
// ghi chú rà soát (mẫu thực tế: "Thiếu GHI CHÚ" vs "Đầy đủ thông tin bắt buộc...").
function reviewHasIssue(item) {
  if (Number(item?.so_loi_ra_soat || 0) > 0) return true;
  return /thieu/.test(normalizeText(reviewNoteOf(item)));
}

const BHXH_OUTPATIENT_FIELDS = [
  { label: 'Họ tên', value: it => it.ho_ten },
  { label: 'Ngày sinh', value: it => it.ngay_sinh },
  { label: 'Giới tính', value: it => it.gioi_tinh },
  { label: 'Chẩn đoán', value: it => it.chan_doan },
  { label: 'Đơn vị', value: it => it.don_vi },
  { label: 'Điều trị từ', value: it => it.dieu_tri_tu_ngay },
  { label: 'Điều trị đến', value: it => it.dieu_tri_den_ngay },
  { label: 'Người hành nghề', value: it => it.nguoi_hanh_nghe },
  { label: 'Thủ trưởng', value: it => it.thu_truong },
  { label: 'Trạng thái BHXH', value: it => it.trang_thai },
  { label: 'Rà soát BHXH', value: it => reviewNoteOf(it) || '—' },
];

const BHXH_INPATIENT_FIELDS = [
  { label: 'Họ tên', value: it => it.ho_ten },
  { label: 'Ngày sinh', value: it => it.ngay_sinh },
  { label: 'Giới tính', value: it => it.gioi_tinh },
  { label: 'Khoa', value: it => it.khoa },
  { label: 'Chẩn đoán', value: it => it.chan_doan },
  { label: 'Ngày vào viện', value: it => it.ngay_vao_vien },
  { label: 'Ngày ra viện', value: it => it.ngay_ra_vien },
  { label: 'Trưởng khoa', value: it => it.truong_khoa },
  { label: 'Thủ trưởng đơn vị', value: it => it.thu_truong_don_vi },
  { label: 'Trạng thái BHXH', value: it => it.trang_thai },
  { label: 'Rà soát BHXH', value: it => reviewNoteOf(it) || '—' },
];

function MatchHint({ row, candidates }) {
  const dobAge = ageFromDob(row.ngay_sinh);
  if (!candidates.length) {
    const searchWindow = searchWindowFor(row);
    return (
      <div style={{ fontSize: 10.5, color: C.amber, lineHeight: 1.5 }}>
        ⚠ Chưa thấy trong dữ liệu đã tải trong app — dò trên EMR: nhập đầy đủ họ tên{' '}
        <b>{row.ho_ten || '—'}</b>
        {(searchWindow.from || searchWindow.to) && <> trong khoảng <b>{searchWindow.from || '?'} → {searchWindow.to || '?'}</b></>},
        EMR sẽ hiện danh sách (không lọc theo ngày sinh) — chọn đúng người bằng cách đối chiếu
        ngày sinh <b>{row.ngay_sinh || '—'}</b> trong file này với từng kết quả trả về.
      </div>
    );
  }
  return (
    <div style={{ fontSize: 10.5, color: C.text2, lineHeight: 1.6 }}>
      <span style={{ color: C.green, fontWeight: 700 }}>✓ {candidates.length} gợi ý trùng tên trong dữ liệu đã tải</span> — đối chiếu tuổi/ngày sinh trước khi dùng:
      {candidates.map((c, idx) => (
        <div key={idx} style={{ marginLeft: 10 }}>
          • Mã BN <b>{c.ma_bn || '—'}</b>
          {c.so_phong ? ` · Phòng ${c.so_phong}` : ''}
          {c.tuoi ? ` · Tuổi ghi nhận ${c.tuoi}` : ''}
          {dobAge ? ` (BHXH ~${dobAge} tuổi)` : ''}
          {c.ngay_lam ? ` · Ngày khám ${c.ngay_lam}` : ''}
          {c.khoa ? ` · ${c.khoa}` : ''}
        </div>
      ))}
    </div>
  );
}

function BhxhCandidateRow({ item, fields, candidates, entry, onToggle, onNoteChange, onDelete }) {
  const submitted = Boolean(entry?.submitted);
  const hasIssue = reviewHasIssue(item);
  return (
    <div style={{
      padding: '9px 10px', borderBottom: `1px solid ${C.border2}`,
      background: submitted ? C.greenBg : (hasIssue ? C.redBg : C.surface),
      borderLeft: hasIssue ? `3px solid ${C.red}` : '3px solid transparent',
    }}>
      {hasIssue && (
        <div style={{ marginBottom: 6, fontSize: 10.5, fontWeight: 800, color: C.red }}>
          ⚠ BHXH báo cần sửa: {reviewNoteOf(item) || `${item.so_loi_ra_soat || ''} lỗi rà soát`}
        </div>
      )}
      <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', paddingTop: 2 }} title="Đã nộp">
          <input type="checkbox" checked={submitted} onChange={() => onToggle(item.key)} style={{ width: 16, height: 16 }} />
        </label>
        <div style={{ flex: '2 1 480px', display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(110px, 1fr))', gap: 6, minWidth: 0 }}>
          {fields.map(f => <Field key={f.label} label={f.label} value={f.value(item)} />)}
        </div>
        <input
          placeholder="Ghi chú (đã cập nhật cổng BHXH...)"
          defaultValue={entry?.note || ''}
          onBlur={e => onNoteChange(item.key, e.target.value)}
          style={{ flex: '1 1 180px', minWidth: 140, padding: '5px 7px', fontSize: 11, border: `1px solid ${C.border}`, borderRadius: 5, background: C.surface, color: C.text, fontFamily: 'inherit' }}
        />
        {onDelete && (
          <button type="button" onClick={() => onDelete(item)} title="Xoá dòng này khỏi danh sách đã nhập (vd nhập nhầm)"
            style={{
              flexShrink: 0, padding: '5px 9px', fontSize: 11, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit',
              border: `1px solid ${C.redBorder || C.border}`, background: C.redBg || C.surface, color: C.red || '#c0392b', borderRadius: 5,
            }}>
            ✕ Xoá
          </button>
        )}
      </div>
      <div style={{ marginTop: 6, paddingLeft: 26 }}>
        <MatchHint row={item} candidates={candidates} />
      </div>
    </div>
  );
}

function BhxhSection({ title, list, fields, matchFn, matchSource, stateEntries, onToggle, onNoteChange, onDelete, emptyMessage }) {
  const submittedCount = list.filter(it => stateEntries[it.key]?.submitted).length;
  const issueCount = list.filter(reviewHasIssue).length;
  return (
    <div style={{ marginBottom: 20 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 8 }}>
        <div style={{ fontSize: 13, fontWeight: 800, color: C.text }}>{title}</div>
        <Badge text={`${list.length} ca`} bg={C.surface2} color={C.text2} size={10} />
        {list.length > 0 && <Badge text={`Đã nộp ${submittedCount}/${list.length}`} bg={submittedCount === list.length ? C.greenBg : C.amberBg} color={submittedCount === list.length ? C.green : C.amber} size={10} />}
        {issueCount > 0 && <Badge text={`⚠ ${issueCount} cần sửa`} bg={C.redBg} color={C.red} size={10} />}
      </div>
      <div style={{ border: `1px solid ${C.border2}`, borderRadius: 8, overflow: 'hidden' }}>
        {list.length === 0 ? (
          <div style={{ padding: 16, fontSize: 12, color: C.text3, textAlign: 'center' }}>{emptyMessage}</div>
        ) : list.map(item => (
          <BhxhCandidateRow key={item.key} item={item} fields={fields} candidates={matchFn(item, matchSource)}
            entry={stateEntries[item.key]} onToggle={onToggle} onNoteChange={onNoteChange} onDelete={onDelete} />
        ))}
      </div>
    </div>
  );
}

function Field({ label, value }) {
  return (
    <div style={{ minWidth: 0 }}>
      <div style={{ fontSize: 9.5, color: C.text3, fontWeight: 700, letterSpacing: '0.03em' }}>{label}</div>
      <div style={{ fontSize: 11.5, color: C.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={value || ''}>{value || '—'}</div>
    </div>
  );
}

function CandidateRow({ item, fields, entry, onToggle, onNoteChange }) {
  const submitted = Boolean(entry?.submitted);
  return (
    <div style={{
      display: 'flex', gap: 10, alignItems: 'flex-start', padding: '9px 10px',
      borderBottom: `1px solid ${C.border2}`, background: submitted ? C.greenBg : C.surface,
    }}>
      <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', paddingTop: 2 }} title="Đã nộp">
        <input type="checkbox" checked={submitted} onChange={() => onToggle(item.key)} style={{ width: 16, height: 16 }} />
      </label>
      <div style={{ flex: '2 1 420px', display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(100px, 1fr))', gap: 6, minWidth: 0 }}>
        {fields.map(f => <Field key={f.label} label={f.label} value={f.value(item)} />)}
      </div>
      <input
        placeholder="Ghi chú (số ngày nghỉ, người nộp...)"
        defaultValue={entry?.note || ''}
        onBlur={e => onNoteChange(item.key, e.target.value)}
        style={{ flex: '1 1 180px', minWidth: 140, padding: '5px 7px', fontSize: 11, border: `1px solid ${C.border}`, borderRadius: 5, background: C.surface, color: C.text, fontFamily: 'inherit' }}
      />
    </div>
  );
}

function Section({ title, hint, list, fields, stateEntries, onToggle, onNoteChange, emptyMessage, compact }) {
  const submittedCount = list.filter(it => stateEntries[it.key]?.submitted).length;
  return (
    <div style={{ marginBottom: compact ? 0 : 20 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 4 }}>
        <div style={{ fontSize: 13, fontWeight: 800, color: C.text }}>{title}</div>
        <Badge text={`${list.length} ca`} bg={C.surface2} color={C.text2} size={10} />
        {list.length > 0 && <Badge text={`Đã nộp ${submittedCount}/${list.length}`} bg={submittedCount === list.length ? C.greenBg : C.amberBg} color={submittedCount === list.length ? C.green : C.amber} size={10} />}
      </div>
      {hint && <div style={{ fontSize: 11, color: C.text3, marginBottom: 8 }}>{hint}</div>}
      <div style={{ border: `1px solid ${C.border2}`, borderRadius: 8, overflow: 'hidden' }}>
        {list.length === 0 ? (
          <div style={{ padding: 16, fontSize: 12, color: C.text3, textAlign: 'center' }}>{emptyMessage}</div>
        ) : list.map(item => (
          <CandidateRow key={item.key} item={item} fields={fields} entry={stateEntries[item.key]}
            onToggle={onToggle} onNoteChange={onNoteChange} />
        ))}
      </div>
    </div>
  );
}

// Khối gấp lại được — dùng cho phần "Quét trực tiếp EMR" (cần nhập tài khoản/URL,
// không phải ai cũng dùng mỗi lần mở tab) để không chiếm chỗ ngang với các danh
// sách BHXH cần xử lý ngay.
function Collapsible({ title, subtitle, badge, open, onToggle }) {
  return (
    <button type="button" onClick={onToggle} style={{
      width: '100%', display: 'flex', alignItems: 'center', gap: 8, textAlign: 'left',
      padding: '10px 12px', border: `1px solid ${C.blueBorder || C.border}`,
      background: C.blueBg || C.surface2, cursor: 'pointer', fontFamily: 'inherit',
      borderRadius: open ? '8px 8px 0 0' : 8,
    }}>
      <span style={{ fontSize: 10, color: C.text3, transition: 'transform 0.12s ease', transform: open ? 'rotate(90deg)' : 'none', flexShrink: 0 }}>▶</span>
      <span style={{ flex: 1, minWidth: 0 }}>
        <span style={{ fontSize: 12.5, fontWeight: 800, color: C.text }}>{title}</span>
        {subtitle && <span style={{ display: 'block', fontSize: 10.5, color: C.text3, marginTop: 1 }}>{subtitle}</span>}
      </span>
      {badge}
    </button>
  );
}

// Nhãn nhỏ phân tách "danh sách BHXH gửi" (checklist chính) khỏi phần app tự dò
// thêm — hai nguồn dữ liệu khác hẳn nhau về độ tin cậy, không nên trộn lẫn trực quan.
function AutoDetectLabel({ children }) {
  return (
    <div style={{ fontSize: 10.5, fontWeight: 800, color: C.text3, letterSpacing: '0.03em', margin: '18px 0 10px', paddingTop: 12, borderTop: `1px dashed ${C.border2}` }}>
      {children}
    </div>
  );
}

export default function SickLeaveTab({ toast, workDateRange }) {
  const [patients, setPatients] = useState([]);
  const [clinicDraft, setClinicDraft] = useState(null);
  const [stateEntries, setStateEntries] = useState({});
  const [bhxhImport, setBhxhImport] = useState(null);
  const [loading, setLoading] = useState(true);
  const [importing, setImporting] = useState(false);

  // Mã phiên để BhytPortalPanel gọi API "lấy từ web app" đúng dữ liệu
  // của phiên làm việc hiện tại.
  const sessionId = useMemo(() => getSessionId(), []);
  const [bhytPanelOpen, setBhytPanelOpen] = useState(false);

  // Quét trực tiếp EMR (ngoại trú) theo khoảng ngày — không dùng chung ô tài
  // khoản với tab Phòng khám để tránh phụ thuộc trạng thái tab khác; chỉ lưu
  // trong phiên làm việc này, không lưu mật khẩu vào server/localStorage.
  const [clinicUsername, setClinicUsername] = useState('');
  const [clinicPassword, setClinicPassword] = useState('');
  const [clinicLoginUrl, setClinicLoginUrl] = useState(DEFAULT_CLINIC_LOGIN_URL);
  const [clinicListUrl, setClinicListUrl] = useState(DEFAULT_CLINIC_LIST_URL);
  const [scanning, setScanning] = useState(false);
  const [scannedOutpatientRows, setScannedOutpatientRows] = useState([]);
  const [scanMessage, setScanMessage] = useState('');

  // Tab Nội trú/Ngoại trú tách riêng để không phải cuộn qua dữ liệu không liên
  // quan; khối "Quét trực tiếp EMR" gấp lại mặc định vì cần nhập tài khoản/URL,
  // không phải bước ai cũng cần mỗi lần mở tab.
  const [recordType, setRecordType] = useState('noitru');
  const [scanPanelOpen, setScanPanelOpen] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    Promise.all([
      api.getPatients().catch(() => []),
      api.getClinicCareDraft().catch(() => ({ draft: null })),
      api.getSickLeaveState().catch(() => ({ entries: {} })),
      api.getSickLeaveImport().catch(() => ({ import: null })),
    ]).then(([patientsRes, draftRes, stateRes, importRes]) => {
      setPatients(Array.isArray(patientsRes) ? patientsRes : []);
      setClinicDraft(draftRes?.draft || null);
      setStateEntries(stateRes?.entries || {});
      setBhxhImport(importRes?.import || null);
    }).catch(e => toast?.(String(e?.message || 'Không tải được dữ liệu nghỉ ốm'), 'error'))
      .finally(() => setLoading(false));
  }, [toast]);

  useEffect(() => { load(); }, [load]);

  const handleImportFile = useCallback(async (file) => {
    if (!file) return;
    setImporting(true);
    try {
      const base64 = await asBase64(file);
      const result = await api.importSickLeaveList({ excel: { filename: file.name, base64 } });
      if (result?.status !== 'ok') throw new Error(result?.message || 'Không nhập được danh sách BHXH.');
      setBhxhImport({
        version: result.version,
        imported_at: result.imported_at,
        filename: result.filename,
        outpatient: result.outpatient,
        inpatient: result.inpatient,
      });
      toast?.(result.message || `Đã nhập ${result.outpatient?.length || 0} ca ngoại trú, ${result.inpatient?.length || 0} ca nội trú.`, 'ok');
      // Sheet không khớp tên "Ngoại trú"/"Nội trú" bị bỏ qua âm thầm ở worker —
      // cảnh báo ngay để người dùng biết sao dữ liệu có thể thiếu/rỗng.
      if (Array.isArray(result.unknown_sheets) && result.unknown_sheets.length > 0) {
        toast?.(`Không nhận diện được sheet: ${result.unknown_sheets.join(', ')} — kiểm tra lại tên sheet trong file (phải đúng "Ngoại trú"/"Nội trú").`, 'error');
      }
    } catch (e) {
      toast?.(String(e?.message || 'Không nhập được danh sách BHXH.'), 'error');
    } finally {
      setImporting(false);
    }
  }, [toast]);

  const handleScanOutpatient = useCallback(async () => {
    if (!clinicUsername.trim() || !clinicPassword || !clinicLoginUrl.trim() || !clinicListUrl.trim()) {
      toast?.('Thiếu tài khoản, mật khẩu hoặc URL phòng khám để quét EMR.', 'error');
      return;
    }
    const { dateFrom, dateTo } = workDateRangeToDmy(workDateRange);
    setScanning(true);
    setScanMessage('');
    try {
      const result = await api.runClinicPreview({
        mode: 'date_range', dateFrom, dateTo,
        username: clinicUsername.trim(), password: clinicPassword,
        loginUrl: clinicLoginUrl.trim(), listUrl: clinicListUrl.trim(),
        headless: true, clinicSchedule: {},
      });
      if (result?.status !== 'ok' && result?.status !== 'partial') throw new Error(result?.message || 'Không quét được EMR.');
      setScannedOutpatientRows(Array.isArray(result.rows) ? result.rows : []);
      setScanMessage(result.message || '');
      toast?.(result.message || `Đã quét ${result.rows?.length || 0} dòng.`, result.status === 'ok' ? 'ok' : 'info');
    } catch (e) {
      toast?.(String(e?.message || 'Không quét được EMR ngoại trú.'), 'error');
    } finally {
      setScanning(false);
    }
  }, [toast, workDateRange, clinicUsername, clinicPassword, clinicLoginUrl, clinicListUrl]);

  const range = useMemo(() => sanitizeWorkDateRange(workDateRange), [workDateRange?.from, workDateRange?.to]);
  const scannedOutpatientList = useMemo(() => buildScannedOutpatientCandidates(scannedOutpatientRows), [scannedOutpatientRows]);
  const inpatientList = useMemo(() => buildInpatientCandidates(patients, range), [patients, range.from, range.to]);
  const outpatientList = useMemo(() => buildOutpatientCandidates(clinicDraft, range), [clinicDraft, range.from, range.to]);

  const bhxhOutpatientList = useMemo(() => {
    const rows = Array.isArray(bhxhImport?.outpatient) ? bhxhImport.outpatient : [];
    // Key theo nội dung (tên + ngày sinh + khoảng điều trị), không dùng "dong_nguon"
    // (số thứ tự dòng trong file BHXH) — số này có thể đổi giữa các lần BHXH gửi lại
    // file (chèn/xoá dòng), làm mất trạng thái "đã nộp" đã đánh dấu cho cùng một ca.
    // _index = vị trí trong mảng đã lưu ở server, dùng để gọi API xoá đúng dòng.
    return rows.map((r, i) => {
      const identity = normalizeText(r.ho_ten) || r.dong_nguon || r.ma_so_bh || 'unknown';
      return { ...r, _index: i, key: `bhxh-ngt::${identity}::${r.ngay_sinh || ''}::${r.dieu_tri_tu_ngay || ''}::${r.dieu_tri_den_ngay || ''}` };
    });
  }, [bhxhImport]);
  const bhxhInpatientList = useMemo(() => {
    const rows = Array.isArray(bhxhImport?.inpatient) ? bhxhImport.inpatient : [];
    return rows.map((r, i) => {
      const identity = normalizeText(r.ho_ten) || r.dong_nguon || r.ma_y_te || 'unknown';
      return { ...r, _index: i, key: `bhxh-nt::${identity}::${r.ngay_sinh || ''}::${r.ngay_vao_vien || ''}::${r.ngay_ra_vien || ''}` };
    });
  }, [bhxhImport]);

  const persist = useCallback((nextEntries) => {
    api.saveSickLeaveState({ entries: nextEntries })
      .catch(e => toast?.(String(e?.message || 'Không lưu được trạng thái nghỉ ốm'), 'error'));
  }, [toast]);

  const handleDeleteBhxhRow = useCallback(async (type, item) => {
    if (typeof window !== 'undefined' && !window.confirm(`Xoá dòng "${item.ho_ten || '—'}" khỏi danh sách đã nhập? Không thể hoàn tác.`)) return;
    try {
      const result = await api.deleteSickLeaveImportRow({ type, index: item._index });
      if (result?.status !== 'ok') throw new Error(result?.message || 'Không xoá được dòng.');
      setBhxhImport(prev => ({ ...(prev || {}), outpatient: result.outpatient, inpatient: result.inpatient }));
      toast?.('Đã xoá dòng khỏi danh sách.', 'ok');
    } catch (e) {
      toast?.(String(e?.message || 'Không xoá được dòng.'), 'error');
    }
  }, [toast]);

  const toggle = useCallback((key) => {
    setStateEntries(prev => {
      const current = prev[key] || { submitted: false, note: '' };
      const next = { ...prev, [key]: { ...current, submitted: !current.submitted, updated_at: new Date().toISOString() } };
      persist(next);
      return next;
    });
  }, [persist]);

  const setNote = useCallback((key, note) => {
    setStateEntries(prev => {
      const current = prev[key] || { submitted: false, note: '' };
      if ((current.note || '') === note) return prev;
      const next = { ...prev, [key]: { ...current, note, updated_at: new Date().toISOString() } };
      persist(next);
      return next;
    });
  }, [persist]);

  const noitruPending = bhxhInpatientList.filter(it => !stateEntries[it.key]?.submitted).length;
  const ngoaitruPending = bhxhOutpatientList.filter(it => !stateEntries[it.key]?.submitted).length;
  const tabs = [
    { id: 'noitru', label: 'Nội trú', total: bhxhInpatientList.length, pending: noitruPending },
    { id: 'ngoaitru', label: 'Ngoại trú', total: bhxhOutpatientList.length, pending: ngoaitruPending },
  ];

  return (
    <div style={{ padding: 14, overflow: 'auto', height: '100%' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 4 }}>
        <div style={{ fontSize: 14, fontWeight: 850, color: C.text }}>Nghỉ ốm</div>
        {loading && <Spinner size={12} />}
        <Btn variant="default" onClick={load} disabled={loading} style={{ marginLeft: 'auto', padding: '4px 10px', fontSize: 11 }}>⟳ Làm mới</Btn>
      </div>
      <div style={{ fontSize: 11, color: C.text3, marginBottom: 10, lineHeight: 1.5 }}>
        Danh sách người bệnh cần chuẩn bị Giấy chứng nhận nghỉ việc hưởng BHXH, lọc từ dữ liệu đã có trong app
        cho khoảng ngày <b style={{ color: C.text2 }}>{workDateRangeLabel(workDateRange)}</b>. Chưa tự động nộp lên
        Cổng Dịch vụ công BHXH (khác hệ thống/tài khoản đăng nhập) — tick "Đã nộp" sau khi làm thủ công.
      </div>
      <div style={{ marginBottom: 14 }}>
        <button type="button" onClick={() => setBhytPanelOpen(o => !o)} style={{
          width: '100%', display: 'flex', alignItems: 'center', gap: 8, textAlign: 'left',
          padding: '10px 12px', border: `1px solid ${C.blueBorder || C.border}`,
          background: C.blueBg || C.surface2, cursor: 'pointer', fontFamily: 'inherit',
          borderRadius: bhytPanelOpen ? '8px 8px 0 0' : 8,
        }}>
          <span style={{ fontSize: 10, color: C.text3, transition: 'transform 0.12s ease', transform: bhytPanelOpen ? 'rotate(90deg)' : 'none', flexShrink: 0 }}>▶</span>
          <span style={{ flex: 1, minWidth: 0 }}>
            <span style={{ fontSize: 12.5, fontWeight: 800, color: C.text }}>Nhập/sửa lên Cổng BHXH</span>
            <span style={{ display: 'block', fontSize: 10.5, color: C.text3, marginTop: 1 }}>
              Đăng nhập, lấy dữ liệu đã rà soát, điền thử rồi nhập thật — ngay tại đây, không cần mở tab riêng.
            </span>
          </span>
        </button>
        {bhytPanelOpen && (
          <div style={{ border: `1px solid ${C.blueBorder || C.border}`, borderTop: 'none', borderRadius: '0 0 8px 8px', padding: 12 }}>
            <BhytPortalPanel toast={toast} sessionId={sessionId} />
          </div>
        )}
      </div>

      <div style={{
        border: `1px solid ${C.blueBorder || C.border}`, background: C.blueBg || C.surface2,
        borderRadius: 8, padding: 12, marginBottom: 18,
      }}>
        <div style={{ fontSize: 12.5, fontWeight: 800, color: C.text, marginBottom: 4 }}>Nhập danh sách BHXH gửi rà soát (.xlsx)</div>
        <div style={{ fontSize: 11, color: C.text3, marginBottom: 8, lineHeight: 1.5 }}>
          File phải có 2 sheet "Ngoại trú" và "Nội trú" (đúng định dạng BHXH gửi). Ô tìm trên EMR chỉ nhận
          họ tên đầy đủ + khoảng thời gian (không lọc được theo ngày sinh), nên mỗi dòng sẽ kèm gợi ý khớp
          tên trong dữ liệu đã tải ở app hoặc khoảng ngày để tự tìm lại — luôn đối chiếu ngày sinh trước khi tin.
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <input type="file" accept=".xlsx" disabled={importing}
            onChange={e => { const f = e.target.files?.[0]; handleImportFile(f); e.target.value = ''; }}
            style={{ fontSize: 11 }} />
          {importing && <Spinner size={12} />}
          {bhxhImport?.filename && (
            <span style={{ fontSize: 10.5, color: C.text3 }}>
              Đã nhập: {bhxhImport.filename} lúc {bhxhImport.imported_at ? new Date(bhxhImport.imported_at).toLocaleString('vi-VN') : '—'}
            </span>
          )}
        </div>
      </div>

      <div style={{ display: 'flex', gap: 6, marginBottom: 16, borderBottom: `1px solid ${C.border2}` }}>
        {tabs.map(t => (
          <button type="button" key={t.id} onClick={() => setRecordType(t.id)} style={{
            display: 'flex', alignItems: 'center', gap: 6, padding: '7px 4px', marginBottom: -1,
            border: 'none', borderBottom: '2px solid', cursor: 'pointer', fontFamily: 'inherit',
            background: 'transparent',
            borderColor: recordType === t.id ? C.blue : 'transparent',
            color: recordType === t.id ? C.blue : C.text2,
          }}>
            <span style={{ fontSize: 13, fontWeight: 800 }}>{t.label}</span>
            <Badge text={`${t.total} ca`} bg={recordType === t.id ? C.blueBg : C.surface2} color={recordType === t.id ? C.blue : C.text3} size={10} />
            {t.pending > 0 && <Badge text={`${t.pending} chưa nộp`} bg={C.amberBg} color={C.amber} size={10} />}
          </button>
        ))}
      </div>

      {recordType === 'noitru' && (
        <>
          <BhxhSection
            title="BHXH — Nội trú (Giấy ra viện)"
            list={bhxhInpatientList}
            fields={BHXH_INPATIENT_FIELDS}
            matchFn={matchInpatientCandidates}
            matchSource={patients}
            stateEntries={stateEntries}
            onToggle={toggle}
            onNoteChange={setNote}
            onDelete={item => handleDeleteBhxhRow('inpatient', item)}
            emptyMessage={loading ? 'Đang tải...' : 'Chưa nhập danh sách BHXH (Nội trú), hoặc file chưa có dòng nào.'}
          />

          <AutoDetectLabel>Tự phát hiện thêm trong app (ngoài danh sách BHXH ở trên)</AutoDetectLabel>

          <Section
            title="Nội trú xuất viện"
            hint="Mọi người bệnh có ngày ra viện trong khoảng ngày đã chọn."
            list={inpatientList}
            fields={INPATIENT_FIELDS}
            stateEntries={stateEntries}
            onToggle={toggle}
            onNoteChange={setNote}
            emptyMessage={loading ? 'Đang tải...' : 'Không có người bệnh ra viện trong khoảng ngày đã chọn.'}
          />
        </>
      )}

      {recordType === 'ngoaitru' && (
        <>
          <BhxhSection
            title="BHXH — Ngoại trú (Giấy nghỉ hưởng BHXH)"
            list={bhxhOutpatientList}
            fields={BHXH_OUTPATIENT_FIELDS}
            matchFn={matchOutpatientCandidates}
            matchSource={clinicDraft}
            stateEntries={stateEntries}
            onToggle={toggle}
            onNoteChange={setNote}
            onDelete={item => handleDeleteBhxhRow('outpatient', item)}
            emptyMessage={loading ? 'Đang tải...' : 'Chưa nhập danh sách BHXH (Ngoại trú), hoặc file chưa có dòng nào.'}
          />

          <AutoDetectLabel>Tự phát hiện thêm trong app (ngoài danh sách BHXH ở trên)</AutoDetectLabel>

          <Section
            title="Ngoại trú (từ tab Phòng khám)"
            hint='Danh sách khám ngày đã chọn ở tab "Phòng khám", đã lọc bớt người ngoài tuổi lao động (trẻ em/đã nghỉ hưu). "Giấy chứng nhận nghỉ việc hưởng BHXH" là form riêng trên EMR, không có trong y lệnh/diễn biến, nên KHÔNG tự biết ai đã có giấy — cần tự rà soát danh sách dưới đây.'
            list={outpatientList}
            fields={OUTPATIENT_FIELDS}
            stateEntries={stateEntries}
            onToggle={toggle}
            onNoteChange={setNote}
            emptyMessage={loading
              ? 'Đang tải...'
              : (clinicDraft
                ? 'Có bản xem trước Phòng khám nhưng không có ca nào còn tuổi lao động trong khoảng ngày đã chọn.'
                : 'Chưa có bản xem trước ở tab Phòng khám. Vào tab Phòng khám, dán/tải danh sách rồi quay lại đây.')}
          />

          <div style={{ marginTop: 20 }}>
            <Collapsible
              title="Quét trực tiếp EMR theo khoảng ngày"
              subtitle={scannedOutpatientRows.length ? `Đã quét ${scannedOutpatientRows.length} dòng · ${scannedOutpatientList.length} ca còn tuổi lao động` : 'Cần tài khoản/URL phòng khám — chưa quét'}
              open={scanPanelOpen}
              onToggle={() => setScanPanelOpen(o => !o)}
              badge={scanning ? <Spinner size={12} /> : null}
            />
            {scanPanelOpen && (
              <div style={{ border: `1px solid ${C.blueBorder || C.border}`, borderTop: 'none', borderRadius: '0 0 8px 8px', padding: 12 }}>
                <div style={{ fontSize: 11, color: C.text3, marginBottom: 8, lineHeight: 1.5 }}>
                  Tìm mù trên "Danh sách Khám bệnh" trong khoảng ngày đang chọn ở trên ({workDateRangeLabel(workDateRange)}),
                  rồi lọc bớt người ngoài tuổi lao động (trẻ em/đã nghỉ hưu). "Giấy chứng nhận nghỉ việc hưởng BHXH" là form
                  riêng trên EMR nên không quét được ai đã có giấy — cần tự rà soát trong danh sách còn lại. Chưa test với
                  EMR thật — nếu bộ lọc khoảng ngày không áp dụng đúng, kết quả sẽ ghi rõ "partial" và cần kiểm tra lại thủ công.
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 8, marginBottom: 8 }}>
                  <input placeholder="Tài khoản phòng khám" value={clinicUsername} onChange={e => setClinicUsername(e.target.value)}
                    style={{ padding: '6px 8px', fontSize: 12, border: `1px solid ${C.border}`, borderRadius: 5, background: C.surface, color: C.text, fontFamily: 'inherit' }} />
                  <input placeholder="Mật khẩu" type="password" value={clinicPassword} onChange={e => setClinicPassword(e.target.value)}
                    style={{ padding: '6px 8px', fontSize: 12, border: `1px solid ${C.border}`, borderRadius: 5, background: C.surface, color: C.text, fontFamily: 'inherit' }} />
                  <input placeholder="URL đăng nhập" value={clinicLoginUrl} onChange={e => setClinicLoginUrl(e.target.value)}
                    style={{ padding: '6px 8px', fontSize: 12, border: `1px solid ${C.border}`, borderRadius: 5, background: C.surface, color: C.text, fontFamily: 'inherit' }} />
                  <input placeholder="URL Danh sách Khám bệnh" value={clinicListUrl} onChange={e => setClinicListUrl(e.target.value)}
                    style={{ padding: '6px 8px', fontSize: 12, border: `1px solid ${C.border}`, borderRadius: 5, background: C.surface, color: C.text, fontFamily: 'inherit' }} />
                </div>
                <Btn variant="primary" onClick={handleScanOutpatient} disabled={scanning} style={{ padding: '6px 12px', fontSize: 12 }}>
                  {scanning ? <><Spinner size={11} /> Đang quét...</> : '⟳ Quét EMR theo khoảng ngày'}
                </Btn>
                {scanMessage && <div style={{ fontSize: 10.5, color: C.text3, marginTop: 6 }}>{scanMessage}</div>}

                <div style={{ marginTop: 14 }}>
                  <Section
                    compact
                    title="Kết quả quét"
                    hint="Chỉ trong phiên làm việc này (bấm Quét lại nếu tải lại trang). Đã lọc bớt người ngoài tuổi lao động; phần còn lại cần tự rà soát ai đã có Giấy chứng nhận."
                    list={scannedOutpatientList}
                    fields={SCANNED_OUTPATIENT_FIELDS}
                    stateEntries={stateEntries}
                    onToggle={toggle}
                    onNoteChange={setNote}
                    emptyMessage={scanning
                      ? 'Đang quét...'
                      : (scannedOutpatientRows.length
                        ? 'Đã quét nhưng không có ca nào còn tuổi lao động.'
                        : 'Chưa quét — bấm "Quét EMR theo khoảng ngày" ở trên.')}
                  />
                </div>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
