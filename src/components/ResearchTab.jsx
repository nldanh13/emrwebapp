// Màn hình Kho nghiên cứu (state, tải dữ liệu, thao tác). Phần giao diện và logic thuần
// được tách vào src/components/research/:
//   researchScope, researchFormat              phạm vi kho/nghiên cứu, bảng xem được, định dạng
//   variableCatalogModel, researchStatusModel  mô hình danh mục biến; trạng thái/tiến độ/tổng quan
//   researchUi                                 component nhỏ dùng chung (nhãn, thẻ, nút, ô nhập)
//   CollectionWorkspace                        khu Thu thập dữ liệu theo bước (dùng ResearchMonitor,
//                                              CollectionAutoPanel); chung cho kho gốc và nghiên cứu
//   GeneralOverviewView, PatientLookupView,    các mục của kho gốc: tổng quan, tra cứu người bệnh,
//   VariableCatalogView                        tạo nghiên cứu từ biến
// Bố cục: cột trái chọn Kho gốc / từng nghiên cứu (+ Tạo nghiên cứu mới); bên phải là tiêu đề,
// các chế độ (kho: Tổng quát · Thu thập · Tra cứu; nghiên cứu: Bảng dữ liệu · Thu thập) và nội dung.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { C, FONT_MONO, FS } from '../tokens.js';
import { Btn, Spinner } from './shared.jsx';
import * as api from '../api.js';
import { compactNumber, downloadCsv, lower, pick, rowInDateRange, saveBlob, sortRowsForDisplay, text } from './research/researchFormat.js';
import { ARCHIVE_API_SCOPE, ARCHIVE_DEFAULT_TABLE, ARCHIVE_SCOPE, SENSITIVE_COLUMNS, STUDY_PRIMARY_TABLES, STUDY_TABLES, datasetCount, defaultTableForScope, initialStudyTable, primaryTableAfterRun, tableIdsForScope, tableLabel, todayInputDate } from './research/researchScope.js';
import { VARIABLE_CLINICAL_GROUPS, dedupeWideTableVariables, enhanceCatalogVariable, groupVariablesBySection } from './research/variableCatalogModel.js';
import { buildGeneralOverviewModel, diffProgressSnapshots, summarizeStatusRows } from './research/researchStatusModel.js';
import { EmptyState, ModeButton, SectionHead, SideItem, StatBadge, WizField, WizLabel, WizSelect, actionBtn, inp, wizInp } from './research/researchUi.jsx';
import { CollectionWorkspace } from './research/CollectionWorkspace.jsx';
import useIsMobile from '../hooks/useIsMobile.js';
import { PatientLookupView } from './research/PatientLookupView.jsx';
import { GeneralOverviewView } from './research/GeneralOverviewView.jsx';
import { VariableCatalogView } from './research/VariableCatalogView.jsx';

// ── main component ────────────────────────────────────────────────────────────
export default function ResearchTab({ toast }) {
  const [archive, setArchive]         = useState(null);
  const [studies, setStudies]         = useState([]);
  const [selectedId, setSelectedId]   = useState(ARCHIVE_SCOPE);
  const [study, setStudy]             = useState(null);
  const [table, setTable]             = useState(ARCHIVE_DEFAULT_TABLE);
  const [rows, setRows]               = useState([]);
  const [columns, setColumns]         = useState([]);
  const [loading, setLoading]           = useState(false);
  const [initialLoading, setInitialLoading] = useState(true); // chỉ true lần đầu load trang
  const [tableLoading, setTableLoading] = useState(false);
  const [busy, setBusy]                 = useState(false);
  const [showWizard, setShowWizard]         = useState(false);
  const [wizardStep, setWizardStep]         = useState(1); // 1=info, 2=filter+preview, 3=review
  const [analysisPresets, setAnalysisPresets] = useState([]);
  const [wizardForm, setWizardForm]         = useState({ name: '', description: '', analysis_config: { preset: 'general', custom_fields: [] } });
  const [wizardFilters, setWizardFilters]   = useState({
    tuoiMin: '', tuoiMax: '', gioi: '',
    xnList: [],    // [{ ten, min, max }]
    cdhaList: [],  // [string]
    chanDoan: '',
  });
  const [wizardRows, setWizardRows]         = useState([]); // preview rows từ archive
  const [wizardCols, setWizardCols]         = useState([]);
  const [wizardLoadingPreview, setWizardLoadingPreview] = useState(false);
  const [wizardExcluded, setWizardExcluded] = useState(new Set()); // Mã NC bị loại
  const [editMode, setEditMode]             = useState(false); // chế độ sửa danh sách mẫu
  const [deleteConfirm, setDeleteConfirm]   = useState(null); // studyId cần xác nhận xóa
  const [filters, setFilters]         = useState({ q: '', patient: '', from: '', to: '', hideSensitive: true });
  const [archiveOptions, setArchiveOptions] = useState(() => ({ headless: true, fromDate: '2026-01-01', toDate: todayInputDate() }));
  const [studyOptions, setStudyOptions]     = useState({ headless: true });
  const [showLog, setShowLog]               = useState(false);
  const [logLines, setLogLines]             = useState([]);
  const [caseTraces, setCaseTraces]         = useState([]);
  const [caseTraceRedact, setCaseTraceRedact] = useState(true);
  const [logLoading, setLogLoading]         = useState(false);
  const [coverage, setCoverage]             = useState(null);
  const [statusRows, setStatusRows]         = useState([]);
  const [progressSnapshot, setProgressSnapshot] = useState(null);
  const [statusLoading, setStatusLoading]   = useState(false);
  const [lastUpdateSummary, setLastUpdateSummary] = useState(null);
  const [archiveMode, setArchiveMode]       = useState('overview'); // overview | update | patient | variables (tạo nghiên cứu)
  const [studyMode, setStudyMode]           = useState('data');     // data | collect
  const isMobile = useIsMobile();
  const [generalOverview, setGeneralOverview] = useState(null);
  const [generalOverviewLoading, setGeneralOverviewLoading] = useState(false);
  const [generalOverviewQuery, setGeneralOverviewQuery] = useState('');
  const [generalOverviewMissingOnly, setGeneralOverviewMissingOnly] = useState(false);
  const [researchError, setResearchError] = useState('');
  const [patientHistoryError, setPatientHistoryError] = useState('');
  const [patientHistoryMeta, setPatientHistoryMeta] = useState(null);
  const [automationRun, setAutomationRun] = useState({ kind: '', status: 'idle', current: '', steps: [], error: '', warning: '' });
  const [patientQuery, setPatientQuery]     = useState('');
  const [patientHistory, setPatientHistory] = useState(null);
  const [patientHistoryLoading, setPatientHistoryLoading] = useState(false);
  // Quyền xem dữ liệu có định danh (null = chưa biết). Khi đang khóa, tab Tra cứu người
  // bệnh hiện hướng dẫn thay vì gọi API rồi báo lỗi đỏ.
  const [identifiedAccess, setIdentifiedAccess] = useState(null);
  const [variableCatalog, setVariableCatalog] = useState(null);
  const [variableCatalogLoading, setVariableCatalogLoading] = useState(false);
  const [variableCatalogError, setVariableCatalogError] = useState('');
  const [variableQuery, setVariableQuery]   = useState('');
  const [questionnaireVariables, setQuestionnaireVariables] = useState('');
  const [variableGroupFilter, setVariableGroupFilter] = useState('admin');
  const [variableTypeFilter, setVariableTypeFilter] = useState('all');
  const [variableFillFilter, setVariableFillFilter] = useState('all');
  const [showTechnicalVariables, setShowTechnicalVariables] = useState(false);
  const [selectedVariableIds, setSelectedVariableIds] = useState(() => new Set());
  const [variableAggregations, setVariableAggregations] = useState({});
  const [variableSurveyLabels, setVariableSurveyLabels] = useState({});
  const [variableConditions, setVariableConditions] = useState([]);
  const [variableStudyDraft, setVariableStudyDraft] = useState({ name: '', description: '' });
  const [variablePreview, setVariablePreview] = useState(null);
  const [variablePreviewLoading, setVariablePreviewLoading] = useState(false);
  const [variablePreviewError, setVariablePreviewError] = useState('');
  const [variablePreviewConfirmed, setVariablePreviewConfirmed] = useState(false);

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
  // loadSummary: cập nhật sidebar/metadata, KHÔNG set loading (không xóa bảng)
  const loadSummary = useCallback(async (showSpinner = false) => {
    if (showSpinner) setLoading(true);
    try {
      const [archiveRes, studiesRes] = await Promise.all([
        api.getResearchArchive(),
        api.listResearchStudies(),
      ]);
      const list = Array.isArray(studiesRes.studies) ? studiesRes.studies : [];
      setArchive(archiveRes.archive || null);
      if (archiveRes.archive) {
        const today = todayInputDate();
        const savedToDate = text(archiveRes.archive.scan_to_date);
        setArchiveOptions(prev => ({
          ...prev,
          fromDate: archiveRes.archive.scan_from_date || prev.fromDate || '2026-01-01',
          // Khoảng quét mặc định luôn mở rộng tới hôm nay; metadata cũ không được kéo lùi về ngày cũ.
          toDate:   savedToDate && savedToDate > today ? savedToDate : today,
        }));
      }
      setStudies(list);
      if (selectedId !== ARCHIVE_SCOPE && !list.some(s => s.id === selectedId)) setSelectedId(ARCHIVE_SCOPE);
    } catch (e) { showErrorOnce(e); }
    finally { if (showSpinner) setLoading(false); }
  }, [selectedId, showErrorOnce]);

  // loadTable: load dữ liệu bảng — giữ rows cũ trong lúc chờ, chỉ fade nhẹ
  const loadTable = useCallback(async (scopeId = selectedId, tableKey = table) => {
    setTableLoading(true);
    try {
      if (scopeId === ARCHIVE_SCOPE) {
        const r = await api.getResearchArchiveData({ table: tableKey, runId: 'latest', redact: filters.hideSensitive });
        setArchive(r.archive || null); setStudy(null);
        setRows(sortRowsForDisplay(tableKey, Array.isArray(r.rows) ? r.rows : []));
        setColumns(Array.isArray(r.columns) ? r.columns : []);
      } else {
        const r = await api.getResearchData(scopeId, { table: tableKey, runId: 'latest', redact: filters.hideSensitive });
        setStudy(r.study || null);
        setRows(sortRowsForDisplay(tableKey, Array.isArray(r.rows) ? r.rows : []));
        setColumns(Array.isArray(r.columns) ? r.columns : []);
      }
    } catch (e) {
      // Nghiên cứu chưa lấy dữ liệu lần nào: bảng trống là bình thường, màn hình tự hướng dẫn
      // sang Thu thập dữ liệu; không bật thông báo lỗi đỏ.
      if (!/chưa có run/i.test(String(e?.message || ''))) showErrorOnce(e);
      setRows([]); setColumns([]);
    } finally {
      setTableLoading(false);
      setInitialLoading(false); // sau lần load đầu tiên, không bao giờ xóa trắng nữa
    }
  }, [selectedId, table, filters.hideSensitive, showErrorOnce]);

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

  const loadGeneralOverview = useCallback(async (scopeId = selectedId, { silent = false } = {}) => {
    if (!silent) setGeneralOverviewLoading(true);
    try {
      const fetchTable = tableKey => (
        scopeId === ARCHIVE_SCOPE
          ? api.getResearchArchiveData({ table: tableKey, runId: 'latest', redact: filters.hideSensitive })
          : api.getResearchData(scopeId, { table: tableKey, runId: 'latest', redact: filters.hideSensitive })
      );
      const fetchProgress = () => (
        scopeId === ARCHIVE_SCOPE
          ? api.getResearchArchiveProgress({ runId: 'latest' })
          : api.getResearchStudyProgress(scopeId, { runId: 'latest' })
      );
      const fetchCoverage = () => (
        scopeId === ARCHIVE_SCOPE
          ? api.getResearchArchiveCoverage({ runId: 'latest' })
          : api.getResearchStudyCoverage(scopeId, { runId: 'latest' })
      );

      // Dùng cùng một snapshot backend cho số lượng và dùng extract_status đầy đủ
      // cho bảng theo dõi. Không trộn rows.length của dữ liệu đã redact với metadata.
      const [patientRes0, encounterRes, statusRes, progressRes, coverageRes] = await Promise.all([
        fetchTable('patient_master'),
        fetchTable('encounters'),
        fetchTable('extract_status'),
        fetchProgress(),
        fetchCoverage(),
      ]);
      let patientRes = patientRes0;
      if (!Array.isArray(patientRes?.rows) || !patientRes.rows.length) {
        patientRes = await fetchTable(scopeId === ARCHIVE_SCOPE ? 'initial_list' : 'cohort');
      }

      const nextProgress = progressRes?.progress || null;
      const nextCoverage = coverageRes?.coverage || null;
      const sourceMeta = scopeId === ARCHIVE_SCOPE ? archive : study;
      setProgressSnapshot(nextProgress);
      setCoverage(nextCoverage);
      setGeneralOverview(buildGeneralOverviewModel({
        patientRows: Array.isArray(patientRes?.rows) ? patientRes.rows : [],
        encounterRows: Array.isArray(encounterRes?.rows) ? encounterRes.rows : [],
        statusRows: Array.isArray(statusRes?.rows) ? statusRes.rows : [],
        coverage: nextCoverage,
        progressSnapshot: nextProgress,
        source: sourceMeta,
        isArchive: scopeId === ARCHIVE_SCOPE,
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
  }, [selectedId, filters.hideSensitive, archive, study, showErrorOnce]);

  const loadStatusRows = useCallback(async (scopeId = selectedId, { silent = false } = {}) => {
    if (!silent) setStatusLoading(true);
    try {
      const r = scopeId === ARCHIVE_SCOPE
        ? await api.getResearchArchiveData({ table: 'extract_status', runId: 'latest' })
        : await api.getResearchData(scopeId, { table: 'extract_status', runId: 'latest' });
      const nextRows = Array.isArray(r.rows) ? r.rows : [];
      setStatusRows(nextRows);
      return nextRows;
    } catch (_) {
      setStatusRows([]);
      return [];
    } finally {
      if (!silent) setStatusLoading(false);
    }
  }, [selectedId]);

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
  }, [selectedId]);

  const reloadCurrentView = useCallback(async () => {
    await loadSummary(true);
    await loadProgressSnapshot(selectedId, { silent: true });
    if (selectedId === ARCHIVE_SCOPE) {
      if (archiveMode === 'overview') await loadGeneralOverview(selectedId);
      return;
    }
    await Promise.all([loadTable(selectedId, table), loadCoverage(selectedId)]);
  }, [loadSummary, loadTable, loadCoverage, loadGeneralOverview, loadProgressSnapshot, selectedId, table, archiveMode]);

  const ensureIdentifiedAccess = useCallback(async () => {
    try {
      const r = await api.getResearchIdentifiedAccess();
      const next = { allowed: Boolean(r?.allowed), env_enabled: Boolean(r?.env_enabled), role_ok: Boolean(r?.role_ok) };
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
    if (access && !access.allowed) {
      setPatientHistory(null);
      setPatientHistoryError('');
      return;
    }
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
      if (r?.selection_required) {
        setPatientHistoryError('');
      } else if (!r?.patients?.length) {
        const msg = 'Không tìm thấy người bệnh trong kho hiện tại.';
        setPatientHistoryError(msg);
      }
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
    if (archiveMode === 'patient') ensureIdentifiedAccess();
  }, [archiveMode, ensureIdentifiedAccess]);

  const loadVariableCatalog = useCallback(async (options = {}) => {
    const silentError = Boolean(options?.silentError);
    setVariableCatalogLoading(true);
    setVariableCatalogError('');
    try {
      const r = await api.getResearchArchiveVariableCatalog({ runId: 'latest' });
      setVariableCatalog(r.catalog || null);
      setVariableCatalogError('');
    } catch (e) {
      const msg = String(e?.message || e || 'Không tải được danh mục biến.');
      setVariableCatalog(null);
      setVariableCatalogError(msg);
      if (!silentError) showErrorOnce(e);
    }
    finally { setVariableCatalogLoading(false); }
  }, [showErrorOnce]);

  useEffect(() => {
    if (!(isArchive && archiveMode === 'variables')) return;
    const runKey = `archive:${archive?.latest_run?.id || 'latest'}`;
    if (variableCatalogAutoKeyRef.current === runKey) return;
    if (!variableCatalogLoading) {
      variableCatalogAutoKeyRef.current = runKey;
      loadVariableCatalog({ silentError: true });
    }
  }, [isArchive, archiveMode, archive?.latest_run?.id, variableCatalogLoading, loadVariableCatalog]);

  useEffect(() => { loadSummary(true); }, []); // eslint-disable-line
  useEffect(() => {
    const ids = tableIdsForScope(selectedId === ARCHIVE_SCOPE);
    if (!ids.includes(table)) { setTable(defaultTableForScope(selectedId === ARCHIVE_SCOPE)); return; }
    loadProgressSnapshot(selectedId, { silent: true });
    if (selectedId === ARCHIVE_SCOPE) {
      setTableLoading(false);
      setInitialLoading(false);
      return;
    }
    loadTable(selectedId, table);
    loadCoverage(selectedId);
  }, [selectedId, table, archiveMode]); // eslint-disable-line

  useEffect(() => {
    if (!(isArchive && archiveMode === 'overview')) return;
    loadGeneralOverview(ARCHIVE_SCOPE, { silent: true });
    // Chỉ tự tải khi đổi run hoặc đổi chế độ ẩn định danh.
    // Không phụ thuộc identity của callback để tránh vòng tải lại khi summary auto-poll cập nhật object archive.
  }, [isArchive, archiveMode, archive?.latest_run?.id, filters.hideSensitive]); // eslint-disable-line

  // Auto-poll: progress cần realtime, summary thì chậm hơn để không tự tạo 429 khi task dài.
  useEffect(() => {
    const runIsActive = archive?.latest_run?.id && (
      archive?.latest_run?.done_patients < archive?.latest_run?.patients_count ||
      archive?.latest_run?.patients_count === 0
    );
    const taskIsActive = Boolean(progressSnapshot?.active_task && ['queued', 'running'].includes(String(progressSnapshot.active_task.status || '').toLowerCase()));
    const active = busy || runIsActive || taskIsActive;
    const intervalMs = active ? 2500 : 15000;
    const tid = setInterval(() => {
      loadProgressSnapshot(selectedId, { silent: true });
      const now = Date.now();
      if (active && now - summaryPollRef.current > 10000) {
        summaryPollRef.current = now;
        loadSummary(false);
      }
    }, intervalMs);
    return () => clearInterval(tid);
  }, [busy, archive, progressSnapshot?.active_task?.status, selectedId, loadSummary, loadProgressSnapshot]);

  const activeStudy  = useMemo(() => studies.find(s => s.id === selectedId) || study, [studies, selectedId, study]);
  const activeSource = isArchive ? archive : activeStudy;
  const latest       = activeSource?.latest_run || null;
  const operationSnapshot = useMemo(
    () => progressSnapshot || summarizeStatusRows(statusRows, activeSource, coverage, isArchive),
    [progressSnapshot, statusRows, activeSource, coverage, isArchive]
  );
  const remoteTaskActive = Boolean(operationSnapshot?.active_task && ['queued', 'running'].includes(String(operationSnapshot.active_task.status || '').toLowerCase()));
  const uiBusy = busy || remoteTaskActive;

  const filteredRows = useMemo(() => {
    const q       = lower(filters.q);
    const patient = lower(filters.patient);
    const from    = filters.from ? new Date(`${filters.from}T00:00:00`) : null;
    const to      = filters.to   ? new Date(`${filters.to}T23:59:59`)   : null;
    return rows.filter(row => {
      if (q && !lower(columns.map(c => row?.[c]).join(' ')).includes(q)) return false;
      if (patient) {
        const codes = lower([pick(row, ['Mã NC','Ma NC','research_code']), pick(row, ['Mã BN','Ma BN','MABN','patient_code'])].join(' '));
        if (!codes.includes(patient)) return false;
      }
      return rowInDateRange(row, columns, from, to);
    });
  }, [rows, columns, filters]);

  const visibleColumns = useMemo(
    () => filters.hideSensitive ? columns.filter(c => !SENSITIVE_COLUMNS.has(c)) : columns,
    [columns, filters.hideSensitive]
  );

  // ── Wizard helpers ────────────────────────────────────────────────────────
  const openWizard = () => {
    setWizardStep(1);
    setWizardForm({ name: '', description: '', analysis_config: { preset: 'general', custom_fields: [] } });
    setWizardFilters({ tuoiMin:'', tuoiMax:'', gioi:'', xnList:[], cdhaList:[], chanDoan:'' });
    setWizardRows([]); setWizardCols([]); setWizardExcluded(new Set());
    setShowWizard(true);
    // Load presets nếu chưa có
    if (!analysisPresets.length) {
      api.getAnalysisPresets().then(r => { if (r.presets) setAnalysisPresets(r.presets); }).catch(() => {});
    }
  };

  const loadWizardPreview = useCallback(async () => {
    setWizardLoadingPreview(true);
    try {
      // Dùng bảng phân tích đã chuẩn hóa làm nguồn chính để tạo nghiên cứu mới.
      // Bảng này đã gộp: BN + đợt điều trị + XN + CĐHA + phẫu thuật + hành chánh nếu đã nhập.
      let r = await api.getResearchArchiveData({ table: 'analysis_ready', runId: 'latest' });
      let merged = Array.isArray(r.rows) ? r.rows : [];
      if (!merged.length) {
        // Fallback khi kho chưa chuẩn hóa schema mới: dùng đợt điều trị + BN chuẩn.
        const enc = await api.getResearchArchiveData({ table: 'encounters', runId: 'latest' });
        const pat = await api.getResearchArchiveData({ table: 'patient_master', runId: 'latest' });
        const pMap = new Map((pat.rows || []).map(x => [x.patient_code || x['Mã BN'] || '', x]));
        merged = (enc.rows || []).map(row => ({ ...(pMap.get(row.patient_code || row['Mã BN'] || '') || {}), ...row }));
      }
      setWizardRows(merged);
      const colSet = new Set();
      for (const row of merged.slice(0, 200)) Object.keys(row || {}).forEach(k => colSet.add(k));
      setWizardCols(Array.from(colSet));
    } catch (e) { t(String(e.message || e), 'error'); }
    finally { setWizardLoadingPreview(false); }
  }, [t]);

  function wizardText(row, keys) {
    return keys.map(k => text(row?.[k])).filter(Boolean).join(' ');
  }
  function wizardNumber(row, keys) {
    for (const k of keys) {
      const raw = String(row?.[k] ?? '').replace(',', '.');
      const m = raw.match(/[-+]?\d+(?:\.\d+)?/);
      if (m) return Number(m[0]);
    }
    return NaN;
  }

  // Lọc wizard rows theo wizardFilters (lọc trên bảng phân tích đã gộp)
  const wizardFiltered = useMemo(() => {
    const f = wizardFilters;
    return wizardRows.filter(row => {
      const tuoi = wizardNumber(row, ['age', 'Tuổi', 'tuoi']);
      if (f.tuoiMin && (Number.isNaN(tuoi) || tuoi < Number(f.tuoiMin))) return false;
      if (f.tuoiMax && (Number.isNaN(tuoi) || tuoi > Number(f.tuoiMax))) return false;

      if (f.gioi) {
        const g = lower(wizardText(row, ['sex', 'GT', 'Giới', 'Giới tính']));
        if (!g.includes(lower(f.gioi))) return false;
      }

      if (f.chanDoan) {
        const cd = lower(wizardText(row, [
          'diagnosis_raw', 'admission_diagnosis', 'discharge_diagnosis', 'comorbidity_text', 'complication_text',
          'Chẩn đoán', 'Chan doan', 'chan_doan', 'diagnosis', 'imaging_summary',
        ]));
        if (!cd.includes(lower(f.chanDoan))) return false;
      }

      for (const xn of (f.xnList || [])) {
        if (!xn.ten) continue;
        const wanted = lower(xn.ten);
        const aliases = {
          hb: ['hb', 'hemoglobin', 'hgb'],
          hct: ['hct', 'hematocrit'],
          neutrophil: ['neutrophil', 'neu'],
          lymphocyte: ['lymphocyte', 'lym'],
          monocyte: ['monocyte', 'mono'],
          rdw: ['rdw'],
          plt: ['plt', 'platelet', 'tiểu cầu'],
        };
        const aliasList = aliases[wanted] || [wanted];
        const colKey = Object.keys(row).find(k => aliasList.some(a => lower(k).includes(lower(a))));
        const val = colKey ? wizardNumber(row, [colKey]) : NaN;
        if (xn.min && (Number.isNaN(val) || val < Number(xn.min))) return false;
        if (xn.max && (Number.isNaN(val) || val > Number(xn.max))) return false;
        if (!xn.min && !xn.max && Number.isNaN(val)) return false;
      }

      for (const cdha of (f.cdhaList || [])) {
        if (!cdha) continue;
        const cdhaText = lower(wizardText(row, ['imaging_summary', 'CĐHA', 'cdha', 'service_name_raw', 'conclusion_text', 'result_text']));
        if (!cdhaText.includes(lower(cdha))) return false;
      }
      return true;
    });
  }, [wizardRows, wizardFilters]);

  const wizardFinalRows = useMemo(
    () => wizardFiltered.filter(r => !wizardExcluded.has(r.encounter_id || r.research_code || r.patient_code || r['Mã NC'] || r['Mã BN'] || '')),
    [wizardFiltered, wizardExcluded]
  );

  const createStudyFromWizard = useCallback(async () => {
    const name = text(wizardForm.name);
    if (!name) { t('Cần nhập tên nghiên cứu.', 'error'); return; }
    if (!wizardFinalRows.length) { t('Danh sách mẫu rỗng.', 'error'); return; }
    setBusy(true);
    try {
      const r = await api.createResearchStudy({ name, description: wizardForm.description, analysis_config: wizardForm.analysis_config });
      const studyId = r.study?.id;
      if (!studyId) throw new Error('Không lấy được ID nghiên cứu.');
      await api.saveCohortFromFiltered(studyId, wizardFinalRows);
      await loadSummary();
      await loadCoverage(ARCHIVE_SCOPE);
      setSelectedId(studyId);
      setTable('cohort');
      setStudyMode('collect');
      setShowWizard(false);
      t(`Đã tạo nghiên cứu "${name}" với ${wizardFinalRows.length} BN.`, 'ok');
    } catch (e) { t(String(e.message || e), 'error'); }
    finally { setBusy(false); }
  }, [wizardForm, wizardFinalRows, loadSummary, toast]);

  const deleteStudy = useCallback(async (studyId) => {
    setBusy(true);
    try {
      const r = await api.deleteResearchStudy(studyId);
      t(r.message || 'Đã xóa nghiên cứu.', 'ok');
      await loadSummary();
      if (selectedId === studyId) { setSelectedId(ARCHIVE_SCOPE); setTable(ARCHIVE_DEFAULT_TABLE); setArchiveMode('overview'); }
    } catch (e) { t(String(e.message || e), 'error'); }
    finally { setBusy(false); setDeleteConfirm(null); }
  }, [selectedId, loadSummary, toast]);

  // Lưu cohort sau khi chỉnh sửa thủ công (editMode)
  const saveEditedCohort = useCallback(async () => {
    if (!activeStudy?.id) return;
    setBusy(true);
    try {
      await api.saveCohortFromFiltered(activeStudy.id, filteredRows);
      t('Đã lưu danh sách mẫu.', 'ok');
      setEditMode(false);
      await loadTable(activeStudy.id, 'cohort');
    } catch (e) { t(String(e.message || e), 'error'); }
    finally { setBusy(false); }
  }, [activeStudy, filteredRows, loadTable, toast]);

  const runArchive = useCallback(async (resume = true) => {
    setBusy(true);
    try {
      const today = todayInputDate();
      const options = { ...archiveOptions, toDate: archiveOptions.toDate || today };
      const r = await api.runResearchArchive({ ...options, resume, mode: 'initial' });
      t(r.message || 'Đã quét danh sách ban đầu.', 'ok');
      await loadSummary();
      setSelectedId(ARCHIVE_SCOPE); setArchiveMode('update');
      await loadProgressSnapshot(ARCHIVE_SCOPE, { silent: true });
    } catch (e) { t(String(e.message || e), 'error'); }
    finally { setBusy(false); }
  }, [archiveOptions, loadSummary, loadProgressSnapshot, t]);

  const runArchiveDeep = useCallback(async () => {
    setBusy(true);
    const beforeProgress = await loadProgressSnapshot(ARCHIVE_SCOPE, { silent: true });
    try {
      const today = todayInputDate();
      const options = { ...archiveOptions, toDate: archiveOptions.toDate || today };
      const r = await api.runResearchArchive({ ...options, resume: true, mode: 'deep', deep: true });
      t(r.message || 'Đã cập nhật dữ liệu gốc.', 'ok');
      await loadSummary();
      setSelectedId(ARCHIVE_SCOPE); setArchiveMode('update');
      const afterProgress = await loadProgressSnapshot(ARCHIVE_SCOPE, { silent: true });
      setLastUpdateSummary(diffProgressSnapshots(beforeProgress, afterProgress, 'Cập nhật XN & CĐHA'));
    } catch (e) { t(String(e.message || e), 'error'); }
    finally { setBusy(false); }
  }, [archiveOptions, loadSummary, loadTable, loadProgressSnapshot, toast]);

  const runPatientInfo = useCallback(async () => {
    setBusy(true);
    try {
      const options = isArchive
        ? { headless: archiveOptions.headless, fromDate: archiveOptions.fromDate, toDate: archiveOptions.toDate || todayInputDate() }
        : { headless: studyOptions.headless, fromDate: studyOptions.fromDate || archiveOptions.fromDate, toDate: studyOptions.toDate || archiveOptions.toDate || todayInputDate() };
      const r = isArchive
        ? await api.runResearchArchivePatientInfo(options)
        : await api.runResearchStudyPatientInfo(selectedId, options);
      t(r.message || 'Đã lấy thông tin khác.', 'ok');
      await loadSummary();
      await loadProgressSnapshot(selectedId, { silent: true });
      if (!isArchive) {
        setTable('patient_extra');
        await loadTable(selectedId, 'patient_extra');
      }
    } catch (e) { t(String(e.message || e), 'error'); }
    finally { setBusy(false); }
  }, [isArchive, selectedId, archiveOptions.headless, archiveOptions.fromDate, archiveOptions.toDate, studyOptions.headless, studyOptions.fromDate, studyOptions.toDate, loadSummary, loadTable, loadProgressSnapshot, t]);

  const runHchanhAuto = useCallback(async () => {
    setBusy(true);
    const scopeForStatus = isArchive ? ARCHIVE_SCOPE : selectedId;
    const beforeProgress = await loadProgressSnapshot(scopeForStatus, { silent: true });
    try {
      const options = isArchive
        ? { headless: archiveOptions.headless, fromDate: archiveOptions.fromDate, toDate: archiveOptions.toDate || todayInputDate(), files: ['profile', 'discharge', 'surgery'] }
        : { headless: studyOptions.headless, fromDate: studyOptions.fromDate || archiveOptions.fromDate, toDate: studyOptions.toDate || archiveOptions.toDate || todayInputDate(), files: ['profile', 'discharge', 'surgery'] };
      const r = isArchive
        ? await api.fetchHchanhForResearchArchive(options)
        : await api.fetchHchanhForResearchStudy(selectedId, options);
      t(r.message || 'Đã tự động lấy hành chánh từ EMR.', 'ok');
      await loadSummary();
      const afterProgress = await loadProgressSnapshot(scopeForStatus, { silent: true });
      setLastUpdateSummary(diffProgressSnapshots(beforeProgress, afterProgress, 'Cập nhật hồ sơ'));
      if (!isArchive) {
        setTable('analysis_ready');
        await loadTable(selectedId, 'analysis_ready');
      }
    } catch (e) { t(String(e.message || e), 'error'); }
    finally { setBusy(false); }
  }, [isArchive, selectedId, archiveOptions.headless, archiveOptions.fromDate, archiveOptions.toDate, studyOptions.headless, studyOptions.fromDate, studyOptions.toDate, loadSummary, loadTable, loadProgressSnapshot, t]);

  const runOrderHistoryAuto = useCallback(async () => {
    setBusy(true);
    const scopeForStatus = isArchive ? ARCHIVE_SCOPE : selectedId;
    const beforeProgress = await loadProgressSnapshot(scopeForStatus, { silent: true });
    try {
      const options = isArchive
        ? { headless: archiveOptions.headless, fromDate: archiveOptions.fromDate, toDate: archiveOptions.toDate || todayInputDate(), files: ['order_history'] }
        : { headless: studyOptions.headless, fromDate: studyOptions.fromDate || archiveOptions.fromDate, toDate: studyOptions.toDate || archiveOptions.toDate || todayInputDate(), files: ['order_history'] };
      const r = isArchive
        ? await api.fetchOrderHistoryForResearchArchive(options)
        : await api.fetchOrderHistoryForResearchStudy(selectedId, options);
      t(r.message || 'Đã tự động lấy lịch sử y lệnh từ EMR.', 'ok');
      await loadSummary();
      const afterProgress = await loadProgressSnapshot(scopeForStatus, { silent: true });
      setLastUpdateSummary(diffProgressSnapshots(beforeProgress, afterProgress, 'Cập nhật y lệnh'));
      if (!isArchive) {
        setTable('medication_orders');
        await loadTable(selectedId, 'medication_orders');
      }
    } catch (e) { t(String(e.message || e), 'error'); }
    finally { setBusy(false); }
  }, [isArchive, selectedId, archiveOptions.headless, archiveOptions.fromDate, archiveOptions.toDate, studyOptions.headless, studyOptions.fromDate, studyOptions.toDate, loadSummary, loadTable, loadProgressSnapshot, t]);

  // Gộp hành chánh + y lệnh thành 1 lần fetch
  const runHchanhAll = useCallback(async () => {
    setBusy(true);
    const scopeForStatus = isArchive ? ARCHIVE_SCOPE : selectedId;
    const beforeProgress = await loadProgressSnapshot(scopeForStatus, { silent: true });
    try {
      const r = isArchive
        ? await api.fetchHchanhAllForResearchArchive({ headless: archiveOptions.headless, fromDate: archiveOptions.fromDate, toDate: archiveOptions.toDate || todayInputDate() })
        : await api.fetchHchanhAllForResearchStudy(selectedId, { headless: studyOptions.headless, fromDate: studyOptions.fromDate || archiveOptions.fromDate, toDate: studyOptions.toDate || archiveOptions.toDate || todayInputDate() });
      t(r.message || 'Đã lấy hành chánh + y lệnh.', 'ok');
      await loadSummary();
      const afterProgress = await loadProgressSnapshot(scopeForStatus, { silent: true });
      setLastUpdateSummary(diffProgressSnapshots(beforeProgress, afterProgress, 'Cập nhật hồ sơ + y lệnh'));
      if (!isArchive) {
        setTable('analysis_ready');
        await loadTable(selectedId, 'analysis_ready');
      }
    } catch (e) { t(String(e.message || e), 'error'); }
    finally { setBusy(false); }
  }, [isArchive, selectedId, archiveOptions.headless, archiveOptions.fromDate, archiveOptions.toDate, studyOptions.headless, studyOptions.fromDate, studyOptions.toDate, loadSummary, loadTable, loadProgressSnapshot, t]);

  // Bổ sung phần thiếu — đọc extract_status, chỉ xử lý BN còn pending/error
  const [showMissingPanel, setShowMissingPanel] = useState(false);
  const [missingTypes, setMissingTypes] = useState(['profile', 'discharge', 'surgery', 'order_history', 'xn_cdha']);

  // Panel sửa analysis config cho study đang chọn
  const [showConfigPanel, setShowConfigPanel] = useState(false);
  const [editConfig, setEditConfig] = useState({ preset: 'general', custom_fields: [] });
  const openConfigPanel = useCallback(() => {
    const cur = activeStudy?.analysis_config || { preset: 'general', custom_fields: [] };
    setEditConfig({ preset: cur.preset || 'general', custom_fields: Array.isArray(cur.custom_fields) ? [...cur.custom_fields] : [] });
    if (!analysisPresets.length) {
      api.getAnalysisPresets().then(r => { if (r.presets) setAnalysisPresets(r.presets); }).catch(() => {});
    }
    setShowConfigPanel(true);
  }, [activeStudy, analysisPresets]);
  const saveAnalysisConfig = useCallback(async () => {
    if (!selectedId || isArchive) return;
    setBusy(true);
    try {
      const r = await api.updateStudyAnalysisConfig(selectedId, editConfig);
      t(r.message || 'Đã cập nhật cấu hình phân tích.', 'ok');
      setShowConfigPanel(false);
      await loadSummary();
    } catch (e) { t(String(e.message || e), 'error'); }
    finally { setBusy(false); }
  }, [selectedId, isArchive, editConfig, loadSummary, toast]);
  const runRefetchMissing = useCallback(async () => {
    if (!missingTypes.length) { t('Chọn ít nhất 1 loại dữ liệu cần lấy lại.', 'error'); return; }
    setBusy(true);
    const scopeForStatus = isArchive ? ARCHIVE_SCOPE : selectedId;
    const beforeProgress = await loadProgressSnapshot(scopeForStatus, { silent: true });
    try {
      const scope = isArchive ? ARCHIVE_API_SCOPE : selectedId;
      const options = isArchive
        ? { scope, missingTypes, headless: archiveOptions.headless, fromDate: archiveOptions.fromDate, toDate: archiveOptions.toDate || todayInputDate() }
        : { scope, missingTypes, headless: studyOptions.headless, fromDate: studyOptions.fromDate || archiveOptions.fromDate, toDate: studyOptions.toDate || archiveOptions.toDate || todayInputDate() };
      const r = await api.refetchMissingResearch(options);
      t(r.message || 'Đã lấy lại chỗ thiếu.', 'ok');
      setShowMissingPanel(false);
      await loadSummary();
      const afterProgress = await loadProgressSnapshot(scopeForStatus, { silent: true });
      setLastUpdateSummary(diffProgressSnapshots(beforeProgress, afterProgress, 'Bổ sung phần thiếu'));
      if (!isArchive) {
        setTable(primaryTableAfterRun(isArchive));
        await loadTable(selectedId, primaryTableAfterRun(isArchive));
      }
    } catch (e) { t(String(e.message || e), 'error'); }
    finally { setBusy(false); }
  }, [isArchive, selectedId, missingTypes, archiveOptions.headless, archiveOptions.fromDate, archiveOptions.toDate, studyOptions.headless, studyOptions.fromDate, studyOptions.toDate, loadSummary, loadTable, loadProgressSnapshot, t]);

  const runStudyData = useCallback(async (resume = true) => {
    if (isArchive || !selectedId) return;
    setBusy(true);
    const beforeProgress = await loadProgressSnapshot(selectedId, { silent: true });
    try {
      const r = await api.runResearchStudy(selectedId, { ...studyOptions, resume });
      t(r.message || 'Đã lấy XN/CĐHA cho nghiên cứu.', 'ok');
      await loadSummary();
      setTable('analysis_ready');
      await loadTable(selectedId, 'analysis_ready');
      const afterProgress = await loadProgressSnapshot(selectedId, { silent: true });
      setLastUpdateSummary(diffProgressSnapshots(beforeProgress, afterProgress, 'Cập nhật XN & CĐHA'));
    } catch (e) { t(String(e.message || e), 'error'); }
    finally { setBusy(false); }
  }, [isArchive, selectedId, studyOptions, loadSummary, loadTable, loadProgressSnapshot, t]);

  const updateAutomationStep = useCallback((index, patch) => {
    setAutomationRun(prev => ({
      ...prev,
      steps: prev.steps.map((step, i) => i === index ? { ...step, ...patch } : step),
    }));
  }, []);

  const runAutomaticWorkflow = useCallback(async ({ kind, steps, successMessage }) => {
    setBusy(true);
    setResearchError('');
    setAutomationRun({
      kind,
      status: 'running',
      current: steps[0]?.label || '',
      steps: steps.map(step => ({ label: step.label, status: 'pending', detail: '' })),
      error: '',
      warning: '',
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
          updateAutomationStep(index, {
            status: wasCancelled ? 'cancelled' : 'done',
            detail: text(result?.message || result?.summary?.message || ''),
          });
          if (wasCancelled) {
            const message = text(result?.message || 'Đã dừng theo yêu cầu. Có thể bấm Lấy dữ liệu/Cập nhật để chạy tiếp phần còn thiếu.');
            setAutomationRun(prev => ({
              ...prev,
              status: 'cancelled',
              current: '',
              warning: message,
            }));
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
      setAutomationRun(prev => ({
        ...prev,
        status: warnings.length ? 'warning' : 'done',
        current: '',
        warning: warnings.join(' | '),
      }));
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

  const runSimpleListScan = useCallback(async () => {
    if (!isArchive) {
      t('Quét danh sách chỉ thực hiện tại Kho dữ liệu gốc.', 'error');
      return;
    }
    const today = todayInputDate();
    const options = { ...archiveOptions, toDate: archiveOptions.toDate || today };
    await runAutomaticWorkflow({
      kind: 'scan',
      successMessage: 'Đã quét danh sách và cập nhật cơ sở dữ liệu.',
      steps: [
        {
          label: 'Quét danh sách người bệnh trên EMR',
          run: () => api.runResearchArchive({ ...options, resume: true, mode: 'initial' }),
        },
        {
          label: 'Chuẩn hóa danh sách và cập nhật SQLite',
          run: () => api.normalizeResearchArchive(),
        },
      ],
    });
    setSelectedId(ARCHIVE_SCOPE);
    setArchiveMode('update');
  }, [archiveOptions, isArchive, runAutomaticWorkflow, t]);

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
      await loadProgressSnapshot(isArchive ? ARCHIVE_SCOPE : selectedId, { silent: true });
    } catch (e) { t(String(e.message || e), 'error'); }
    finally { setBusy(false); }
  }, [isArchive, selectedId, archiveOptions.headless, archiveOptions.fromDate, archiveOptions.toDate, studyOptions.headless, studyOptions.fromDate, studyOptions.toDate, loadSummary, loadProgressSnapshot, t]);

  const runSimpleDataCollection = useCallback(async () => {
    const today = todayInputDate();
    const scope = isArchive ? ARCHIVE_API_SCOPE : selectedId;
    const fromDate = isArchive ? archiveOptions.fromDate : (studyOptions.fromDate || archiveOptions.fromDate);
    const toDate = isArchive ? (archiveOptions.toDate || today) : (studyOptions.toDate || archiveOptions.toDate || today);
    const headless = isArchive ? archiveOptions.headless : studyOptions.headless;

    if (isArchive && !archive?.latest_run?.id) { showErrorOnce('Cần bấm Quét danh sách trước khi lấy dữ liệu.'); return; }
    if (!isArchive && !activeStudy?.has_cohort) { showErrorOnce('Nghiên cứu chưa có danh sách mẫu.'); return; }

    setResearchError('');
    const beforeProgress = await loadProgressSnapshot(selectedId, { silent: true });
    const moduleMap = new Map((beforeProgress?.modules || []).map(m => [m.key, m]));
    const missingTypes = ['xn_cdha', 'profile', 'discharge', 'surgery', 'order_history'].filter(key => {
      const m = moduleMap.get(key);
      if (!m) return true;
      return Number(m.done || 0) < Number(m.total || beforeProgress?.total || 0) || Number(m.error || 0) > 0 || Number(m.missing || 0) > 0 || Number(m.waiting || 0) > 0;
    });
    const hasProgress = Number(beforeProgress?.total || 0) > 0 && (Number(beforeProgress?.counts?.done || 0) + Number(beforeProgress?.counts?.error || 0) + Number(beforeProgress?.counts?.missing || 0) > 0);

    let steps = [];
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
      { label: 'Chuẩn hóa và cập nhật SQLite', run: () => isArchive ? api.normalizeResearchArchive() : api.normalizeResearchStudy(selectedId) },
      { label: 'Cập nhật mã danh mục phân tích', run: () => isArchive ? api.buildResearchArchiveEncodedDataset() : api.buildResearchStudyEncodedDataset(selectedId) },
      { label: 'Cập nhật dataset cuối', run: () => isArchive ? api.finalizeResearchArchiveDataset() : api.finalizeResearchStudyDataset(selectedId), optional: true },
    );

    await runAutomaticWorkflow({
      kind: 'collect',
      steps,
      successMessage: missingTypes.length && hasProgress
        ? 'Đã bổ sung phần còn thiếu và cập nhật SQLite.'
        : hasProgress
          ? 'Dữ liệu đã đủ; chỉ cập nhật SQLite và dataset.'
          : 'Đã lấy dữ liệu và cập nhật SQLite.',
    });
    const afterProgress = await loadProgressSnapshot(selectedId, { silent: true });
    setLastUpdateSummary(diffProgressSnapshots(beforeProgress, afterProgress, 'Lấy dữ liệu'));
  }, [
    activeStudy?.has_cohort, archive?.latest_run?.id, archiveOptions, isArchive,
    loadProgressSnapshot, runAutomaticWorkflow, selectedId, showErrorOnce, studyOptions,
  ]);

  const normalizeCurrent = useCallback(async () => {
    setBusy(true);
    try {
      const r = isArchive ? await api.normalizeResearchArchive() : await api.normalizeResearchStudy(selectedId);
      t(r.message || 'Đã chuẩn hóa dữ liệu.', 'ok');
      await loadSummary();
      await loadCoverage(selectedId);
      const next = primaryTableAfterRun(isArchive);
      await loadProgressSnapshot(selectedId, { silent: true });
      if (!isArchive) {
        setTable(next);
        await loadTable(selectedId, next);
      }
    } catch (e) { t(String(e.message || e), 'error'); }
    finally { setBusy(false); }
  }, [isArchive, selectedId, loadSummary, loadCoverage, loadTable, loadProgressSnapshot, t]);

  const finalizeDataset = useCallback(async () => {
    setBusy(true);
    try {
      const r = isArchive
        ? await api.finalizeResearchArchiveDataset()
        : await api.finalizeResearchStudyDataset(selectedId);
      t(r.message || 'Đã tạo dataset cuối.', 'ok');
      await loadSummary();
      await loadCoverage(selectedId);
      setTable('analysis_final');
      await loadTable(selectedId, 'analysis_final');
    } catch (e) {
      t(String(e.message || e), 'error');
      if (e?.coverage) setCoverage(e.coverage);
    } finally { setBusy(false); }
  }, [isArchive, selectedId, loadSummary, loadCoverage, loadTable, t]);

  const buildEncodedDataset = useCallback(async () => {
    setBusy(true);
    try {
      const r = isArchive
        ? await api.buildResearchArchiveEncodedDataset()
        : await api.buildResearchStudyEncodedDataset(selectedId);
      const added = r?.new_entries
        ? Object.values(r.new_entries).reduce((sum, n) => sum + Number(n || 0), 0)
        : 0;
      t(r.message || `Đã tạo dữ liệu encoded${added ? `, thêm ${added} mã mới vào dictionary.` : '.'}`, 'ok');
      await loadSummary();
      setTable('analysis_ready_encoded');
      await loadTable(selectedId, 'analysis_ready_encoded');
    } catch (e) { t(String(e.message || e), 'error'); }
    finally { setBusy(false); }
  }, [isArchive, selectedId, loadSummary, loadTable, t]);

  const cleanGeneratedData = useCallback(async () => {
    const ok = window.confirm('Dọn file phụ có thể tạo lại: encoded/, file debug hành chánh/y lệnh và log phụ. Dữ liệu gốc và dữ liệu chuẩn hóa sẽ được giữ nguyên. Tiếp tục?');
    if (!ok) return;
    setBusy(true);
    try {
      const r = isArchive
        ? await api.cleanResearchArchiveGenerated({ encoded: true, debug: true, derived: false })
        : await api.cleanResearchStudyGenerated(selectedId, { encoded: true, debug: true, derived: false });
      const mb = Number(r?.removed_bytes || 0) / 1024 / 1024;
      t(r.message || `Đã dọn file phụ${mb ? `, giảm khoảng ${mb.toFixed(1)} MB.` : '.'}`, 'ok');
      await loadSummary();
      const next = primaryTableAfterRun(isArchive);
      setTable(next);
      await loadTable(selectedId, next);
    } catch (e) { t(String(e.message || e), 'error'); }
    finally { setBusy(false); }
  }, [isArchive, selectedId, loadSummary, loadTable, t]);

  const loadLog = useCallback(async () => {
    setLogLoading(true);
    try {
      const [r, trace] = await Promise.all([
        isArchive
          ? api.getResearchArchiveLog({ runId: 'latest', lines: 800 })
          : api.getResearchStudyLog(selectedId, { runId: 'latest', lines: 800 }),
        isArchive
          ? api.getResearchArchiveCaseTrace({ runId: 'latest', limit: 10, redact: caseTraceRedact })
          : api.getResearchStudyCaseTrace(selectedId, { runId: 'latest', limit: 10, redact: caseTraceRedact }),
      ]);
      setLogLines(Array.isArray(r.lines) ? r.lines : []);
      setCaseTraces(Array.isArray(trace.cases) ? trace.cases : []);
    } catch (e) {
      setLogLines([`Lỗi: ${e.message}`]);
      setCaseTraces([]);
    }
    finally { setLogLoading(false); }
  }, [isArchive, selectedId, caseTraceRedact]);

  const exportCurrent = useCallback(async () => {
    if (!visibleColumns.length) { t('Không có dữ liệu để xuất.', 'error'); return; }
    const hasClientFilters = Boolean(filters.q || filters.patient || filters.from || filters.to);
    const safe = (isArchive ? 'du_lieu_goc' : selectedId || 'nghien_cuu').replace(/[^a-zA-Z0-9_-]+/g,'_');
    if (!filters.hideSensitive && hasClientFilters) {
      t('Không xuất dữ liệu định danh bằng bộ lọc phía trình duyệt vì thao tác đó không tạo audit đầy đủ. Hãy bỏ bộ lọc hoặc bật ẩn thông tin nhạy cảm.', 'error');
      return;
    }
    if (!hasClientFilters) {
      try {
        const r = isArchive
          ? await api.downloadResearchArchiveCsv({ table, runId: 'latest', redact: filters.hideSensitive })
          : await api.downloadResearchStudyCsv(selectedId, { table, runId: 'latest', redact: filters.hideSensitive });
        saveBlob(r.filename || `${safe}_${table}.csv`, r.blob);
        t(filters.hideSensitive ? 'Đã xuất toàn bộ CSV đã ẩn định danh.' : 'Đã xuất toàn bộ CSV từ server.', 'ok');
        return;
      } catch (e) {
        t(String(e.message || e), 'error');
        return;
      }
    }
    if (!filteredRows.length) { t('Không có dữ liệu để xuất.', 'error'); return; }
    downloadCsv(`${safe}_${table}_${new Date().toISOString().slice(0,10)}.csv`, visibleColumns, filteredRows);
    t(`Đã xuất ${compactNumber(filteredRows.length)} dòng đang lọc trên UI.`, 'ok');
  }, [filteredRows, visibleColumns, filters, isArchive, selectedId, table, t]);

  const dismissAlert = useCallback(async () => {
    try { await api.dismissFatalAlert(); await loadSummary(false); } catch (e) { t(String(e), 'error'); }
  }, [loadSummary]);

  const resetFilters = () => setFilters({ q: '', patient: '', from: '', to: '', hideSensitive: true });

  // ── derived counts for sidebar ────────────────────────────────────────────
  const archiveInitial = datasetCount(archive, 'initial_list', true);
  const archiveDeep    = datasetCount(archive, 'deep_source', true);

  const archiveAnalysis = datasetCount(archive, 'analysis_ready', true);
  const archiveEncounters = datasetCount(archive, 'encounters', true);
  const archivePatients = datasetCount(archive, 'patient_master', true);
  const allCatalogVariables = useMemo(() => (
    variableCatalog?.groups || []
  ).flatMap(g => (g.variables || []).map(v => enhanceCatalogVariable(v, g))), [variableCatalog]);
  // Danh sách để duyệt/chọn: không lặp biến chung giữa các bảng rộng. allCatalogVariables
  // vẫn giữ đủ để nhận ra biến đã chọn từ trước (vd. patients.sex).
  const browseCatalogVariables = useMemo(() => dedupeWideTableVariables(allCatalogVariables), [allCatalogVariables]);
  const catalogGroupOptions = useMemo(() => {
    const counts = new Map();
    for (const v of browseCatalogVariables) {
      if (!showTechnicalVariables && v.technical_or_identity) continue;
      const key = v.clinical_group_key || v.group_key || 'other';
      counts.set(key, (counts.get(key) || 0) + 1);
    }
    return VARIABLE_CLINICAL_GROUPS
      .map(g => ({ ...g, count: counts.get(g.key) || 0 }))
      .filter(g => g.count > 0 && (showTechnicalVariables || g.key !== 'technical'));
  }, [browseCatalogVariables, showTechnicalVariables]);
  const questionnaireTerms = useMemo(() => [...new Set(
    String(questionnaireVariables || '')
      .split(/[\n;]+/)
      .map(x => lower(x).trim())
      .filter(x => x.length >= 2)
  )], [questionnaireVariables]);
  const filteredCatalogVariables = useMemo(() => {
    const q = lower(variableQuery);
    const terms = [q, ...questionnaireTerms].filter(Boolean);
    return browseCatalogVariables.filter(v => {
      if (!showTechnicalVariables && v.technical_or_identity) return false;
      if (variableGroupFilter !== 'all' && v.clinical_group_key !== variableGroupFilter) return false;
      if (variableTypeFilter !== 'all' && v.type !== variableTypeFilter) return false;
      if (variableFillFilter === 'high' && Number(v.fill_rate || 0) < 80) return false;
      if (variableFillFilter === 'medium' && (Number(v.fill_rate || 0) < 30 || Number(v.fill_rate || 0) >= 80)) return false;
      if (variableFillFilter === 'low' && Number(v.fill_rate || 0) >= 30) return false;
      if (!terms.length) return true;
      const haystack = lower(`${v.clinical_group_label} ${v.clinical_section} ${v.source_group_label} ${v.display_label} ${v.raw_name} ${v.description} ${v.type} ${v.role} ${v.sample_values?.map(x => x.value).join(' ')}`);
      const labels = [lower(v.display_label), lower(v.raw_name)].filter(x => x.length >= 2);
      return terms.some(term => haystack.includes(term) || labels.some(label => term.includes(label)));
    });
  }, [browseCatalogVariables, variableQuery, questionnaireTerms, variableGroupFilter, variableTypeFilter, variableFillFilter, showTechnicalVariables]);
  const filteredVariableSections = useMemo(() => groupVariablesBySection(filteredCatalogVariables), [filteredCatalogVariables]);
  const selectedVariables = useMemo(() => allCatalogVariables.filter(v => selectedVariableIds.has(v.id)), [allCatalogVariables, selectedVariableIds]);
  const selectedCoverage = useMemo(() => {
    const rates = selectedVariables.map(v => Number(v.fill_rate || 0));
    return {
      high: rates.filter(x => x >= 80).length,
      medium: rates.filter(x => x >= 30 && x < 80).length,
      low: rates.filter(x => x < 30).length,
      lowest: rates.length ? Math.min(...rates) : 0,
    };
  }, [selectedVariables]);
  const selectedVariablesByGroup = useMemo(() => {
    const map = new Map();
    for (const v of selectedVariables) {
      const key = v.clinical_group_key || v.group_key || 'other';
      if (!map.has(key)) map.set(key, { label: v.clinical_group_label || v.group_label || 'Khác', variables: [] });
      map.get(key).variables.push(v);
    }
    return [...map.values()];
  }, [selectedVariables]);
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
    const coreName = /^(sex|birth_year|age|admission_date|discharge_date|hospital_stay_days|diagnosis_raw|surgery_date|surgery_name)$/i;
    addVariables(browseCatalogVariables.filter(v => coreName.test(String(v.name || ''))));
  }, [browseCatalogVariables, addVariables]);
  const addConditionForVariable = useCallback((variable) => {
    if (!variable) return;
    setVariableConditions(prev => [...prev, { id: `${Date.now()}_${prev.length}`, variable_id: variable.id, label: `${variable.group_label || variable.table_label}.${variable.display_label || variable.name}`, operator: variable.operators?.[0] || 'contains', value: '', value2: '' }]);
    setSelectedVariableIds(prev => new Set([...prev, variable.id]));
  }, []);
  const buildVariableSpec = useCallback(() => ({
    schema_version: 1,
    source: 'research_archive',
    created_at: new Date().toISOString(),
    run_id: variableCatalog?.run_id || latest?.id || '',
    selected_variables: selectedVariables.map(v => ({
      id: v.id,
      table: v.table,
      table_label: v.group_label || v.table_label || '',
      name: v.name,
      label: v.display_label || v.name,
      survey_label: variableSurveyLabels[v.id] || v.display_label || v.name,
      type: v.type,
      role: v.role,
      virtual_kind: v.virtual_kind || '',
      source_filter: v.source_filter || null,
      aggregation: variableAggregations[v.id] || 'list',
    })),
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
  }), [selectedVariables, variableAggregations, variableSurveyLabels, variableConditions, variableCatalog, latest, allCatalogVariables]);

  useEffect(() => {
    setVariablePreview(null);
    setVariablePreviewError('');
    setVariablePreviewConfirmed(false);
  }, [selectedVariableIds, variableAggregations, variableSurveyLabels, variableConditions]);

  const loadVariablePreview = useCallback(async () => {
    if (!selectedVariables.length) { t('Chọn ít nhất 1 biến để xem trước.', 'error'); return; }
    setVariablePreviewLoading(true);
    setVariablePreviewError('');
    setVariablePreviewConfirmed(false);
    try {
      const result = await api.previewResearchArchiveVariables({ variable_selection: buildVariableSpec(), limit: 20 });
      setVariablePreview(result);
      t(`Đã kiểm tra ${compactNumber(result.summary?.total || 0)} lượt điều trị.`, 'ok');
    } catch (error) {
      const message = String(error?.message || error || 'Không xem trước được dữ liệu.');
      setVariablePreviewError(message);
      t(message, 'error');
    } finally {
      setVariablePreviewLoading(false);
    }
  }, [selectedVariables.length, buildVariableSpec, t]);

  const exportVariableSpec = useCallback(() => {
    const spec = buildVariableSpec();
    const blob = new Blob([JSON.stringify(spec, null, 2)], { type: 'application/json;charset=utf-8' });
    saveBlob(`research_variable_spec_${new Date().toISOString().slice(0,10)}.json`, blob);
    t('Đã xuất danh sách biến và điều kiện dạng JSON.', 'ok');
  }, [buildVariableSpec, t]);

  const createStudyFromVariableSelection = useCallback(async () => {
    const name = text(variableStudyDraft.name);
    if (!name) { t('Nhập tên nghiên cứu trước khi tạo.', 'error'); return; }
    if (!selectedVariables.length) { t('Chọn ít nhất 1 biến cần lấy.', 'error'); return; }
    if (!variablePreview || !variablePreviewConfirmed) { t('Hãy xem trước dữ liệu và xác nhận bảng ánh xạ trước khi tạo.', 'error'); return; }
    setBusy(true);
    try {
      const spec = buildVariableSpec();
      const payload = {
        name,
        description: variableStudyDraft.description,
        analysis_config: {
          preset: 'general',
          custom_fields: [],
          variable_selection: spec,
        },
        variable_selection: spec,
      };
      const r = await api.createResearchStudy(payload);
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
      setTable('cohort');
      // Nghiên cứu mới chưa có dữ liệu: mở thẳng phần Thu thập của nghiên cứu.
      setStudyMode('collect');
      t(imported
        ? `Đã tạo nghiên cứu "${name}" và nạp ${compactNumber(imported)} dòng từ kho hiện tại.`
        : `Đã tạo nghiên cứu "${name}".`, 'ok');
    } catch (e) { t(String(e.message || e), 'error'); }
    finally { setBusy(false); }
  }, [variableStudyDraft, selectedVariables.length, variablePreview, variablePreviewConfirmed, buildVariableSpec, loadSummary, t]);

  const overviewRows = useMemo(() => {
    const sourceRows = Array.isArray(generalOverview?.rows) ? generalOverview.rows : [];
    const q = lower(generalOverviewQuery);
    return sourceRows.filter(row => {
      if (generalOverviewMissingOnly && row.ready) return false;
      if (!q) return true;
      return [
        row.research_code, row.patient_code, row.patient_name, row.diagnosis,
        row.admission_date, row.discharge_date, row.status_label, row.missing_text,
      ].some(v => lower(v).includes(q));
    });
  }, [generalOverview, generalOverviewQuery, generalOverviewMissingOnly]);


  const identifiedLocked = Boolean(identifiedAccess && !identifiedAccess.allowed);



  const openLog = () => { setShowLog(true); loadLog(); };
  const selectArchive = (mode = 'overview') => {
    setSelectedId(ARCHIVE_SCOPE); setTable(ARCHIVE_DEFAULT_TABLE); setArchiveMode(mode); setEditMode(false);
  };
  const selectStudy = (item) => {
    if (!item) return;
    setSelectedId(item.id);
    setTable(initialStudyTable(item));
    // Nghiên cứu chưa lấy dữ liệu lần nào thì mở thẳng phần Thu thập, vì bảng nào cũng trống.
    setStudyMode(item.latest_run ? 'data' : 'collect');
    setEditMode(false);
  };
  const openCreateStudy = () => selectArchive('variables');
  const creatingStudy = isArchive && archiveMode === 'variables';

  const archiveSummaryText = archive?.latest_run
    ? [
        archivePatients ? `${compactNumber(archivePatients)} người bệnh` : '',
        `${compactNumber(archiveEncounters || archiveInitial)} lượt điều trị`,
      ].filter(Boolean).join(' · ')
    : 'Chưa quét dữ liệu';
  const studyCountLabel = (item) => `${compactNumber(item?.cohort_count || 0)} mẫu · ${item?.latest_run ? 'đã lấy dữ liệu' : 'chưa lấy dữ liệu'}`;

  const archiveModes = [
    ['overview', 'Dữ liệu tổng quát', 'Số lượng, độ đầy đủ và danh sách người bệnh'],
    ['update', 'Thu thập dữ liệu', 'Quét danh sách, lấy dữ liệu và theo dõi tiến độ'],
    ['patient', 'Tra cứu người bệnh', 'Xem toàn bộ các lần điều trị của một người bệnh'],
  ];
  const studyModes = [
    ['data', 'Bảng dữ liệu', 'Danh sách mẫu, bảng phân tích và các bảng lâm sàng'],
    ['collect', 'Thu thập dữ liệu', 'Lấy dữ liệu cho danh sách mẫu và theo dõi tiến độ'],
  ];
  const otherStudyTables = STUDY_TABLES.filter(([id]) => !STUDY_PRIMARY_TABLES.includes(id));
  const studyHasRun = Boolean(activeStudy?.latest_run);

  const collectionWorkspace = (
    <CollectionWorkspace {...{
      isArchive, archive, study: activeStudy, selectedId, uiBusy, automationRun,
      archiveOptions, setArchiveOptions, studyOptions, setStudyOptions,
      runSimpleListScan, runSimpleDataCollection, runRefreshProvisional,
      operationSnapshot, lastUpdateSummary, statusLoading, loadProgressSnapshot, loadSummary,
      openLog, toast,
    }} />
  );

  const renderArchiveWorkspace = () => {
    if (archiveMode === 'overview') return <GeneralOverviewView {...{
          filters, generalOverview, generalOverviewLoading, generalOverviewMissingOnly,
          generalOverviewQuery, loadPatientHistory, overviewRows, setArchiveMode, setFilters,
          setGeneralOverviewMissingOnly, setGeneralOverviewQuery, setPatientQuery,
        }} />;
    if (archiveMode === 'patient') return <PatientLookupView {...{
          identifiedAccess, identifiedLocked, loadPatientHistory, patientHistory,
          patientHistoryError, patientHistoryLoading, patientHistoryMeta, patientQuery,
          setPatientQuery,
        }} />;
    if (archiveMode === 'variables') return <VariableCatalogView {...{
          addConditionForVariable, addCoreVariables, addVariables, allCatalogVariables, busy,
          catalogGroupOptions, createStudyFromVariableSelection, exportVariableSpec,
          filteredCatalogVariables, filteredVariableSections, loadVariableCatalog,
          loadVariablePreview, questionnaireTerms, questionnaireVariables, selectedCoverage,
          selectedVariableIds, selectedVariables, selectedVariablesByGroup,
          setQuestionnaireVariables, setSelectedVariableIds, setShowTechnicalVariables,
          setVariableAggregations, setVariableConditions, setVariableFillFilter,
          setVariableGroupFilter, setVariablePreviewConfirmed, setVariableQuery,
          setVariableStudyDraft, setVariableSurveyLabels, setVariableTypeFilter,
          showTechnicalVariables, toggleVariable, variableAggregations, variableCatalog,
          variableCatalogError, variableCatalogLoading, variableConditions, variableFillFilter,
          variableGroupFilter, variablePreview, variablePreviewConfirmed, variablePreviewError,
          variablePreviewLoading, variableQuery, variableStudyDraft, variableSurveyLabels,
          variableTypeFilter,
        }} />;
    if (archiveMode === 'update') return collectionWorkspace;
    return null;
  };

  const tableTabStyle = (active) => ({
    height: 34, padding: '0 10px',
    border: 0, borderBottom: `2px solid ${active ? C.blue : 'transparent'}`,
    background: 'transparent', color: active ? C.blue : C.text2,
    cursor: 'pointer', fontSize: FS.sm, fontWeight: active ? 700 : 500,
    whiteSpace: 'nowrap', fontFamily: 'inherit', flexShrink: 0,
  });

  const renderStudyData = () => (
    <>
      {/* ── Chọn bảng: bảng hay dùng thành tab, phần còn lại trong "Bảng khác" ── */}
      <div className="emr-hscroll" style={{
        display: 'flex', alignItems: 'center', gap: 0,
        padding: '0 12px', flexShrink: 0, minHeight: 36,
        borderBottom: `1px solid ${C.border}`, background: C.surface,
        overflowX: 'auto', overflowY: 'hidden',
      }}>
        {STUDY_PRIMARY_TABLES.map(id => {
          const cnt = datasetCount(activeSource, id, false);
          const active = table === id;
          return (
            <button key={id} type="button" onClick={() => setTable(id)} style={tableTabStyle(active)}>
              {tableLabel(id, false)}
              {cnt > 0 && <span style={{ marginLeft: 5, fontSize: FS.xs, color: active ? C.blue : C.text3, fontVariantNumeric: 'tabular-nums' }}>{compactNumber(cnt)}</span>}
            </button>
          );
        })}
        <select
          value={STUDY_PRIMARY_TABLES.includes(table) ? '' : table}
          onChange={e => { if (e.target.value) setTable(e.target.value); }}
          aria-label="Bảng khác"
          style={{ ...inp, height: 28, marginLeft: 8, flexShrink: 0, background: STUDY_PRIMARY_TABLES.includes(table) ? C.surface : C.blueBg, color: STUDY_PRIMARY_TABLES.includes(table) ? C.text2 : C.blue }}
        >
          <option value="">Bảng khác…</option>
          {otherStudyTables.map(([id, label]) => <option key={id} value={id}>{label}</option>)}
        </select>
      </div>

      {/* ── Lọc + xuất ── */}
      <div style={{
        padding: '7px 12px', borderBottom: `1px solid ${C.border2}`,
        background: C.surface, flexShrink: 0,
        display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap',
      }}>
        <input
          value={filters.q}
          onChange={e => setFilters(p => ({ ...p, q: e.target.value }))}
          placeholder="Tìm trong bảng: xét nghiệm, chẩn đoán..."
          aria-label="Tìm trong bảng"
          style={{ ...inp, flex: '1 1 200px', minWidth: 0 }}
        />
        <input
          value={filters.patient}
          onChange={e => setFilters(p => ({ ...p, patient: e.target.value }))}
          placeholder="Mã NC / Mã BN"
          aria-label="Lọc theo mã"
          style={{ ...inp, width: 130, flexShrink: 0 }}
        />
        <input type="date" value={filters.from} aria-label="Từ ngày"
          onChange={e => setFilters(p => ({ ...p, from: e.target.value }))}
          style={{ ...inp, width: 132, flexShrink: 0 }} />
        <input type="date" value={filters.to} aria-label="Đến ngày"
          onChange={e => setFilters(p => ({ ...p, to: e.target.value }))}
          style={{ ...inp, width: 132, flexShrink: 0 }} />
        <label style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: FS.sm, color: C.text2, whiteSpace: 'nowrap' }}>
          <input type="checkbox" checked={filters.hideSensitive}
            onChange={e => setFilters(p => ({ ...p, hideSensitive: e.target.checked }))} />
          Ẩn định danh
        </label>
        {(filters.q || filters.patient || filters.from || filters.to || !filters.hideSensitive) && (
          <Btn onClick={resetFilters} style={{ height: 28, padding: '0 8px', fontSize: FS.xs }}>Xoá lọc</Btn>
        )}
        <span style={{ marginLeft: 'auto', fontSize: FS.xs, color: C.text3, fontVariantNumeric: 'tabular-nums' }}>
          {compactNumber(filteredRows.length)}/{compactNumber(rows.length)} dòng
        </span>
        {table === 'cohort' && (
          editMode
            ? <>
                <Btn variant="success" onClick={saveEditedCohort} disabled={uiBusy} style={actionBtn}>Lưu danh sách mẫu</Btn>
                <Btn onClick={() => setEditMode(false)} disabled={uiBusy} style={actionBtn}>Huỷ</Btn>
              </>
            : <Btn onClick={() => setEditMode(true)} disabled={uiBusy} style={actionBtn}>Sửa danh sách mẫu</Btn>
        )}
        <Btn variant="success" onClick={exportCurrent} disabled={!filteredRows.length} style={actionBtn}>Xuất CSV</Btn>
      </div>

      {/* ── Bảng ── */}
      <div style={{ flex: 1, overflow: 'auto', minHeight: 0, background: C.surface }}>
        {initialLoading && (
          <div style={{ padding: 24, color: C.text2, display: 'flex', alignItems: 'center', gap: 8 }}>
            <Spinner size={12} /> Đang tải dữ liệu...
          </div>
        )}
        {!initialLoading && !tableLoading && !rows.length && (
          !studyHasRun && table !== 'cohort'
            ? <div style={{ padding: '36px 24px', textAlign: 'center' }}>
                <div style={{ fontSize: FS.md, fontWeight: 700, color: C.text }}>Nghiên cứu này chưa lấy dữ liệu</div>
                <div style={{ fontSize: FS.sm, color: C.text3, marginTop: 6 }}>
                  Đã có {compactNumber(activeStudy?.cohort_count || 0)} mẫu. Thu thập dữ liệu để có bảng phân tích, xét nghiệm, CĐHA...
                </div>
                <Btn variant="solidPrimary" onClick={() => setStudyMode('collect')} style={{ marginTop: 12, height: 30 }}>Đi tới Thu thập dữ liệu</Btn>
              </div>
            : <EmptyState title="Bảng này chưa có dữ liệu" hint="Thử chọn bảng khác, hoặc chạy Thu thập dữ liệu nếu dữ liệu còn thiếu." />
        )}
        {rows.length > 0 && (
          <div style={{ opacity: tableLoading ? 0.5 : 1, transition: 'opacity 0.2s' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: FS.sm, tableLayout: 'fixed' }}>
            <thead style={{ position: 'sticky', top: 0, background: C.surface2, zIndex: 2 }}>
              <tr>
                {editMode && <th style={{ width: 28, borderBottom: `1px solid ${C.border}` }} />}
                {visibleColumns.map((col, ci) => {
                  const isLong = /thuốc|chi tiết|chẩn đoán|mô tả|kết luận|dòng/i.test(col);
                  const isLast = ci === visibleColumns.length - 1;
                  const w = isLast ? undefined : isLong ? 320 : /họ tên|ho ten|patient_name/i.test(col) ? 200 : /t\/g|ngày|thời gian/i.test(col) ? 140 : /mã bn|mã nc|mã vào/i.test(col) ? 110 : /tuổi|age/i.test(col) ? 60 : /gt|giới/i.test(col) ? 60 : 130;
                  return (
                    <th key={col} style={{
                      textAlign: 'left', padding: '7px 10px',
                      borderBottom: `1px solid ${C.border}`,
                      color: C.text2, fontWeight: 700, fontSize: FS.xs,
                      whiteSpace: 'nowrap', width: w, overflow: 'hidden',
                    }}>{col}</th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {filteredRows.slice(0, 1000).map((row, idx) => (
                <tr key={idx} style={{ borderBottom: `1px solid ${C.border2}` }}
                  onMouseEnter={e => e.currentTarget.style.background = C.surface2}
                  onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
                >
                  {editMode && (
                    <td style={{ padding: '0 6px', width: 28, textAlign: 'center' }}>
                      <button type="button" aria-label="Bỏ dòng này khỏi danh sách mẫu"
                        onClick={() => setRows(prev => prev.filter((_, i) => i !== idx))}
                        style={{ background: 'none', border: 'none', cursor: 'pointer', color: C.red, fontSize: FS.lg, lineHeight: 1 }}>✕</button>
                    </td>
                  )}
                  {visibleColumns.map((col, ci) => {
                    const isCode = col === 'Mã NC';
                    const isLong = /thuốc|chi tiết|chẩn đoán|mô tả|kết luận|dòng/i.test(col);
                    const isLast = ci === visibleColumns.length - 1;
                    return (
                      <td key={col} style={{
                        padding: '7px 10px',
                        color: isCode ? C.blue : C.text2,
                        fontWeight: isCode ? 700 : 500,
                        verticalAlign: 'top',
                        whiteSpace: isLong ? 'pre-wrap' : 'nowrap',
                        overflow: 'hidden',
                        textOverflow: isLast ? 'clip' : 'ellipsis',
                      }}>{text(row?.[col]) || <span style={{ color: C.text3 }}>—</span>}</td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        )}
        {tableLoading && rows.length > 0 && (
          <div style={{ padding: '6px 12px', display: 'flex', alignItems: 'center', gap: 6, borderTop: `1px solid ${C.border2}` }}>
            <Spinner size={9} /><span style={{ fontSize: FS.xs, color: C.text3 }}>Đang cập nhật...</span>
          </div>
        )}
        {!loading && !tableLoading && filteredRows.length > 1000 && (
          <div style={{ padding: '8px 12px', color: C.text3, fontSize: FS.xs, borderTop: `1px solid ${C.border2}` }}>
            Hiển thị 1.000 dòng đầu · Xuất CSV để lấy toàn bộ {compactNumber(filteredRows.length)} dòng.
          </div>
        )}
      </div>
    </>
  );

  const dot = (on) => <span aria-hidden="true" style={{ width: 7, height: 7, borderRadius: '50%', background: on ? C.green : C.text3, flexShrink: 0 }} />;

  // ── render ────────────────────────────────────────────────────────────────
  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0, overflow: 'hidden', background: C.bg, fontSize: FS.sm }}>

      {/* ── Delete confirm ── */}
      {deleteConfirm && (
        <div style={{
          position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)',
          display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100,
        }}>
          <div style={{
            background: C.surface, border: `1px solid ${C.redBorder}`,
            borderRadius: 6, padding: '24px 28px', maxWidth: 380, width: '90%',
          }}>
            <div style={{ fontSize: FS.lg, fontWeight: 700, color: C.text, marginBottom: 8 }}>Xóa nghiên cứu?</div>
            <div style={{ fontSize: FS.sm, color: C.text2, marginBottom: 20, lineHeight: 1.6 }}>
              Toàn bộ dữ liệu của nghiên cứu <b style={{ color: C.text }}>{studies.find(s => s.id === deleteConfirm)?.name || deleteConfirm}</b> sẽ bị xóa vĩnh viễn, bao gồm cohort và tất cả dữ liệu đã lấy.
            </div>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <Btn onClick={() => setDeleteConfirm(null)} style={{ height: 30, padding: '0 14px', fontSize: FS.sm }}>Huỷ</Btn>
              <Btn variant="danger" onClick={() => deleteStudy(deleteConfirm)} disabled={uiBusy} style={{ height: 30, padding: '0 14px', fontSize: FS.sm, background: C.redBg, borderColor: C.redBorder, color: C.red }}>
                {busy ? <><Spinner size={9} /> Đang xóa</> : 'Xóa'}
              </Btn>
            </div>
          </div>
        </div>
      )}

      {/* ── Wizard tạo nghiên cứu ── */}
      {showWizard && (
        <div style={{
          position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.75)',
          display: 'flex', alignItems: 'flex-start', justifyContent: 'center',
          zIndex: 99, overflowY: 'auto', padding: '40px 16px',
        }}>
          <div style={{
            background: C.surface, border: `1px solid ${C.border}`,
            borderRadius: 7, width: '100%', maxWidth: 860,
            display: 'flex', flexDirection: 'column', gap: 0,
          }}>
            {/* Wizard header */}
            <div style={{ padding: '16px 20px', borderBottom: `1px solid ${C.border}`, display: 'flex', alignItems: 'center', gap: 12 }}>
              <span style={{ fontSize: FS.lg, fontWeight: 700, color: C.text }}>Tạo nghiên cứu mới</span>
              <div style={{ display: 'flex', gap: 6, marginLeft: 8 }}>
                {[['1','Thông tin'], ['2','Lọc mẫu'], ['3','Xác nhận']].map(([s, label]) => (
                  <span key={s} style={{
                    fontSize: FS.xs, fontWeight: 700, padding: '2px 9px', borderRadius: 20,
                    background: wizardStep === Number(s) ? C.blueBg : C.surface2,
                    color: wizardStep === Number(s) ? C.blue : C.text3,
                    border: `1px solid ${wizardStep === Number(s) ? C.blueBorder : C.border2}`,
                  }}>{s}. {label}</span>
                ))}
              </div>
              <Btn onClick={() => setShowWizard(false)} style={{ marginLeft: 'auto', height: 26, padding: '0 8px', fontSize: FS.xs }}>✕</Btn>
            </div>

            {/* Step 1: Thông tin cơ bản */}
            {wizardStep === 1 && (
              <div style={{ padding: '20px 24px', display: 'flex', flexDirection: 'column', gap: 14 }}>
                <WizLabel>Tên nghiên cứu *</WizLabel>
                <input value={wizardForm.name}
                  onChange={e => setWizardForm(p => ({ ...p, name: e.target.value }))}
                  placeholder="VD: Khảo sát nồng độ calci huyết sau truyền Aclasta"
                  style={{ ...inp, width: '100%' }} autoFocus />
                <WizLabel>Mô tả / Tiêu chí</WizLabel>
                <input value={wizardForm.description}
                  onChange={e => setWizardForm(p => ({ ...p, description: e.target.value }))}
                  placeholder="VD: BN > 50 tuổi, có chỉ định truyền Aclasta, lấy XN calci T0, T24h, T48h"
                  style={{ ...inp, width: '100%' }} />

                {/* Cấu hình phân tích */}
                <div style={{ borderTop: `1px solid ${C.border2}`, paddingTop: 12 }}>
                  <WizLabel>Loại phân tích (preset)</WizLabel>
                  <select
                    value={wizardForm.analysis_config.preset}
                    onChange={e => setWizardForm(p => ({ ...p, analysis_config: { ...p.analysis_config, preset: e.target.value } }))}
                    style={{ ...inp, width: '100%', marginTop: 4 }}>
                    {(analysisPresets.length ? analysisPresets : [
                      { id: 'ortho_fracture', label: 'Chấn thương chỉnh hình — Gãy xương' },
                      { id: 'ortho_joint',    label: 'Chấn thương chỉnh hình — Khớp / Thay khớp' },
                      { id: 'neuro_spine',    label: 'Thần kinh — Cột sống / Tủy sống' },
                      { id: 'neuro_brain',    label: 'Thần kinh — Sọ não / Đột quỵ' },
                      { id: 'general',        label: 'Tổng quát (không inference)' },
                    ]).map(p => (
                      <option key={p.id} value={p.id}>{p.label}</option>
                    ))}
                  </select>
                  {analysisPresets.length > 0 && (() => {
                    const chosen = analysisPresets.find(p => p.id === wizardForm.analysis_config.preset);
                    return chosen?.inference_fields?.length ? (
                      <div style={{ fontSize: FS.xs, color: C.text3, marginTop: 4 }}>
                        Sẽ tự suy luận: {chosen.inference_fields.map(f => f.label).join(' · ')}
                      </div>
                    ) : null;
                  })()}
                </div>

                {/* Custom fields */}
                <div>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
                    <WizLabel>Trường tuỳ chỉnh (regex từ chẩn đoán)</WizLabel>
                    <button type="button"
                      onClick={() => setWizardForm(p => ({ ...p, analysis_config: { ...p.analysis_config, custom_fields: [...(p.analysis_config.custom_fields || []), { name: '', pattern: '', label: '' }] } }))}
                      style={{ background: C.blueBg, border: `1px solid ${C.blueBorder}`, color: C.blue, borderRadius: 5, padding: '2px 8px', fontSize: FS.xs, cursor: 'pointer' }}>
                      + Thêm
                    </button>
                  </div>
                  {(wizardForm.analysis_config.custom_fields || []).length === 0 && (
                    <div style={{ fontSize: FS.xs, color: C.text3, fontStyle: 'italic' }}>VD: tên="diabetes", pattern="đái tháo đường|type 2" → cột diabetes = 1/0</div>
                  )}
                  {(wizardForm.analysis_config.custom_fields || []).map((cf, i) => (
                    <div key={i} style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 28px', gap: 6, marginTop: 6 }}>
                      <input value={cf.name}
                        onChange={e => setWizardForm(p => { const cfs = [...p.analysis_config.custom_fields]; cfs[i] = { ...cfs[i], name: e.target.value }; return { ...p, analysis_config: { ...p.analysis_config, custom_fields: cfs } }; })}
                        placeholder="Tên cột (VD: diabetes)" style={inp} />
                      <input value={cf.pattern}
                        onChange={e => setWizardForm(p => { const cfs = [...p.analysis_config.custom_fields]; cfs[i] = { ...cfs[i], pattern: e.target.value }; return { ...p, analysis_config: { ...p.analysis_config, custom_fields: cfs } }; })}
                        placeholder="Regex (VD: đái tháo đường|type 2)" style={inp} />
                      <button type="button"
                        onClick={() => setWizardForm(p => { const cfs = p.analysis_config.custom_fields.filter((_, j) => j !== i); return { ...p, analysis_config: { ...p.analysis_config, custom_fields: cfs } }; })}
                        style={{ background: 'none', border: 'none', cursor: 'pointer', color: C.text3, fontSize: FS.xl }}>✕</button>
                    </div>
                  ))}
                </div>

                <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 4 }}>
                  <Btn onClick={() => setShowWizard(false)} style={{ height: 30, padding: '0 14px', fontSize: FS.sm }}>Huỷ</Btn>
                  <Btn variant="primary" onClick={() => { if (!text(wizardForm.name)) { t('Cần nhập tên nghiên cứu.', 'error'); return; } setWizardStep(2); loadWizardPreview(); }} style={{ height: 30, padding: '0 14px', fontSize: FS.sm }}>
                    Tiếp theo →
                  </Btn>
                </div>
              </div>
            )}

            {/* Step 2: Lọc mẫu */}
            {wizardStep === 2 && (
              <div style={{ padding: '20px 24px', display: 'flex', flexDirection: 'column', gap: 18 }}>

                {/* Tuổi + Giới */}
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12 }}>
                  <WizField label="Tuổi từ" type="number" placeholder="VD: 18"
                    value={wizardFilters.tuoiMin} onChange={v => setWizardFilters(p => ({ ...p, tuoiMin: v }))} />
                  <WizField label="Tuổi đến" type="number" placeholder="VD: 80"
                    value={wizardFilters.tuoiMax} onChange={v => setWizardFilters(p => ({ ...p, tuoiMax: v }))} />
                  <WizSelect label="Giới tính" value={wizardFilters.gioi}
                    onChange={v => setWizardFilters(p => ({ ...p, gioi: v }))}
                    options={[['','Tất cả'],['Nam','Nam'],['Nữ','Nữ']]} />
                </div>

                {/* Chẩn đoán */}
                <div>
                  <WizLabel>Chẩn đoán chứa</WizLabel>
                  <input value={wizardFilters.chanDoan}
                    onChange={e => setWizardFilters(p => ({ ...p, chanDoan: e.target.value }))}
                    placeholder="VD: loãng xương, gãy cổ xương đùi, đái tháo đường..."
                    style={{ ...wizInp, width: '100%' }} />
                </div>

                {/* Xét nghiệm — danh sách điều kiện */}
                <div style={{ borderTop: `1px solid ${C.border2}`, paddingTop: 14 }}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
                    <WizLabel>Xét nghiệm — bệnh nhân phải có</WizLabel>
                    <button type="button"
                      onClick={() => setWizardFilters(p => ({ ...p, xnList: [...p.xnList, { ten: '', min: '', max: '' }] }))}
                      style={{ background: C.blueBg, border: `1px solid ${C.blueBorder}`, color: C.blue, borderRadius: 5, padding: '2px 10px', fontSize: FS.xs, cursor: 'pointer' }}>
                      + Thêm XN
                    </button>
                  </div>
                  {wizardFilters.xnList.length === 0 && (
                    <div style={{ fontSize: FS.xs, color: C.text3, fontStyle: 'italic' }}>Chưa có điều kiện XN nào — bấm "+ Thêm XN" để thêm</div>
                  )}
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                    {wizardFilters.xnList.map((xn, i) => (
                      <div key={i} style={{ display: 'grid', gridTemplateColumns: '1fr 120px 120px 28px', gap: 8, alignItems: 'end' }}>
                        <div>
                          {i === 0 && <WizLabel>Tên chỉ số</WizLabel>}
                          <input value={xn.ten}
                            onChange={e => setWizardFilters(p => { const l = [...p.xnList]; l[i] = { ...l[i], ten: e.target.value }; return { ...p, xnList: l }; })}
                            placeholder="VD: creatinine, wbc, crp, calci..."
                            style={wizInp} />
                        </div>
                        <div>
                          {i === 0 && <WizLabel>Tối thiểu</WizLabel>}
                          <input type="number" value={xn.min}
                            onChange={e => setWizardFilters(p => { const l = [...p.xnList]; l[i] = { ...l[i], min: e.target.value }; return { ...p, xnList: l }; })}
                            placeholder="Bỏ trống = không giới hạn"
                            style={wizInp} />
                        </div>
                        <div>
                          {i === 0 && <WizLabel>Tối đa</WizLabel>}
                          <input type="number" value={xn.max}
                            onChange={e => setWizardFilters(p => { const l = [...p.xnList]; l[i] = { ...l[i], max: e.target.value }; return { ...p, xnList: l }; })}
                            placeholder="Bỏ trống = không giới hạn"
                            style={wizInp} />
                        </div>
                        <button type="button"
                          onClick={() => setWizardFilters(p => ({ ...p, xnList: p.xnList.filter((_, j) => j !== i) }))}
                          style={{ background: 'none', border: 'none', cursor: 'pointer', color: C.text3, fontSize: FS.xl, marginTop: i === 0 ? 18 : 0 }}>✕</button>
                      </div>
                    ))}
                  </div>
                </div>

                {/* CĐHA — danh sách từ khóa */}
                <div style={{ borderTop: `1px solid ${C.border2}`, paddingTop: 14 }}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
                    <WizLabel>CĐHA — bệnh nhân phải có</WizLabel>
                    <button type="button"
                      onClick={() => setWizardFilters(p => ({ ...p, cdhaList: [...p.cdhaList, ''] }))}
                      style={{ background: C.blueBg, border: `1px solid ${C.blueBorder}`, color: C.blue, borderRadius: 5, padding: '2px 10px', fontSize: FS.xs, cursor: 'pointer' }}>
                      + Thêm CĐHA
                    </button>
                  </div>
                  {wizardFilters.cdhaList.length === 0 && (
                    <div style={{ fontSize: FS.xs, color: C.text3, fontStyle: 'italic' }}>Chưa có điều kiện CĐHA nào — bấm "+ Thêm CĐHA" để thêm</div>
                  )}
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                    {wizardFilters.cdhaList.map((cdha, i) => (
                      <div key={i} style={{ display: 'grid', gridTemplateColumns: '1fr 28px', gap: 8, alignItems: 'center' }}>
                        <input value={cdha}
                          onChange={e => setWizardFilters(p => { const l = [...p.cdhaList]; l[i] = e.target.value; return { ...p, cdhaList: l }; })}
                          placeholder="VD: X-quang cột sống, siêu âm ổ bụng, đo mật độ xương..."
                          style={wizInp} />
                        <button type="button"
                          onClick={() => setWizardFilters(p => ({ ...p, cdhaList: p.cdhaList.filter((_, j) => j !== i) }))}
                          style={{ background: 'none', border: 'none', cursor: 'pointer', color: C.text3, fontSize: FS.xl }}>✕</button>
                      </div>
                    ))}
                  </div>
                </div>

                {/* Preview count — chỉ số, không có bảng */}
                <div style={{
                  padding: '12px 16px', borderRadius: 8,
                  background: wizardFiltered.length > 0 ? C.blueBg : C.surface2,
                  border: `1px solid ${wizardFiltered.length > 0 ? C.blueBorder : C.border2}`,
                  display: 'flex', alignItems: 'center', gap: 12,
                }}>
                  {wizardLoadingPreview
                    ? <><Spinner size={10} /><span style={{ fontSize: FS.sm, color: C.text2 }}>Đang tải dữ liệu kho gốc...</span></>
                    : <>
                        <span style={{ fontSize: FS.stat, fontWeight: 700, color: wizardFiltered.length > 0 ? C.blue : C.text3, lineHeight: 1 }}>
                          {compactNumber(wizardFiltered.length)}
                        </span>
                        <div>
                          <div style={{ fontSize: FS.md, fontWeight: 700, color: wizardFiltered.length > 0 ? C.text : C.text2 }}>
                            BN phù hợp tiêu chí
                          </div>
                          <div style={{ fontSize: FS.xs, color: C.text3 }}>
                            {wizardRows.length
                              ? `trên tổng ${compactNumber(wizardRows.length)} BN trong kho gốc`
                              : <span style={{ color: C.amber }}>Kho gốc chưa có dữ liệu Bước 2</span>
                            }
                          </div>
                        </div>
                      </>
                  }
                </div>

                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                  <Btn onClick={() => setWizardStep(1)} style={{ height: 30, padding: '0 14px', fontSize: FS.sm }}>← Quay lại</Btn>
                  <Btn variant="primary"
                    onClick={() => { setWizardExcluded(new Set()); setWizardStep(3); }}
                    disabled={wizardFiltered.length === 0 || wizardLoadingPreview}
                    style={{ height: 30, padding: '0 14px', fontSize: FS.sm }}>
                    Xem danh sách →
                  </Btn>
                </div>
              </div>
            )}

            {/* Step 3: Xác nhận & loại bỏ thủ công */}
            {wizardStep === 3 && (
              <div style={{ padding: '20px 24px', display: 'flex', flexDirection: 'column', gap: 14 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <span style={{ fontSize: FS.md, fontWeight: 700, color: C.text }}>
                    {compactNumber(wizardFinalRows.length)} BN sẽ vào danh sách mẫu
                  </span>
                  {wizardExcluded.size > 0 && (
                    <span style={{ fontSize: FS.xs, color: C.amber }}>({compactNumber(wizardExcluded.size)} đã loại)</span>
                  )}
                  <span style={{ marginLeft: 'auto', fontSize: FS.xs, color: C.text3 }}>Bấm ✕ để loại BN không đạt tiêu chí</span>
                </div>

                <div style={{ maxHeight: 340, overflow: 'auto', borderRadius: 6, border: `1px solid ${C.border}` }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: FS.xs }}>
                    <thead style={{ position: 'sticky', top: 0, background: C.surface2 }}>
                      <tr>
                        <th style={{ width: 32 }} />
                        {['patient_code','Họ tên','Tuổi','GT','Ngày vào viện','Ngày ra viện'].map(col => (
                          <th key={col} style={{ padding: '6px 8px', textAlign: 'left', color: C.text3, fontWeight: 700, whiteSpace: 'nowrap', borderBottom: `1px solid ${C.border}` }}>{col}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {wizardFiltered.map((row, i) => {
                        const code = row.encounter_id || row.research_code || row.patient_code || row['Mã NC'] || row['Mã BN'] || String(i);
                        const excluded = wizardExcluded.has(code);
                        return (
                          <tr key={code} style={{ borderBottom: `1px solid ${C.border2}`, opacity: excluded ? 0.35 : 1, background: excluded ? C.redBg : 'transparent' }}>
                            <td style={{ padding: '4px 6px', textAlign: 'center' }}>
                              {excluded
                                ? <button type="button" onClick={() => setWizardExcluded(s => { const n = new Set(s); n.delete(code); return n; })}
                                    style={{ background: 'none', border: 'none', cursor: 'pointer', color: C.green, fontSize: FS.md, lineHeight: 1 }}>↩</button>
                                : <button type="button" onClick={() => setWizardExcluded(s => new Set([...s, code]))}
                                    style={{ background: 'none', border: 'none', cursor: 'pointer', color: C.red, fontSize: FS.lg, lineHeight: 1 }}>✕</button>
                              }
                            </td>
                            {['patient_code','Họ tên','Tuổi','GT','Ngày vào viện','Ngày ra viện'].map(col => (
                              <td key={col} style={{ padding: '5px 8px', color: col === 'patient_code' ? C.blue : C.text2, whiteSpace: 'nowrap' }}>
                                {text(row[col] || row[col.toLowerCase()]) || '—'}
                              </td>
                            ))}
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>

                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                  <Btn onClick={() => setWizardStep(2)} style={{ height: 30, padding: '0 14px', fontSize: FS.sm }}>← Sửa bộ lọc</Btn>
                  <Btn variant="success" onClick={createStudyFromWizard} disabled={busy || wizardFinalRows.length === 0} style={{ height: 30, padding: '0 18px', fontSize: FS.sm }}>
                    {busy ? <><Spinner size={9} /> Đang tạo...</> : `✓ Tạo nghiên cứu (${compactNumber(wizardFinalRows.length)} BN)`}
                  </Btn>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ── Log panel ── */}
      {showLog && (
        <div style={{
          borderBottom: `1px solid ${C.border}`, background: '#0a0f14',
          display: 'flex', flexDirection: 'column', flexShrink: 0,
          height: 220,
        }}>
          <div style={{
            display: 'flex', alignItems: 'center', gap: 8, padding: '4px 12px',
            borderBottom: `1px solid ${C.border2}`, background: C.surface,
          }}>
            <span style={{ fontSize: FS.xs, fontWeight: 700, color: C.blue }}>Log chạy · action_log.txt</span>
            <span style={{ fontSize: FS.xs, color: C.text3 }}>{caseTraces.length ? `${caseTraces.length} ca gần nhất · ` : ''}{logLines.length} dòng cuối</span>
            <label style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: FS.xs, color: C.text3 }}>
              <input type="checkbox" checked={caseTraceRedact} onChange={e => setCaseTraceRedact(e.target.checked)} />
              Ẩn thông tin nhạy cảm
            </label>
            <Btn onClick={loadLog} disabled={logLoading} style={{ height: 22, padding: '0 7px', fontSize: FS.xs, marginLeft: 'auto' }}>
              {logLoading ? <><Spinner size={8} /> Đang tải</> : '↻'}
            </Btn>
            <Btn onClick={() => setShowLog(false)} style={{ height: 22, padding: '0 7px', fontSize: FS.xs }}>✕</Btn>
          </div>
          <div style={{ flex: 1, overflow: 'auto', padding: '6px 12px', fontFamily: FONT_MONO, fontSize: FS.xs }}>
            {logLoading && <div style={{ color: C.text3 }}>Đang tải log...</div>}
            {!logLoading && !logLines.length && !caseTraces.length && (
              <div style={{ color: C.text3 }}>Chưa có log. Log xuất hiện sau khi chạy Quét danh sách hoặc Thu thập dữ liệu. Log chi tiết 10 ca gần nhất sẽ ghi vào <b>research_case_trace_recent.json</b>.</div>
            )}
            {!logLoading && !!caseTraces.length && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 10 }}>
                <div style={{ color: '#58a6ff', fontWeight: 700 }}>[CASE_TRACE] 10 ca gần nhất — tag ở đầu mỗi bước</div>
                {caseTraces.map((c, ci) => (
                  <details key={c.case_id || ci} open={ci === 0} style={{ border: '1px solid #263442', borderRadius: 8, padding: '6px 8px', background: '#0d141b' }}>
                    <summary style={{ cursor: 'pointer', color: '#d1d7e0', fontWeight: 700 }}>
                      [{c.status || '—'}] {c.index || '?'} / {c.total || '?'} · BN {c.ma_bn || '—'} · NC {c.research_code || '—'} · {c.date_from || '—'} → {c.date_to || '—'}
                    </summary>
                    <div style={{ marginTop: 6, display: 'grid', gap: 3 }}>
                      {(c.events || []).map((ev, ei) => (
                        <div key={ei} style={{ color: ev.tag?.startsWith('ERROR') ? '#f85149' : ev.tag === 'WARN' ? '#d29922' : ev.tag?.startsWith('OUTPUT') ? '#3fb950' : '#8b949e', lineHeight: 1.45, whiteSpace: 'pre-wrap' }}>
                          [{ev.tag || 'TAG'}] {ev.step || ''}
                          {ev.screen ? ` | vào=${ev.screen}` : ''}
                          {ev.sees ? ` | thấy=${ev.sees}` : ''}
                          {ev.takes ? ` | lấy=${ev.takes}` : ''}
                          {ev.writes ? ` | ghi=${ev.writes}` : ''}
                          {ev.target ? ` | đích=${ev.target}` : ''}
                        </div>
                      ))}
                    </div>
                  </details>
                ))}
              </div>
            )}
            {logLines.map((line, i) => {
              const isError = /ERROR|❌|lỗi/i.test(line);
              const isWarn  = /WARN|⚠/i.test(line);
              const isOk    = /OK   |✅|Commit xong|Tab.*xong/i.test(line);
              const isClick = /CLICK/.test(line);
              const isStep  = /STEP /.test(line);
              const color   = isError ? '#f85149' : isWarn ? '#d29922' : isOk ? '#3fb950' : isClick ? '#58a6ff' : isStep ? '#bc8cff' : '#8b949e';
              return (
                <div key={i} style={{ color, lineHeight: 1.55, whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>{line}</div>
              );
            })}
          </div>
        </div>
      )}

      {researchError && (
        <div style={{ padding: '7px 12px', background: C.redBg, borderBottom: `1px solid ${C.redBorder}`, color: C.red, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', fontSize: FS.xs }}>
          <b>Lỗi:</b><span style={{ flex: 1 }}>{researchError}</span>
          <Btn onClick={openLog} style={{ height: 24, fontSize: FS.xs }}>Xem log</Btn>
          <Btn onClick={() => setResearchError('')} style={{ height: 24, fontSize: FS.xs }}>Đóng</Btn>
        </div>
      )}

      {/* ── Body: danh sách kho/nghiên cứu + nội dung ── */}
      <div style={{ display: 'flex', flex: 1, overflow: 'hidden', minHeight: 0 }}>

        {!isMobile && (
          <nav aria-label="Kho và nghiên cứu" style={{
            width: 220, flexShrink: 0, display: 'flex', flexDirection: 'column',
            borderRight: `1px solid ${C.border}`, background: C.surface, overflowY: 'auto',
          }}>
            <SectionHead>Kho dữ liệu gốc</SectionHead>
            <SideItem
              label="Toàn bộ kho"
              sub={archiveSummaryText}
              active={isArchive && !creatingStudy}
              onClick={() => selectArchive(creatingStudy ? 'overview' : archiveMode)}
              badge={dot(Boolean(archive?.latest_run))}
            >
              {(!!operationSnapshot?.counts?.error || !!operationSnapshot?.unmatched_progress) && isArchive && (
                <div style={{ display: 'flex', gap: 3, flexWrap: 'wrap' }}>
                  {!!operationSnapshot?.counts?.error && <StatBadge label="Lỗi" value={operationSnapshot.counts.error} tone="danger" />}
                  {!!operationSnapshot?.unmatched_progress && <StatBadge label="Chưa ghép" value={operationSnapshot.unmatched_progress} tone="warn" />}
                </div>
              )}
            </SideItem>

            <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '12px 12px 6px', borderBottom: `1px solid ${C.border2}` }}>
              <span style={{ fontSize: FS.xs, fontWeight: 600, color: C.text3 }}>Nghiên cứu riêng{studies.length ? ` (${studies.length})` : ''}</span>
            </div>
            <button
              type="button"
              onClick={openCreateStudy}
              aria-pressed={creatingStudy}
              style={{
                display: 'flex', alignItems: 'center', gap: 6, width: '100%', textAlign: 'left',
                border: 0, borderBottom: `1px solid ${C.border2}`, borderLeft: `2px solid ${creatingStudy ? C.blue : 'transparent'}`,
                background: creatingStudy ? C.blueBg : 'transparent', color: C.blue,
                padding: '9px 12px', cursor: 'pointer', fontSize: FS.sm, fontWeight: 700, fontFamily: 'inherit',
              }}
            >
              <span aria-hidden="true" style={{ fontSize: FS.lg, lineHeight: 1 }}>+</span> Tạo nghiên cứu mới
            </button>

            {studies.length === 0 && (
              <div style={{ padding: '10px 12px 14px', fontSize: FS.xs, color: C.text3, lineHeight: 1.45 }}>
                Chưa có nghiên cứu riêng. Tạo nghiên cứu bằng cách chọn biến từ kho gốc.
              </div>
            )}

            {studies.map(item => (
              <SideItem
                key={item.id}
                label={item.name}
                sub={studyCountLabel(item)}
                active={item.id === selectedId}
                onClick={() => selectStudy(item)}
                badge={dot(Boolean(item.latest_run))}
              >
                {item.latest_run && datasetCount(item, 'errors', false) > 0 && (
                  <StatBadge label="Lỗi" value={datasetCount(item, 'errors', false)} tone="danger" />
                )}
              </SideItem>
            ))}
          </nav>
        )}

        {/* ── NỘI DUNG ── */}
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', minWidth: 0 }}>

          {isMobile && (
            <div style={{ display: 'flex', gap: 6, padding: '8px 12px', borderBottom: `1px solid ${C.border2}`, background: C.surface, flexShrink: 0 }}>
              <select
                value={creatingStudy ? '__create__' : selectedId}
                aria-label="Chọn kho hoặc nghiên cứu"
                onChange={e => {
                  const v = e.target.value;
                  if (v === '__create__') openCreateStudy();
                  else if (v === ARCHIVE_SCOPE) selectArchive('overview');
                  else selectStudy(studies.find(s => s.id === v));
                }}
                style={{ ...inp, flex: 1, minWidth: 0, height: 40 }}
              >
                <option value={ARCHIVE_SCOPE}>Kho dữ liệu gốc · {archiveSummaryText}</option>
                {studies.map(item => <option key={item.id} value={item.id}>{item.name} · {studyCountLabel(item)}</option>)}
                <option value="__create__">+ Tạo nghiên cứu mới</option>
              </select>
            </div>
          )}

          {/* ── Tiêu đề + chế độ ── */}
          <div style={{ padding: '8px 12px 0', borderBottom: `1px solid ${C.border}`, background: C.surface, flexShrink: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', minHeight: 30 }}>
              <span style={{ fontSize: FS.lg, fontWeight: 700, color: C.text }}>
                {creatingStudy ? 'Tạo nghiên cứu mới' : isArchive ? 'Kho dữ liệu gốc' : (activeStudy?.name || selectedId)}
              </span>
              {!creatingStudy && latest?.id && (
                <span style={{ fontSize: FS.xs, color: C.text3, fontVariantNumeric: 'tabular-nums' }}>đợt {latest.id}</span>
              )}
              <div style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
                <Btn onClick={openLog} disabled={logLoading} style={actionBtn}>Log</Btn>
                <Btn onClick={reloadCurrentView} disabled={loading || tableLoading || busy} title="Tải lại dữ liệu đang xem" style={actionBtn}>
                  {(loading || tableLoading) ? <><Spinner size={8} /> Đang tải</> : 'Tải lại'}
                </Btn>
                {!isArchive && (
                  <Btn variant="danger" onClick={() => setDeleteConfirm(selectedId)} disabled={uiBusy} style={actionBtn}>Xóa nghiên cứu</Btn>
                )}
              </div>
            </div>
            <div style={{ fontSize: FS.xs, color: C.text3, marginTop: 2 }}>
              {creatingStudy
                ? 'Chọn biến từ kho gốc, đặt điều kiện lọc, xem trước rồi tạo. Không mở EMR.'
                : isArchive
                  ? `${archiveSummaryText}. Toàn bộ người bệnh quét từ EMR; nghiên cứu riêng được tạo từ kho này.`
                  : [activeStudy?.description, studyCountLabel(activeStudy)].filter(Boolean).join(' · ')}
            </div>
            <div role="tablist" className="emr-hscroll" style={{ display: 'flex', gap: 0, marginTop: 4, overflowX: 'auto' }}>
              {(isArchive ? archiveModes : studyModes).map(([key, title, hint]) => (
                <ModeButton
                  key={key}
                  title={title}
                  hint={hint}
                  active={isArchive ? archiveMode === key : studyMode === key}
                  onClick={() => (isArchive ? setArchiveMode(key) : setStudyMode(key))}
                />
              ))}
            </div>
          </div>

          {isArchive ? (
            <div style={{ flex: 1, overflow: 'auto', minHeight: 0, background: C.bg }}>
              {renderArchiveWorkspace()}
            </div>
          ) : studyMode === 'collect' ? (
            <div style={{ flex: 1, overflow: 'auto', minHeight: 0, background: C.bg }}>
              {collectionWorkspace}
            </div>
          ) : renderStudyData()}
        </div>
      </div>
    </div>
  );
}
