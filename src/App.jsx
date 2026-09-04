import { useState, useCallback, useEffect, useRef, useMemo } from 'react';
import { C, FONT_UI } from './tokens.js';
import DataProcessingTab from './components/DataProcessingTab.jsx';
import ShiftTab  from './components/ShiftTab.jsx';
import NurseTab  from './components/NurseTab.jsx';
import HchahnTab from './components/hchanh/HchahnTab.jsx';
import RecordsCheckTab from './components/records/RecordsCheckTab.jsx';
import VtytCatalogManager from './components/VtytCatalogManager.jsx';
import ClinicTab from './components/ClinicTab.jsx';
import ResearchTab from './components/ResearchTab.jsx';
import ReportTab from './components/ReportTab.jsx';
import FunctionHubTab from './components/FunctionHubTab.jsx';
import FeatureContextBanner from './components/FeatureContextBanner.jsx';
import WorkDateRangeBar from './components/WorkDateRangeBar.jsx';
import PatientLogModal from './components/patient/PatientLogModal.jsx';
import * as api from './api.js';
import { defaultWorkDateRange, loadWorkDateRange, saveWorkDateRange, sanitizeWorkDateRange, workDateRangeLabel } from './utils/workDateRange.js';
import { installGlobalClickLogger, logActivity, setActivityTab, flushActivityLogs } from './utils/activityLogger.js';
import { NAV_ENTRIES, getNavigationEntry, resolveContextDefinition } from './features/registry.js';

// ── Toast ────────────────────────────────────────────────────────────────────
function ToastBar({ toasts }) {
  if (!toasts.length) return null;
  return (
    <div style={{
      position: 'fixed', bottom: 18, right: 18,
      display: 'flex', flexDirection: 'column', gap: 8, zIndex: 1000,
    }}>
      {toasts.map(t => (
        <div key={t.id} style={{
          padding: '9px 11px', borderRadius: 5, fontSize: 11.5, fontWeight: 650,
          background: t.type === 'error' ? C.redBg : t.type === 'ok' ? C.greenBg : C.surface,
          border: `1px solid ${t.type === 'error' ? C.redBorder : t.type === 'ok' ? C.greenBorder : C.border}`,
          color: t.type === 'error' ? C.red : t.type === 'ok' ? C.green : C.text,
          animation: 'fadeIn 0.16s ease', maxWidth: 380, boxShadow: C.shadow2,
        }}>{t.msg}</div>
      ))}
    </div>
  );
}

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
  const label = safeText(d.label || ev.label || ev.title || ev.id || ev.name || 'thao tác');
  const base = { id: `${Date.now()}_${Math.random().toString(16).slice(2)}`, at: ev.at || new Date().toISOString(), kind: ev.kind || 'activity' };
  if (ev.kind === 'ui.click' || ev.kind === 'ui.tab_change' || ev.kind === 'ui.open_log') return null;
  if (ev.kind === 'api.request.start') {
    if (!shouldShowApiNotice(d, ev.kind)) return null;
    return null;
  }
  if (ev.kind === 'api.request.ok') {
    if (!shouldShowApiNotice(d, ev.kind)) return null;
    const status = String(d.result?.status || '').toLowerCase();
    const message = safeText(d.result?.message || '', 120);
    if (status === 'changed' || status === 'needs_review') return { ...base, tone: 'warn', text: message || 'Có y lệnh/dữ liệu mới, cần xem lại trước khi nhập.', ttl: 7000 };
    return null;
  }
  if (ev.kind === 'api.request.error') return { ...base, tone: 'error', text: `Lỗi: ${label} — ${safeText(d.message || 'không rõ lỗi')}`, ttl: 9000 };
  if (ev.kind === 'api.auth.required') return { ...base, tone: 'warn', text: `Cần nhập mã truy cập để ${label}.`, ttl: 6500 };
  if (ev.kind === 'work_date.changed') return { ...base, tone: 'info', text: `Đã đổi thời gian dữ liệu: ${safeText(d.label || '')}`, ttl: 4300 };
  if (ev.kind === 'work_date.auto_today') return { ...base, tone: 'ok', text: 'Đã tự chuyển thời gian dữ liệu về hôm nay.', ttl: 4300 };
  return null;
}

function ActivityNotifications({ items }) {
  if (!items.length) return null;
  const toneStyle = (tone) => {
    if (tone === 'error') return { background: C.redBg, borderColor: C.redBorder, color: C.red };
    if (tone === 'ok') return { background: C.greenBg, borderColor: C.greenBorder, color: C.green };
    if (tone === 'warn') return { background: C.amberBg, borderColor: C.amberBorder, color: C.amber };
    if (tone === 'running') return { background: C.blueBg, borderColor: C.blueBorder, color: C.blue };
    return { background: C.surface, borderColor: C.border, color: C.text2 };
  };
  return (
    <div style={{ position: 'fixed', bottom: 18, right: 18, zIndex: 1000, width: 380, maxWidth: 'calc(100vw - 40px)', display: 'flex', flexDirection: 'column', gap: 8, pointerEvents: 'none' }}>
      {items.slice(0, 1).map(item => {
        const ts = toneStyle(item.tone);
        return <div key={item.id} style={{ padding: '9px 11px', borderRadius: 5, background: ts.background, border: `1px solid ${ts.borderColor}`, color: ts.color, boxShadow: C.shadow2, animation: 'fadeIn 0.18s ease', fontSize: 12, lineHeight: 1.45, fontWeight: item.tone === 'running' ? 650 : 600 }}>{item.text}</div>;
      })}
    </div>
  );
}

// ── Navigation ───────────────────────────────────────────────────────────────
const TABS = NAV_ENTRIES;
const ACTIVE_TAB_KEY = 'emr_active_tab_v2';
const VALID_TAB_IDS = new Set(TABS.map(t => t.id));
const LEGACY_TAB_MAP = { data: 'acquire', process: 'acquire', overview: 'functions', connection: 'acquire', collected: 'acquire', quality: 'acquire', jobs: 'functions', logs: 'functions' };

function loadActiveTab() {
  try {
    const saved = localStorage.getItem(ACTIVE_TAB_KEY) || localStorage.getItem('emr_active_tab_v1');
    const normalized = LEGACY_TAB_MAP[saved] || saved;
    return VALID_TAB_IDS.has(normalized) ? normalized : 'functions';
  } catch { return 'functions'; }
}
function saveActiveTab(tab) { try { localStorage.setItem(ACTIVE_TAB_KEY, tab); } catch {} }
function currentTab(id) { return getNavigationEntry(id); }

function Sidebar({ active, onChange }) {
  const groups = [];
  for (const tab of TABS) {
    let group = groups.find(g => g.name === tab.group);
    if (!group) { group = { name: tab.group, tabs: [] }; groups.push(group); }
    group.tabs.push(tab);
  }
  return (
    <aside style={{ width: 220, flexShrink: 0, borderRight: `1px solid ${C.border2}`, background: C.surface, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      <div style={{ padding: '13px 13px 12px', borderBottom: `1px solid ${C.border2}` }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={{ width: 32, height: 32, borderRadius: 7, background: C.blue, display: 'grid', placeItems: 'center', color: '#fff', fontWeight: 750, fontSize: 15.5 }}>E</div>
          <div>
            <div style={{ color: C.text, fontSize: 15, fontWeight: 750, letterSpacing: '-0.02em' }}>Data Hub</div>
            <div style={{ color: C.text3, fontSize: 11, marginTop: 2 }}>Khai thác dữ liệu bệnh viện</div>
          </div>
        </div>
      </div>
      <nav style={{ padding: '7px 8px 12px', overflow: 'auto', flex: 1 }}>
        {groups.map(group => (
          <div key={group.name} style={{ marginBottom: 8 }}>
            <div style={{ padding: '8px 9px 5px', color: C.text3, fontSize: 9.5, fontWeight: 750, letterSpacing: '0.08em', textTransform: 'uppercase' }}>{group.name}</div>
            <div style={{ display: 'grid', gap: 2 }}>
              {group.tabs.map(tab => {
                const activeTab = active === tab.id;
                return (
                  <button key={tab.id} type="button" onClick={() => onChange(tab.id)} title={tab.hint} style={{
                    position: 'relative', display: 'flex', alignItems: 'center', gap: 8, width: '100%', textAlign: 'left', padding: '8px 9px', borderRadius: 5,
                    border: '1px solid transparent', borderLeft: `2px solid ${activeTab ? C.blue : 'transparent'}`, background: activeTab ? C.blueBg : 'transparent', color: activeTab ? C.blue : C.text2,
                    fontFamily: 'inherit', cursor: 'pointer', fontSize: 11.5, fontWeight: activeTab ? 750 : 550,
                  }}>
                    <span style={{ width: 20, height: 20, display: 'grid', placeItems: 'center', color: activeTab ? C.blue : C.text3, flexShrink: 0, fontSize: 13 }}>{tab.icon}</span>
                    <span style={{ minWidth: 0, display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{tab.label}</span>
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </nav>
    </aside>
  );
}

function TopBar({ active, now, onCancel, onViewLog, onDiagnostics, onOpenFunctions }) {
  const tab = currentTab(active);
  const dateStr = now.toLocaleDateString('vi-VN', { day:'2-digit', month:'2-digit', year:'numeric' });
  const timeStr = now.toLocaleTimeString('vi-VN', { hour:'2-digit', minute:'2-digit' });
  return (
    <header style={{ height: 54, flexShrink: 0, borderBottom: `1px solid ${C.border2}`, display: 'flex', alignItems: 'center', gap: 10, padding: '0 14px', background: C.surface }}>
      <div style={{ minWidth: 190, maxWidth: 320 }}>
        <div style={{ color: C.text, fontWeight: 700, fontSize: 16, letterSpacing: '-0.02em' }}>{tab.label}</div>
        <div style={{ color: C.text3, fontSize: 11, marginTop: 2 }}>{tab.hint}</div>
      </div>
      <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8 }}>
        <button type="button" onClick={onOpenFunctions} style={{ width: 218, height: 32, borderRadius: 5, border: `1px solid ${C.border}`, background: C.surface, color: C.text3, display: 'flex', alignItems: 'center', gap: 8, padding: '0 10px', fontSize: 12, cursor: 'pointer', fontFamily: 'inherit', textAlign: 'left' }}>
          <span>⌕</span><span style={{ overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>Tìm chức năng, quy trình...</span>
        </button>
        <button type="button" onClick={onDiagnostics} style={topIconButtonStyle} title="Chẩn đoán">◇</button>
        <button type="button" onClick={onViewLog} style={topIconButtonStyle} title="Xem log">◎</button>
        <button type="button" onClick={onCancel} style={{ ...topIconButtonStyle, color: C.red }} title="Huỷ tác vụ">⊘</button>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '2px 0 2px 6px', borderRadius: 0, background: 'transparent', border: 'none' }}>
          <span style={{ width: 27, height: 27, borderRadius: 6, display: 'grid', placeItems: 'center', background: C.blueBg, color: C.blue, fontWeight: 700 }}>DA</span>
          <span style={{ fontSize: 11, color: C.text2, lineHeight: 1.2 }}><b style={{ color: C.text, fontWeight: 700 }}>Duy Anh</b><br />{dateStr} · {timeStr}</span>
        </div>
      </div>
    </header>
  );
}

const topIconButtonStyle = { width: 32, height: 32, borderRadius: 5, border: `1px solid ${C.border}`, background: C.surface, color: C.text2, cursor: 'pointer', fontFamily: 'inherit', fontWeight: 650 };

function shouldShowDateBar(tab) {
  return Boolean(currentTab(tab)?.usesDateRange);
}


function ContentFrame({ children, compact = false }) {
  return <main style={{ flex: 1, overflow: 'auto', background: C.bg }}><div style={{ maxWidth: compact ? 'none' : 1480, margin: '0 auto', padding: compact ? 0 : 12 }}>{children}</div></main>;
}

// ── App ───────────────────────────────────────────────────────────────────────
export default function App() {
  const [tab, setTab] = useState(loadActiveTab);
  const [toasts, setToasts] = useState([]);
  const [now, setNow] = useState(new Date());
  const [showLog, setShowLog] = useState(false);
  const [logData, setLogData] = useState(null);
  const [logLoading, setLogLoading] = useState(false);
  const [activityItems, setActivityItems] = useState([]);
  const [workDateRange, setWorkDateRangeState] = useState(loadWorkDateRange);
  const [featureContext, setFeatureContext] = useState(null);
  const toastIdRef = useRef(0);
  const lastTodayRef = useRef(defaultWorkDateRange().from);

  useEffect(() => { const id = setInterval(() => setNow(new Date()), 60_000); return () => clearInterval(id); }, []);
  useEffect(() => {
    const handler = (event) => {
      const item = formatActivityForScreen(event.detail || {});
      if (!item) return;
      setActivityItems(prev => [item, ...prev].slice(0, 5));
      window.setTimeout(() => setActivityItems(prev => prev.filter(x => x.id !== item.id)), item.ttl || 4500);
    };
    window.addEventListener('emr:activity', handler);
    return () => window.removeEventListener('emr:activity', handler);
  }, []);
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
    const id = ++toastIdRef.current;
    setToasts(prev => [...prev, { id, msg, type }]);
    setTimeout(() => setToasts(prev => prev.filter(t => t.id !== id)), 4000);
  }, []);

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
    <div style={{ fontFamily: FONT_UI, background: C.bg, color: C.text, height: '100vh', fontSize: 13, overflow: 'hidden' }}>
      <div style={{ height: '100%', background: C.app, display: 'flex', overflow: 'hidden' }}>
        <Sidebar active={tab} onChange={handleTabChange} />
        <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
          <TopBar active={tab} now={now} onCancel={handleCancel} onViewLog={handleViewLog} onDiagnostics={handleDiagnostics} onOpenFunctions={handleOpenFunctionHub} />
          <FeatureContextBanner context={featureContext} definition={selectedContextDefinition} onBack={handleOpenFunctionHub} onClose={() => setFeatureContext(null)} />
          {shouldShowDateBar(tab) && <div style={{ borderBottom: `1px solid ${C.border2}`, background: C.surface }}><WorkDateRangeBar value={workDateRange} onChange={setWorkDateRange} /></div>}
          <ContentFrame compact={Boolean(currentTab(tab)?.compact)}>
            {tab === 'functions'    && <FunctionHubTab onOpenContext={handleOpenContext} toast={toast} />}
            {tab === 'acquire'      && <DataProcessingTab toast={toast} workDateRange={workDateRange} />}
            {tab === 'research'     && <ResearchTab toast={toast} />}
            {tab === 'bed'          && <ShiftTab toast={toast} mode="bed" {...sharedDateProps} />}
            {tab === 'ward'         && <ShiftTab toast={toast} mode="ward" workflowTitle="Điều dưỡng bệnh phòng" workflowHint="Nhập chăm sóc, dịch truyền và thủ thuật cho các ca không thuộc diện người trực trong ngày đã chọn." {...sharedDateProps} />}
            {tab === 'duty'         && <ShiftTab toast={toast} mode="duty" workflowTitle="Điều dưỡng trực" workflowHint="Chỉ hiện người bệnh lần đầu vào khoa/chuyển khoa trong ngày trực theo quy tắc GMHS và giờ hành chánh." {...sharedDateProps} />}
            {tab === 'hchanh'       && <HchahnTab toast={toast} workDateRange={workDateRange} />}
            {tab === 'records-check' && <RecordsCheckTab toast={toast} workDateRange={workDateRange} />}
            {tab === 'vtyt-catalog' && <VtytCatalogManager />}
            {tab === 'clinic'       && <ClinicTab toast={toast} />}
            {tab === 'nurse'        && <NurseTab toast={toast} />}
            {tab === 'report'       && <ReportTab toast={toast} workDateRange={workDateRange} />}
          </ContentFrame>
        </div>
      </div>
      <ActivityNotifications items={activityItems} />
      <ToastBar toasts={toasts} />
      <PatientLogModal open={showLog} onClose={() => setShowLog(false)} loading={logLoading} data={logData} />
    </div>
  );
}
