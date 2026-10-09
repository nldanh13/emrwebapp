import { lazy, Suspense, useState, useCallback, useEffect, useRef } from 'react';
import useIsMobile from './hooks/useIsMobile.js';
import { useAuth } from './hooks/useAuth.jsx';
import FeatureContextBanner from './components/FeatureContextBanner.jsx';
import WorkDateRangeBar from './components/WorkDateRangeBar.jsx';
import Sidebar from './components/shell/Sidebar.jsx';
import TopBar from './components/shell/TopBar.jsx';
import BottomNav from './components/shell/BottomNav.jsx';
import Notices, { humanActionLabel, humanMessage } from './components/shell/Notices.jsx';
import PatientLogModal from './components/patient/PatientLogModal.jsx';
import * as api from './api.js';
import { defaultWorkDateRange, loadWorkDateRange, saveWorkDateRange, sanitizeWorkDateRange, workDateRangeLabel } from './utils/workDateRange.js';
import { installGlobalClickLogger, logActivity, setActivityTab, flushActivityLogs } from './utils/activityLogger.js';
import { NAV_ENTRIES, getNavigationEntry, resolveContextDefinition } from './features/registry.js';
import KeepAliveTab from './components/shell/KeepAliveTab.jsx';
import { SharedWorkspaceNotice } from './components/shell/WorkspaceGate.jsx';

// Các màn hình nghiệp vụ lớn chỉ được tải khi người dùng mở tab tương ứng.
// Điều này giảm đáng kể gói JS ban đầu trên máy trạm và điện thoại.
const DataProcessingTab = lazy(() => import('./components/DataProcessingTab.jsx'));
const ShiftTab = lazy(() => import('./components/ShiftTab.jsx'));
const NurseTab = lazy(() => import('./components/NurseTab.jsx'));
const HchahnTab = lazy(() => import('./components/hchanh/HchahnTab.jsx'));
const RecordsCheckTab = lazy(() => import('./components/records/RecordsCheckTab.jsx'));
const DischargeSignTab = lazy(() => import('./components/records/DischargeSignTab.jsx'));
const SickLeaveTab = lazy(() => import('./components/SickLeaveTab.jsx'));
const VtytCatalogManager = lazy(() => import('./components/VtytCatalogManager.jsx'));
const MedicationCatalogManager = lazy(() => import('./components/MedicationCatalogManager.jsx'));
const AccountSettingsTab = lazy(() => import('./components/AccountSettingsTab.jsx'));
const EmrStructureScanTab = lazy(() => import('./components/EmrStructureScanTab.jsx'));
const ClinicTab = lazy(() => import('./components/ClinicTab.jsx'));
const ResearchTab = lazy(() => import('./components/ResearchTab.jsx'));
const PatientJourneyTab = lazy(() => import('./components/PatientJourneyTab.jsx'));
const ReportTab = lazy(() => import('./components/ReportTab.jsx'));
const FunctionHubTab = lazy(() => import('./components/FunctionHubTab.jsx'));

function safeText(value, max = 140) {
  const s = String(value ?? '').replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

function cleanActivityPath(value) { return String(value || '').split('?')[0]; }

const NOTICE_API_ACTIONS = new Set([
  'GET /api/run-scan',
  'POST /api/save',
  'POST /api/run-details',
  'POST /api/run-details-one',
  'GET /api/run-postprocess',
  'POST /api/check-input-changes',
  'POST /api/run-input-care',
  'POST /api/run-input-infusions',
  'POST /api/run-input-procedures',
  'POST /api/run-input-vtyt',
  'POST /api/check-current-bed',
  'POST /api/cancel',
  'GET /api/export-data',
  'POST /api/import-data',
  'POST /api/clinic/preview',
]);

function shouldShowApiNotice(details = {}, kind = '') {
  const method = String(details.method || 'GET').toUpperCase();
  const path = cleanActivityPath(details.url);
  if (kind === 'api.request.error' || kind === 'api.auth.required') return true;
  return NOTICE_API_ACTIONS.has(`${method} ${path}`);
}

function formatCount(result = {}) {
  const value = result?.count;
  if (value === '' || value == null) return '';
  return ` (${value} dòng)`;
}

function formatActivityForScreen(raw) {
  const ev = raw || {};
  const d = ev.details || {};
  const label = humanActionLabel(safeText(d.label || ev.label || ev.title || ev.id || ev.name || ''));
  const base = { id: `${Date.now()}_${Math.random().toString(16).slice(2)}`, at: ev.at || new Date().toISOString(), kind: ev.kind || 'activity' };
  if (ev.kind === 'ui.click' || ev.kind === 'ui.tab_change' || ev.kind === 'ui.open_log') return null;
  if (ev.kind === 'api.request.start') return null;
  if (ev.kind === 'api.request.ok') {
    if (!shouldShowApiNotice(d, ev.kind)) return null;
    const status = String(d.result?.status || '').toLowerCase();
    const message = humanMessage(safeText(d.result?.message || '', 160));
    if (status === 'changed' || status === 'needs_review') return { ...base, tone: 'warn', title: 'Có y lệnh hoặc dữ liệu mới', detail: message || 'Cần xem lại trước khi nhập.', ttl: 7000 };
    return null;
  }
  if (ev.kind === 'api.request.error') return { ...base, tone: 'error', title: `Không thực hiện được ${label}`, detail: humanMessage(safeText(d.message || '', 220)) || 'Không rõ nguyên nhân. Xem nhật ký để biết thêm.', ttl: 9000 };
  if (ev.kind === 'api.auth.required') return { ...base, tone: 'warn', title: `Cần nhập mã truy cập để ${label}.`, ttl: 6500 };
  if (ev.kind === 'work_date.changed') return { ...base, tone: 'info', title: 'Đã đổi khoảng ngày làm việc', detail: safeText(d.label || ''), ttl: 4300 };
  if (ev.kind === 'work_date.auto_today') return { ...base, tone: 'ok', title: 'Đã tự chuyển khoảng ngày về hôm nay', ttl: 4300 };
  return null;
}

const TOAST_TONE = { error: 'error', ok: 'ok', success: 'ok', warn: 'warn', warning: 'warn', info: 'info' };
const MAX_NOTICES = 3;

// ── Navigation ───────────────────────────────────────────────────────────────
const TABS = NAV_ENTRIES;
const ACTIVE_TAB_KEY = 'emr_active_tab_v2';
const VALID_TAB_IDS = new Set(TABS.map(t => t.id));
const DEFAULT_TAB_ID = TABS[0]?.id || 'acquire';
// 'functions' (Bộ chức năng) was removed from the sidebar nav but the tab still exists,
// reachable via TopBar's "Tìm chức năng" button and the feature-context banner's back button.
// 'duty' (Nhập trực) đã gộp vào 'ward' (Nhập bệnh phòng).
const LEGACY_TAB_MAP = { duty: 'ward', data: 'acquire', process: 'acquire', overview: DEFAULT_TAB_ID, connection: 'acquire', collected: 'acquire', quality: 'acquire', jobs: DEFAULT_TAB_ID, logs: DEFAULT_TAB_ID };

function loadActiveTab() {
  try {
    const saved = localStorage.getItem(ACTIVE_TAB_KEY) || localStorage.getItem('emr_active_tab_v1');
    const normalized = LEGACY_TAB_MAP[saved] || saved;
    return (VALID_TAB_IDS.has(normalized) || normalized === 'functions') ? normalized : DEFAULT_TAB_ID;
  } catch { return DEFAULT_TAB_ID; }
}
function saveActiveTab(tab) { try { localStorage.setItem(ACTIVE_TAB_KEY, tab); } catch {} }
// Not in NAV_ENTRIES (sidebar) anymore, but still reachable via TopBar's "Tìm chức năng"
// button and the feature-context banner's back button — keep the header accurate for it.
const FUNCTION_HUB_TAB_META = { id: 'functions', label: 'Bộ chức năng', hint: 'Chọn chức năng hoặc quy trình ghép' };
function currentTab(id) { return id === 'functions' ? FUNCTION_HUB_TAB_META : getNavigationEntry(id); }

function shouldShowDateBar(tab) {
  return Boolean(currentTab(tab)?.usesDateRange);
}


function ContentFrame({ children, compact = false }) {
  return (
    <main className="emr-content" id="emr-main">
      <div className={`emr-content__inner${compact ? ' emr-content__inner--compact' : ''}`}>{children}</div>
    </main>
  );
}

// ── App ───────────────────────────────────────────────────────────────────────
export default function App() {
  const { user, authMode, logout } = useAuth();
  const isMobile = useIsMobile();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [tab, setTab] = useState(loadActiveTab);
  const [now, setNow] = useState(new Date());
  const [showLog, setShowLog] = useState(false);
  const [logData, setLogData] = useState(null);
  const [logLoading, setLogLoading] = useState(false);
  const [notices, setNotices] = useState([]);
  const [workDateRange, setWorkDateRangeState] = useState(loadWorkDateRange);
  const [featureContext, setFeatureContext] = useState(null);
  // Mọi tab được giữ lại (ẩn) sau lần mở đầu (docs/UX_RULES.md): chuyển tab không dựng lại màn
  // hình, không tải lại từ đầu, không mất thao tác đang làm dở; tác vụ đang chạy vẫn được theo dõi.
  // Quay lại tab thì màn hình tự cập nhật ngầm (useOnTabReturn / sự kiện emr:tab-active).
  const [visitedTabs, setVisitedTabs] = useState(() => new Set([tab]));
  useEffect(() => {
    setVisitedTabs(prev => (prev.has(tab) ? prev : new Set([...prev, tab])));
    window.dispatchEvent(new CustomEvent('emr:tab-active', { detail: tab }));
  }, [tab]);
  const researchMounted = visitedTabs.has('research');
  const [researchRunning, setResearchRunning] = useState(null); // { title } khi có tác vụ đang chạy
  // Chưa mở Kho nghiên cứu (vd. vừa tải lại trang) mà máy chủ đang chạy tác vụ nghiên cứu: vẫn báo.
  // Mở Kho rồi thì chính màn hình đó theo dõi và báo lên (onRunningChange).
  useEffect(() => {
    if (researchMounted) return undefined;
    let stopped = false;
    const check = async () => {
      try {
        const r = await api.getResearchRunning();
        const items = Array.isArray(r?.running) ? r.running : [];
        if (!stopped) setResearchRunning(items.length ? { title: items.map(i => `Đang chạy: ${i.label}${i.study_name ? ` · nghiên cứu "${i.study_name}"` : ' · Kho dữ liệu gốc'}`).join('\n') } : null);
      } catch (e) {
        if (/401|403|quyền|đăng nhập/i.test(String(e?.message || ''))) stopped = true;
      }
    };
    check();
    const id = setInterval(() => { if (!stopped) check(); }, 15000);
    return () => { stopped = true; clearInterval(id); };
  }, [researchMounted]);
  const toastIdRef = useRef(0);
  const lastTodayRef = useRef(defaultWorkDateRange().from);

  const dismissNotice = useCallback((id) => setNotices(prev => prev.filter(n => n.id !== id)), []);
  const pushNotice = useCallback((item) => {
    setNotices(prev => [...prev.filter(n => n.id !== item.id), item].slice(-MAX_NOTICES));
    window.setTimeout(() => dismissNotice(item.id), item.ttl || 4500);
  }, [dismissNotice]);

  useEffect(() => { const id = setInterval(() => setNow(new Date()), 60_000); return () => clearInterval(id); }, []);
  useEffect(() => {
    const handler = (event) => {
      const item = formatActivityForScreen(event.detail || {});
      if (!item) return;
      pushNotice(item);
    };
    window.addEventListener('emr:activity', handler);
    return () => window.removeEventListener('emr:activity', handler);
  }, [pushNotice]);
  useEffect(() => {
    const todayRange = defaultWorkDateRange();
    if (lastTodayRef.current === todayRange.from) return;
    lastTodayRef.current = todayRange.from;
    setWorkDateRangeState(todayRange);
    saveWorkDateRange(todayRange);
    logActivity('work_date.auto_today', { ...todayRange, label: workDateRangeLabel(todayRange) });
  }, [now]);
  useEffect(() => { setActivityTab(tab); }, [tab]);
  useEffect(() => {
    const cleanupClick = installGlobalClickLogger(() => tab);
    const flush = () => flushActivityLogs();
    window.addEventListener('beforeunload', flush);
    return () => { cleanupClick(); window.removeEventListener('beforeunload', flush); flushActivityLogs(); };
  }, [tab]);

  const setWorkDateRange = useCallback((next) => {
    const clean = sanitizeWorkDateRange(typeof next === 'function' ? next(workDateRange) : next);
    setWorkDateRangeState(clean); saveWorkDateRange(clean); logActivity('work_date.changed', { ...clean, label: workDateRangeLabel(clean) });
  }, [workDateRange]);

  const toast = useCallback((msg, type = 'info') => {
    const tone = TOAST_TONE[type] || 'info';
    pushNotice({ id: `toast_${++toastIdRef.current}`, tone, title: humanMessage(msg) || String(msg || ''), ttl: tone === 'error' ? 9000 : 4000 });
  }, [pushNotice]);

  const handleViewLog = useCallback(async () => {
    setShowLog(true); setLogLoading(true);
    try { logActivity('ui.open_log', { tab }); setLogData(await api.getSessionLogs()); }
    catch (e) { setLogData({ files: [], scan_history: String(e.message || 'Không tải được log.'), activity_log: '' }); }
    finally { setLogLoading(false); }
  }, [tab]);

  const handleDiagnostics = useCallback(async () => {
    setShowLog(true); setLogLoading(true);
    try { logActivity('ui.open_diagnostics', { tab }); const d = await api.getDiagnostics(); setLogData({ diagnostics: d, files: [], scan_history: '', activity_log: '' }); }
    catch (e) { setLogData({ files: [], scan_history: String(e.message || 'Không tải được chẩn đoán hệ thống.'), activity_log: '' }); }
    finally { setLogLoading(false); }
  }, [tab]);

  const handleCancel = useCallback(async () => {
    try { const r = await api.cancelTask(); toast(r.message || 'Đã gửi lệnh huỷ', 'ok'); }
    catch (e) { toast(String(e.message), 'error'); }
  }, [toast]);

  const handleTabChange = useCallback((nextTab, options = {}) => {
    if (!VALID_TAB_IDS.has(nextTab)) return;
    logActivity('ui.tab_change', { from: tab, to: nextTab });
    if (!options.preserveContext) setFeatureContext(null);
    saveActiveTab(nextTab); setTab(nextTab);
  }, [tab]);

  const handleOpenContext = useCallback((context) => {
    const definition = resolveContextDefinition(context);
    if (!definition || !VALID_TAB_IDS.has(definition.entryTab)) {
      toast('Chức năng chưa được gắn vào màn hình thực thi.', 'error');
      return;
    }
    setFeatureContext({ kind: context.kind === 'workflow' ? 'workflow' : 'feature', id: definition.id });
    logActivity('ui.feature_open', { kind: context.kind || 'feature', id: definition.id, entry_tab: definition.entryTab });
    saveActiveTab(definition.entryTab);
    setTab(definition.entryTab);
  }, [toast]);

  const handleOpenFunctionHub = useCallback(() => {
    setFeatureContext(null);
    saveActiveTab('functions');
    setTab('functions');
  }, []);

  const selectedContextDefinition = resolveContextDefinition(featureContext);
  const sharedDateProps = { workDateRange, setWorkDateRange };

  return (
    <div className="emr-shell">
      <Sidebar tabs={TABS} active={tab} onChange={handleTabChange} mobile={isMobile} open={sidebarOpen} onClose={() => setSidebarOpen(false)}
        badges={researchRunning ? { research: researchRunning } : {}} />
      <div className="emr-shell__main">
        <TopBar tab={currentTab(tab)} now={now}
          running={researchRunning && tab !== 'research' ? { label: 'Kho nghiên cứu đang chạy', title: `${researchRunning.title}\nBấm để mở Kho nghiên cứu`, onOpen: () => handleTabChange('research') } : null} onCancel={handleCancel} onViewLog={handleViewLog} onDiagnostics={handleDiagnostics} onOpenFunctions={handleOpenFunctionHub} mobile={isMobile} onMenuClick={() => setSidebarOpen(o => !o)} user={user} authMode={authMode} onLogout={logout} />
        <SharedWorkspaceNotice />
        <FeatureContextBanner context={featureContext} definition={selectedContextDefinition} onBack={handleOpenFunctionHub} onClose={() => setFeatureContext(null)} />
        {shouldShowDateBar(tab) && <WorkDateRangeBar value={workDateRange} onChange={setWorkDateRange} />}
        <ContentFrame compact={Boolean(currentTab(tab)?.compact)}>
          <Suspense fallback={<div style={{ padding: 16, color: 'var(--emr-ink-secondary)' }}>Đang mở chức năng…</div>}>
          {[
            ['functions', () => <FunctionHubTab onOpenContext={handleOpenContext} toast={toast} />],
            ['acquire', () => <DataProcessingTab toast={toast} workDateRange={workDateRange} />],
            ['research', () => <ResearchTab toast={toast} active={tab === 'research'} onRunningChange={setResearchRunning} />],
            ['patient-journey', () => <PatientJourneyTab toast={toast} />],
            ['bed', () => <ShiftTab toast={toast} mode="bed" {...sharedDateProps} />],
            ['ward', () => <ShiftTab toast={toast} mode="ward" workflowTitle="Điều dưỡng bệnh phòng" workflowHint="Nhập chăm sóc, dịch truyền và thủ thuật cho mọi người bệnh trong ngày đã chọn, gồm cả ca trực (mới vào khoa, chuyển khoa, về từ GMHS)." {...sharedDateProps} />],
            ['hchanh', () => <HchahnTab toast={toast} workDateRange={workDateRange} />],
            ['hchanh-vtyt', () => <HchahnTab toast={toast} workDateRange={workDateRange} view="vtyt" />],
            ['discharge-sign', () => <DischargeSignTab toast={toast} />],
            ['records-check', () => <RecordsCheckTab toast={toast} workDateRange={workDateRange} />],
            ['sick-leave', () => <SickLeaveTab toast={toast} workDateRange={workDateRange} />],
            ['vtyt-catalog', () => <VtytCatalogManager />],
            ['medication-catalog', () => <MedicationCatalogManager />],
            ['account-settings', () => <AccountSettingsTab toast={toast} />],
            ['emr-structure-scan', () => <EmrStructureScanTab />],
            ['clinic', () => <ClinicTab toast={toast} />],
            ['nurse', () => <NurseTab toast={toast} />],
            ['report', () => <ReportTab toast={toast} workDateRange={workDateRange} />],
          ].map(([id, render]) => (visitedTabs.has(id) ? (
            <KeepAliveTab key={id} id={id} active={tab === id}>{render()}</KeepAliveTab>
          ) : null))}
          </Suspense>
        </ContentFrame>
        {isMobile && <BottomNav tabs={TABS} active={tab} onChange={handleTabChange} onOpenMenu={() => setSidebarOpen(true)} />}
      </div>
      <Notices items={notices} onDismiss={dismissNotice} />
      <PatientLogModal open={showLog} onClose={() => setShowLog(false)} loading={logLoading} data={logData} />
    </div>
  );
}
