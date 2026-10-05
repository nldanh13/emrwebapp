// Khung Thu thập tự động: chạy lấy phần thiếu/lỗi/đã đổi, chính sách làm mới, yêu cầu dữ liệu, đủ dùng, ngoại lệ, duyệt lượt chưa ghép.
import { buildPlanView } from './collectionPlanText.js';
import { useState, useCallback, useEffect, useRef } from 'react';
import * as api from '../../api.js';
import { todayInputDate } from './researchScope.js';
import { C, FS } from '../../tokens.js';
import { compactNumber } from './researchFormat.js';
import { inp, StatBadge, SmallRowsTable } from './researchUi.jsx';
import { Btn, Spinner } from '../shared.jsx';

const COLLECTION_PARTS = [
  ['xn', 'Xét nghiệm'], ['cdha', 'CĐHA'], ['profile', 'Hồ sơ nền'],
  ['discharge', 'Ra viện'], ['surgery', 'Phẫu thuật'], ['order_history', 'Y lệnh'],
];

const COLLECTION_CATEGORY_LABEL = {
  unmatched: 'Không ghép chắc lượt',
  needs_review: 'Cần người xem',
  retry_exhausted: 'Hết lượt tự thử lại',
  selenium_error: 'Lỗi, sẽ tự thử lại',
};

const REQUIREMENT_ITEM_KINDS = [
  ['imaging_modality', 'Có CĐHA loại'], ['lab_item', 'Có xét nghiệm'],
  ['procedure_item', 'Có phẫu thuật'], ['drug_item', 'Có thuốc'],
];

const READINESS_LABEL = {
  usable: ['Đủ dùng', 'ok'],
  not_eligible: ['Không đạt điều kiện đề tài', 'neutral'],
  incomplete: ['Chưa lấy xong', 'warn'],
  needs_review: ['Cần người xem', 'danger'],
};

// Thu thập tự động: một nút chạy, một báo cáo ngắn, danh sách ngoại lệ chỉ mở khi cần.
// serverRunning: tác vụ máy chủ đang chạy ở kho/nghiên cứu này ({ label, since }) hoặc null. Dùng để
// nút và báo cáo đúng cả khi tác vụ được bấm chạy từ trước (rời tab, tải lại trang, máy khác).
function CollectionAutoPanel({ studyId = '', options = {}, disabled = false, onDone, toast, study = null, serverRunning = null }) {
  const [status, setStatus] = useState(null);
  const [loading, setLoading] = useState(false);
  const [running, setRunning] = useState(false);
  // Kết quả lần bấm gần nhất ở đây (lỗi hiện tại chỗ, không chỉ thoáng qua ở thông báo góc màn hình).
  const [lastClick, setLastClick] = useState(null);
  const [reconciling, setReconciling] = useState(false);
  const [showEncounterReviews, setShowEncounterReviews] = useState(false);
  const [encounterReviews, setEncounterReviews] = useState(null);
  const [reviewSelections, setReviewSelections] = useState({});
  const [reviewActing, setReviewActing] = useState('');
  const [showExceptions, setShowExceptions] = useState(false);
  const [readiness, setReadiness] = useState(null);
  const [showReq, setShowReq] = useState(false);
  const [req, setReq] = useState({ parts: [], items: [] });
  const [showRefresh, setShowRefresh] = useState(false);
  const [policy, setPolicy] = useState({});
  const [refreshParts, setRefreshParts] = useState([]);
  const [changes, setChanges] = useState(null);
  const t = (msg, type) => { if (toast) toast(msg, type); };

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await api.getResearchCollectionStatus(studyId);
      setStatus(r);
      setPolicy(r?.refresh_policy || {});
      if (studyId) {
        try { setReadiness(await api.getResearchStudyReadiness(studyId)); } catch (_) { setReadiness(null); }
      }
    } catch (_) {
      setStatus(null);
    } finally {
      setLoading(false);
    }
  }, [studyId]);

  useEffect(() => { load(); }, [load]);
  // Tác vụ máy chủ vừa kết thúc (kể cả không do nút ở đây bấm): tải lại báo cáo.
  const wasServerRunning = useRef(Boolean(serverRunning));
  useEffect(() => {
    if (wasServerRunning.current && !serverRunning && !running) load();
    wasServerRunning.current = Boolean(serverRunning);
  }, [serverRunning, running, load]);
  useEffect(() => {
    const dr = study?.data_requirements || {};
    setReq({ parts: Array.isArray(dr.parts) ? dr.parts : [], items: Array.isArray(dr.items) ? dr.items : [] });
  }, [study?.id, study?.data_requirements]);

  const run = async (manualParts = []) => {
    setRunning(true);
    setLastClick(null);
    try {
      const r = await api.collectResearchAuto(studyId, {
        headless: options.headless !== false,
        fromDate: options.fromDate || '',
        toDate: options.toDate || todayInputDate(),
        refreshParts: manualParts,
      });
      t(r.message || 'Đã thu thập tự động.', r.cancelled ? 'info' : 'ok');
      await load();
      if (onDone) await onDone(r);
    } catch (e) {
      const message = String(e.message || e);
      setLastClick({ at: new Date(), message });
      t(message, 'error');
    } finally {
      setRunning(false);
    }
  };

  const reconcileEncounters = async () => {
    if (showEncounterReviews) {
      setShowEncounterReviews(false);
      return;
    }
    setReconciling(true);
    try {
      const r = await api.getResearchEncounterReviews(studyId);
      setEncounterReviews(r);
      setReviewSelections(Object.fromEntries((r?.items || []).map(it => [it.source_key, it.candidates?.[0]?.encounter_id || ''])));
      setShowEncounterReviews(true);
    } catch (e) {
      t(String(e.message || e), 'error');
    } finally {
      setReconciling(false);
    }
  };

  const saveEncounterReview = async (item, action) => {
    const encounterId = reviewSelections[item.source_key] || '';
    if (action === 'link' && !encounterId) return t('Ca này không có lượt ứng viên để chọn.', 'error');
    setReviewActing(item.source_key);
    try {
      const r = await api.updateResearchEncounterReview(studyId, {
        source_key: item.source_key,
        action,
        ...(action === 'link' ? { encounter_id: encounterId } : {}),
      });
      setEncounterReviews(r);
      setReviewSelections(p => ({ ...p, ...Object.fromEntries((r?.items || []).filter(x => !p[x.source_key]).map(x => [x.source_key, x.candidates?.[0]?.encounter_id || ''])) }));
      await load();
      if (action === 'link') t('Đã lưu lượt điều trị đúng.', 'ok');
      else if (action === 'unresolved') t('Đã ghi nhận ca chưa đủ thông tin.', 'info');
      else t('Đã mở lại ca để rà soát.', 'ok');
      if (onDone) await onDone();
    } catch (e) {
      t(String(e.message || e), 'error');
    } finally {
      setReviewActing('');
    }
  };

  const savePolicy = async () => {
    try {
      const clean = Object.fromEntries(Object.entries(policy).filter(([, v]) => Number(v) >= 1));
      const r = await api.updateResearchRefreshPolicy(studyId, clean);
      setPolicy(r?.refresh_policy || clean);
      t('Đã lưu chính sách làm mới.', 'ok');
      await load();
    } catch (e) {
      t(String(e.message || e), 'error');
    }
  };

  const loadChanges = async () => {
    try {
      const r = await api.getResearchCollectionChanges(studyId);
      setChanges(Array.isArray(r?.changes) ? r.changes : []);
    } catch (e) {
      t(String(e.message || e), 'error');
    }
  };

  const saveRequirements = async () => {
    try {
      await api.updateResearchStudyDataRequirements(studyId, {
        parts: req.parts,
        items: req.items.filter(it => it.kind && String(it.value || '').trim()),
      });
      t('Đã lưu yêu cầu dữ liệu của đề cương.', 'ok');
      setShowReq(false);
      await load();
    } catch (e) {
      t(String(e.message || e), 'error');
    }
  };

  const report = status?.last_report || null;
  const plan = status?.next_plan || null;
  const exceptions = Array.isArray(status?.exceptions) ? status.exceptions : [];
  const busy = disabled || running;
  const collecting = running || /thu thập/i.test(String(serverRunning?.label || ''));
  const runningLabel = collecting ? 'Đang thu thập' : serverRunning ? `Đang chạy: ${serverRunning.label}` : '';
  const planView = buildPlanView(plan, { running: Boolean(collecting || serverRunning), maxAttempts: status?.max_attempts || 3, busy });
  const reportAt = report?.finished_at ? new Date(report.finished_at).toLocaleString('vi-VN') : '';

  return (
    <section style={{ border: `1px solid ${C.border2}`, borderRadius: 8, background: C.surface, padding: '9px 11px', display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <span style={{ fontSize: FS.md, fontWeight: 700, color: C.text }}>Thu thập tự động</span>
        <span style={{ fontSize: FS.xs, color: C.text3 }}>
          Chỉ lấy ca mới, phần còn thiếu, phần lỗi (tự thử lại tối đa {status?.max_attempts || 3} lần) và ca mà EMR đã thay đổi.
        </span>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 5 }}>
          <Btn onClick={() => setShowRefresh(v => !v)} style={{ height: 26, padding: '0 9px', fontSize: FS.xs }}>{showRefresh ? 'Đóng làm mới' : 'Làm mới…'}</Btn>
          <Btn variant="solidPrimary" onClick={() => run([])} disabled={busy} style={{ height: 30, padding: '0 14px', fontSize: FS.sm }}>
            {runningLabel ? <><Spinner size={9} /> {runningLabel}</> : 'Thu thập tự động'}
          </Btn>
        </div>
      </div>

      {lastClick && (
        <div role="alert" style={{ fontSize: FS.xs, color: C.red, background: C.redBg, border: `1px solid ${C.redBorder}`, borderRadius: 6, padding: '6px 9px', display: 'flex', gap: 8, alignItems: 'center' }}>
          <span style={{ flex: 1 }}>
            <b>Chưa chạy được</b> (lúc {lastClick.at.toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' })}): {lastClick.message}
          </span>
          <button type="button" onClick={() => setLastClick(null)} aria-label="Đóng" style={{ border: 0, background: 'transparent', color: C.red, cursor: 'pointer' }}>✕</button>
        </div>
      )}

      {planView && (
        <div style={{ fontSize: FS.xs, color: C.text2, display: 'grid', gap: 4 }}>
          <div>
            {planView.title}, trong <b>{compactNumber(planView.total)}</b> lượt của danh sách thu thập:{' '}
            {planView.groups.filter(g => g.value || g.key === 'fetch').map((g, i) => (
              <span key={g.key}>{i ? ' · ' : ''}{g.label} <b>{compactNumber(g.value)}</b>{g.extra ? ` (${g.extra})` : ''}</span>
            ))}.
          </div>
          {planView.notes.map(note => (
            <div key={note.key} style={{ borderLeft: `3px solid ${C.amber}`, paddingLeft: 8 }}>
              <b style={{ color: C.text }}>{compactNumber(note.value)} lượt {note.label}:</b> {note.meaning}
              <div style={{ color: C.text }}><b>Cần làm:</b> {note.action}</div>
            </div>
          ))}
        </div>
      )}

      {report ? (
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
          <span style={{ fontSize: FS.xs, color: C.text3 }}>Lần gần nhất{reportAt ? ` (${reportAt})` : ''}{report.cancelled ? ' — đã dừng giữa chừng' : ''}:</span>
          <StatBadge label="ca đã lấy" value={report.fetched_encounters || 0} tone="ok" />
          <StatBadge label="bỏ qua vì không đổi" value={report.skipped_unchanged || 0} tone="neutral" />
          <StatBadge label="phần đã tự lấy bù" value={report.parts_backfilled || 0} tone="ok" />
          <StatBadge label="lỗi Selenium còn tồn" value={report.selenium_errors_open || 0} tone={report.selenium_errors_open ? 'danger' : 'neutral'} />
          <StatBadge label="ca không ghép chắc" value={report.unmatched_encounters || 0} tone={report.unmatched_encounters ? 'warn' : 'neutral'} />
          {!!report.parts_rechecked && <StatBadge label="phần kiểm tra lại" value={report.parts_rechecked} tone="info" />}
          {!!report.parts_rechecked && <StatBadge label="có thay đổi" value={report.parts_changed || 0} tone={report.parts_changed ? 'warn' : 'neutral'} />}
          {!!(report.readiness_changes || []).length && <StatBadge label="đổi mức đủ dùng" value={report.readiness_changes.length} tone="info" />}
        </div>
      ) : (
        <div style={{ fontSize: FS.xs, color: C.text3 }}>
          {collecting || serverRunning ? 'Báo cáo của lần chạy này sẽ hiện ở đây khi xong.' : 'Chưa chạy thu thập tự động lần nào.'}
        </div>
      )}

      {readiness && (
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
          <span style={{ fontSize: FS.xs, color: C.text3 }}>
            Đủ dùng cho đề cương này ({readiness.requirements?.source === 'explicit' ? 'theo yêu cầu đã khai báo' : readiness.requirements?.source === 'variables' ? 'suy ra từ biến đã chọn' : 'mặc định: cần đủ 6 phần'}):
          </span>
          {Object.entries(READINESS_LABEL).map(([k, [label, tone]]) => (
            <StatBadge key={k} label={label} value={readiness.counts?.[k] || 0} tone={readiness.counts?.[k] ? tone : 'neutral'} />
          ))}
          <Btn onClick={() => setShowReq(v => !v)} style={{ height: 24, padding: '0 8px', fontSize: FS.xs }}>{showReq ? 'Đóng' : 'Yêu cầu dữ liệu'}</Btn>
        </div>
      )}

      {showReq && studyId && (
        <div style={{ borderTop: `1px solid ${C.border2}`, paddingTop: 8, display: 'flex', flexDirection: 'column', gap: 6 }}>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center', fontSize: FS.xs, color: C.text2 }}>
            <span style={{ fontWeight: 700 }}>Phần bắt buộc:</span>
            {COLLECTION_PARTS.map(([id, label]) => (
              <label key={id} style={{ display: 'flex', alignItems: 'center', gap: 4, cursor: 'pointer' }}>
                <input type="checkbox" checked={req.parts.includes(id)}
                  onChange={e => setReq(p => ({ ...p, parts: e.target.checked ? [...p.parts, id] : p.parts.filter(x => x !== id) }))} />
                {label}
              </label>
            ))}
          </div>
          {req.items.map((it, i) => (
            <div key={i} style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              <select value={it.kind} onChange={e => setReq(p => { const items = [...p.items]; items[i] = { ...items[i], kind: e.target.value }; return { ...p, items }; })}
                style={{ fontSize: FS.xs, padding: '3px 6px', borderRadius: 5, border: `1px solid ${C.border}`, background: C.surface, color: C.text }}>
                {REQUIREMENT_ITEM_KINDS.map(([k, label]) => <option key={k} value={k}>{label}</option>)}
              </select>
              <input value={it.value || ''} placeholder="VD: CT, MRI, Hb, CRP"
                onChange={e => setReq(p => { const items = [...p.items]; items[i] = { ...items[i], value: e.target.value, label: e.target.value }; return { ...p, items }; })}
                style={{ ...inp, width: 180, fontSize: FS.xs }} />
              <button type="button" onClick={() => setReq(p => ({ ...p, items: p.items.filter((_, j) => j !== i) }))}
                style={{ background: 'none', border: 'none', cursor: 'pointer', color: C.text3, fontSize: FS.lg }}>✕</button>
            </div>
          ))}
          <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
            <Btn onClick={() => setReq(p => ({ ...p, items: [...p.items, { kind: 'imaging_modality', value: '' }] }))} style={{ height: 24, padding: '0 8px', fontSize: FS.xs }}>+ Dữ liệu phải có</Btn>
            <Btn variant="primary" onClick={saveRequirements} style={{ height: 24, padding: '0 10px', fontSize: FS.xs }}>Lưu</Btn>
            <span style={{ fontSize: FS.xs, color: C.text3 }}>Ca đã lấy đủ nhưng EMR không có dữ liệu bắt buộc (ví dụ không có CT) được ghi "không đạt điều kiện đề tài", không phải "thiếu".</span>
          </div>
        </div>
      )}

      {showRefresh && (
        <div style={{ borderTop: `1px solid ${C.border2}`, paddingTop: 8, display: 'flex', flexDirection: 'column', gap: 7 }}>
          <div style={{ fontSize: FS.xs, color: C.text2 }}>
            <b>Chính sách làm mới:</b> kiểm tra lại một phần khi lần kiểm tra gần nhất đã quá số ngày đặt cho phần đó.
            Để trống = không tự kiểm tra lại (chỉ lấy lại khi danh sách EMR đổi hoặc bấm Làm mới).
          </div>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
            {COLLECTION_PARTS.map(([id, label]) => (
              <label key={id} style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: FS.xs, color: C.text2 }}>
                {label}
                <input type="number" min="1" max="3650" value={policy[id] ?? ''} placeholder="—"
                  onChange={e => setPolicy(p => ({ ...p, [id]: e.target.value === '' ? undefined : Number(e.target.value) }))}
                  style={{ ...inp, width: 56, fontSize: FS.xs }} />
                <span style={{ color: C.text3 }}>ngày</span>
              </label>
            ))}
            <Btn onClick={savePolicy} style={{ height: 24, padding: '0 10px', fontSize: FS.xs }}>Lưu chính sách</Btn>
          </div>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center', fontSize: FS.xs, color: C.text2 }}>
            <b>Làm mới ngay:</b>
            {COLLECTION_PARTS.map(([id, label]) => (
              <label key={id} style={{ display: 'flex', alignItems: 'center', gap: 4, cursor: 'pointer' }}>
                <input type="checkbox" checked={refreshParts.includes(id)}
                  onChange={e => setRefreshParts(p => e.target.checked ? [...p, id] : p.filter(x => x !== id))} />
                {label}
              </label>
            ))}
            <Btn variant="solidWarn" onClick={() => run(refreshParts)} disabled={busy || !refreshParts.length} style={{ height: 24, padding: '0 10px', fontSize: FS.xs }}>
              Làm mới phần đã chọn
            </Btn>
            <span style={{ fontSize: FS.xs, color: C.text3 }}>Lấy lại các phần này cho mọi lượt, so với bản trước: không đổi thì giữ nguyên, đổi thì lưu phiên bản mới.</span>
          </div>
          <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <Btn onClick={loadChanges} style={{ height: 24, padding: '0 9px', fontSize: FS.xs }}>Xem lịch sử thay đổi</Btn>
            {changes && !changes.length && <span style={{ fontSize: FS.xs, color: C.text3 }}>Chưa ghi nhận thay đổi nào.</span>}
          </div>
          {!!changes?.length && (
            <SmallRowsTable max={100} rows={changes.map(c => ({ ...c, at: c.changed_at ? new Date(c.changed_at).toLocaleString('vi-VN') : '', version: `v${c.from_version} → v${c.to_version}`, diff: `+${c.rows_added} / −${c.rows_removed}` }))} columns={[
              { key: 'at', label: 'Thời điểm' },
              { key: 'research_code', label: 'Mã NC' },
              { key: 'part_label', label: 'Phần' },
              { key: 'version', label: 'Phiên bản' },
              { key: 'diff', label: 'Dòng thêm/bớt' },
            ]} />
          )}
        </div>
      )}

      {status && (
        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <Btn onClick={() => setShowExceptions(v => !v)} disabled={!exceptions.length} style={{ height: 24, padding: '0 9px', fontSize: FS.xs }}>
            {showExceptions ? 'Ẩn danh sách cần xử lý' : `Danh sách cần xử lý (${compactNumber(status.exceptions_total || 0)} mục)`}
          </Btn>
          {!!exceptions.length && (
            <Btn onClick={() => api.downloadResearchCollectionExceptions(studyId).catch(e => t(String(e.message || e), 'error'))} style={{ height: 24, padding: '0 9px', fontSize: FS.xs }}>Tải CSV</Btn>
          )}
          {!!plan?.unmatched_encounters && (
            <Btn onClick={reconcileEncounters} disabled={busy || reconciling}
              title={busy ? 'Làm được khi lượt thu thập đang chạy xong.' : undefined}
              style={{ height: 24, padding: '0 9px', fontSize: FS.xs }}>
              {reconciling ? <><Spinner size={8} /> Đang tải</> : (showEncounterReviews ? 'Đóng rà soát' : busy ? 'Rà soát ghép lượt (sau khi thu thập xong)' : 'Rà soát ghép lượt')}
            </Btn>
          )}
          {!exceptions.length && <span style={{ fontSize: FS.xs, color: C.text3 }}>Không có ngoại lệ — không cần rà từng ca.</span>}
        </div>
      )}

      {showExceptions && !!exceptions.length && (
        <SmallRowsTable max={200} rows={exceptions.map(e => ({
          ...e,
          category_label: COLLECTION_CATEGORY_LABEL[e.category] || e.category,
          attempts_label: e.status === 'failed' ? `${e.attempts}/${status.max_attempts || 3}` : '—',
        }))} columns={[
          { key: 'category_label', label: 'Loại' },
          { key: 'research_code', label: 'Mã NC' },
          { key: 'patient_code', label: 'Mã BN' },
          { key: 'part_label', label: 'Phần' },
          { key: 'reason_label', label: 'Lý do' },
          { key: 'detail', label: 'Chi tiết' },
          { key: 'attempts_label', label: 'Lần thử' },
        ]} />
      )}

      {showEncounterReviews && encounterReviews && (
        <div style={{ borderTop: `1px solid ${C.border2}`, paddingTop: 8, display: 'flex', flexDirection: 'column', gap: 7 }}>
          <div style={{ fontSize: FS.xs, color: C.text2 }}>
            <b>{compactNumber(encounterReviews.pending || 0)}</b> ca chờ chọn; <b>{compactNumber(encounterReviews.confirmed_unresolved || 0)}</b> ca đã xác nhận chưa đủ thông tin.
            {!!encounterReviews.manual_linked && <> <b>{compactNumber(encounterReviews.manual_linked)}</b> ca đã ghép thủ công.</>}
            Chỉ các lượt cùng Mã BN mới được hiển thị. Sau khi lưu, quyết định được dùng lại khi chuẩn hóa.
          </div>
          {(encounterReviews.items || []).map(item => {
            const acting = reviewActing === item.source_key;
            const confirmed = item.review_status === 'confirmed_unresolved';
            return (
              <div key={item.source_key} style={{ border: `1px solid ${confirmed ? C.border2 : C.amberBorder}`, borderRadius: 7, padding: '8px 9px', background: confirmed ? C.surface2 : C.amberBg }}>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', fontSize: FS.xs, color: C.text2 }}>
                  <b style={{ color: C.text }}>{item.research_code || 'Chưa có Mã NC'}</b>
                  <span>Mã BN: <b>{item.patient_code}</b></span>
                  {item.patient_name && <span>{item.patient_name}</span>}
                  <span>Nguồn vào: <b>{item.admission_date || '—'}</b></span>
                  {item.source_noitru_id && <span>Mã nội trú nguồn: <b>{item.source_noitru_id}</b></span>}
                  <span style={{ color: C.amber }}>{item.reason_label}</span>
                </div>
                {confirmed ? (
                  <div style={{ marginTop: 6, display: 'flex', gap: 7, alignItems: 'center' }}>
                    <span style={{ fontSize: FS.xs, color: C.text3 }}>Đã xác nhận chưa đủ bằng chứng để ghép.</span>
                    <Btn onClick={() => saveEncounterReview(item, 'clear')} disabled={acting} style={{ height: 23, padding: '0 8px', fontSize: FS.xs }}>Xem lại</Btn>
                  </div>
                ) : (
                  <div style={{ marginTop: 6, display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
                    <select value={reviewSelections[item.source_key] || ''}
                      onChange={e => setReviewSelections(p => ({ ...p, [item.source_key]: e.target.value }))}
                      style={{ ...inp, minWidth: 360, maxWidth: '100%', fontSize: FS.xs }}>
                      {!item.candidates?.length && <option value="">Không có lượt ứng viên</option>}
                      {(item.candidates || []).map(c => (
                        <option key={c.encounter_id} value={c.encounter_id}>
                          {`${c.admission_date || '—'} → ${c.discharge_date || 'chưa ra viện'} · NT ${c.emr_noitru_id || '—'} · ${c.research_code || 'chưa Mã NC'}`}
                        </option>
                      ))}
                    </select>
                    <Btn variant="primary" onClick={() => saveEncounterReview(item, 'link')} disabled={acting || !item.candidates?.length} style={{ height: 26, padding: '0 10px', fontSize: FS.xs }}>
                      {acting ? <Spinner size={8} /> : 'Chọn lượt này'}
                    </Btn>
                    <Btn onClick={() => saveEncounterReview(item, 'unresolved')} disabled={acting} style={{ height: 26, padding: '0 9px', fontSize: FS.xs }}>Chưa đủ thông tin</Btn>
                  </div>
                )}
              </div>
            );
          })}
          {!encounterReviews.items?.length && <div style={{ fontSize: FS.xs, color: C.green }}>Không còn lượt nào cần rà soát.</div>}
          {!!encounterReviews.linked_items?.length && (
            <details style={{ borderTop: `1px solid ${C.border2}`, paddingTop: 6 }}>
              <summary style={{ cursor: 'pointer', fontSize: FS.xs, fontWeight: 700, color: C.text2 }}>
                Đã ghép thủ công ({compactNumber(encounterReviews.manual_linked)}) — mở để xem hoặc hoàn tác
              </summary>
              <div style={{ marginTop: 6, display: 'flex', flexDirection: 'column', gap: 5 }}>
                {encounterReviews.linked_items.map(item => (
                  <div key={item.source_key} style={{ display: 'flex', gap: 7, flexWrap: 'wrap', alignItems: 'center', border: `1px solid ${C.border2}`, borderRadius: 6, padding: '6px 8px', fontSize: FS.xs, color: C.text2 }}>
                    <b>{item.research_code || 'Chưa Mã NC'}</b><span>Mã BN: {item.patient_code}</span>
                    {item.patient_name && <span>{item.patient_name}</span>}
                    <span>→ {item.admission_date || '—'} đến {item.discharge_date || 'chưa ra viện'}</span>
                    <span>NT: {item.emr_noitru_id || '—'}</span>
                    <Btn onClick={() => saveEncounterReview(item, 'clear')} disabled={reviewActing === item.source_key} style={{ height: 23, padding: '0 8px', fontSize: FS.xs }}>Hoàn tác</Btn>
                  </div>
                ))}
              </div>
            </details>
          )}
        </div>
      )}
    </section>
  );
}

export {
  COLLECTION_PARTS,
  COLLECTION_CATEGORY_LABEL,
  REQUIREMENT_ITEM_KINDS,
  READINESS_LABEL,
  CollectionAutoPanel,
};
