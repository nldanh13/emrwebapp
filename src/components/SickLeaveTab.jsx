import { useCallback, useEffect, useMemo, useState } from 'react';
import { C, FS } from '../tokens.js';
import { Badge, Btn, Spinner } from './shared.jsx';
import * as api from '../api.js';
import SickLeaveAutoPanel from './SickLeaveAutoPanel.jsx';
import { useOnTabReturn } from '../hooks/useTabActivity.js';
import { SkeletonTable } from './Skeleton.jsx';


// Lần đầu chưa có danh sách: khung xám thay cho chữ "Đang tải..." (UX_RULES mục 9).
const LOADING_ROWS = (
  <div role="status" aria-busy="true" aria-label="Đang tải danh sách" style={{ textAlign: 'left' }}>
    <SkeletonTable rows={3} cols={4} />
  </div>
);

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

function patientIdOf(p) {
  return String(p?.ma_bn || p?.id || '').trim();
}

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
      <div style={{ fontSize: FS.xs, color: C.amber, lineHeight: 1.5 }}>
        ⚠ Chưa thấy trong dữ liệu đã tải trong app — dò trên EMR: nhập đầy đủ họ tên{' '}
        <b>{row.ho_ten || '—'}</b>
        {(searchWindow.from || searchWindow.to) && <> trong khoảng <b>{searchWindow.from || '?'} → {searchWindow.to || '?'}</b></>},
        EMR sẽ hiện danh sách (không lọc theo ngày sinh) — chọn đúng người bằng cách đối chiếu
        ngày sinh <b>{row.ngay_sinh || '—'}</b> trong file này với từng kết quả trả về.
      </div>
    );
  }
  return (
    <div style={{ fontSize: FS.xs, color: C.text2, lineHeight: 1.6 }}>
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
        <div style={{ marginBottom: 6, fontSize: FS.xs, fontWeight: 700, color: C.red }}>
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
          style={{ flex: '1 1 180px', minWidth: 140, padding: '5px 7px', fontSize: FS.xs, border: `1px solid ${C.border}`, borderRadius: 5, background: C.surface, color: C.text, fontFamily: 'inherit' }}
        />
        {onDelete && (
          <button type="button" onClick={() => onDelete(item)} title="Xoá dòng này khỏi danh sách đã nhập (vd nhập nhầm)"
            style={{
              flexShrink: 0, padding: '5px 9px', fontSize: FS.xs, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit',
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
        <div style={{ fontSize: FS.md, fontWeight: 700, color: C.text }}>{title}</div>
        <Badge text={`${list.length} ca`} bg={C.surface2} color={C.text2} size={FS.xs} />
        {list.length > 0 && <Badge text={`Đã nộp ${submittedCount}/${list.length}`} bg={submittedCount === list.length ? C.greenBg : C.amberBg} color={submittedCount === list.length ? C.green : C.amber} size={FS.xs} />}
        {issueCount > 0 && <Badge text={`⚠ ${issueCount} cần sửa`} bg={C.redBg} color={C.red} size={FS.xs} />}
      </div>
      <div style={{ border: `1px solid ${C.border2}`, borderRadius: 8, overflow: 'hidden' }}>
        {list.length === 0 ? (
          <div style={{ padding: 16, fontSize: FS.sm, color: C.text3, textAlign: 'center' }}>{emptyMessage}</div>
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
      <div style={{ fontSize: FS.xs, color: C.text3, fontWeight: 700 }}>{label}</div>
      <div style={{ fontSize: FS.xs, color: C.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={value || ''}>{value || '—'}</div>
    </div>
  );
}

// Khối gấp lại được — phần rà soát danh sách BHXH gửi về (chỉ dùng khi có file BHXH).
function Collapsible({ title, subtitle, badge, open, onToggle }) {
  return (
    <button type="button" onClick={onToggle} style={{
      width: '100%', display: 'flex', alignItems: 'center', gap: 8, textAlign: 'left',
      padding: '10px 12px', border: `1px solid ${C.blueBorder || C.border}`,
      background: C.blueBg || C.surface2, cursor: 'pointer', fontFamily: 'inherit',
      borderRadius: open ? '8px 8px 0 0' : 8,
    }}>
      <span style={{ fontSize: FS.xs, color: C.text3, transition: 'transform 0.12s ease', transform: open ? 'rotate(90deg)' : 'none', flexShrink: 0 }}>▶</span>
      <span style={{ flex: 1, minWidth: 0 }}>
        <span style={{ fontSize: FS.md, fontWeight: 700, color: C.text }}>{title}</span>
        {subtitle && <span style={{ display: 'block', fontSize: FS.xs, color: C.text3, marginTop: 1 }}>{subtitle}</span>}
      </span>
      {badge}
    </button>
  );
}

export default function SickLeaveTab({ toast }) {
  const [patients, setPatients] = useState([]);
  const [clinicDraft, setClinicDraft] = useState(null);
  const [stateEntries, setStateEntries] = useState({});
  const [bhxhImport, setBhxhImport] = useState(null);
  const [loading, setLoading] = useState(true);
  const [importing, setImporting] = useState(false);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [recordType, setRecordType] = useState('noitru');

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
  useOnTabReturn(load);

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
  const reviewTotal = bhxhInpatientList.length + bhxhOutpatientList.length;
  const tabs = [
    { id: 'noitru', label: 'Nội trú', total: bhxhInpatientList.length, pending: noitruPending },
    { id: 'ngoaitru', label: 'Ngoại trú', total: bhxhOutpatientList.length, pending: ngoaitruPending },
  ];

  return (
    <div style={{ padding: 14, overflow: 'auto', height: '100%' }}>
      <SickLeaveAutoPanel toast={toast} />

      <div style={{ marginTop: 16 }}>
        <Collapsible
          title="Rà soát danh sách BHXH gửi về"
          subtitle={reviewTotal
            ? `${reviewTotal} ca trong file ${bhxhImport?.filename || ''} · ${noitruPending + ngoaitruPending} ca chưa nộp`
            : 'Khi BHXH gửi file rà soát (.xlsx): nhập file, đối chiếu và đánh dấu đã nộp'}
          open={reviewOpen}
          onToggle={() => setReviewOpen(o => !o)}
          badge={loading ? <Spinner size={12} /> : null}
        />
        {reviewOpen && (
          <div style={{ border: `1px solid ${C.blueBorder || C.border}`, borderTop: 'none', borderRadius: '0 0 8px 8px', padding: 12 }}>
            <div style={{ fontSize: FS.xs, color: C.text3, marginBottom: 8, lineHeight: 1.5 }}>
              File phải có 2 sheet "Ngoại trú" và "Nội trú" (đúng định dạng BHXH gửi). Ô tìm trên EMR chỉ nhận
              họ tên đầy đủ + khoảng thời gian (không lọc được theo ngày sinh), nên mỗi dòng sẽ kèm gợi ý khớp
              tên trong dữ liệu đã tải ở app hoặc khoảng ngày để tự tìm lại — luôn đối chiếu ngày sinh trước khi tin.
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 14 }}>
              <input type="file" accept=".xlsx" disabled={importing}
                onChange={e => { const f = e.target.files?.[0]; handleImportFile(f); e.target.value = ''; }}
                style={{ fontSize: FS.xs }} />
              {importing && <Spinner size={12} />}
              {bhxhImport?.filename && (
                <span style={{ fontSize: FS.xs, color: C.text3 }}>
                  Đã nhập: {bhxhImport.filename} lúc {bhxhImport.imported_at ? new Date(bhxhImport.imported_at).toLocaleString('vi-VN') : '—'}
                </span>
              )}
              <Btn variant="default" onClick={load} disabled={loading} style={{ marginLeft: 'auto', padding: '4px 10px', fontSize: FS.xs }}>Làm mới</Btn>
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
                  <span style={{ fontSize: FS.md, fontWeight: 700 }}>{t.label}</span>
                  <Badge text={`${t.total} ca`} bg={recordType === t.id ? C.blueBg : C.surface2} color={recordType === t.id ? C.blue : C.text3} size={FS.xs} />
                  {t.pending > 0 && <Badge text={`${t.pending} chưa nộp`} bg={C.amberBg} color={C.amber} size={FS.xs} />}
                </button>
              ))}
            </div>

            {recordType === 'noitru' ? (
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
                emptyMessage={loading ? LOADING_ROWS : 'Chưa nhập danh sách BHXH (Nội trú), hoặc file chưa có dòng nào.'}
              />
            ) : (
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
                emptyMessage={loading ? LOADING_ROWS : 'Chưa nhập danh sách BHXH (Ngoại trú), hoặc file chưa có dòng nào.'}
              />
            )}
          </div>
        )}
      </div>
    </div>
  );
}
