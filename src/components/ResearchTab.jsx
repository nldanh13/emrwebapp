// Màn hình Kho nghiên cứu (state, tải dữ liệu, thao tác). Phần giao diện và logic thuần
// được tách vào src/components/research/:
//   researchScope, researchFormat              phạm vi kho/nghiên cứu, bảng, định dạng
//   variableCatalogModel, researchStatusModel  mô hình danh mục biến; trạng thái/tiến độ/tổng quan
//   researchUi, researchStats                  component nhỏ dùng chung; hiển thị thống kê mô tả
//   CollectionWorkspace                        Thu thập dữ liệu theo bước (kho gốc và nghiên cứu)
//   GeneralOverviewView, PatientLookupView     tổng quan kho gốc, tra cứu người bệnh
//   CreateStudyView                            Tạo nghiên cứu: thông tin → biến → điều kiện → kiểm tra
//   StudyStatsView                             nghiên cứu: thống kê và xuất dữ liệu
// Bố cục: cột trái chọn Kho gốc / từng nghiên cứu (+ Tạo nghiên cứu mới); bên phải là tiêu đề,
// các chế độ (kho: Tổng quát · Thu thập · Tra cứu; nghiên cứu: Thống kê & xuất · Thu thập) và nội dung.
// Màn hình chỉ hiện thống kê; dữ liệu chi tiết chỉ lấy ra bằng Xuất CSV khi cần xử lý số liệu.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { C, FONT_MONO, FS } from '../tokens.js';
import { Btn, Spinner } from './shared.jsx';
import * as api from '../api.js';
import { compactNumber, lower, saveBlob, text } from './research/researchFormat.js';
import { ARCHIVE_API_SCOPE, ARCHIVE_SCOPE, datasetCount, todayInputDate } from './research/researchScope.js';
import { ANCHOR_AGGREGATIONS, defaultAggregationFor, VARIABLE_CLINICAL_GROUPS, dedupeWideTableVariables, enhanceCatalogVariable, groupVariablesBySection } from './research/variableCatalogModel.js';
import { buildGeneralOverviewModel, diffProgressSnapshots, summarizeStatusRows } from './research/researchStatusModel.js';
import { ModeButton, SectionHead, SideItem, StatBadge, actionBtn, inp } from './research/researchUi.jsx';
import { CollectionWorkspace } from './research/CollectionWorkspace.jsx';
import { PatientLookupView } from './research/PatientLookupView.jsx';
import { GeneralOverviewView } from './research/GeneralOverviewView.jsx';
import { CreateStudyView } from './research/CreateStudyView.jsx';
import { StudyStatsView } from './research/StudyStatsView.jsx';
import { EmptyCohortNotice } from './research/EmptyCohortNotice.jsx';
import { CrfView } from './research/CrfView.jsx';
import { RunningBanner, formatDuration } from './research/RunningBanner.jsx';
import { NormalizeStatus } from './research/NormalizeStatus.jsx';
import useIsMobile from '../hooks/useIsMobile.js';

const CORE_VARIABLE_NAME = /^(sex|birth_year|age|admission_date|discharge_date|hospital_stay_days|diagnosis_raw|surgery_date|surgery_name)$/i;

export default function ResearchTab({ toast, active: tabActive = true, onRunningChange }) {
  const isMobile = useIsMobile();
  const [archive, setArchive]         = useState(null);
  const [studies, setStudies]         = useState([]);
  const [selectedId, setSelectedId]   = useState(ARCHIVE_SCOPE);
  const [loading, setLoading]         = useState(false);
  const [busy, setBusy]               = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState(null); // studyId cần xác nhận xóa
  const [archiveOptions, setArchiveOptions] = useState(() => ({ headless: true, fromDate: '2026-01-01', toDate: todayInputDate() }));
  const [studyOptions, setStudyOptions]     = useState({ headless: true });
  const [archiveMode, setArchiveMode] = useState('overview'); // overview | update | patient | create
  const [studyMode, setStudyMode]     = useState('stats');    // stats | collect | crf
  const [showLog, setShowLog]         = useState(false);
  const [logLines, setLogLines]       = useState([]);
  const [caseTraces, setCaseTraces]   = useState([]);
  const [caseTraceRedact, setCaseTraceRedact] = useState(true);
  const [logLoading, setLogLoading]   = useState(false);
  const [coverage, setCoverage]       = useState(null);
  const [progressSnapshot, setProgressSnapshot] = useState(null);
  const [statusLoading, setStatusLoading] = useState(false);
  const [lastUpdateSummary, setLastUpdateSummary] = useState(null);
  const [generalOverview, setGeneralOverview] = useState(null);
  const [generalOverviewLoading, setGeneralOverviewLoading] = useState(false);
  const [pipeline, setPipeline] = useState(null);
  const [researchError, setResearchError] = useState('');
  const [automationRun, setAutomationRun] = useState({ kind: '', status: 'idle', current: '', steps: [], error: '', warning: '' });
  // Tác vụ đang chạy theo máy chủ (đúng cả khi rời tab / tải lại trang) và tác vụ vừa kết thúc.
  const [serverRunning, setServerRunning] = useState({ items: [], checkedAt: 0, clockOffset: 0 });
  const [lastFinished, setLastFinished] = useState(null);
  const [normalizeRequest, setNormalizeRequest] = useState({ status: 'idle' }); // Chuẩn hóa bấm tay
  const runningRef = useRef(new Map());
  // Tra cứu người bệnh. Quyền xem dữ liệu có định danh (null = chưa biết): khi đang khóa,
  // tab Tra cứu hiện hướng dẫn thay vì gọi API rồi báo lỗi đỏ.
  const [patientQuery, setPatientQuery]     = useState('');
  const [patientHistory, setPatientHistory] = useState(null);
  const [patientHistoryLoading, setPatientHistoryLoading] = useState(false);
  const [patientHistoryError, setPatientHistoryError] = useState('');
  const [patientHistoryMeta, setPatientHistoryMeta] = useState(null);
  const [identifiedAccess, setIdentifiedAccess] = useState(null);
  // Tạo nghiên cứu
  const [variableCatalog, setVariableCatalog] = useState(null);
  const [variableCatalogLoading, setVariableCatalogLoading] = useState(false);
  const [variableCatalogError, setVariableCatalogError] = useState('');
  const [variableQuery, setVariableQuery]   = useState('');
  const [questionnaireVariables, setQuestionnaireVariables] = useState('');
  const [variableExporting, setVariableExporting] = useState(false);
  const [variableGroupFilter, setVariableGroupFilter] = useState('all');
  const [variableFillFilter, setVariableFillFilter] = useState('all');
  const [selectedVariableIds, setSelectedVariableIds] = useState(() => new Set());
  const [variableAggregations, setVariableAggregations] = useState({});
  const [variableSurveyLabels, setVariableSurveyLabels] = useState({});
  const [variableConditions, setVariableConditions] = useState([]);
  const [variableAnchor, setVariableAnchor] = useState(null);       // { kind, drug } — mốc thời gian
  const [variableWindows, setVariableWindows] = useState({});       // { [variableId]: { from, to } } ngày so với mốc
  const [variableRoles, setVariableRoles] = useState({});           // { [key]: 'primary_outcome' | ... } vai trò biến
  const [variablePeriod, setVariablePeriod] = useState({ from: '', to: '' }); // thời gian nghiên cứu (ngày nhập viện)
  const [variableOnePerPatient, setVariableOnePerPatient] = useState(false);  // mỗi người bệnh một lượt
  const [variableSampleSize, setVariableSampleSize] = useState({ design: '' }); // thông số tính cỡ mẫu
  const [variableStudyDraft, setVariableStudyDraft] = useState({ name: '', description: '' });
  const [variablePreview, setVariablePreview] = useState(null);
  const [variablePreviewLoading, setVariablePreviewLoading] = useState(false);
  const [variablePreviewError, setVariablePreviewError] = useState('');

  // Dùng ref cho toast để tránh callback recreation mỗi khi parent re-render
  const toastRef = useRef(toast);
  const summaryPollRef = useRef(0);
  const errorToastRef = useRef({ message: '', at: 0 });
  const variableCatalogAutoKeyRef = useRef('');
  useEffect(() => { toastRef.current = toast; }, [toast]);
  const t = useCallback((msg, type) => toastRef.current?.(msg, type), []);
  const showErrorOnce = useCallback((err, cooldownMs = 8000) => {
    const msg = String(err?.message || err || 'Có lỗi không xác định.');
    const now = Date.now();
    if (errorToastRef.current.message === msg && now - errorToastRef.current.at < cooldownMs) return;
    errorToastRef.current = { message: msg, at: now };
    setResearchError(msg);
    t(msg, 'error');
  }, [t]);

  const isArchive = selectedId === ARCHIVE_SCOPE;

  // ── api calls ─────────────────────────────────────────────────────────────
  const loadSummary = useCallback(async (showSpinner = false) => {
    if (showSpinner) setLoading(true);
    try {
      const [archiveRes, studiesRes] = await Promise.all([api.getResearchArchive(), api.listResearchStudies()]);
      const list = Array.isArray(studiesRes.studies) ? studiesRes.studies : [];
      setArchive(archiveRes.archive || null);
      if (archiveRes.archive) {
        const today = todayInputDate();
        const savedToDate = text(archiveRes.archive.scan_to_date);
        setArchiveOptions(prev => ({
          ...prev,
          fromDate: archiveRes.archive.scan_from_date || prev.fromDate || '2026-01-01',
          // Khoảng quét mặc định luôn mở rộng tới hôm nay; metadata cũ không được kéo lùi về ngày cũ.
          toDate: savedToDate && savedToDate > today ? savedToDate : today,
        }));
      }
      setStudies(list);
      if (selectedId !== ARCHIVE_SCOPE && !list.some(s => s.id === selectedId)) setSelectedId(ARCHIVE_SCOPE);
    } catch (e) { showErrorOnce(e); }
    finally { if (showSpinner) setLoading(false); }
  }, [selectedId, showErrorOnce]);

  const loadCoverage = useCallback(async (scopeId = selectedId) => {
    try {
      const r = scopeId === ARCHIVE_SCOPE
        ? await api.getResearchArchiveCoverage({ runId: 'latest' })
        : await api.getResearchStudyCoverage(scopeId, { runId: 'latest' });
      setCoverage(r.coverage || null);
    } catch (_) {
      setCoverage(null);
    }
  }, [selectedId]);

  const loadGeneralOverview = useCallback(async ({ silent = false } = {}) => {
    if (!silent) setGeneralOverviewLoading(true);
    try {
      // Tổng quát chỉ đếm số liệu: luôn đọc bản đã ẩn định danh.
      const fetchTable = tableKey => api.getResearchArchiveData({ table: tableKey, runId: 'latest', redact: true });
      // Dùng cùng một snapshot backend cho số lượng và dùng extract_status đầy đủ
      // cho bảng theo dõi. Không trộn rows.length của dữ liệu đã redact với metadata.
      const [patientRes0, encounterRes, statusRes, progressRes, coverageRes, pipelineRes] = await Promise.all([
        fetchTable('patient_master'),
        fetchTable('encounters'),
        fetchTable('extract_status'),
        api.getResearchArchiveProgress({ runId: 'latest' }),
        api.getResearchArchiveCoverage({ runId: 'latest' }),
        api.getResearchArchivePipeline().catch(() => null),
      ]);
      setPipeline(pipelineRes?.pipeline || null);
      let patientRes = patientRes0;
      if (!Array.isArray(patientRes?.rows) || !patientRes.rows.length) patientRes = await fetchTable('initial_list');
      const nextProgress = progressRes?.progress || null;
      const nextCoverage = coverageRes?.coverage || null;
      setProgressSnapshot(nextProgress);
      setCoverage(nextCoverage);
      setGeneralOverview(buildGeneralOverviewModel({
        patientRows: Array.isArray(patientRes?.rows) ? patientRes.rows : [],
        encounterRows: Array.isArray(encounterRes?.rows) ? encounterRes.rows : [],
        statusRows: Array.isArray(statusRes?.rows) ? statusRes.rows : [],
        coverage: nextCoverage,
        progressSnapshot: nextProgress,
        source: archive,
        isArchive: true,
        limited: Boolean(patientRes?.limited || encounterRes?.limited || statusRes?.limited),
        patientCount: Number(patientRes?.count || 0),
        encounterCount: Number(encounterRes?.count || 0),
      }));
    } catch (e) {
      setGeneralOverview(null);
      showErrorOnce(e);
    } finally {
      if (!silent) setGeneralOverviewLoading(false);
    }
  }, [archive, showErrorOnce]);

  const loadProgressSnapshot = useCallback(async (scopeId = selectedId, { silent = false } = {}) => {
    if (!silent) setStatusLoading(true);
    try {
      const r = scopeId === ARCHIVE_SCOPE
        ? await api.getResearchArchiveProgress({ runId: 'latest' })
        : await api.getResearchStudyProgress(scopeId, { runId: 'latest' });
      const next = r.progress || null;
      setProgressSnapshot(next);
      return next;
    } catch (e) {
      setProgressSnapshot(null);
      if (!silent) showErrorOnce(e);
      return null;
    } finally {
      if (!silent) setStatusLoading(false);
    }
  }, [selectedId, showErrorOnce]);

  const loadVariableCatalog = useCallback(async (options = {}) => {
    setVariableCatalogLoading(true);
    setVariableCatalogError('');
    try {
      const r = await api.getResearchArchiveVariableCatalog({ runId: 'latest' });
      setVariableCatalog(r.catalog || null);
    } catch (e) {
      setVariableCatalog(null);
      setVariableCatalogError(String(e?.message || e || 'Không tải được danh mục biến.'));
      if (!options.silentError) showErrorOnce(e);
    } finally { setVariableCatalogLoading(false); }
  }, [showErrorOnce]);

  const reloadCurrentView = useCallback(async () => {
    await loadSummary(true);
    await loadProgressSnapshot(selectedId, { silent: true });
    if (!isArchive) { await loadCoverage(selectedId); return; }
    if (archiveMode === 'overview') await loadGeneralOverview();
    if (archiveMode === 'create') await loadVariableCatalog();
  }, [loadSummary, loadProgressSnapshot, loadCoverage, loadGeneralOverview, loadVariableCatalog, selectedId, isArchive, archiveMode]);

  const ensureIdentifiedAccess = useCallback(async () => {
    try {
      const r = await api.getResearchIdentifiedAccess();
      const next = { allowed: Boolean(r?.allowed), env_enabled: Boolean(r?.env_enabled), role_ok: Boolean(r?.role_ok), env_diagnosis: r?.env_diagnosis || null };
      setIdentifiedAccess(next);
      return next;
    } catch (_) {
      return null; // không biết thì để server tự quyết như trước
    }
  }, []);

  const loadPatientHistory = useCallback(async (queryOverride = '') => {
    const q = typeof queryOverride === 'string' && text(queryOverride) ? text(queryOverride) : text(patientQuery);
    if (!q) { showErrorOnce('Nhập tên, mã BN, mã NC hoặc chẩn đoán để tra cứu.'); return; }
    if (q.length < 2) { showErrorOnce('Từ khóa tra cứu quá ngắn. Nhập ít nhất 2 ký tự.'); return; }
    const access = identifiedAccess || await ensureIdentifiedAccess();
    if (access && !access.allowed) { setPatientHistory(null); setPatientHistoryError(''); return; }
    setPatientHistoryLoading(true);
    setPatientHistoryError('');
    setResearchError('');
    const started = Date.now();
    try {
      const request = api.getResearchArchivePatientHistory({ q, runId: 'latest' });
      const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error('Tra cứu quá 20 giây. Hãy thử bằng mã BN/mã NC cụ thể; nếu vẫn chậm, xem Log.')), 20000));
      const r = await Promise.race([request, timeout]);
      setPatientHistory(r);
      setPatientHistoryMeta({
        elapsedMs: Number(r?.request_ms || r?.elapsed_ms || (Date.now() - started)),
        source: r?.data_source || '',
        truncated: Boolean(r?.truncated),
        matched: Number(r?.matched_before_limit || r?.total_matches || 0),
      });
      if (!r?.selection_required && !r?.patients?.length) setPatientHistoryError('Không tìm thấy người bệnh trong kho hiện tại.');
    } catch (e) {
      const msg = String(e?.message || e || 'Tra cứu thất bại.');
      // Quyền bị đổi giữa chừng (server khởi động lại không bật khóa): hiện trạng thái khóa.
      const latest = await ensureIdentifiedAccess();
      if (latest && !latest.allowed) { setPatientHistoryError(''); return; }
      setPatientHistoryError(msg);
      showErrorOnce(msg);
    } finally { setPatientHistoryLoading(false); }
  }, [patientQuery, showErrorOnce, identifiedAccess, ensureIdentifiedAccess]);

  useEffect(() => {
    if (isArchive && archiveMode === 'patient') ensureIdentifiedAccess();
  }, [isArchive, archiveMode, ensureIdentifiedAccess]);

  useEffect(() => {
    if (!(isArchive && archiveMode === 'create')) return;
    const runKey = `archive:${archive?.latest_run?.id || 'latest'}`;
    if (variableCatalogAutoKeyRef.current === runKey || variableCatalogLoading) return;
    variableCatalogAutoKeyRef.current = runKey;
    loadVariableCatalog({ silentError: true });
  }, [isArchive, archiveMode, archive?.latest_run?.id, variableCatalogLoading, loadVariableCatalog]);

  useEffect(() => { loadSummary(true); }, []); // eslint-disable-line
  useEffect(() => {
    loadProgressSnapshot(selectedId, { silent: true });
    if (!isArchive) loadCoverage(selectedId);
  }, [selectedId]); // eslint-disable-line

  // Tab Thu thập cũng cần biết có dữ liệu mới chưa chuẩn hóa (để hiện nút Chuẩn hóa ngay).
  useEffect(() => {
    if (!(isArchive && archiveMode === 'update') || !tabActive) return;
    api.getResearchArchivePipeline().then(r => setPipeline(r?.pipeline || null)).catch(() => {});
  }, [isArchive, archiveMode, tabActive, lastFinished]);

  useEffect(() => {
    if (!(isArchive && archiveMode === 'overview') || !tabActive) return;
    loadGeneralOverview({ silent: true });
    // Tải khi đổi run, khi quay lại màn hình này (dữ liệu có thể đã được lấy ở nơi khác) và khi
    // tác vụ vừa kết thúc. Không phụ thuộc identity của callback để tránh vòng tải lại.
  }, [isArchive, archiveMode, archive?.latest_run?.id, tabActive, lastFinished]); // eslint-disable-line

  // Auto-poll: progress cần realtime, summary thì chậm hơn để không tự tạo 429 khi task dài.
  useEffect(() => {
    const runIsActive = archive?.latest_run?.id && (
      archive?.latest_run?.done_patients < archive?.latest_run?.patients_count ||
      archive?.latest_run?.patients_count === 0
    );
    const taskIsActive = Boolean(progressSnapshot?.active_task && ['queued', 'running'].includes(String(progressSnapshot.active_task.status || '').toLowerCase()));
    const active = busy || runIsActive || taskIsActive;
    const tid = setInterval(() => {
      loadProgressSnapshot(selectedId, { silent: true });
      const now = Date.now();
      if (active && now - summaryPollRef.current > 10000) {
        summaryPollRef.current = now;
        loadSummary(false);
      }
    }, active ? 2500 : tabActive ? 15000 : 30000);
    return () => clearInterval(tid);
  }, [busy, archive, progressSnapshot?.active_task?.status, selectedId, loadSummary, loadProgressSnapshot, tabActive]);

  // Hỏi máy chủ tác vụ nào đang chạy. Tác vụ biến khỏi danh sách = đã kết thúc: báo và tải lại.
  const loadServerRunning = useCallback(async () => {
    try {
      const r = await api.getResearchRunning();
      const items = Array.isArray(r?.running) ? r.running : [];
      const serverTime = Date.parse(r?.server_time || '');
      setServerRunning({ items, checkedAt: Date.now(), clockOffset: Number.isFinite(serverTime) ? serverTime - Date.now() : 0 });
      const prev = runningRef.current;
      const next = new Map(items.map(item => [item.scope_key, item]));
      const finished = [...prev.values()].filter(item => !next.has(item.scope_key));
      runningRef.current = next;
      if (finished.length) {
        const item = finished[finished.length - 1];
        const finishedAt = Number.isFinite(serverTime) ? serverTime : Date.now();
        setLastFinished({ ...item, finished_at: new Date(finishedAt).toISOString(), elapsed_ms: finishedAt - Date.parse(item.since) });
        loadSummary(false);
        loadProgressSnapshot(selectedId, { silent: true });
      }
      return { items, finished };
    } catch (_) {
      return null;
    }
  }, [loadSummary, loadProgressSnapshot, selectedId]);
  useEffect(() => {
    const anyRunning = serverRunning.items.length > 0 || busy;
    loadServerRunning();
    const tid = setInterval(loadServerRunning, anyRunning ? 3000 : tabActive ? 10000 : 20000);
    return () => clearInterval(tid);
  }, [serverRunning.items.length > 0, busy, tabActive]); // eslint-disable-line

  const activeStudy  = useMemo(() => studies.find(s => s.id === selectedId) || null, [studies, selectedId]);
  const activeSource = isArchive ? archive : activeStudy;
  const latest       = activeSource?.latest_run || null;
  const operationSnapshot = useMemo(
    () => progressSnapshot || summarizeStatusRows([], activeSource, coverage, isArchive),
    [progressSnapshot, activeSource, coverage, isArchive]
  );
  const remoteTaskActive = Boolean(operationSnapshot?.active_task && ['queued', 'running'].includes(String(operationSnapshot.active_task.status || '').toLowerCase()));
  const currentScopeKey = isArchive ? 'archive' : `study:${selectedId}`;
  const scopeRunningItem = serverRunning.items.find(item => item.scope_key === currentScopeKey) || null;
  const scopeRunning = Boolean(scopeRunningItem);
  // Máy chủ báo đang chạy thì khung tiến độ không được hiện "đã dừng giữa chừng" (snapshot có thể cũ hơn).
  const monitorSnapshot = useMemo(() => {
    if (!scopeRunningItem || !operationSnapshot || operationSnapshot.scope_running || operationSnapshot.active_task) return operationSnapshot;
    return {
      ...operationSnapshot,
      scope_running: { label: scopeRunningItem.label, since: scopeRunningItem.since },
      stopped: null,
      current_case: operationSnapshot.current_case ? { ...operationSnapshot.current_case, stale: false } : operationSnapshot.current_case,
    };
  }, [operationSnapshot, scopeRunningItem]);
  const uiBusy = busy || remoteTaskActive || scopeRunning;
  const scopeName = useCallback((item) => (item.kind === 'study'
    ? `nghiên cứu "${item.study_name || studies.find(s => s.id === item.study_id)?.name || item.study_id}"`
    : 'Kho dữ liệu gốc'), [studies]);

  // Báo cho thanh menu: Kho nghiên cứu đang chạy gì (hiện dấu "Đang chạy" kể cả khi ở màn hình khác).
  const runningTitle = serverRunning.items.length
    ? serverRunning.items.map(item => `Đang chạy: ${item.label} · ${scopeName(item)}`).join('\n')
    : busy && automationRun.status === 'running' ? `Đang chạy: ${automationRun.current || 'tác vụ nghiên cứu'}` : '';
  useEffect(() => {
    onRunningChange?.(runningTitle ? { title: runningTitle } : null);
  }, [runningTitle, onRunningChange]);
  useEffect(() => () => onRunningChange?.(null), [onRunningChange]);

  // Tác vụ kết thúc lúc đang ở màn hình khác: báo bằng thông báo chung (tác vụ chạy từ đây đã tự báo).
  useEffect(() => {
    if (!lastFinished || busy || tabActive) return;
    t(`Kho nghiên cứu: đã kết thúc "${lastFinished.label}" (${scopeName(lastFinished)}) sau ${formatDuration(lastFinished.elapsed_ms)}.`, 'info');
  }, [lastFinished]); // eslint-disable-line

  const cancelRunning = useCallback(async (item) => {
    if (!window.confirm(`Dừng "${item.label}" của ${scopeName(item)}?\n\nPhần đã lấy được giữ lại; chạy lại sẽ tiếp tục phần còn thiếu.`)) return;
    try { const r = await api.cancelTask(); t(r?.message || 'Đã gửi lệnh dừng.', 'ok'); }
    catch (e) { t(String(e.message || e), 'error'); }
    finally { loadServerRunning(); }
  }, [scopeName, loadServerRunning, t]);
  const openRunning = useCallback((item) => {
    if (item.kind === 'study') { setSelectedId(item.study_id); setStudyMode('collect'); }
    else { setSelectedId(ARCHIVE_SCOPE); setArchiveMode('update'); }
  }, []);

  const deleteStudy = useCallback(async (studyId) => {
    setBusy(true);
    try {
      const r = await api.deleteResearchStudy(studyId);
      t(r.message || 'Đã xóa nghiên cứu.', 'ok');
      await loadSummary();
      if (selectedId === studyId) { setSelectedId(ARCHIVE_SCOPE); setArchiveMode('overview'); }
    } catch (e) { t(String(e.message || e), 'error'); }
    finally { setBusy(false); setDeleteConfirm(null); }
  }, [selectedId, loadSummary, t]);

  // ── Thu thập dữ liệu ──────────────────────────────────────────────────────
  const updateAutomationStep = useCallback((index, patch) => {
    setAutomationRun(prev => ({ ...prev, steps: prev.steps.map((step, i) => (i === index ? { ...step, ...patch } : step)) }));
  }, []);

  const runAutomaticWorkflow = useCallback(async ({ kind, steps, successMessage }) => {
    setBusy(true);
    setResearchError('');
    setAutomationRun({
      kind, status: 'running', current: steps[0]?.label || '',
      steps: steps.map(step => ({ label: step.label, status: 'pending', detail: '' })), error: '', warning: '',
    });
    const warnings = [];
    try {
      for (let index = 0; index < steps.length; index += 1) {
        const step = steps[index];
        setAutomationRun(prev => ({ ...prev, current: step.label }));
        updateAutomationStep(index, { status: 'running', detail: '' });
        try {
          const result = await step.run();
          const wasCancelled = Boolean(result?.cancelled || result?.stopped);
          updateAutomationStep(index, { status: wasCancelled ? 'cancelled' : 'done', detail: text(result?.message || result?.summary?.message || '') });
          if (wasCancelled) {
            const message = text(result?.message || 'Đã dừng theo yêu cầu. Chạy lại để tiếp tục phần còn thiếu.');
            setAutomationRun(prev => ({ ...prev, status: 'cancelled', current: '', warning: message }));
            t(message, 'info');
            return;
          }
        } catch (error) {
          const message = String(error?.message || error || 'Không rõ lỗi');
          if (step.optional) {
            warnings.push(`${step.label}: ${message}`);
            updateAutomationStep(index, { status: 'warning', detail: message });
            continue;
          }
          updateAutomationStep(index, { status: 'error', detail: message });
          throw new Error(`${step.label}: ${message}`);
        }
      }
      setAutomationRun(prev => ({ ...prev, status: warnings.length ? 'warning' : 'done', current: '', warning: warnings.join(' | ') }));
      t(warnings.length ? `${successMessage} Có ${warnings.length} cảnh báo cần xem.` : successMessage, warnings.length ? 'info' : 'ok');
    } catch (error) {
      const message = String(error?.message || error || 'Không rõ lỗi');
      setAutomationRun(prev => ({ ...prev, status: 'error', current: '', error: message }));
      setResearchError(message);
      t(message, 'error');
    } finally {
      await Promise.all([loadSummary(), loadProgressSnapshot(selectedId, { silent: true })]);
      if (selectedId !== ARCHIVE_SCOPE) await loadCoverage(selectedId);
      setBusy(false);
    }
  }, [loadCoverage, loadProgressSnapshot, loadSummary, selectedId, t, updateAutomationStep]);

  // Chuẩn hóa lại kho từ dữ liệu đã lấy (không mở EMR): khi có dữ liệu mới chưa vào bảng chuẩn.
  // Chuẩn hóa là quy trình riêng: không dùng cờ busy của Thu thập, nên không khóa nút thu thập.
  const runNormalizeArchive = useCallback(async () => {
    setNormalizeRequest({ status: 'starting', started_at: new Date().toISOString() });
    setTimeout(() => { loadServerRunning(); }, 700);
    try {
      const r = await api.normalizeResearchArchive();
      setNormalizeRequest({ status: 'done', message: r?.message || '' });
      t(r?.message || 'Đã chuẩn hóa kho.', 'ok');
    } catch (e) {
      const message = String(e?.message || e || 'Chuẩn hóa lỗi.');
      setNormalizeRequest({ status: 'error', error: message });
      t(message, 'error');
    } finally {
      loadServerRunning();
      api.getResearchArchivePipeline().then(r => setPipeline(r?.pipeline || null)).catch(() => {});
      loadSummary(false);
      loadProgressSnapshot(selectedId, { silent: true });
      if (archiveMode === 'overview') loadGeneralOverview({ silent: true });
    }
  }, [loadServerRunning, loadSummary, loadProgressSnapshot, selectedId, archiveMode, loadGeneralOverview, t]);

  const runSimpleListScan = useCallback(async () => {
    const options = { ...archiveOptions, toDate: archiveOptions.toDate || todayInputDate() };
    await runAutomaticWorkflow({
      kind: 'scan',
      successMessage: 'Đã quét danh sách và cập nhật cơ sở dữ liệu.',
      steps: [
        { label: 'Quét danh sách người bệnh trên EMR', run: () => api.runResearchArchive({ ...options, resume: true, mode: 'initial' }) },
        { label: 'Chuẩn hóa danh sách và cập nhật SQLite', run: () => api.normalizeResearchArchive() },
      ],
    });
  }, [archiveOptions, runAutomaticWorkflow]);

  // Ca đang dùng dữ liệu tạm thời lấy từ tab Kiểm HSBA / Trả HSBA: quét lại từ EMR để có dữ liệu gốc.
  const runRefreshProvisional = useCallback(async () => {
    if (!window.confirm('Quét lại từ EMR các ca đang dùng dữ liệu tạm thời lấy từ tab Kiểm HSBA / Trả HSBA?\n\nKết quả quét lại là dữ liệu gốc và sẽ thay dữ liệu tạm thời.')) return;
    setBusy(true);
    try {
      const today = todayInputDate();
      const options = isArchive
        ? { headless: archiveOptions.headless, fromDate: archiveOptions.fromDate, toDate: archiveOptions.toDate || today, refreshProvisional: true }
        : { headless: studyOptions.headless, fromDate: studyOptions.fromDate || archiveOptions.fromDate, toDate: studyOptions.toDate || archiveOptions.toDate || today, refreshProvisional: true };
      const r = isArchive
        ? await api.fetchHchanhAllForResearchArchive(options)
        : await api.fetchHchanhAllForResearchStudy(selectedId, options);
      t(r.message || 'Đã quét lại các ca dùng dữ liệu tạm thời.', 'ok');
      await loadSummary();
      await loadProgressSnapshot(selectedId, { silent: true });
    } catch (e) { t(String(e.message || e), 'error'); }
    finally { setBusy(false); }
  }, [isArchive, selectedId, archiveOptions, studyOptions, loadSummary, loadProgressSnapshot, t]);

  // Lấy dữ liệu theo quy trình đầy đủ: dùng cho lần đầu của nghiên cứu (chưa có đợt chạy,
  // nên Thu thập tự động chưa dùng được). Đã có tiến độ thì chỉ lấy phần còn thiếu.
  const runSimpleDataCollection = useCallback(async () => {
    const today = todayInputDate();
    const scope = isArchive ? ARCHIVE_API_SCOPE : selectedId;
    const fromDate = isArchive ? archiveOptions.fromDate : (studyOptions.fromDate || archiveOptions.fromDate);
    const toDate = isArchive ? (archiveOptions.toDate || today) : (studyOptions.toDate || archiveOptions.toDate || today);
    const headless = isArchive ? archiveOptions.headless : studyOptions.headless;
    if (isArchive && !archive?.latest_run?.id) { showErrorOnce('Cần quét danh sách trước khi lấy dữ liệu.'); return; }
    if (!isArchive && !activeStudy?.has_cohort) { showErrorOnce('Nghiên cứu chưa có danh sách mẫu.'); return; }

    setResearchError('');
    const beforeProgress = await loadProgressSnapshot(selectedId, { silent: true });
    const moduleMap = new Map((beforeProgress?.modules || []).map(m => [m.key, m]));
    const missingTypes = ['xn_cdha', 'profile', 'discharge', 'surgery', 'order_history'].filter(key => {
      const m = moduleMap.get(key);
      if (!m) return true;
      return Number(m.done || 0) < Number(m.total || beforeProgress?.total || 0) || Number(m.error || 0) > 0 || Number(m.missing || 0) > 0 || Number(m.waiting || 0) > 0;
    });
    // Chưa có đợt chạy (exists: false) thì "thiếu" chỉ là cả danh sách chưa lấy: phải lấy lần đầu,
    // không gọi "chỉ lấy phần còn thiếu" (cần đợt chạy có sẵn, báo "Nghiên cứu chưa có run").
    const hasRun = beforeProgress?.exists !== false && Boolean(beforeProgress?.run_id);
    const hasProgress = hasRun && Number(beforeProgress?.total || 0) > 0 && (Number(beforeProgress?.counts?.done || 0) + Number(beforeProgress?.counts?.error || 0) + Number(beforeProgress?.counts?.missing || 0) > 0);

    const steps = [];
    if (hasProgress) {
      if (missingTypes.length) {
        const labelMap = { xn_cdha: 'XN/CĐHA', profile: 'Hồ sơ nền', discharge: 'Ra viện', surgery: 'Phẫu thuật', order_history: 'Y lệnh' };
        steps.push({
          label: `Chỉ lấy phần còn thiếu: ${missingTypes.map(x => labelMap[x] || x).join(', ')}`,
          run: () => api.refetchMissingResearch({ scope, missingTypes, headless, fromDate, toDate }),
        });
      }
    } else if (isArchive) {
      steps.push(
        { label: 'Lấy XN và CĐHA', run: () => api.runResearchArchive({ headless, fromDate, toDate, resume: true, mode: 'deep', deep: true }) },
        { label: 'Lấy hồ sơ, ra viện, phẫu thuật và y lệnh', run: () => api.fetchHchanhAllForResearchArchive({ headless, fromDate, toDate }) },
        { label: 'Bổ sung thông tin hành chánh', run: () => api.runResearchArchivePatientInfo({ headless, fromDate, toDate }), optional: true },
      );
    } else {
      steps.push(
        { label: 'Lấy XN và CĐHA', run: () => api.runResearchStudy(selectedId, { ...studyOptions, headless, fromDate, toDate, resume: true }) },
        { label: 'Lấy hồ sơ, ra viện, phẫu thuật và y lệnh', run: () => api.fetchHchanhAllForResearchStudy(selectedId, { headless, fromDate, toDate }) },
        { label: 'Bổ sung thông tin hành chánh', run: () => api.runResearchStudyPatientInfo(selectedId, { headless, fromDate, toDate }), optional: true },
      );
    }
    // Nếu mọi module đã đủ, không mở Selenium. Chỉ bảo đảm SQLite/dataset hiện hành.
    steps.push(
      { label: 'Chuẩn hóa và cập nhật SQLite', run: () => (isArchive ? api.normalizeResearchArchive() : api.normalizeResearchStudy(selectedId)) },
      { label: 'Cập nhật mã danh mục phân tích', run: () => (isArchive ? api.buildResearchArchiveEncodedDataset() : api.buildResearchStudyEncodedDataset(selectedId)) },
      { label: 'Cập nhật dataset cuối', run: () => (isArchive ? api.finalizeResearchArchiveDataset() : api.finalizeResearchStudyDataset(selectedId)), optional: true },
    );
    await runAutomaticWorkflow({
      kind: 'collect',
      steps,
      successMessage: missingTypes.length && hasProgress
        ? 'Đã bổ sung phần còn thiếu và cập nhật SQLite.'
        : hasProgress ? 'Dữ liệu đã đủ; chỉ cập nhật SQLite và dataset.' : 'Đã lấy dữ liệu và cập nhật SQLite.',
    });
    const afterProgress = await loadProgressSnapshot(selectedId, { silent: true });
    setLastUpdateSummary(diffProgressSnapshots(beforeProgress, afterProgress, 'Lấy dữ liệu'));
  }, [
    activeStudy?.has_cohort, archive?.latest_run?.id, archiveOptions, isArchive,
    loadProgressSnapshot, runAutomaticWorkflow, selectedId, showErrorOnce, studyOptions,
  ]);

  const loadLog = useCallback(async () => {
    setLogLoading(true);
    try {
      const [r, trace] = await Promise.all([
        isArchive ? api.getResearchArchiveLog({ runId: 'latest', lines: 800 }) : api.getResearchStudyLog(selectedId, { runId: 'latest', lines: 800 }),
        isArchive
          ? api.getResearchArchiveCaseTrace({ runId: 'latest', limit: 10, redact: caseTraceRedact })
          : api.getResearchStudyCaseTrace(selectedId, { runId: 'latest', limit: 10, redact: caseTraceRedact }),
      ]);
      setLogLines(Array.isArray(r.lines) ? r.lines : []);
      setCaseTraces(Array.isArray(trace.cases) ? trace.cases : []);
    } catch (e) {
      setLogLines([`Lỗi: ${e.message}`]);
      setCaseTraces([]);
    } finally { setLogLoading(false); }
  }, [isArchive, selectedId, caseTraceRedact]);
  const openLog = () => { setShowLog(true); loadLog(); };

  // ── Tạo nghiên cứu: danh mục biến, chọn biến, điều kiện ───────────────────
  const allCatalogVariables = useMemo(() => (
    variableCatalog?.groups || []
  ).flatMap(g => (g.variables || []).map(v => enhanceCatalogVariable(v, g))), [variableCatalog]);
  // Danh sách để duyệt/chọn: không lặp biến chung giữa các bảng rộng, không có biến định danh/kỹ
  // thuật. allCatalogVariables vẫn giữ đủ để nhận ra biến đã chọn từ trước (vd. patients.sex).
  const browseCatalogVariables = useMemo(
    () => dedupeWideTableVariables(allCatalogVariables).filter(v => !v.technical_or_identity),
    [allCatalogVariables]
  );
  const catalogGroupOptions = useMemo(() => {
    const counts = new Map();
    for (const v of browseCatalogVariables) {
      const key = v.clinical_group_key || v.group_key || 'other';
      counts.set(key, (counts.get(key) || 0) + 1);
    }
    return VARIABLE_CLINICAL_GROUPS
      .map(g => ({ ...g, count: counts.get(g.key) || 0 }))
      .filter(g => g.count > 0 && g.key !== 'technical');
  }, [browseCatalogVariables]);
  const filteredCatalogVariables = useMemo(() => {
    const q = lower(variableQuery);
    const filtered = browseCatalogVariables.filter(v => {
      if (variableGroupFilter !== 'all' && v.clinical_group_key !== variableGroupFilter) return false;
      const rate = Number(v.fill_rate || 0);
      if (variableFillFilter === 'high' && rate < 80) return false;
      if (variableFillFilter === 'medium' && (rate < 30 || rate >= 80)) return false;
      if (variableFillFilter === 'low' && rate >= 30) return false;
      const haystack = lower(`${v.clinical_group_label} ${v.clinical_section} ${v.source_group_label} ${v.display_label} ${v.raw_name} ${v.description}`);
      return !q || haystack.includes(q);
    });
    // Theo nhóm lâm sàng; trong nhóm, biến nên dùng và đầy đủ hơn lên trước.
    return groupVariablesBySection(filtered).flatMap(section => section.variables);
  }, [browseCatalogVariables, variableQuery, variableGroupFilter, variableFillFilter]);
  // Khóa chọn = id biến, hoặc "id@@lần" khi lấy cùng một biến nhiều lần với cách lấy khác nhau
  // (vd. Canxi trước và sau dùng thuốc). Cách lấy, cửa sổ, tên cột lưu theo khóa chọn.
  const catalogById = useMemo(() => new Map(allCatalogVariables.map(v => [v.id, v])), [allCatalogVariables]);
  const selectedVariables = useMemo(() => [...selectedVariableIds].map(key => {
    const base = catalogById.get(String(key).split('@@')[0]);
    return base ? { ...base, key } : null;
  }).filter(Boolean), [catalogById, selectedVariableIds]);
  const toggleVariable = useCallback((id) => {
    setSelectedVariableIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }, []);
  const addVariables = useCallback((variables) => {
    setSelectedVariableIds(prev => {
      const next = new Set(prev);
      for (const variable of variables || []) if (variable?.id && !variable.technical_or_identity) next.add(variable.id);
      return next;
    });
  }, []);
  const addCoreVariables = useCallback(() => {
    addVariables(browseCatalogVariables.filter(v => CORE_VARIABLE_NAME.test(String(v.name || ''))));
  }, [browseCatalogVariables, addVariables]);
  const addConditionForVariable = useCallback((variable, { exclude = false } = {}) => {
    if (!variable) return;
    setVariableConditions(prev => [...prev, { id: `${Date.now()}_${prev.length}`, variable_id: variable.id, label: `${variable.group_label || variable.table_label}.${variable.display_label || variable.name}`, operator: variable.operators?.[0] || 'contains', value: '', value2: '', exclude }]);
  }, []);
  const buildVariableSpec = useCallback(() => ({
    schema_version: 1,
    source: 'research_archive',
    created_at: new Date().toISOString(),
    run_id: variableCatalog?.run_id || archive?.latest_run?.id || '',
    selected_variables: selectedVariables.map(v => ({
      id: v.id,
      table: v.table,
      table_label: v.group_label || v.table_label || '',
      name: v.name,
      label: v.display_label || v.name,
      survey_label: variableSurveyLabels[v.key] || v.display_label || v.name,
      type: v.type,
      role: variableRoles[v.key] || '',
      virtual_kind: v.virtual_kind || '',
      source_filter: v.source_filter || null,
      // Bỏ mốc thì cách lấy theo mốc không còn nghĩa: quay về liệt kê giá trị.
      aggregation: (!variableAnchor && ANCHOR_AGGREGATIONS.has(variableAggregations[v.key])) ? 'list' : (variableAggregations[v.key] || defaultAggregationFor(v)),
      ...(variableAnchor && (variableWindows[v.key]?.from !== undefined || variableWindows[v.key]?.to !== undefined)
        ? { window_from_days: variableWindows[v.key]?.from ?? '', window_to_days: variableWindows[v.key]?.to ?? '' }
        : {}),
    })),
    ...(variableAnchor ? { anchor: { ...variableAnchor, label: variableAnchor.kind === 'drug' ? `Dùng ${variableAnchor.drug}` : '' } } : {}),
    ...(variablePeriod.from || variablePeriod.to ? { period: variablePeriod } : {}),
    ...(variableOnePerPatient ? { one_per_patient: true } : {}),
    ...(variableSampleSize.design ? { sample_size: variableSampleSize } : {}),
    conditions: variableConditions.map(cond => {
      const variable = allCatalogVariables.find(v => v.id === cond.variable_id);
      return {
        ...cond,
        table: variable?.table || cond.table || '',
        name: variable?.name || cond.name || '',
        label: variable?.display_label || cond.label || '',
        type: variable?.type || cond.type || '',
        virtual_kind: variable?.virtual_kind || cond.virtual_kind || '',
        source_filter: variable?.source_filter || cond.source_filter || null,
      };
    }),
  }), [selectedVariables, variableAggregations, variableSurveyLabels, variableConditions, variableAnchor, variableWindows, variableRoles, variablePeriod, variableOnePerPatient, variableSampleSize, variableCatalog, archive?.latest_run?.id, allCatalogVariables]);

  // Lựa chọn đổi thì thống kê cũ không còn đúng.
  useEffect(() => {
    setVariablePreview(null);
    setVariablePreviewError('');
  }, [selectedVariableIds, variableAggregations, variableSurveyLabels, variableConditions, variableAnchor, variableWindows, variablePeriod, variableOnePerPatient]);

  const loadVariablePreview = useCallback(async () => {
    if (!selectedVariables.length) { t('Chọn ít nhất 1 biến.', 'error'); return; }
    setVariablePreviewLoading(true);
    setVariablePreviewError('');
    try {
      setVariablePreview(await api.previewResearchArchiveVariables({ variable_selection: buildVariableSpec() }));
    } catch (error) {
      const message = String(error?.message || error || 'Không tính được thống kê.');
      setVariablePreviewError(message);
      t(message, 'error');
    } finally {
      setVariablePreviewLoading(false);
    }
  }, [selectedVariables.length, buildVariableSpec, t]);

  // Dùng một đề tài gợi ý: điền sẵn tên, mốc, biến (kể cả biến lấy nhiều lần), cách lấy,
  // cửa sổ ngày, tên cột và điều kiện chọn mẫu. Người dùng vẫn sửa được ở các bước.
  const applySuggestion = useCallback((s) => {
    const keys = [];
    const aggregations = {}; const windows = {}; const labels = {}; const roles = {};
    s.variables.forEach((v, i) => {
      if (!catalogById.has(v.id)) return;
      const key = keys.some(k => k.split('@@')[0] === v.id) ? `${v.id}@@s${i}` : v.id;
      keys.push(key);
      if (v.aggregation) aggregations[key] = v.aggregation;
      if (v.window_from_days != null || v.window_to_days != null) windows[key] = { from: v.window_from_days ?? '', to: v.window_to_days ?? '' };
      if (v.survey_label) labels[key] = v.survey_label;
      if (v.role) roles[key] = v.role;
    });
    setSelectedVariableIds(new Set(keys));
    setVariableAggregations(aggregations);
    setVariableWindows(windows);
    setVariableSurveyLabels(labels);
    setVariableRoles(roles);
    setVariableSampleSize({ design: s.sample_size_design || '' });
    setVariablePeriod({ from: '', to: '' });
    setVariableOnePerPatient(false);
    setVariableAnchor(s.anchor || null);
    setVariableConditions((s.conditions || []).filter(c => catalogById.has(c.variable_id)).map((c, i) => {
      const variable = catalogById.get(c.variable_id);
      return { id: `sg_${i}`, variable_id: c.variable_id, label: variable.display_label || variable.name, operator: c.operator, value: c.value || '', value2: '' };
    }));
    setVariableStudyDraft({ name: s.title, description: `${s.design_label}. Nhóm: ${s.cohort_label}. Kết cục chính: ${s.outcome}.` });
  }, [catalogById]);

  // Xuất ngay từ kho theo biến + điều kiện (đã ẩn định danh), không cần tạo nghiên cứu.
  const exportVariableDataset = useCallback(async () => {
    if (!selectedVariables.length) { t('Chọn ít nhất 1 biến.', 'error'); return; }
    setVariableExporting(true);
    try {
      const name = text(variableStudyDraft.name).normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/gi, 'd').replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_|_$/g, '') || 'du_lieu_nghien_cuu';
      const r = await api.exportResearchArchiveVariables({ variable_selection: buildVariableSpec(), name });
      saveBlob(r.filename || `${name}.csv`, r.blob);
      t(`Đã xuất ${compactNumber(variablePreview?.summary?.total || 0)} lượt điều trị, ${selectedVariables.length} biến (đã ẩn định danh).`, 'ok');
    } catch (e) {
      t(String(e.message || e), 'error');
    } finally {
      setVariableExporting(false);
    }
  }, [selectedVariables.length, variableStudyDraft.name, buildVariableSpec, variablePreview, t]);

  const createStudyFromVariableSelection = useCallback(async () => {
    const name = text(variableStudyDraft.name);
    if (!name) { t('Nhập tên nghiên cứu trước khi tạo.', 'error'); return; }
    if (!selectedVariables.length) { t('Chọn ít nhất 1 biến cần lấy.', 'error'); return; }
    if (!variablePreview?.summary) { t('Cần tính thống kê kiểm tra trước khi tạo.', 'error'); return; }
    setBusy(true);
    try {
      const spec = buildVariableSpec();
      const r = await api.createResearchStudy({
        name,
        description: variableStudyDraft.description,
        analysis_config: { preset: 'general', custom_fields: [], variable_selection: spec },
        variable_selection: spec,
      });
      const studyId = r.study?.id;
      if (!studyId) throw new Error('Không lấy được ID nghiên cứu.');
      let imported = 0;
      try {
        const imp = await api.importResearchFromArchive(studyId, {});
        imported = Number(imp?.count || 0);
      } catch (importErr) {
        t(`Đã tạo nghiên cứu, nhưng chưa nạp được danh sách mẫu: ${String(importErr.message || importErr)}`, 'error');
      }
      await loadSummary();
      setSelectedId(studyId);
      // Nghiên cứu mới chưa có dữ liệu: mở thẳng phần Thu thập của nghiên cứu.
      setStudyMode('collect');
      setVariableStudyDraft({ name: '', description: '' });
      setSelectedVariableIds(new Set());
      setVariableConditions([]);
      setVariableAggregations({});
      setVariableSurveyLabels({});
      setVariableAnchor(null);
      setVariableWindows({});
      setVariableRoles({});
      setVariablePeriod({ from: '', to: '' });
      setVariableOnePerPatient(false);
      setVariableSampleSize({ design: '' });
      t(imported
        ? `Đã tạo nghiên cứu "${name}" và nạp ${compactNumber(imported)} lượt từ kho.`
        : `Đã tạo nghiên cứu "${name}".`, 'ok');
    } catch (e) { t(String(e.message || e), 'error'); }
    finally { setBusy(false); }
  }, [variableStudyDraft, selectedVariables.length, variablePreview, buildVariableSpec, loadSummary, t]);

  const identifiedLocked = Boolean(identifiedAccess && !identifiedAccess.allowed);

  // ── điều hướng ────────────────────────────────────────────────────────────
  const selectArchive = (mode = 'overview') => { setSelectedId(ARCHIVE_SCOPE); setArchiveMode(mode); };
  const selectStudy = (item) => {
    if (!item) return;
    setSelectedId(item.id);
    // Nghiên cứu chưa lấy dữ liệu lần nào thì mở thẳng phần Thu thập, vì chưa có gì để thống kê.
    setStudyMode(item.latest_run ? 'stats' : 'collect');
  };
  const openCreateStudy = () => selectArchive('create');
  const creatingStudy = isArchive && archiveMode === 'create';

  const archivePatients = datasetCount(archive, 'patient_master', true);
  const archiveEncounters = datasetCount(archive, 'encounters', true) || datasetCount(archive, 'initial_list', true);
  const archiveSummaryText = archive?.latest_run
    ? [archivePatients ? `${compactNumber(archivePatients)} người bệnh` : '', `${compactNumber(archiveEncounters)} lượt điều trị`].filter(Boolean).join(' · ')
    : 'Chưa quét dữ liệu';
  const studyCountLabel = (item) => `${compactNumber(item?.cohort_count || 0)} mẫu · ${item?.latest_run ? 'đã lấy dữ liệu' : 'chưa lấy dữ liệu'}`;

  const archiveModes = [
    ['overview', 'Dữ liệu tổng quát', 'Số liệu kho và quy trình quét, thu thập, chuẩn hóa, lưu trữ'],
    ['update', 'Thu thập dữ liệu', 'Quét danh sách, lấy dữ liệu và theo dõi tiến độ'],
    ['patient', 'Tra cứu người bệnh', 'Xem toàn bộ các lần điều trị của một người bệnh'],
  ];
  const studyModes = [
    ['stats', 'Thống kê & xuất dữ liệu', 'Đo lường biến; xuất CSV khi cần xử lý số liệu'],
    ['collect', 'Thu thập dữ liệu', 'Lấy dữ liệu cho danh sách mẫu và theo dõi tiến độ'],
    ['crf', 'Phiếu nhập tay & theo dõi', 'Biến không có trên EMR và lịch gọi theo dõi sau mốc'],
  ];

  const collectionWorkspace = (
    <CollectionWorkspace {...{
      isArchive, archive, study: activeStudy, selectedId, uiBusy, automationRun, scopeRunning: scopeRunningItem,
      archiveOptions, setArchiveOptions, studyOptions, setStudyOptions,
      runSimpleListScan, runSimpleDataCollection, runRefreshProvisional,
      operationSnapshot: monitorSnapshot, lastUpdateSummary, statusLoading, loadProgressSnapshot, loadSummary,
      openLog, toast,
    }} />
  );

  const renderWorkspace = () => {
    if (!isArchive) {
      const view = studyMode === 'collect' ? collectionWorkspace
        : studyMode === 'crf' ? <CrfView key={`${activeStudy?.id}:${activeStudy?.cohort_count || 0}`} study={activeStudy} toast={t} />
        : <StudyStatsView study={activeStudy} toast={t} onGoCollect={() => setStudyMode('collect')} />;
      // Chưa có mẫu: Thống kê và Thu thập đều chưa làm được gì, chỉ hiện một thông báo kèm cách nạp mẫu
      // (không lặp hai khung "chưa có dữ liệu"/"chưa thể thu thập"). Phiếu nhập tay vẫn thiết kế được.
      const noCohort = activeStudy?.id && !Number(activeStudy.cohort_count || 0);
      return <><EmptyCohortNotice study={activeStudy} toast={t} onImported={loadSummary} />{noCohort && studyMode !== 'crf' ? null : view}</>;
    }
    if (archiveMode === 'overview') return <GeneralOverviewView {...{ generalOverview, generalOverviewLoading, pipeline, setArchiveMode }} />;
    if (archiveMode === 'patient') return <PatientLookupView {...{
      identifiedAccess, identifiedLocked, loadPatientHistory, patientHistory,
      patientHistoryError, patientHistoryLoading, patientHistoryMeta, patientQuery, setPatientQuery,
    }} />;
    if (archiveMode === 'create') return <CreateStudyView {...{
      variableCatalog, variableCatalogLoading, variableCatalogError,
      catalogGroupOptions, filteredCatalogVariables, allCatalogVariables, browseCatalogVariables,
      variableQuery, setVariableQuery, variableGroupFilter, setVariableGroupFilter, variableFillFilter, setVariableFillFilter,
      questionnaireVariables, setQuestionnaireVariables,
      selectedVariableIds, setSelectedVariableIds, selectedVariables, toggleVariable, addVariables, addCoreVariables,
      variableAggregations, setVariableAggregations, variableSurveyLabels, setVariableSurveyLabels,
      variableConditions, setVariableConditions, addConditionForVariable,
      variableAnchor, setVariableAnchor, variableWindows, setVariableWindows,
      variableRoles, setVariableRoles, variablePeriod, setVariablePeriod, variableOnePerPatient, setVariableOnePerPatient,
      variableSampleSize, setVariableSampleSize,
      variableStudyDraft, setVariableStudyDraft,
      variablePreview, variablePreviewLoading, variablePreviewError, loadVariablePreview,
      createStudyFromVariableSelection, exportVariableDataset, variableExporting, applySuggestion, busy,
    }} />;
    return collectionWorkspace;
  };

  const runningScopes = new Set(serverRunning.items.map(item => item.scope_key));
  const dot = (on, running = false) => (running
    ? <span className="emr-running-dot" title="Đang chạy" aria-label="Đang chạy" />
    : <span aria-hidden="true" style={{ width: 7, height: 7, borderRadius: '50%', background: on ? C.green : C.text3, flexShrink: 0 }} />);

  // ── render ────────────────────────────────────────────────────────────────
  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0, overflow: 'hidden', background: C.bg, fontSize: FS.sm }}>

      {deleteConfirm && (
        <div role="dialog" aria-modal="true" aria-label="Xóa nghiên cứu" style={{ position: 'fixed', inset: 0, background: 'rgba(15, 23, 42, 0.42)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100 }}>
          <div style={{ background: C.surface, border: `1px solid ${C.redBorder}`, borderRadius: 8, padding: '22px 24px', maxWidth: 400, width: '90%' }}>
            <div style={{ fontSize: FS.lg, fontWeight: 700, color: C.text, marginBottom: 8 }}>Xóa nghiên cứu?</div>
            <div style={{ fontSize: FS.sm, color: C.text2, marginBottom: 18, lineHeight: 1.6 }}>
              Nghiên cứu <b style={{ color: C.text }}>{studies.find(s => s.id === deleteConfirm)?.name || deleteConfirm}</b> cùng danh sách mẫu và dữ liệu đã lấy sẽ bị xóa.
            </div>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <Btn onClick={() => setDeleteConfirm(null)} style={{ height: 32 }}>Huỷ</Btn>
              <Btn variant="solidDanger" onClick={() => deleteStudy(deleteConfirm)} disabled={uiBusy} loading={busy} style={{ height: 32 }}>Xóa</Btn>
            </div>
          </div>
        </div>
      )}

      {showLog && (
        <div style={{ borderBottom: `1px solid ${C.border}`, background: '#0a0f14', display: 'flex', flexDirection: 'column', flexShrink: 0, height: 220 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 12px', borderBottom: `1px solid ${C.border2}`, background: C.surface }}>
            <span style={{ fontSize: FS.xs, fontWeight: 700, color: C.text }}>Log chạy</span>
            <span style={{ fontSize: FS.xs, color: C.text3 }}>{caseTraces.length ? `${caseTraces.length} ca gần nhất · ` : ''}{logLines.length} dòng cuối</span>
            <label style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: FS.xs, color: C.text3 }}>
              <input type="checkbox" checked={caseTraceRedact} onChange={e => setCaseTraceRedact(e.target.checked)} />
              Ẩn thông tin nhạy cảm
            </label>
            <Btn onClick={loadLog} disabled={logLoading} style={{ height: 24, padding: '0 8px', fontSize: FS.xs, marginLeft: 'auto' }}>{logLoading ? <Spinner size={8} /> : 'Tải lại'}</Btn>
            <Btn onClick={() => setShowLog(false)} aria-label="Đóng log" style={{ height: 24, padding: '0 8px', fontSize: FS.xs }}>Đóng</Btn>
          </div>
          <div style={{ flex: 1, overflow: 'auto', padding: '6px 12px', fontFamily: FONT_MONO, fontSize: FS.xs }}>
            {logLoading && <div style={{ color: '#8b949e' }}>Đang tải log...</div>}
            {!logLoading && !logLines.length && !caseTraces.length && (
              <div style={{ color: '#8b949e' }}>Chưa có log. Log xuất hiện sau khi chạy Quét danh sách hoặc Thu thập dữ liệu.</div>
            )}
            {!logLoading && !!caseTraces.length && <div style={{ color: '#58a6ff', fontWeight: 700, marginBottom: 6 }}>[CASE_TRACE] 10 ca gần nhất — tag ở đầu mỗi bước</div>}
            {!logLoading && caseTraces.map((c, ci) => (
              <details key={c.case_id || ci} open={ci === 0} style={{ border: '1px solid #263442', borderRadius: 8, padding: '6px 8px', background: '#0d141b', marginBottom: 6 }}>
                <summary style={{ cursor: 'pointer', color: '#d1d7e0', fontWeight: 700 }}>
                  [{c.status || '—'}] {c.index || '?'} / {c.total || '?'} · BN {c.ma_bn || '—'} · NC {c.research_code || '—'} · {c.date_from || '—'} → {c.date_to || '—'}
                </summary>
                <div style={{ marginTop: 6, display: 'grid', gap: 3 }}>
                  {(c.events || []).map((ev, ei) => (
                    <div key={ei} style={{ color: ev.tag?.startsWith('ERROR') ? '#f85149' : ev.tag === 'WARN' ? '#d29922' : ev.tag?.startsWith('OUTPUT') ? '#3fb950' : '#8b949e', lineHeight: 1.45, whiteSpace: 'pre-wrap' }}>
                      [{ev.tag || 'TAG'}] {ev.step || ''}{ev.screen ? ` | vào=${ev.screen}` : ''}{ev.sees ? ` | thấy=${ev.sees}` : ''}{ev.takes ? ` | lấy=${ev.takes}` : ''}{ev.writes ? ` | ghi=${ev.writes}` : ''}{ev.target ? ` | đích=${ev.target}` : ''}
                    </div>
                  ))}
                </div>
              </details>
            ))}
            {logLines.map((line, i) => {
              const color = /ERROR|❌|lỗi/i.test(line) ? '#f85149' : /WARN|⚠/i.test(line) ? '#d29922' : /OK   |✅|Commit xong|Tab.*xong/i.test(line) ? '#3fb950' : /CLICK/.test(line) ? '#58a6ff' : /STEP /.test(line) ? '#bc8cff' : '#8b949e';
              return <div key={i} style={{ color, lineHeight: 1.55, whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>{line}</div>;
            })}
          </div>
        </div>
      )}

      {/* Chuẩn hóa hiện ở khung riêng trong Kho dữ liệu gốc (NormalizeStatus), không lặp lại ở đây. */}
      <RunningBanner running={serverRunning.items.filter(item => item.lane !== 'normalize')} checkedAt={serverRunning.checkedAt} clockOffset={serverRunning.clockOffset}
        lastFinished={lastFinished?.lane === 'normalize' ? null : lastFinished} scopeName={scopeName} onOpen={openRunning} onCancel={cancelRunning}
        onDismissFinished={() => setLastFinished(null)} />

      {researchError && (
        <div role="alert" style={{ padding: '7px 12px', background: C.redBg, borderBottom: `1px solid ${C.redBorder}`, color: C.red, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', fontSize: FS.sm }}>
          <b>Lỗi:</b><span style={{ flex: 1 }}>{researchError}</span>
          <Btn onClick={openLog} style={{ height: 26, fontSize: FS.xs }}>Xem log</Btn>
          <Btn onClick={() => setResearchError('')} style={{ height: 26, fontSize: FS.xs }}>Đóng</Btn>
        </div>
      )}

      <div style={{ display: 'flex', flex: 1, overflow: 'hidden', minHeight: 0 }}>
        {!isMobile && (
          <nav aria-label="Kho và nghiên cứu" style={{ width: 220, flexShrink: 0, display: 'flex', flexDirection: 'column', borderRight: `1px solid ${C.border}`, background: C.surface, overflowY: 'auto' }}>
            <SectionHead>Kho dữ liệu gốc</SectionHead>
            <SideItem
              label="Toàn bộ kho"
              sub={archiveSummaryText}
              active={isArchive && !creatingStudy}
              onClick={() => selectArchive(creatingStudy ? 'overview' : archiveMode)}
              badge={dot(Boolean(archive?.latest_run), runningScopes.has('archive'))}
            >
              {isArchive && (!!operationSnapshot?.counts?.error || !!operationSnapshot?.unmatched_progress) && (
                <div style={{ display: 'flex', gap: 3, flexWrap: 'wrap' }}>
                  {!!operationSnapshot?.counts?.error && <StatBadge label="Lỗi" value={operationSnapshot.counts.error} tone="danger" />}
                  {!!operationSnapshot?.unmatched_progress && <StatBadge label="Chưa ghép" value={operationSnapshot.unmatched_progress} tone="warn" />}
                </div>
              )}
            </SideItem>

            <SectionHead>Nghiên cứu riêng{studies.length ? ` (${studies.length})` : ''}</SectionHead>
            <button type="button" onClick={openCreateStudy} aria-pressed={creatingStudy} style={{
              display: 'flex', alignItems: 'center', gap: 6, width: '100%', textAlign: 'left',
              border: 0, borderBottom: `1px solid ${C.border2}`, borderLeft: `2px solid ${creatingStudy ? C.blue : 'transparent'}`,
              background: creatingStudy ? C.blueBg : 'transparent', color: C.blue,
              padding: '9px 12px', cursor: 'pointer', fontSize: FS.sm, fontWeight: 700, fontFamily: 'inherit',
            }}>
              <span aria-hidden="true" style={{ fontSize: FS.lg, lineHeight: 1 }}>+</span> Tạo nghiên cứu mới
            </button>
            {studies.map(item => (
              <SideItem key={item.id} label={item.name} sub={studyCountLabel(item)} active={item.id === selectedId}
                onClick={() => selectStudy(item)} badge={dot(Boolean(item.latest_run), runningScopes.has(`study:${item.id}`))} />
            ))}
          </nav>
        )}

        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', minWidth: 0 }}>
          {isMobile && (
            <div style={{ padding: '8px 12px', borderBottom: `1px solid ${C.border2}`, background: C.surface, flexShrink: 0 }}>
              <select
                value={creatingStudy ? '__create__' : selectedId}
                aria-label="Chọn kho hoặc nghiên cứu"
                onChange={e => {
                  const v = e.target.value;
                  if (v === '__create__') openCreateStudy();
                  else if (v === ARCHIVE_SCOPE) selectArchive('overview');
                  else selectStudy(studies.find(s => s.id === v));
                }}
                style={{ ...inp, width: '100%', height: 40 }}
              >
                <option value={ARCHIVE_SCOPE}>Kho dữ liệu gốc · {archiveSummaryText}</option>
                {studies.map(item => <option key={item.id} value={item.id}>{item.name} · {studyCountLabel(item)}</option>)}
                <option value="__create__">+ Tạo nghiên cứu mới</option>
              </select>
            </div>
          )}

          <div style={{ padding: '8px 12px 0', borderBottom: `1px solid ${C.border}`, background: C.surface, flexShrink: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', minHeight: 30 }}>
              <span style={{ fontSize: FS.lg, fontWeight: 700, color: C.text }}>
                {creatingStudy ? 'Tạo nghiên cứu mới' : isArchive ? 'Kho dữ liệu gốc' : (activeStudy?.name || selectedId)}
              </span>
              <div style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
                <Btn onClick={reloadCurrentView} disabled={loading || busy} loading={loading} title="Tải lại dữ liệu đang xem" style={actionBtn}>Tải lại</Btn>
                {!isArchive && <Btn variant="danger" onClick={() => setDeleteConfirm(selectedId)} disabled={uiBusy} style={actionBtn}>Xóa nghiên cứu</Btn>}
              </div>
            </div>
            <div style={{ fontSize: FS.xs, color: C.text3, marginTop: 2, paddingBottom: creatingStudy ? 8 : 0 }}>
              {creatingStudy
                ? 'Dán phiếu thu thập → app ghép biến với kho → đặt điều kiện chọn mẫu → xem số lượng và xuất CSV ngay. Lấy từ dữ liệu đã có, không mở EMR.'
                : isArchive
                  ? `${archiveSummaryText}${latest?.id ? ` · đợt ${latest.id}` : ''}`
                  : [activeStudy?.description, studyCountLabel(activeStudy)].filter(Boolean).join(' · ')}
            </div>
            {!creatingStudy && (
              <div role="tablist" className="emr-hscroll" style={{ display: 'flex', gap: 0, marginTop: 4, overflowX: 'auto' }}>
                {(isArchive ? archiveModes : studyModes).map(([key, title, hint]) => (
                  <ModeButton key={key} title={title} hint={hint}
                    active={isArchive ? archiveMode === key : studyMode === key}
                    onClick={() => (isArchive ? setArchiveMode(key) : setStudyMode(key))} />
                ))}
              </div>
            )}
          </div>

          <div style={{ flex: 1, overflow: 'auto', minHeight: 0, background: C.bg }}>
            {isArchive && !creatingStudy && ['overview', 'update'].includes(archiveMode) && (
              <div style={{ padding: '10px 12px 0' }}>
                <NormalizeStatus pipeline={pipeline} clockOffset={serverRunning.clockOffset}
                  running={serverRunning.items.find(item => item.lane === 'normalize' && item.scope === 'archive') || null}
                  request={normalizeRequest} onNormalize={runNormalizeArchive}
                  onDismiss={() => setNormalizeRequest({ status: 'idle' })} />
              </div>
            )}
            {renderWorkspace()}
          </div>
        </div>
      </div>
    </div>
  );
}
