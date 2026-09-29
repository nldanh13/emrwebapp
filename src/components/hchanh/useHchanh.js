// src/components/hchanh/useHchanh.js
// Hook quản lý toàn bộ state cho tab Hành chánh mới.
// Đọc từ /api/hchanh/* — hoàn toàn độc lập với useAdminNurseDashboard.

import { useState, useCallback, useEffect, useRef } from 'react';
import * as api from '../../features/hchanh/api.js';
import { DISCHARGE_FULL_FILES, SCOPE_FILES, SCOPE_LABEL, getHchanhPatientKey } from '../../features/hchanh/model.js';
import { buildHchanhVtytBatchDraft } from '../../engine/hchanhVtytPlanner.js';
import { collectionRows, eligibleInputJobs } from '../../engine/hchanhVtytWorkspace.js';
import { matchesManualReviewFilter } from '../../engine/hchanhManualReviewView.js';
import { mergeVtytDraftEdits } from '../../engine/hchanhVtytDraftMerge.js';
import { buildVtytReviewWindows } from '../../engine/hchanhVtytScope.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

function safeArray(v) { return Array.isArray(v) ? v : []; }

const getMaBn = getHchanhPatientKey;

function inputDateToDmy(value) {
  const m = String(value || '').trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return '';
  return `${m[3]}/${m[2]}/${m[1]}`;
}

function addDaysInputDate(value, days) {
  const m = String(value || '').trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return '';
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  d.setDate(d.getDate() + days);
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function workDateRangeDatesToDmy(workDateRange) {
  const from = String(workDateRange?.from || '').trim();
  const to = String(workDateRange?.to || from).trim();
  const inputDateRe = /^\d{4}-\d{2}-\d{2}$/;
  if (!inputDateRe.test(from)) return [];
  const end = inputDateRe.test(to) && to >= from ? to : from;
  const out = [];
  let cur = from;
  for (let guard = 0; guard < 45 && cur && cur <= end; guard += 1) {
    const dmy = inputDateToDmy(cur);
    if (dmy) out.push(dmy);
    cur = addDaysInputDate(cur, 1);
  }
  return out;
}

function hchanhVtytDatesToDmy(workDateRange) {
  const from = String(workDateRange?.from || '').trim();
  const to = String(workDateRange?.to || from).trim();
  const inputDateRe = /^\d{4}-\d{2}-\d{2}$/;
  if (!inputDateRe.test(from)) return [];
  const cleanTo = inputDateRe.test(to) && to >= from ? to : from;
  const rangeDates = workDateRangeDatesToDmy({ from, to: cleanTo });
  // Hành chánh thường kiểm VTYT ngày sau mốc dữ liệu.
  // Nếu người dùng đã mở khoảng nhiều ngày, lấy ngày cuối khoảng làm ngày VTYT cần kiểm.
  if (rangeDates.length > 1) return [rangeDates[rangeDates.length - 1]];
  const nextInput = addDaysInputDate(cleanTo, 1);
  const nextDmy = inputDateToDmy(nextInput);
  return nextDmy ? [nextDmy] : rangeDates;
}

function previewKeyFor(card, dates = []) {
  return `${getMaBn(card)}::${dates.join(',')}`;
}

export { SCOPE_LABEL, SCOPE_FILES, DISCHARGE_FULL_FILES, getMaBn };

// ── Hook ──────────────────────────────────────────────────────────────────────

export function useHchanh({ toast, workDateRange, manualReviewFilterEnabled = true } = {}) {
  const [dashboard, setDashboard]         = useState(null);
  const [loading, setLoading]             = useState(false);
  const [fetchingKey, setFetchingKey]     = useState('');   // ma_bn đang fetch
  const fetchingFile = '';                                  // giữ để tương thích các điều kiện "đang bận" khác; không còn nơi set giá trị
  const [inputVtytKey, setInputVtytKey]   = useState('');   // ma_bn đang nhập VTYT
  const [previewVtytKey, setPreviewVtytKey] = useState(''); // ma_bn đang quét thuốc/VTYT
  const [bedEditKey, setBedEditKey]     = useState('');   // ma_bn đang mở popup sửa giường
  const [printBillingKey, setPrintBillingKey] = useState(''); // ma_bn đang in/lưu bảng kê
  const [ticketKey, setTicketKey]       = useState('');   // ma_bn đang tạo/cập nhật phiếu sửa
  const [manualReviewKey, setManualReviewKey] = useState('');
  const [vtytPreviewByPatient, setVtytPreviewByPatient] = useState({});
  const [vtytBatchDraft, setVtytBatchDraft] = useState(null);
  const [vtytBatchLoading, setVtytBatchLoading] = useState(false);
  const [vtytBatchInputting, setVtytBatchInputting] = useState(false);
  const vtytDraftLoadedRef = useRef(false);
  const [selectedCard, setSelectedCard]   = useState(null);
  const [search, setSearch]               = useState('');
  const [filterScope, setFilterScope]     = useState('all');
  const [filterStatus, setFilterStatus]   = useState('all');
  const [filterManualReview, setFilterManualReview] = useState('all');
  const [snapshotState, setSnapshotState] = useState(null);
  const abortRef = useRef(false);

  // ── Load dashboard ─────────────────────────────────────────────────────────

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api.getHchanh_Dashboard();
      setDashboard(data);
      // Cập nhật selectedCard nếu đang chọn
      if (selectedCard) {
        const ma_bn = getMaBn(selectedCard);
        const updated = safeArray(data?.patients).find(p => getMaBn(p) === ma_bn);
        if (updated) setSelectedCard(updated);
      }
    } catch (e) {
      toast?.(String(e.message || e), 'error');
    } finally {
      setLoading(false);
    }
  }, [selectedCard, toast]);

  // Load dashboard + sync khi mount.
  // Hành chánh có kho dữ liệu riêng, nên mỗi lần mở tab phải đồng bộ lại index
  // từ danh sách BN đã quét trong session. Nếu chỉ sync khi dashboard rỗng,
  // tab Hành chánh dễ giữ danh sách cũ sau lần quét mới.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        await api.syncHchanh();
        const fresh = await api.getHchanh_Dashboard();
        if (!cancelled) setDashboard(fresh);
      } catch (e) {
        if (!cancelled) toast?.(String(e.message || e), 'error');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Khôi phục bản nháp VTYT đã lưu trong runtime của session.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const result = await api.getHchanh_VtytDraft();
        if (!cancelled && result?.draft) setVtytBatchDraft(result.draft);
      } catch (e) {
        if (!cancelled) toast?.(`Không tải được bản nháp VTYT: ${String(e.message || e)}`, 'error');
      } finally {
        if (!cancelled) vtytDraftLoadedRef.current = true;
      }
    })();
    return () => { cancelled = true; };
  }, [toast]);

  // Lưu ngay sau mỗi thay đổi. Backend dùng updated_at để chặn request cũ
  // hoàn tất muộn ghi đè lên bản nháp mới hơn.
  useEffect(() => {
    if (!vtytDraftLoadedRef.current || !vtytBatchDraft) return undefined;
    let cancelled = false;
    (async () => {
      try {
        await api.saveHchanh_VtytDraft(vtytBatchDraft);
      } catch (e) {
        if (!cancelled) toast?.(`Không lưu được bản nháp VTYT: ${String(e.message || e)}`, 'error');
      }
    })();
    return () => { cancelled = true; };
  }, [toast, vtytBatchDraft]);

  // ── Fetch dữ liệu 1 BN theo scope ─────────────────────────────────────────

  const fetchPatient = useCallback(async (card, { files, scope: scopeOverride } = {}) => {
    const ma_bn = getMaBn(card);
    if (!ma_bn) return;
    const scope = scopeOverride || card?.scope || card?.scope_default || 'daily';

    setFetchingKey(ma_bn);
    try {
      // Lấy khoảng ngày từ workDateRange hoặc từ profile BN
      const dateFrom = workDateRange?.from || '';
      const dateTo   = workDateRange?.to   || dateFrom;

      const result = await api.fetchHchanh(ma_bn, scope, files || null, dateFrom, dateTo);

      const savedCount = safeArray(result?.saved).length;
      const missing    = safeArray(result?.missing);
      if (missing.length) {
        toast?.(
          `Đã lấy ${savedCount} file cho ${ma_bn}.${missing.length ? ` Chưa lấy được: ${missing.join(', ')}` : ''}`,
          savedCount > 0 ? 'ok' : 'error'
        );
      } else {
        toast?.(`Đã lấy đủ dữ liệu ${SCOPE_LABEL[scope] || scope} cho ${card?.ho_ten || ma_bn}.`, 'ok');
      }
      await load();
    } catch (e) {
      toast?.(`Không lấy được dữ liệu: ${String(e.message || e)}`, 'error');
    } finally {
      setFetchingKey('');
    }
  }, [load, toast, workDateRange]);

  // Lấy một mạch toàn bộ dữ liệu cần kiểm ra viện cho 1 người bệnh.
  const fetchDischargeFull = useCallback(async (card) => {
    const ma_bn = getMaBn(card);
    if (!ma_bn) return;
    await fetchPatient({ ...card, scope: 'discharge', scope_default: 'discharge' }, {
      scope: 'discharge',
      files: DISCHARGE_FULL_FILES,
    });
  }, [fetchPatient]);

  function buildHchanhVtytTargets(card, previewJobs = null) {
    const ma_bn = getMaBn(card);
    const dates = hchanhVtytDatesToDmy(workDateRange);
    return {
      patientIds: ma_bn ? [ma_bn] : [],
      patientDates: ma_bn ? { [ma_bn]: dates } : {},
      selectedDates: dates,
      ngay_lam: dates[0] || '',
      taskType: 'vtyt',
      taskName: 'input_vtyt',
      source: 'hchanh',
      hchanhDirectVtyt: true,
      allowMissingProcessed: true,
      forceFullVtyt: true,
      ho_ten: card?.ho_ten || '',
      phong: card?.phong || '',
      ...(previewJobs ? { vtytPreviewJobs: previewJobs } : {}),
    };
  }

  const previewBatchVTYT = useCallback(async (cards = []) => {
    const selectedCards = safeArray(cards).filter(card => getMaBn(card));
    if (!selectedCards.length) {
      toast?.('Chưa chọn người bệnh để quét VTYT.', 'error');
      return;
    }
    if (fetchingKey || fetchingFile || inputVtytKey || previewVtytKey || vtytBatchLoading || vtytBatchInputting) {
      toast?.('Đang có tác vụ chạy, vui lòng chờ xong rồi quét VTYT.', 'error');
      return;
    }
    const windows = buildVtytReviewWindows(selectedCards, workDateRange);
    const invalid = windows.filter(row => row.error || !row.dates.length);
    const valid = windows.filter(row => !row.error && row.dates.length);
    const patientDates = Object.fromEntries(valid.map(row => [row.ma_bn, row.dates]));
    const patientIds = valid.map(row => row.ma_bn);
    const vtytBatchRanges = Object.fromEntries(patientIds.map(id => {
      const dates = safeArray(patientDates[id]);
      return [id, { from: dates[0] || '', to: dates[dates.length - 1] || '' }];
    }));
    if (!patientIds.length) {
      toast?.('Không xác định được phạm vi VTYT. Người bệnh ra viện phải có đủ ngày vào và ngày ra viện.', 'error');
      return;
    }
    const dischargeCount = valid.filter(row => row.mode === 'full_episode').length;
    const continuingCount = valid.filter(row => row.mode === 'next_day').length;
    const totalDays = valid.reduce((sum, row) => sum + row.dates.length, 0);
    const skippedText = invalid.length ? `\nBỏ qua ${invalid.length} người bệnh thiếu ngày vào/ra viện.` : '';
    const ok = typeof window === 'undefined' ? true : window.confirm(
      `Lập danh sách VTYT cho ${patientIds.length} người bệnh?\n\n` +
      `• ${dischargeCount} người bệnh ra viện: kiểm toàn bộ từ ngày vào đến ngày ra viện.\n` +
      `• ${continuingCount} người bệnh tiếp tục điều trị: chỉ xem y lệnh ngày hôm sau.\n` +
      `Tổng phạm vi: ${totalDays} BN/ngày.${skippedText}\n\nBước này chỉ lập kế hoạch và chưa nhập EMR.`
    );
    if (!ok) return;

    setVtytBatchLoading(true);
    try {
      const result = await api.previewInputVTYT({
        patientIds,
        patientDates,
        vtytBatchRanges,
        selectedDates: [],
        taskType: 'vtyt',
        taskName: 'input_vtyt',
        source: 'hchanh',
        hchanhDirectVtyt: true,
        allowMissingProcessed: true,
        forceFullVtyt: true,
      });
      const scannedCards = valid.map(row => row.card);
      const draft = mergeVtytDraftEdits(vtytBatchDraft, buildHchanhVtytBatchDraft({ previewResult: result, cards: scannedCards }));
      setVtytBatchDraft(draft);
      const supplyCount = safeArray(draft.jobs).reduce((sum, job) => sum + safeArray(job.supplies).filter(item => Number(item.input_quantity || 0) > 0).length, 0);
      toast?.(`Đã lập kế hoạch ${draft.jobs.length} BN/ngày, có ${supplyCount} dòng VTYT dự kiến nhập.`, result?.status === 'partial' ? 'info' : 'ok');
    } catch (e) {
      toast?.(`Không quét được VTYT hàng loạt: ${String(e.message || e)}`, 'error');
    } finally {
      setVtytBatchLoading(false);
    }
  }, [fetchingKey, fetchingFile, inputVtytKey, previewVtytKey, toast, workDateRange, vtytBatchDraft, vtytBatchInputting, vtytBatchLoading]);

  const clearBatchVTYTDraft = useCallback(async () => {
    const ok = typeof window === 'undefined' ? true : window.confirm('Xóa toàn bộ bản nháp VTYT đang lưu?');
    if (!ok) return;
    try {
      await api.clearHchanh_VtytDraft();
      setVtytBatchDraft(null);
      toast?.('Đã xóa bản nháp VTYT.', 'ok');
    } catch (e) {
      toast?.(`Không xóa được bản nháp VTYT: ${String(e.message || e)}`, 'error');
    }
  }, [toast]);

  const inputBatchVTYT = useCallback(async () => {
    const draft = vtytBatchDraft;
    const patients = safeArray(draft?.patients);
    const jobs = safeArray(draft?.jobs);
    const notReviewed = patients.filter(patient => !patient.reviewed);
    if (!draft || !jobs.length) {
      toast?.('Chưa có kế hoạch VTYT hàng loạt.', 'error');
      return;
    }
    if (notReviewed.length) {
      toast?.(`Còn ${notReviewed.length} người bệnh chưa xác nhận đã kiểm kế hoạch.`, 'error');
      return;
    }
    if (!draft.precheck_token) {
      toast?.('Xác nhận quét VTYT đã hết hiệu lực. Hãy quét lại trước khi nhập.', 'error');
      return;
    }
    const blockedStock = collectionRows(draft).filter(row => row.blocked);
    if (blockedStock.length) {
      toast?.(`Không thể nhập: ${blockedStock.map(row => row.name).join(', ')} hết hoặc chưa xác định tồn.`, 'error');
      return;
    }
    const eligibleJobs = eligibleInputJobs(draft);
    const previewJobs = eligibleJobs.map(job => ({
      ...job,
      manual_vtyt_plan: true,
      hchanh_direct_vtyt: true,
      supplies: safeArray(job.supplies).map(item => ({
          ...item,
          required_quantity: Number(item.input_quantity || 0),
          desired_total_quantity: Number(item.existing_quantity || 0) + Number(item.input_quantity || 0),
          preview_existing_quantity: Number(item.existing_quantity || 0),
          input_allowed: true,
          needs_review: false,
        })),
    }));
    if (!previewJobs.length) {
      toast?.('Không có vật tư nào được chọn với số lượng cần nhập lớn hơn 0.', 'error');
      return;
    }
    const patientIds = safeArray(draft.selected_patient_ids).length
      ? safeArray(draft.selected_patient_ids)
      : [...new Set(previewJobs.map(job => String(job.ma_bn || '').trim()).filter(Boolean))];
    const patientDates = draft.patient_dates && typeof draft.patient_dates === 'object'
      ? draft.patient_dates
      : {};
    const ok = typeof window === 'undefined' ? true : window.confirm(
      `Nhập hàng loạt VTYT cho ${patientIds.length} người bệnh, ${previewJobs.length} BN/ngày?\n\n` +
      'Hệ thống chỉ nhập số lượng còn thiếu mà bạn đã kiểm và chỉnh.'
    );
    if (!ok) return;

    setVtytBatchInputting(true);
    try {
      const result = await api.runInputVTYT({
        patientIds,
        patientDates,
        selectedDates: [],
        taskType: 'vtyt',
        taskName: 'input_vtyt',
        source: 'hchanh',
        hchanhDirectVtyt: true,
        allowMissingProcessed: true,
        forceFullVtyt: true,
        precheck_token: draft.precheck_token,
        vtytPreviewJobs: previewJobs,
      });
      const okStatus = ['ok', 'partial', 'skipped'].includes(result?.status);
      setVtytBatchDraft(previous => {
        if (!previous) return previous;
        const submitted = new Set(previewJobs.flatMap(job => safeArray(job.supplies).map(item => `${job.ma_bn}::${job.ngay_lam}::${item.code}`)));
        const markEntered = result?.status === 'ok' || result?.status === 'skipped';
        return {
          ...previous,
          jobs: safeArray(previous.jobs).map(job => ({
            ...job,
            supplies: safeArray(job.supplies).map(item => submitted.has(`${job.ma_bn}::${job.ngay_lam}::${item.code}`)
              ? { ...item, usage_status: markEntered ? 'entered' : 'error', input_status: markEntered ? 'entered' : 'error', entered_at: markEntered ? new Date().toISOString() : '' }
              : item),
          })),
          input_result: result,
          updated_at: new Date().toISOString(),
        };
      });
      toast?.(result?.message || 'Đã chạy nhập VTYT hàng loạt.', okStatus ? (result.status === 'ok' ? 'ok' : 'info') : 'error');
      await load();
    } catch (e) {
      toast?.(`Không nhập được VTYT hàng loạt: ${String(e.message || e)}`, 'error');
    } finally {
      setVtytBatchInputting(false);
    }
  }, [load, toast, vtytBatchDraft]);

  const previewVTYT = useCallback(async (card) => {
    const ma_bn = getMaBn(card);
    if (!ma_bn) {
      toast?.('Không xác định được mã BN để quét thuốc/VTYT.', 'error');
      return;
    }
    if (fetchingKey || fetchingFile || inputVtytKey || previewVtytKey) {
      toast?.('Đang có tác vụ chạy, vui lòng chờ xong rồi quét VTYT.', 'error');
      return;
    }
    const targets = buildHchanhVtytTargets(card);
    const dates = targets.selectedDates || [];
    if (!dates.length) {
      toast?.('Chưa xác định được ngày cần quét VTYT.', 'error');
      return;
    }
    const ok = typeof window === 'undefined' ? true : window.confirm(
      `Quét y lệnh ngày mai cho ${card?.ho_ten || ma_bn}?\n\n` +
      `Ngày sẽ quét: ${dates.join(', ')}.\n` +
      `Bước này chỉ lấy y lệnh/thuốc từ EMR, chưa nhập vật tư.`
    );
    if (!ok) return;
    setPreviewVtytKey(ma_bn);
    try {
      const result = await api.previewInputVTYT(targets);
      const plan = safeArray(result?.plan);
      const key = previewKeyFor(card, dates);
      const preview = { ...result, dates, key, createdAt: new Date().toISOString(), processed: false, processedAt: '', plan };
      setVtytPreviewByPatient(prev => ({ ...prev, [ma_bn]: preview }));
      const drugCount = plan.reduce((n, job) => n + safeArray(job?.drugs).length, 0);
      toast?.(result?.message || `Đã quét ${drugCount} thuốc/y lệnh. Bấm "Xử lý VTYT" để xem vật tư sẽ nhập.`, result?.status === 'ok' ? 'ok' : 'info');
    } catch (e) {
      toast?.(`Không quét được y lệnh ngày mai: ${String(e.message || e)}`, 'error');
    } finally {
      setPreviewVtytKey('');
    }
  }, [fetchingKey, fetchingFile, inputVtytKey, previewVtytKey, toast, workDateRange]);

  // ── Xử lý dữ liệu VTYT đã quét trong tab Hành chánh ───────────────────────
  const processVTYTPreview = useCallback((card) => {
    const ma_bn = getMaBn(card);
    if (!ma_bn) {
      toast?.('Không xác định được mã BN để xử lý VTYT.', 'error');
      return;
    }
    const dates = hchanhVtytDatesToDmy(workDateRange);
    const cachedPreview = vtytPreviewByPatient[ma_bn];
    if (!cachedPreview || previewKeyFor(card, dates) !== cachedPreview.key) {
      toast?.('Chưa có dữ liệu y lệnh ngày mai. Hãy bấm "Quét y lệnh mai" trước.', 'error');
      return;
    }
    const plan = safeArray(cachedPreview.plan);
    const drugCount = plan.reduce((n, job) => n + safeArray(job?.drugs).length, 0);
    const supplyCount = plan.reduce((n, job) => n + safeArray(job?.supplies).length, 0);
    const warningCount = plan.reduce((n, job) => n + safeArray(job?.warnings).length, 0);
    setVtytPreviewByPatient(prev => ({
      ...prev,
      [ma_bn]: {
        ...cachedPreview,
        processed: true,
        processedAt: new Date().toISOString(),
        processSummary: { drugCount, supplyCount, warningCount },
      },
    }));
    toast?.(`Đã xử lý ${drugCount} thuốc/y lệnh → ${supplyCount} VTYT${warningCount ? `, ${warningCount} cảnh báo pha/truyền` : ''}.`, 'ok');
  }, [toast, workDateRange, vtytPreviewByPatient]);

  // ── Nhập VTYT thật vào EMR ────────────────────────────────────────────────
  const inputVTYT = useCallback(async (card) => {
    const ma_bn = getMaBn(card);
    if (!ma_bn) {
      toast?.('Không xác định được mã BN để nhập VTYT.', 'error');
      return;
    }
    if (fetchingKey || fetchingFile || inputVtytKey || previewVtytKey) {
      toast?.('Đang có tác vụ chạy, vui lòng chờ xong rồi nhập VTYT.', 'error');
      return;
    }

    const dates = hchanhVtytDatesToDmy(workDateRange);
    if (!dates.length) {
      toast?.('Chưa xác định được THỜI GIAN DỮ LIỆU để nhập VTYT.', 'error');
      return;
    }

    const cachedPreview = vtytPreviewByPatient[ma_bn];
    const previewJobs = cachedPreview && previewKeyFor(card, dates) === cachedPreview.key
      ? safeArray(cachedPreview.plan)
      : null;
    if (!cachedPreview || !cachedPreview.processed || !previewJobs?.length) {
      toast?.('Chưa có kế hoạch VTYT đã xử lý. Hãy bấm "Quét y lệnh mai" rồi "Xử lý VTYT" trước khi nhập.', 'error');
      return;
    }

    const ok = typeof window === 'undefined' ? true : window.confirm(
      `Nhập thuốc/VTYT sử dụng vào EMR cho ${card?.ho_ten || ma_bn}?\n\n` +
      `Ngày VTYT cần nhập: ${dates.join(', ')}.\n` +
      `Hệ thống sẽ dùng đúng kế hoạch VTYT đã xử lý trong tab Kiểm HSBA.`
    );
    if (!ok) {
      toast?.('Đã hủy nhập VTYT.', 'info');
      return;
    }

    if (!cachedPreview?.precheck_token) {
      toast?.('Xác nhận xem trước VTYT không còn hợp lệ. Hãy quét lại y lệnh trước khi nhập.', 'error');
      return;
    }
    const targets = {
      ...buildHchanhVtytTargets(card, previewJobs),
      precheck_token: cachedPreview.precheck_token,
    };

    setInputVtytKey(ma_bn);
    try {
      // Token một lần được cấp sau bước xem trước thành công và gắn đúng BN/ngày.
      const result = await api.runInputVTYT(targets);
      const okStatus = ['ok', 'partial', 'skipped'].includes(result?.status);
      toast?.(result?.message || 'Đã xử lý nhập VTYT.', okStatus ? (result.status === 'ok' ? 'ok' : 'info') : 'error');
      await load();
    } catch (e) {
      toast?.(`Không nhập được VTYT: ${String(e.message || e)}`, 'error');
    } finally {
      setInputVtytKey('');
    }
  }, [fetchingKey, fetchingFile, inputVtytKey, previewVtytKey, load, toast, workDateRange, vtytPreviewByPatient]);


  // ── Mở popup Sửa giường trong EMR ─────────────────────────────────────────
  const openBedEdit = useCallback(async (card) => {
    const ma_bn = getMaBn(card);
    if (!ma_bn) {
      toast?.('Không xác định được mã BN để sửa giường.', 'error');
      return;
    }
    if (bedEditKey || fetchingKey || fetchingFile || inputVtytKey || previewVtytKey) {
      toast?.('Đang có tác vụ chạy, vui lòng chờ xong rồi mở sửa giường.', 'error');
      return;
    }
    const dateTo = workDateRange?.to || workDateRange?.from || '';
    const ok = typeof window === 'undefined' ? true : window.confirm(
      `Mở Chrome để sửa buồng/giường cho ${card?.ho_ten || ma_bn}?\n\n` +
      `Hệ thống sẽ vào con mắt điều dưỡng → Chăm sóc → Buồng giường → Sửa thông tin.\n` +
      `Sau khi Chrome mở popup, bạn sửa trực tiếp trong EMR.`
    );
    if (!ok) return;
    setBedEditKey(ma_bn);
    try {
      const result = await api.openHchanh_BedEdit(ma_bn, dateTo);
      toast?.(result?.message || 'Đã mở Chrome sửa giường.', 'ok');
    } catch (e) {
      toast?.(`Không mở được sửa giường: ${String(e.message || e)}`, 'error');
    } finally {
      setBedEditKey('');
    }
  }, [bedEditKey, fetchingKey, fetchingFile, inputVtytKey, previewVtytKey, toast, workDateRange]);


  // ── In/lưu bảng kê chi phí nội trú ────────────────────────────────────────
  const printBilling = useCallback(async (card) => {
    const ma_bn = getMaBn(card);
    if (!ma_bn) {
      toast?.('Không xác định được mã BN để in bảng kê.', 'error');
      return;
    }
    if (printBillingKey || bedEditKey || fetchingKey || fetchingFile || inputVtytKey || previewVtytKey) {
      toast?.('Đang có tác vụ chạy, vui lòng chờ xong rồi in bảng kê.', 'error');
      return;
    }
    const dateTo = workDateRange?.to || workDateRange?.from || '';
    const ok = typeof window === 'undefined' ? true : window.confirm(
      `In/lưu Bảng kê chi phí nội trú cho ${card?.ho_ten || ma_bn}?\n\n` +
      `File sẽ được lưu theo tên: ${ma_bn}_${card?.ho_ten || 'BN'}_bảng kê.pdf.`
    );
    if (!ok) return;
    setPrintBillingKey(ma_bn);
    try {
      const result = await api.printHchanh_BillingPdf(ma_bn, card?.ho_ten || '', dateTo);
      if (result?.file_name) {
        try {
          const blob = await api.downloadHchanh_BillingPdf(result.file_name);
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url;
          a.download = result.file_name;
          a.click();
          URL.revokeObjectURL(url);
        } catch (downloadErr) {
          // File vẫn đã được lưu ở runtime, nên chỉ báo cảnh báo tải về.
          toast?.(`Đã lưu trên hệ thống nhưng chưa tải được về máy: ${String(downloadErr.message || downloadErr)}`, 'info');
        }
      }
      toast?.(result?.message || 'Đã lưu bảng kê PDF.', 'ok');
    } catch (e) {
      toast?.(`Không in/lưu được bảng kê: ${String(e.message || e)}`, 'error');
    } finally {
      setPrintBillingKey('');
    }
  }, [bedEditKey, fetchingKey, fetchingFile, inputVtytKey, previewVtytKey, printBillingKey, toast, workDateRange]);

  // ── Tạo phiếu sửa ─────────────────────────────────────────────────────────

  const createTicket = useCallback(async (card, payload = {}) => {
    const ma_bn = getMaBn(card);
    if (!ma_bn) return;
    if (ticketKey) return; // Bấm trùng khi phiếu trước còn đang gửi -> bỏ qua, tránh 2 request chồng lên nhau.
    setTicketKey(ma_bn);
    try {
      const result = await api.createHchanh_Ticket(ma_bn, {
        issues: card?.issues || [],
        ...payload,
      });
      toast?.(result.created ? 'Đã tạo phiếu sửa.' : 'Đã cập nhật phiếu sửa.', 'ok');
      await load();
    } catch (e) {
      toast?.(String(e.message || e), 'error');
    } finally {
      setTicketKey('');
    }
  }, [load, toast, ticketKey]);

  const updateTicket = useCallback(async (ticketId, patch) => {
    try {
      await api.updateHchanh_Ticket(ticketId, patch);
      await load();
    } catch (e) {
      toast?.(String(e.message || e), 'error');
    }
  }, [load, toast]);

  const saveManualReview = useCallback(async (card, patch) => {
    const ma_bn = getMaBn(card);
    if (!ma_bn || manualReviewKey) return;
    setManualReviewKey(ma_bn);
    try {
      await api.saveHchanh_ManualReview(ma_bn, {
        ...patch,
        encounter_key: card?.encounter_key || '',
      });
      await load();
    } catch (e) {
      toast?.(`Không lưu được checklist: ${String(e.message || e)}`, 'error');
    } finally {
      setManualReviewKey('');
    }
  }, [load, manualReviewKey, toast]);

  // ── Snapshot ───────────────────────────────────────────────────────────────

  const loadSnapshot = useCallback(async () => {
    try {
      const data = await api.getHchanh_Snapshot();
      setSnapshotState(data);
    } catch (_) {}
  }, []);

  const createSnapshot = useCallback(async (kind) => {
    try {
      await api.createHchanh_Snapshot(kind);
      await loadSnapshot();
      toast?.(`Đã chốt snapshot ${kind === 'morning' ? 'sáng' : 'chiều'}.`, 'ok');
    } catch (e) {
      toast?.(String(e.message || e), 'error');
    }
  }, [loadSnapshot, toast]);

  // ── F: Nghiệm thu lại sau khi BS sửa ─────────────────────────────────────

  const rescanPatient = useCallback(async (card) => {
    const ma_bn = getMaBn(card);
    if (!ma_bn) return;
    setFetchingKey(ma_bn);
    try {
      const result = await api.rescanHchanh(ma_bn);
      const msg    = result.ticket_auto_verified
        ? `✓ Nghiệm thu thành công — đã tự động đóng phiếu sửa.`
        : result.issues_remaining
          ? `Còn ${result.issues_remaining} vấn đề sau nghiệm thu.`
          : 'Nghiệm thu xong.';
      toast?.(msg, result.issues_remaining ? 'error' : 'ok');
      await load();
    } catch (e) {
      toast?.(String(e.message || e), 'error');
    } finally {
      setFetchingKey('');
    }
  }, [load, toast]);

  // ── G: Export danh sách vấn đề ────────────────────────────────────────────

  const exportIssues = useCallback(async (format = 'csv') => {
    try {
      const res = await api.exportHchanh_Issues(format);
      if (!res.ok) throw new Error('Export thất bại');
      const blob = await res.blob();
      const url  = URL.createObjectURL(blob);
      const a    = document.createElement('a');
      a.href     = url;
      a.download = `hchanh_issues_${new Date().toISOString().slice(0,10)}.${format}`;
      a.click();
      URL.revokeObjectURL(url);
      toast?.('Đã tải file export.', 'ok');
    } catch (e) {
      toast?.(String(e.message || e), 'error');
    }
  }, [toast]);

  // ── Filter + search ────────────────────────────────────────────────────────

  const patients = safeArray(dashboard?.patients);
  const counts = dashboard?.counts || {};

  const filteredCards = patients.filter(card => {
    const ma_bn  = getMaBn(card);
    const name   = String(card?.ho_ten || '').toLowerCase();
    const phong  = String(card?.phong  || '').toLowerCase();
    const scope  = card?.scope || 'daily';
    const status = card?.workflowStatus || 'gray';

    if (search) {
      const q = search.toLowerCase();
      if (!name.includes(q) && !ma_bn.includes(q) && !phong.includes(q)) return false;
    }
    if (filterScope  !== 'all' && scope  !== filterScope)  return false;
    if (filterStatus !== 'all' && status !== filterStatus) return false;
    if (manualReviewFilterEnabled && !matchesManualReviewFilter(card, filterManualReview)) return false;
    return true;
  });

  // ── I: Batch fetch tất cả BN theo scope ───────────────────────────────────

  const [batchProgress, setBatchProgress] = useState({ running: false, done: 0, total: 0, errors: 0 });

  // Lấy dữ liệu cho mọi người bệnh còn thiếu/lỗi trong một lượt — dùng khi mở
  // tab lần đầu trong ngày. Cần cập nhật lại riêng một người bệnh (VD: vừa sửa
  // trên EMR) thì dùng nút "Cập nhật"/"Lấy lại" trên từng dòng thay vì bấm lại
  // nút này (nút này bỏ qua người bệnh đã đủ dữ liệu).
  const batchFetchMissing = useCallback(async (headless = false) => {
    const targets = patients.filter(p => !p.data_complete || Boolean(p.fetch_error_active));
    if (!targets.length) {
      toast?.('Không có người bệnh nào còn thiếu dữ liệu.', 'error');
      return;
    }
    if (!window.confirm(`Lấy dữ liệu cho ${targets.length} người bệnh còn thiếu/lỗi?\nQuá trình này có thể mất vài phút.`)) return;

    setBatchProgress({ running: true, done: 0, total: targets.length, errors: 0 });
    let done = 0, errors = 0;
    for (const card of targets) {
      const ma_bn = getMaBn(card);
      const scope = card.scope || card.scope_default || 'daily';
      try {
        setFetchingKey(ma_bn);
        await api.fetchHchanh(ma_bn, scope, null,
          workDateRange?.from || '', workDateRange?.to || '', { headless });
        done++;
      } catch (_) {
        errors++;
      } finally {
        setFetchingKey('');
      }
      setBatchProgress({ running: true, done, total: targets.length, errors });
      // Cập nhật bảng ngay sau mỗi người bệnh — không đợi hết cả lượt mới thấy
      // dòng vừa quét đổi trạng thái. dashboard.js chỉ đọc snapshot đã lưu
      // (không gọi lại EMR) nên gọi lại mỗi vòng lặp không tốn kém.
      await load();
    }
    setBatchProgress({ running: false, done, total: targets.length, errors });
    toast?.(`Batch fetch xong: ${done}/${targets.length} OK, ${errors} lỗi.`, errors ? 'error' : 'ok');
  }, [patients, load, toast, workDateRange]);



  const clearPatient = useCallback(async (card) => {
    const ma_bn = getMaBn(card);
    if (!ma_bn) return;
    if (!window.confirm(`Xóa toàn bộ dữ liệu hành chánh đã lấy của ${card?.ho_ten || ma_bn}?`)) return;
    try {
      await api.clearHchanh_Patient(ma_bn);
      toast?.('Đã xóa dữ liệu hành chánh.', 'ok');
      await load();
    } catch (e) {
      toast?.(String(e.message || e), 'error');
    }
  }, [load, toast]);

  return {
    // State
    loading,
    fetchingKey,
    inputVtytKey,
    previewVtytKey,
    bedEditKey,
    printBillingKey,
    ticketKey,
    manualReviewKey,
    vtytPreviewByPatient,
    vtytBatchDraft, setVtytBatchDraft, vtytBatchLoading, vtytBatchInputting,
    selectedCard,
    setSelectedCard,
    search,
    setSearch,
    filterScope,
    setFilterScope,
    filterStatus,
    setFilterStatus,
    filterManualReview,
    setFilterManualReview,
    snapshotState,
    // Data
    dashboard,
    patients,
    filteredCards,
    counts,
    // Actions
    load,
    fetchPatient,
    fetchDischargeFull,
    previewBatchVTYT, inputBatchVTYT, clearBatchVTYTDraft,
    previewVTYT,
    processVTYTPreview,
    inputVTYT,
    openBedEdit,
    printBilling,
    createTicket,
    updateTicket,
    saveManualReview,
    rescanPatient,
    exportIssues,
    batchFetchMissing,
    batchProgress,
    createSnapshot,
    clearPatient,
  };
}
