// src/components/BhytPortalPanel.jsx — Nhúng thẳng giao diện "Nhập chứng từ BHYT"
// (tools/bhyt_selenium_app) vào tab Nghỉ ốm, thay vì mở tab riêng. Gọi thẳng
// API Flask (127.0.0.1:5005, đã bật CORS giới hạn origin localhost/127.0.0.1)
// từ trình duyệt — không qua Node. Bản port đầy đủ tính năng từ
// tools/bhyt_selenium_app/static/app.js, giữ đúng luồng an toàn: không tự
// vượt CAPTCHA/OTP, không lưu mật khẩu, luôn "Điền thử" trước "Nhập thật".

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { C, FS } from '../tokens.js';
import { Badge, Btn, Spinner } from './shared.jsx';
import * as api from '../api.js';

const BHYT_BASE = 'http://127.0.0.1:5005';

const STATUS_LABELS = { pending: 'Chờ xử lý', previewed: 'Đã điền thử', running: 'Đang chạy', success: 'Thành công', error: 'Lỗi' };

const FIELD_DEFS_COMMON = [
  ['ho_ten', 'Họ tên'], ['ma_bhxh', 'Mã số BHXH'], ['ma_the', 'Mã thẻ BHYT'],
  ['ngay_sinh', 'Ngày sinh'], ['gioi_tinh', 'Giới tính'], ['doctor_text', 'Bác sĩ / Trưởng khoa'], ['ngay_ct', 'Ngày chứng từ'],
];
const FIELD_DEFS_BHXH07 = [
  ['so_kcb', 'Số KCB'], ['ma_ct', 'Mã chứng từ'], ['so_seri', 'Số seri'], ['mau_so', 'Mẫu số'],
  ['ten_dv', 'Đơn vị'], ['ngay_kcb', 'Ngày khám bệnh'], ['chan_doan', 'Chẩn đoán và điều trị', 'wide'],
  ['tu_ngay', 'Nghỉ từ ngày'], ['den_ngay', 'Nghỉ đến ngày'], ['ho_ten_cha', 'Họ tên cha'],
  ['ho_ten_me', 'Họ tên mẹ'], ['nguoi_dai_dien', 'Thủ trưởng đơn vị'],
];
const FIELD_DEFS_GRV03 = [
  ['ma_ct', 'Số lưu trữ'], ['so_seri', 'Mã y tế'], ['ma_khoa', 'Khoa'], ['dan_toc', 'Dân tộc'],
  ['nghe_nghiep', 'Nghề nghiệp'], ['dia_chi', 'Địa chỉ', 'wide'], ['tu_ngay', 'Ngày vào viện'], ['den_ngay', 'Ngày ra viện'],
  ['chan_doan', 'Chẩn đoán', 'wide'], ['pp_dieutri', 'Phương pháp điều trị', 'wide'], ['ghi_chu', 'Ghi chú', 'wide'],
  ['ngoaitru_tungay', 'Ngoại trú từ ngày'], ['ngoaitru_denngay', 'Ngoại trú đến ngày'],
  ['ho_ten_cha', 'Họ tên cha'], ['ho_ten_me', 'Mẹ / người nuôi dưỡng'], ['nguoi_dai_dien', 'Thủ trưởng đơn vị'], ['loai_giay_to', 'Loại giấy tờ'],
];
const FIELD_DEFS_BY_TYPE = { BHXH07: FIELD_DEFS_BHXH07, GRV03: FIELD_DEFS_GRV03 };

async function bhytFetch(path, options = {}) {
  let res;
  try {
    res = await fetch(`${BHYT_BASE}${path}`, options);
  } catch (err) {
    throw new Error(`Không gọi được công cụ BHYT (chưa chạy?): ${err.message || err}`);
  }
  let data = {};
  try { data = await res.json(); } catch { /* rỗng/không phải JSON */ }
  if (!res.ok) throw new Error(data.error || `Lỗi HTTP ${res.status}`);
  return data;
}

const INPUT_STYLE = {
  padding: '6px 8px', fontSize: FS.sm, border: `1px solid ${C.border}`, borderRadius: 5,
  background: C.surface, color: C.text, fontFamily: 'inherit', width: '100%', boxSizing: 'border-box',
};
const LABEL_STYLE = { fontSize: FS.xs, fontWeight: 700, color: C.text3, display: 'block', marginBottom: 3 };

function Field({ label, children }) {
  return <label style={{ display: 'block' }}><span style={LABEL_STYLE}>{label}</span>{children}</label>;
}

function StepCard({ n, title, hint, children, actions }) {
  return (
    <div style={{
      display: 'flex', gap: 12, alignItems: 'flex-start', padding: '12px 14px',
      border: `1px solid ${C.border2}`, borderRadius: 8, background: C.surface, marginBottom: 10,
    }}>
      <div style={{
        flexShrink: 0, width: 22, height: 22, borderRadius: '50%', background: C.blueBg || C.surface2,
        color: C.blue || C.text2, fontSize: FS.xs, fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}>{n}</div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: FS.md, fontWeight: 700, color: C.text, marginBottom: 2 }}>{title}</div>
        {hint && <div style={{ fontSize: FS.xs, color: C.text3, marginBottom: 8, lineHeight: 1.5 }}>{hint}</div>}
        {children}
      </div>
      {actions && <div style={{ flexShrink: 0, display: 'flex', gap: 6, flexWrap: 'wrap' }}>{actions}</div>}
    </div>
  );
}

export default function BhytPortalPanel({ toast, sessionId, autoOpenPortal = false }) {
  const [available, setAvailable] = useState(null); // null=đang kiểm tra, true/false
  const [launching, setLaunching] = useState(false);

  const [summary, setSummary] = useState({ total: 0, not_ready: 0, by_type: {} });
  const [workerStatus, setWorkerStatus] = useState({ running: false, current_id: null, message: '' });
  const [browserStatus, setBrowserStatus] = useState({ logged_in: false });
  const [records, setRecords] = useState([]);

  const [facilityCode, setFacilityCode] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');

  // Đăng nhập headless: CAPTCHA lấy từ cổng về hiện ngay ở Data Hub, người dùng gõ ở đây.
  const [captchaImg, setCaptchaImg] = useState('');
  const [captchaText, setCaptchaText] = useState('');
  const [loadingCaptcha, setLoadingCaptcha] = useState(false);
  const [loggingIn, setLoggingIn] = useState(false);
  const [capturing, setCapturing] = useState(false);

  // Mục tiêu 2 — nhập "Giấy chứng nhận nghỉ việc hưởng BHXH" vào EMR nội bộ.
  const [emrUser, setEmrUser] = useState('');
  const [emrPass, setEmrPass] = useState('');
  const [emrStatus, setEmrStatus] = useState({ logged_in: false });
  const [emrPatient, setEmrPatient] = useState('');
  const [emrBusy, setEmrBusy] = useState('');
  const [emrConfirmOpen, setEmrConfirmOpen] = useState(false);
  const [emrConfirmText, setEmrConfirmText] = useState('');

  const fileInputRef = useRef(null);
  const autoOpenStarted = useRef(false);
  const [importing, setImporting] = useState(false);
  const [importingFromWebapp, setImportingFromWebapp] = useState(false);

  const [typeFilter, setTypeFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState(() => new Set());

  const [editing, setEditing] = useState(null); // record đang sửa
  const [editForm, setEditForm] = useState({});
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [confirmText, setConfirmText] = useState('');

  const [logs, setLogs] = useState([]);
  const [logsOpen, setLogsOpen] = useState(false);

  const checkAvailable = useCallback(async () => {
    try {
      await bhytFetch('/api/summary');
      setAvailable(true);
      return true;
    } catch {
      setAvailable(false);
      return false;
    }
  }, []);

  const loadAll = useCallback(async () => {
    try {
      const query = new URLSearchParams({ doc_type: typeFilter, status: statusFilter, search: search.trim() });
      const [recordsRes, summaryRes] = await Promise.all([
        bhytFetch(`/api/records?${query}`),
        bhytFetch('/api/summary'),
      ]);
      setRecords(Array.isArray(recordsRes.records) ? recordsRes.records : []);
      setSummary(summaryRes.summary || { total: 0, not_ready: 0, by_type: {} });
      setWorkerStatus(summaryRes.worker || { running: false, current_id: null, message: '' });
    } catch (e) {
      toast?.(String(e?.message || 'Không tải được danh sách hồ sơ BHYT'), 'error');
    }
  }, [typeFilter, statusFilter, search, toast]);

  const checkBrowser = useCallback(async () => {
    try {
      setBrowserStatus(await bhytFetch('/api/browser/status'));
    } catch (e) {
      setBrowserStatus({ logged_in: false, error: e.message });
    }
  }, []);

  // Khởi động công cụ nhập BHXH (Flask + trình duyệt ngầm) như luồng mở EMR, không cần start.bat.
  // Sau khi sẵn sàng thì lấy luôn mã CAPTCHA về để đăng nhập.
  const handleOpenPortal = useCallback(async () => {
    setLaunching(true);
    try {
      let ready = await checkAvailable();
      if (!ready) {
        const result = await api.launchBhytTool();
        if (result?.status !== 'ok') throw new Error(result?.message || 'Không khởi động được công cụ nhập BHXH.');
        for (let i = 0; i < 8; i += 1) {
          if (await checkAvailable()) { ready = true; break; }
          await new Promise(r => setTimeout(r, 500));
        }
      }
      if (!ready) throw new Error('Công cụ BHXH chưa sẵn sàng. Hãy thử lại hoặc kiểm tra start.bat.');
      await checkBrowser();
      toast?.('Công cụ đã sẵn sàng. Bấm "Lấy mã CAPTCHA" ở bước 1 để đăng nhập.', 'ok');
    } catch (e) {
      toast?.(String(e?.message || 'Không khởi động được công cụ nhập BHXH.'), 'error');
    } finally {
      setLaunching(false);
    }
  }, [checkAvailable, checkBrowser, toast]);

  useEffect(() => {
    if (!autoOpenPortal || autoOpenStarted.current) return;
    autoOpenStarted.current = true;
    handleOpenPortal();
  }, [autoOpenPortal, handleOpenPortal]);

  const loadLogs = useCallback(async () => {
    try {
      const d = await bhytFetch('/api/logs');
      setLogs(Array.isArray(d.logs) ? d.logs : []);
    } catch (e) {
      toast?.(String(e?.message || 'Không tải được nhật ký'), 'error');
    }
  }, [toast]);

  useEffect(() => {
    let cancelled = false;
    checkAvailable().then(ok => {
      if (cancelled || !ok) return;
      loadAll();
      checkBrowser();
      checkEmr();
    });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (available) loadAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [typeFilter, statusFilter, search, available]);

  // Poll khi worker đang chạy (điền thử/nhập thật) — giống setInterval trong app.js gốc.
  // ux-rules: no-realtime — công cụ BHYT chạy riêng ở cổng khác, máy chủ app không theo dõi được file của nó.
  useEffect(() => {
    if (!available || !workerStatus.running) return undefined;
    const id = setInterval(() => { loadAll(); if (logsOpen) loadLogs(); }, 2000);
    return () => clearInterval(id);
  }, [available, workerStatus.running, logsOpen, loadAll, loadLogs]);

  // Lấy ảnh CAPTCHA từ cổng (trình duyệt chạy ngầm trên máy chủ) về hiện ở Data Hub.
  const loadCaptcha = useCallback(async () => {
    setLoadingCaptcha(true);
    try {
      let ready = available;
      if (!ready) ready = await checkAvailable();
      if (!ready) {
        const result = await api.launchBhytTool();
        if (result?.status !== 'ok') throw new Error(result?.message || 'Không khởi động được công cụ nhập BHXH.');
        for (let i = 0; i < 8; i += 1) {
          if (await checkAvailable()) { ready = true; break; }
          await new Promise(r => setTimeout(r, 500));
        }
      }
      if (!ready) throw new Error('Công cụ BHXH chưa sẵn sàng. Hãy thử lại sau giây lát.');
      const d = await bhytFetch('/api/browser/captcha');
      setCaptchaImg(d.image || '');
      setCaptchaText('');
    } catch (e) {
      toast?.(String(e?.message || 'Không lấy được mã CAPTCHA.'), 'error');
      setCaptchaImg('');
    } finally {
      setLoadingCaptcha(false);
    }
  }, [available, checkAvailable, toast]);

  const refreshCaptcha = useCallback(async () => {
    setLoadingCaptcha(true);
    try {
      const d = await bhytFetch('/api/browser/refresh-captcha', { method: 'POST' });
      setCaptchaImg(d.image || '');
      setCaptchaText('');
    } catch (e) {
      toast?.(String(e?.message || 'Không đổi được mã CAPTCHA.'), 'error');
    } finally {
      setLoadingCaptcha(false);
    }
  }, [toast]);

  // Gửi tài khoản + CAPTCHA (người dùng gõ ở Data Hub) lên cổng, đăng nhập, giữ phiên.
  const doHeadlessLogin = useCallback(async () => {
    if (!facilityCode.trim() || !username.trim() || !password || !captchaText.trim()) {
      toast?.('Cần nhập đủ Mã cơ sở KCB, tên đăng nhập, mật khẩu và mã CAPTCHA.', 'error');
      return;
    }
    setLoggingIn(true);
    try {
      const d = await bhytFetch('/api/browser/login', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          facility_code: facilityCode.trim(), username: username.trim(), password, captcha: captchaText.trim(),
        }),
      });
      setPassword('');
      setCaptchaText('');
      if (d.logged_in) {
        setCaptchaImg('');
        toast?.(d.message || 'Đăng nhập thành công, đã giữ phiên.', 'ok');
        await checkBrowser();
      } else {
        toast?.(d.message || 'Chưa đăng nhập được. Lấy lại mã CAPTCHA và thử lại.', 'error');
        await loadCaptcha(); // mã cũ đã dùng, lấy mã mới
      }
    } catch (e) {
      toast?.(String(e?.message || 'Không đăng nhập được.'), 'error');
    } finally {
      setLoggingIn(false);
    }
  }, [facilityCode, username, password, captchaText, checkBrowser, loadCaptcha, toast]);

  // Lưu HTML các trang sau khi đăng nhập để kỹ thuật dựng tiếp phần tra cứu/nhập.
  const capturePages = useCallback(async () => {
    setCapturing(true);
    try {
      const d = await bhytFetch('/api/browser/capture', { method: 'POST' });
      const n = Array.isArray(d.captured) ? d.captured.length : 0;
      toast?.(`Đã lưu ${n} trang vào thư mục debug của công cụ. Gửi các file này cho kỹ thuật.`, 'ok');
    } catch (e) {
      toast?.(String(e?.message || 'Không lưu được trang.'), 'error');
    } finally {
      setCapturing(false);
    }
  }, [toast]);

  // ── EMR nội bộ: nhập giấy nghỉ (mục tiêu 2) ────────────────────────────────
  const checkEmr = useCallback(async () => {
    try {
      setEmrStatus(await bhytFetch('/api/emr/status'));
    } catch (e) {
      setEmrStatus({ logged_in: false, error: e.message });
    }
  }, []);

  const emrLogin = useCallback(async () => {
    if (!emrUser.trim() || !emrPass) { toast?.('Cần nhập tài khoản và mật khẩu EMR.', 'error'); return; }
    setEmrBusy('login');
    try {
      const d = await bhytFetch('/api/emr/login', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: emrUser.trim(), password: emrPass }),
      });
      setEmrPass('');
      if (d.logged_in) { setEmrStatus({ logged_in: true }); toast?.(d.message || 'Đã đăng nhập EMR.', 'ok'); }
      else toast?.(d.message || 'Chưa đăng nhập được EMR.', 'error');
    } catch (e) {
      toast?.(String(e?.message || 'Không đăng nhập được EMR.'), 'error');
    } finally {
      setEmrBusy('');
    }
  }, [emrUser, emrPass, toast]);

  // Người bệnh để thao tác: tên gõ tay, hoặc hồ sơ đầu tiên đang chọn trong danh sách.
  const firstSelected = records.find(r => selected.has(r.id));
  const emrTargetName = emrPatient.trim() || firstSelected?.patient_name || '';

  const emrOpenCert = useCallback(async () => {
    if (!emrTargetName) { toast?.('Nhập tên người bệnh hoặc chọn một hồ sơ trong danh sách.', 'error'); return; }
    setEmrBusy('open');
    try {
      const d = await bhytFetch('/api/emr/open-cert', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ patient_name: emrTargetName }),
      });
      toast?.(d.message || 'Đã mở form giấy nghỉ.', 'ok');
    } catch (e) {
      toast?.(String(e?.message || 'Không mở được form giấy nghỉ.'), 'error');
    } finally {
      setEmrBusy('');
    }
  }, [emrTargetName, toast]);

  const emrCapture = useCallback(async () => {
    setEmrBusy('capture');
    try {
      const d = await bhytFetch('/api/emr/capture', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'form-giay-nghi' }),
      });
      toast?.(d.saved ? 'Đã lưu form vào thư mục debug. Gửi file cho kỹ thuật.' : 'Chưa có gì để lưu.', d.saved ? 'ok' : 'error');
    } catch (e) {
      toast?.(String(e?.message || 'Không lưu được form.'), 'error');
    } finally {
      setEmrBusy('');
    }
  }, [toast]);

  const emrFill = useCallback(async (dryRun, confirmation = '') => {
    if (!firstSelected) { toast?.('Chọn một hồ sơ trong danh sách để lấy dữ liệu điền.', 'error'); return; }
    setEmrBusy(dryRun ? 'fill' : 'fillreal');
    try {
      const d = await bhytFetch('/api/emr/fill', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ record_id: firstSelected.id, dry_run: dryRun, confirmation }),
      });
      toast?.(d.message || (dryRun ? 'Đã điền thử.' : 'Đã nhập thật.'), 'ok');
    } catch (e) {
      toast?.(String(e?.message || 'Không điền được form.'), 'error');
    } finally {
      setEmrBusy('');
    }
  }, [firstSelected, toast]);

  const handleImportFiles = useCallback(async (fileList) => {
    if (!fileList || !fileList.length) return;
    setImporting(true);
    try {
      const fd = new FormData();
      for (const f of fileList) fd.append('files', f);
      const d = await bhytFetch('/api/import', { method: 'POST', body: fd });
      toast?.(`Đã nhận ${d.recognized} hồ sơ: thêm ${d.added}, cập nhật ${d.updated}`, 'ok');
      await loadAll();
    } catch (e) {
      toast?.(String(e?.message || 'Không đọc được file Excel.'), 'error');
    } finally {
      setImporting(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  }, [loadAll, toast]);

  // Lấy thẳng từ web app hiện tại — không cần form URL/mã phiên vì đang cùng
  // trang, dùng luôn window.location.origin + sessionId đã có sẵn.
  const handleImportFromWebapp = useCallback(async () => {
    setImportingFromWebapp(true);
    try {
      const d = await bhytFetch('/api/import-from-webapp', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ base_url: window.location.origin, session_id: sessionId }),
      });
      const skipped = [
        d.skipped_issue ? `${d.skipped_issue} đang cần sửa` : '',
        d.skipped_submitted ? `${d.skipped_submitted} đã nộp` : '',
        d.skipped_doctor ? `${d.skipped_doctor} khác bác sĩ` : '',
      ].filter(Boolean).join(', ');
      toast?.(`Đã nhận ${d.recognized} hồ sơ: thêm ${d.added}, cập nhật ${d.updated}${skipped ? ` (bỏ qua: ${skipped})` : ''}`, 'ok');
      await loadAll();
    } catch (e) {
      toast?.(String(e?.message || 'Không lấy được dữ liệu từ web app.'), 'error');
    } finally {
      setImportingFromWebapp(false);
    }
  }, [sessionId, loadAll, toast]);

  const openEdit = useCallback((record) => {
    setEditing(record);
    setEditForm({ ...record.fields });
  }, []);

  const saveEdit = useCallback(async (e) => {
    e.preventDefault();
    if (!editing) return;
    try {
      await bhytFetch(`/api/records/${editing.id}/fields`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fields: editForm }),
      });
      toast?.('Đã lưu dữ liệu bổ sung.', 'ok');
      setEditing(null);
      await loadAll();
    } catch (e2) {
      toast?.(String(e2?.message || 'Không lưu được.'), 'error');
    }
  }, [editing, editForm, loadAll, toast]);

  const runSelected = useCallback(async (dryRun, confirmation = '') => {
    const ids = [...selected];
    if (!ids.length) { toast?.('Hãy chọn ít nhất một hồ sơ sẵn sàng.', 'error'); return; }
    try {
      const d = await bhytFetch('/api/run', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ record_ids: ids, dry_run: dryRun, confirmation }),
      });
      toast?.(`${d.message}: ${d.count} hồ sơ`, 'ok');
      await loadAll();
    } catch (e) {
      toast?.(String(e?.message || 'Không chạy được.'), 'error');
    }
  }, [selected, loadAll, toast]);

  const handleStop = useCallback(async () => {
    try {
      const d = await bhytFetch('/api/stop', { method: 'POST' });
      toast?.(d.message || 'Đã gửi yêu cầu dừng.', 'ok');
    } catch (e) {
      toast?.(String(e?.message || 'Không dừng được.'), 'error');
    }
  }, [toast]);

  const handleResetSelected = useCallback(async () => {
    const ids = [...selected];
    if (!ids.length) { toast?.('Chưa chọn hồ sơ.', 'error'); return; }
    try {
      await bhytFetch('/api/reset', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ record_ids: ids }),
      });
      toast?.('Đã đặt lại trạng thái.', 'ok');
      await loadAll();
    } catch (e) {
      toast?.(String(e?.message || 'Không đặt lại được.'), 'error');
    }
  }, [selected, loadAll, toast]);

  const toggleSelect = useCallback((id) => {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }, []);

  const toggleSelectAll = useCallback((checked) => {
    setSelected(checked ? new Set(records.map(r => r.id)) : new Set());
  }, [records]);

  const allSelected = records.length > 0 && records.every(r => selected.has(r.id));

  if (available === null) {
    return (
      <div style={{ padding: 16, textAlign: 'center', color: C.text3, fontSize: FS.sm }}>
        <Spinner size={14} /> Đang kiểm tra công cụ nhập cổng BHXH...
      </div>
    );
  }

  if (!available) {
    return (
      <div style={{ padding: 16, textAlign: 'center' }}>
        <div style={{ fontSize: FS.sm, color: C.text3, marginBottom: 10, lineHeight: 1.6 }}>
          Công cụ nhập cổng BHYT (<code>tools/bhyt_selenium_app</code>) chưa chạy trên máy này.
        </div>
        <Btn variant="primary" onClick={handleOpenPortal} disabled={launching}>
          {launching ? <><Spinner size={11} /> Đang khởi động...</> : 'Khởi động công cụ nhập BHXH'}
        </Btn>
        <div style={{ fontSize: FS.xs, color: C.text3, marginTop: 10 }}>
          Nếu vẫn không được, lần đầu trên máy này cần tự chạy <code>start.bat</code> trong <code>tools/bhyt_selenium_app</code> 1 lần để cài thư viện.
        </div>
      </div>
    );
  }

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
        <Badge
          text={browserStatus.logged_in ? 'Cổng: đã đăng nhập' : (browserStatus.error ? 'Cổng: chưa chạy' : 'Cổng: chưa đăng nhập')}
          bg={browserStatus.logged_in ? C.greenBg : C.redBg}
          color={browserStatus.logged_in ? C.green : C.red}
          size={FS.xs}
        />
        <Btn variant="default" onClick={handleOpenPortal} disabled={launching} style={{ padding: '5px 10px', fontSize: FS.xs }}>
          {launching ? <><Spinner size={10} /> Đang khởi động...</> : 'Khởi động công cụ'}
        </Btn>
        {browserStatus.logged_in && (
          <Btn variant="default" onClick={capturePages} disabled={capturing} style={{ padding: '5px 10px', fontSize: FS.xs }}>
            {capturing ? <><Spinner size={10} /> Đang lưu...</> : 'Lưu trang cho kỹ thuật'}
          </Btn>
        )}
        <Btn variant="default" onClick={loadAll} style={{ padding: '4px 10px', fontSize: FS.xs, marginLeft: 'auto' }}>⟳ Làm mới</Btn>
      </div>

      <StepCard
        n={1}
        title="Đăng nhập cổng BHYT"
        hint="Trình duyệt chạy ngầm trên máy chủ. Bấm 'Lấy mã CAPTCHA' để cổng gửi mã về đây, gõ mã rồi 'Đăng nhập' — phiên được giữ để tra cứu thẻ và nhập giấy nghỉ. Không tự vượt CAPTCHA, không lưu mật khẩu."
        actions={<>
          <Btn variant="default" onClick={checkBrowser} style={{ padding: '6px 10px', fontSize: FS.xs }}>Kiểm tra đăng nhập</Btn>
        </>}
      >
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 8 }}>
          <Field label="Mã cơ sở KCB"><input value={facilityCode} onChange={e => setFacilityCode(e.target.value)} style={INPUT_STYLE} autoComplete="off" /></Field>
          <Field label="Tên đăng nhập"><input value={username} onChange={e => setUsername(e.target.value)} style={INPUT_STYLE} autoComplete="off" /></Field>
          <Field label="Mật khẩu"><input type="password" value={password} onChange={e => setPassword(e.target.value)} style={INPUT_STYLE} autoComplete="new-password" /></Field>
        </div>

        <div style={{ display: 'flex', alignItems: 'flex-end', gap: 10, marginTop: 10, flexWrap: 'wrap' }}>
          <div style={{ flexShrink: 0 }}>
            <span style={LABEL_STYLE}>Mã CAPTCHA từ cổng</span>
            <div style={{
              width: 180, height: 56, border: `1px solid ${C.border}`, borderRadius: 5, background: C.surface2,
              display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden',
            }}>
              {loadingCaptcha
                ? <Spinner size={14} />
                : captchaImg
                  ? <img src={captchaImg} alt="Mã CAPTCHA" style={{ maxWidth: '100%', maxHeight: '100%' }} />
                  : <span style={{ fontSize: FS.xs, color: C.text3, padding: 6, textAlign: 'center' }}>Bấm "Lấy mã CAPTCHA"</span>}
            </div>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <Btn variant="default" onClick={loadCaptcha} disabled={loadingCaptcha} style={{ padding: '5px 10px', fontSize: FS.xs }}>Lấy mã CAPTCHA</Btn>
            <Btn variant="default" onClick={refreshCaptcha} disabled={loadingCaptcha || !captchaImg} style={{ padding: '5px 10px', fontSize: FS.xs }}>Đổi mã khác</Btn>
          </div>
          <div style={{ flex: '1 1 140px', minWidth: 140 }}>
            <Field label="Nhập mã CAPTCHA">
              <input value={captchaText} onChange={e => setCaptchaText(e.target.value)} disabled={!captchaImg}
                onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); doHeadlessLogin(); } }}
                style={INPUT_STYLE} autoComplete="off" placeholder="Gõ mã nhìn thấy ở trên" />
            </Field>
          </div>
          <Btn variant="primary" onClick={doHeadlessLogin} disabled={loggingIn || !captchaImg} style={{ padding: '7px 14px', fontSize: FS.xs }}>
            {loggingIn ? <><Spinner size={10} /> Đang đăng nhập...</> : 'Đăng nhập'}
          </Btn>
        </div>
      </StepCard>

      <StepCard
        n={2}
        title="Nhập dữ liệu"
        hint="Lấy thẳng bảng đã rà soát từ tab Nghỉ ốm (khuyến nghị — tự bỏ qua ca đang cần sửa/đã nộp), hoặc đọc file Excel BHXH gửi trực tiếp."
        actions={<>
          <Btn variant="primary" onClick={handleImportFromWebapp} disabled={importingFromWebapp} style={{ padding: '6px 10px', fontSize: FS.xs }}>
            {importingFromWebapp ? <><Spinner size={10} /> Đang lấy...</> : '⟳ Lấy từ tab Nghỉ ốm'}
          </Btn>
        </>}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <input ref={fileInputRef} type="file" multiple accept=".xlsx,.xlsm" disabled={importing}
            onChange={e => handleImportFiles(e.target.files)} style={{ fontSize: FS.xs }} />
          {importing && <Spinner size={11} />}
        </div>
      </StepCard>

      <StepCard
        n={3}
        title="Kiểm tra và chạy Selenium"
        hint='Luôn dùng "Điền thử" trước — chế độ này không bấm Lưu.'
        actions={<>
          <Btn variant="default" onClick={() => runSelected(true)} style={{ padding: '6px 10px', fontSize: FS.xs }}>Điền thử 1 hồ sơ</Btn>
          <Btn variant="danger" onClick={() => { if (!selected.size) { toast?.('Hãy chọn hồ sơ cần nhập.', 'error'); return; } setConfirmText(''); setConfirmOpen(true); }} style={{ padding: '6px 10px', fontSize: FS.xs }}>
            Nhập thật hồ sơ đã chọn
          </Btn>
          <Btn variant="default" onClick={handleStop} disabled={!workerStatus.running} style={{ padding: '6px 10px', fontSize: FS.xs }}>Dừng</Btn>
        </>}
      >
        <div style={{ display: 'flex', gap: 12, fontSize: FS.xs, color: C.text3, flexWrap: 'wrap' }}>
          <span>Tổng {summary.total || 0} hồ sơ</span>
          <span>· Thiếu dữ liệu {summary.not_ready || 0}</span>
          <span>· Giấy nghỉ 07: {Object.values(summary.by_type?.BHXH07 || {}).reduce((a, b) => a + b, 0)}</span>
          <span>· Giấy ra viện 03: {Object.values(summary.by_type?.GRV03 || {}).reduce((a, b) => a + b, 0)}</span>
          {workerStatus.running && <span style={{ color: C.blue, fontWeight: 700 }}><Spinner size={9} /> {workerStatus.message || 'Đang chạy...'}</span>}
        </div>
      </StepCard>

      <div style={{ marginTop: 16 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 8 }}>
          <div style={{ fontSize: FS.md, fontWeight: 700, color: C.text }}>Danh sách hồ sơ</div>
          <Badge text={`${records.length} hồ sơ`} bg={C.surface2} color={C.text2} size={FS.xs} />
          <input placeholder="Tìm bệnh nhân, bác sĩ..." value={search} onChange={e => setSearch(e.target.value)}
            style={{ ...INPUT_STYLE, width: 180 }} />
          <select value={typeFilter} onChange={e => setTypeFilter(e.target.value)} style={INPUT_STYLE}>
            <option value="">Tất cả loại</option>
            <option value="BHXH07">Giấy nghỉ BHXH 07</option>
            <option value="GRV03">Giấy ra viện 03</option>
          </select>
          <select value={statusFilter} onChange={e => setStatusFilter(e.target.value)} style={INPUT_STYLE}>
            <option value="">Tất cả trạng thái</option>
            {Object.entries(STATUS_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
          <a href={`${BHYT_BASE}/export/status.csv`} target="_blank" rel="noreferrer"
            style={{ fontSize: FS.xs, color: C.blue, textDecoration: 'none', border: `1px solid ${C.border}`, borderRadius: 4, padding: '4px 8px' }}>
            Xuất trạng thái CSV
          </a>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6, fontSize: FS.xs }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 5, cursor: 'pointer' }}>
            <input type="checkbox" checked={allSelected} onChange={e => toggleSelectAll(e.target.checked)} /> Chọn tất cả đang hiển thị
          </label>
          <span style={{ color: C.text3 }}>Đã chọn {selected.size}</span>
          <button type="button" onClick={handleResetSelected} style={{ fontSize: FS.xs, color: C.blue, background: 'none', border: 'none', cursor: 'pointer', textDecoration: 'underline', padding: 0 }}>
            Đặt lại trạng thái đã chọn
          </button>
        </div>

        <div style={{ border: `1px solid ${C.border2}`, borderRadius: 8, overflow: 'hidden' }}>
          {records.length === 0 ? (
            <div style={{ padding: 16, fontSize: FS.sm, color: C.text3, textAlign: 'center' }}>Chưa có dữ liệu. Hãy nhập ở bước 2.</div>
          ) : records.map(r => (
            <div key={r.id} style={{
              display: 'flex', gap: 10, alignItems: 'flex-start', padding: '9px 10px',
              borderBottom: `1px solid ${C.border2}`, background: r.status === 'success' ? C.greenBg : (r.status === 'error' ? C.redBg : C.surface),
            }}>
              <input type="checkbox" checked={selected.has(r.id)} onChange={() => toggleSelect(r.id)} style={{ marginTop: 2 }} />
              <div style={{ flex: '1 1 140px', minWidth: 0 }}>
                <div style={{ fontSize: FS.xs, fontWeight: 700, color: C.text }}>{r.patient_name || '—'}</div>
                <div style={{ fontSize: FS.xs, color: C.text3 }}>{r.doc_type} · {r.doctor_name || '—'}</div>
              </div>
              <div style={{ flex: '1 1 140px', minWidth: 0, fontSize: FS.xs, color: C.text2 }}>
                {r.doc_type === 'BHXH07' ? `Số KCB: ${r.fields?.so_kcb || '—'}` : `Mã y tế: ${r.fields?.so_seri || '—'}`}
                <div style={{ color: C.text3 }}>{r.fields?.tu_ngay || ''} → {r.fields?.den_ngay || ''}</div>
              </div>
              <div style={{ flex: '0 0 110px', fontSize: FS.xs }}>
                {r.ready
                  ? <Badge text="Sẵn sàng" bg={C.greenBg} color={C.green} size={FS.xs} />
                  : <><Badge text="Chưa" bg={C.amberBg} color={C.amber} size={FS.xs} /><div style={{ color: C.text3, marginTop: 3 }}>{(r.issues || []).join('; ')}</div></>}
              </div>
              <div style={{ flex: '0 0 110px', fontSize: FS.xs }}>
                <Badge text={STATUS_LABELS[r.status] || r.status} bg={r.status === 'success' ? C.greenBg : (r.status === 'error' ? C.redBg : C.surface2)} color={r.status === 'success' ? C.green : (r.status === 'error' ? C.red : C.text2)} size={FS.xs} />
                {r.message && <div style={{ color: C.text3, marginTop: 3 }}>{r.message}</div>}
              </div>
              <button type="button" onClick={() => openEdit(r)} style={{
                flexShrink: 0, padding: '4px 8px', fontSize: FS.xs, cursor: 'pointer', fontFamily: 'inherit',
                border: `1px solid ${C.border}`, background: C.surface, color: C.text2, borderRadius: 4,
              }}>Bổ sung</button>
            </div>
          ))}
        </div>
      </div>

      <div style={{
        marginTop: 16, border: `1px solid ${C.border2}`, borderRadius: 8, padding: '12px 14px', background: C.surface,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6, flexWrap: 'wrap' }}>
          <div style={{ fontSize: FS.md, fontWeight: 700, color: C.text }}>Nhập giấy nghỉ vào EMR nội bộ</div>
          <Badge text="Mục tiêu 2 · thử nghiệm" bg={C.amberBg} color={C.amber} size={FS.xs} />
          <Badge
            text={emrStatus.logged_in ? 'EMR: đã đăng nhập' : (emrStatus.error ? 'EMR: chưa chạy' : 'EMR: chưa đăng nhập')}
            bg={emrStatus.logged_in ? C.greenBg : C.redBg}
            color={emrStatus.logged_in ? C.green : C.red}
            size={FS.xs}
          />
          <Btn variant="default" onClick={checkEmr} style={{ padding: '4px 10px', fontSize: FS.xs, marginLeft: 'auto' }}>Kiểm tra</Btn>
        </div>
        <div style={{ fontSize: FS.xs, color: C.text3, lineHeight: 1.5, marginBottom: 10 }}>
          Đây là nhập "Giấy chứng nhận nghỉ việc hưởng BHXH" vào <b>EMR nội bộ</b> (không phải cổng BHYT).
          Đăng nhập EMR, chọn 1 hồ sơ ở danh sách trên (hoặc gõ tên), <b>Mở form</b> rồi <b>Điền thử</b> (không bấm Chấp nhận).
          Nếu nav sai hoặc thiếu ô, bấm <b>Chụp form</b> và gửi file để khớp lại.
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 8, marginBottom: 10 }}>
          <Field label="Tài khoản EMR"><input value={emrUser} onChange={e => setEmrUser(e.target.value)} style={INPUT_STYLE} autoComplete="off" /></Field>
          <Field label="Mật khẩu EMR"><input type="password" value={emrPass} onChange={e => setEmrPass(e.target.value)} style={INPUT_STYLE} autoComplete="new-password" /></Field>
          <div style={{ display: 'flex', alignItems: 'flex-end' }}>
            <Btn variant="primary" onClick={emrLogin} disabled={emrBusy === 'login'} style={{ padding: '7px 12px', fontSize: FS.xs }}>
              {emrBusy === 'login' ? <><Spinner size={10} /> Đang đăng nhập...</> : 'Đăng nhập EMR'}
            </Btn>
          </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'flex-end', gap: 8, flexWrap: 'wrap' }}>
          <div style={{ flex: '1 1 200px', minWidth: 160 }}>
            <Field label="Người bệnh (để trống thì lấy hồ sơ đang chọn ở trên)">
              <input value={emrPatient} onChange={e => setEmrPatient(e.target.value)} style={INPUT_STYLE}
                autoComplete="off" placeholder={firstSelected?.patient_name || 'Gõ tên người bệnh'} />
            </Field>
          </div>
          <Btn variant="default" onClick={emrOpenCert} disabled={!!emrBusy} style={{ padding: '6px 10px', fontSize: FS.xs }}>
            {emrBusy === 'open' ? <><Spinner size={10} /> Đang mở...</> : 'Mở form giấy nghỉ'}
          </Btn>
          <Btn variant="default" onClick={emrCapture} disabled={!!emrBusy} style={{ padding: '6px 10px', fontSize: FS.xs }}>
            {emrBusy === 'capture' ? <><Spinner size={10} /> Đang lưu...</> : 'Chụp form cho kỹ thuật'}
          </Btn>
          <Btn variant="default" onClick={() => emrFill(true)} disabled={!!emrBusy} style={{ padding: '6px 10px', fontSize: FS.xs }}>
            {emrBusy === 'fill' ? <><Spinner size={10} /> Đang điền...</> : 'Điền thử'}
          </Btn>
          <Btn variant="danger" onClick={() => { if (!firstSelected) { toast?.('Chọn một hồ sơ trong danh sách.', 'error'); return; } setEmrConfirmText(''); setEmrConfirmOpen(true); }}
            disabled={!!emrBusy} style={{ padding: '6px 10px', fontSize: FS.xs }}>
            Nhập thật (bấm Chấp nhận)
          </Btn>
        </div>
        {emrTargetName && (
          <div style={{ fontSize: FS.xs, color: C.text3, marginTop: 8 }}>Đang thao tác với: <b>{emrTargetName}</b></div>
        )}
      </div>

      <div style={{ marginTop: 16 }}>
        <button type="button" onClick={() => { setLogsOpen(o => !o); if (!logsOpen) loadLogs(); }} style={{
          fontSize: FS.xs, color: C.blue, background: 'none', border: 'none', cursor: 'pointer', padding: 0, textDecoration: 'underline',
        }}>
          {logsOpen ? '▾' : '▸'} Nhật ký gần đây
        </button>
        {logsOpen && (
          <div style={{ marginTop: 8, border: `1px solid ${C.border2}`, borderRadius: 8, padding: 10, maxHeight: 200, overflowY: 'auto' }}>
            {logs.length === 0 ? <span style={{ fontSize: FS.xs, color: C.text3 }}>Chưa có nhật ký.</span> : logs.map((l, i) => (
              <div key={i} style={{ display: 'flex', gap: 8, fontSize: FS.xs, padding: '3px 0', borderBottom: i < logs.length - 1 ? `1px dashed ${C.border2}` : 'none' }}>
                <span style={{ color: C.text3, flexShrink: 0 }}>{l.created_at}</span>
                <span style={{ color: C.text3, flexShrink: 0 }}>{l.doc_type || ''}</span>
                <span style={{ color: C.text2, flexShrink: 0 }}>{l.patient_name || ''}</span>
                <span style={{ color: l.level === 'error' ? C.red : C.text }}>{l.message}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      {editing && (
        <div style={{
          position: 'fixed', inset: 0, background: 'rgba(23,32,51,0.42)', zIndex: 200,
          display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16,
        }} onClick={() => setEditing(null)}>
          <form onSubmit={saveEdit} onClick={e => e.stopPropagation()} style={{
            background: C.surface, border: `1px solid ${C.border}`, borderRadius: 8,
            padding: 18, width: 620, maxWidth: '95vw', maxHeight: '90vh', overflowY: 'auto',
          }}>
            <div style={{ fontSize: FS.lg, fontWeight: 700, color: C.text, marginBottom: 4 }}>Bổ sung: {editing.patient_name}</div>
            <div style={{ fontSize: FS.xs, color: C.text3, marginBottom: 10 }}>{editing.doc_type} · {editing.source_file}, dòng {editing.source_row}</div>
            {(editing.issues || []).length > 0 && (
              <div style={{ fontSize: FS.xs, color: C.red, background: C.redBg, borderRadius: 5, padding: '6px 8px', marginBottom: 10 }}>
                {editing.issues.join('; ')}
              </div>
            )}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 10 }}>
              {[...FIELD_DEFS_COMMON, ...(FIELD_DEFS_BY_TYPE[editing.doc_type] || [])]
                .filter((v, i, a) => a.findIndex(x => x[0] === v[0]) === i)
                .map(([key, label, wide]) => (
                  <div key={key} style={wide ? { gridColumn: '1 / -1' } : undefined}>
                    <Field label={label}>
                      {wide
                        ? <textarea value={editForm[key] || ''} onChange={e => setEditForm(f => ({ ...f, [key]: e.target.value }))} rows={2} style={{ ...INPUT_STYLE, resize: 'vertical' }} />
                        : <input value={editForm[key] || ''} onChange={e => setEditForm(f => ({ ...f, [key]: e.target.value }))} style={INPUT_STYLE} />}
                    </Field>
                  </div>
                ))}
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 14 }}>
              <Btn variant="default" onClick={() => setEditing(null)} style={{ padding: '6px 14px', fontSize: FS.sm }}>Hủy</Btn>
              <Btn variant="primary" type="submit" style={{ padding: '6px 14px', fontSize: FS.sm }}>Lưu thay đổi</Btn>
            </div>
          </form>
        </div>
      )}

      {confirmOpen && (
        <div style={{
          position: 'fixed', inset: 0, background: 'rgba(23,32,51,0.42)', zIndex: 200,
          display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16,
        }} onClick={() => setConfirmOpen(false)}>
          <form onSubmit={e => { e.preventDefault(); const v = confirmText; setConfirmOpen(false); runSelected(false, v); }}
            onClick={e => e.stopPropagation()} style={{
              background: C.surface, border: `1px solid ${C.border}`, borderRadius: 8, padding: 18, width: 420, maxWidth: '95vw',
            }}>
            <div style={{ fontSize: FS.lg, fontWeight: 700, color: C.text, marginBottom: 8 }}>Xác nhận nhập thật</div>
            <div style={{ fontSize: FS.xs, color: C.text2, lineHeight: 1.6, marginBottom: 10 }}>
              Selenium sẽ bấm <b>Lưu</b> trên cổng BHYT cho {selected.size} hồ sơ đã chọn. Gõ chính xác <code>NHẬP THẬT</code> để tiếp tục.
            </div>
            <input value={confirmText} onChange={e => setConfirmText(e.target.value)} placeholder="NHẬP THẬT" autoComplete="off" style={INPUT_STYLE} />
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 14 }}>
              <Btn variant="default" onClick={() => setConfirmOpen(false)} style={{ padding: '6px 14px', fontSize: FS.sm }}>Hủy</Btn>
              <Btn variant="danger" type="submit" style={{ padding: '6px 14px', fontSize: FS.sm }}>Bắt đầu nhập thật</Btn>
            </div>
          </form>
        </div>
      )}

      {emrConfirmOpen && (
        <div style={{
          position: 'fixed', inset: 0, background: 'rgba(23,32,51,0.42)', zIndex: 200,
          display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16,
        }} onClick={() => setEmrConfirmOpen(false)}>
          <form onSubmit={e => { e.preventDefault(); const v = emrConfirmText; setEmrConfirmOpen(false); emrFill(false, v); }}
            onClick={e => e.stopPropagation()} style={{
              background: C.surface, border: `1px solid ${C.border}`, borderRadius: 8, padding: 18, width: 440, maxWidth: '95vw',
            }}>
            <div style={{ fontSize: FS.lg, fontWeight: 700, color: C.text, marginBottom: 8 }}>Xác nhận nhập thật vào EMR</div>
            <div style={{ fontSize: FS.xs, color: C.text2, lineHeight: 1.6, marginBottom: 10 }}>
              Sẽ điền form giấy nghỉ của <b>{emrTargetName || firstSelected?.patient_name || '—'}</b> rồi bấm <b>Chấp nhận</b> trên EMR. Form phải đang mở. Gõ chính xác <code>NHẬP THẬT</code> để tiếp tục.
            </div>
            <input value={emrConfirmText} onChange={e => setEmrConfirmText(e.target.value)} placeholder="NHẬP THẬT" autoComplete="off" style={INPUT_STYLE} />
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 14 }}>
              <Btn variant="default" onClick={() => setEmrConfirmOpen(false)} style={{ padding: '6px 14px', fontSize: FS.sm }}>Hủy</Btn>
              <Btn variant="danger" type="submit" style={{ padding: '6px 14px', fontSize: FS.sm }}>Bấm Chấp nhận</Btn>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
