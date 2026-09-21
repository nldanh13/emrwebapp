// src/components/BhytPortalPanel.jsx — Nhúng thẳng giao diện "Nhập chứng từ BHYT"
// (tools/bhyt_selenium_app) vào tab Nghỉ ốm, thay vì mở tab riêng. Gọi thẳng
// API Flask (127.0.0.1:5005, đã bật CORS giới hạn origin localhost/127.0.0.1)
// từ trình duyệt — không qua Node. Bản port đầy đủ tính năng từ
// tools/bhyt_selenium_app/static/app.js, giữ đúng luồng an toàn: không tự
// vượt CAPTCHA/OTP, không lưu mật khẩu, luôn "Điền thử" trước "Nhập thật".

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { C } from '../tokens.js';
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
  padding: '6px 8px', fontSize: 12, border: `1px solid ${C.border}`, borderRadius: 5,
  background: C.surface, color: C.text, fontFamily: 'inherit', width: '100%', boxSizing: 'border-box',
};
const LABEL_STYLE = { fontSize: 10.5, fontWeight: 700, color: C.text3, display: 'block', marginBottom: 3 };

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
        color: C.blue || C.text2, fontSize: 11, fontWeight: 800, display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}>{n}</div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 12.5, fontWeight: 800, color: C.text, marginBottom: 2 }}>{title}</div>
        {hint && <div style={{ fontSize: 10.5, color: C.text3, marginBottom: 8, lineHeight: 1.5 }}>{hint}</div>}
        {children}
      </div>
      {actions && <div style={{ flexShrink: 0, display: 'flex', gap: 6, flexWrap: 'wrap' }}>{actions}</div>}
    </div>
  );
}

export default function BhytPortalPanel({ toast, sessionId }) {
  const [available, setAvailable] = useState(null); // null=đang kiểm tra, true/false
  const [launching, setLaunching] = useState(false);

  const [summary, setSummary] = useState({ total: 0, not_ready: 0, by_type: {} });
  const [workerStatus, setWorkerStatus] = useState({ running: false, current_id: null, message: '' });
  const [browserStatus, setBrowserStatus] = useState({ logged_in: false });
  const [records, setRecords] = useState([]);

  const [facilityCode, setFacilityCode] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [fillingLogin, setFillingLogin] = useState(false);

  const fileInputRef = useRef(null);
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

  const handleLaunch = useCallback(async () => {
    setLaunching(true);
    try {
      const result = await api.launchBhytTool();
      if (result?.status !== 'ok') throw new Error(result?.message || 'Không khởi động được công cụ.');
      // Chờ tối đa vài giây rồi kiểm tra lại — Node đã tự chờ ready trước khi
      // trả về, nhưng thử thêm vài lần cho chắc trước khi báo thất bại.
      for (let i = 0; i < 6; i += 1) {
        if (await checkAvailable()) return;
        await new Promise(r => setTimeout(r, 500));
      }
      toast?.('Đã yêu cầu khởi động nhưng chưa thấy sẵn sàng — thử bấm lại sau vài giây.', 'info');
    } catch (e) {
      toast?.(String(e?.message || 'Không khởi động được công cụ — mở tay bằng start.bat trong tools/bhyt_selenium_app rồi thử lại.'), 'error');
    } finally {
      setLaunching(false);
    }
  }, [checkAvailable, toast]);

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
    });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (available) loadAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [typeFilter, statusFilter, search, available]);

  // Poll khi worker đang chạy (điền thử/nhập thật) — giống setInterval trong app.js gốc.
  useEffect(() => {
    if (!available || !workerStatus.running) return undefined;
    const id = setInterval(() => { loadAll(); if (logsOpen) loadLogs(); }, 2000);
    return () => clearInterval(id);
  }, [available, workerStatus.running, logsOpen, loadAll, loadLogs]);

  const handleFillLogin = useCallback(async () => {
    if (!facilityCode.trim() || !username.trim() || !password) {
      toast?.('Cần nhập đủ Mã cơ sở KCB, tên đăng nhập và mật khẩu.', 'error');
      return;
    }
    setFillingLogin(true);
    try {
      const d = await bhytFetch('/api/browser/fill-login', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ facility_code: facilityCode.trim(), username: username.trim(), password }),
      });
      setPassword('');
      toast?.(d.message || 'Đã điền đăng nhập.', 'ok');
      setBrowserStatus(d.status || { logged_in: false });
    } catch (e) {
      toast?.(String(e?.message || 'Không mở/điền được Chrome.'), 'error');
      setBrowserStatus({ logged_in: false, error: e.message });
    } finally {
      setFillingLogin(false);
    }
  }, [facilityCode, username, password, toast]);

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
      <div style={{ padding: 16, textAlign: 'center', color: C.text3, fontSize: 12 }}>
        <Spinner size={14} /> Đang kiểm tra công cụ nhập cổng BHXH...
      </div>
    );
  }

  if (!available) {
    return (
      <div style={{ padding: 16, textAlign: 'center' }}>
        <div style={{ fontSize: 12, color: C.text3, marginBottom: 10, lineHeight: 1.6 }}>
          Công cụ nhập cổng BHYT (<code>tools/bhyt_selenium_app</code>) chưa chạy trên máy này.
        </div>
        <Btn variant="primary" onClick={handleLaunch} disabled={launching}>
          {launching ? <><Spinner size={11} /> Đang khởi động...</> : '⟳ Tự khởi động công cụ'}
        </Btn>
        <div style={{ fontSize: 10.5, color: C.text3, marginTop: 10 }}>
          Nếu vẫn không được, lần đầu trên máy này cần tự chạy <code>start.bat</code> trong <code>tools/bhyt_selenium_app</code> 1 lần để cài thư viện.
        </div>
      </div>
    );
  }

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
        <Badge
          text={browserStatus.logged_in ? 'Chrome: đã đăng nhập' : (browserStatus.error ? 'Chrome: không kết nối' : 'Chrome: chưa đăng nhập')}
          bg={browserStatus.logged_in ? C.greenBg : C.redBg}
          color={browserStatus.logged_in ? C.green : C.red}
          size={10}
        />
        <Btn variant="default" onClick={loadAll} style={{ padding: '4px 10px', fontSize: 11, marginLeft: 'auto' }}>⟳ Làm mới</Btn>
      </div>

      <StepCard
        n={1}
        title="Đăng nhập cổng BHYT"
        hint="Selenium điền tài khoản vào Chrome; CAPTCHA và OTP thực hiện trực tiếp trên Chrome. Không tự vượt CAPTCHA và không lưu mật khẩu."
        actions={<>
          <Btn variant="primary" onClick={handleFillLogin} disabled={fillingLogin} style={{ padding: '6px 10px', fontSize: 11 }}>
            {fillingLogin ? <><Spinner size={10} /> Đang mở...</> : 'Mở Chrome & điền đăng nhập'}
          </Btn>
          <Btn variant="default" onClick={checkBrowser} style={{ padding: '6px 10px', fontSize: 11 }}>Kiểm tra đăng nhập</Btn>
        </>}
      >
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 8 }}>
          <Field label="Mã cơ sở KCB"><input value={facilityCode} onChange={e => setFacilityCode(e.target.value)} style={INPUT_STYLE} autoComplete="off" /></Field>
          <Field label="Tên đăng nhập"><input value={username} onChange={e => setUsername(e.target.value)} style={INPUT_STYLE} autoComplete="off" /></Field>
          <Field label="Mật khẩu"><input type="password" value={password} onChange={e => setPassword(e.target.value)} style={INPUT_STYLE} autoComplete="new-password" /></Field>
        </div>
      </StepCard>

      <StepCard
        n={2}
        title="Nhập dữ liệu"
        hint="Lấy thẳng bảng đã rà soát từ tab Nghỉ ốm (khuyến nghị — tự bỏ qua ca đang cần sửa/đã nộp), hoặc đọc file Excel BHXH gửi trực tiếp."
        actions={<>
          <Btn variant="primary" onClick={handleImportFromWebapp} disabled={importingFromWebapp} style={{ padding: '6px 10px', fontSize: 11 }}>
            {importingFromWebapp ? <><Spinner size={10} /> Đang lấy...</> : '⟳ Lấy từ tab Nghỉ ốm'}
          </Btn>
        </>}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <input ref={fileInputRef} type="file" multiple accept=".xlsx,.xlsm" disabled={importing}
            onChange={e => handleImportFiles(e.target.files)} style={{ fontSize: 11 }} />
          {importing && <Spinner size={11} />}
        </div>
      </StepCard>

      <StepCard
        n={3}
        title="Kiểm tra và chạy Selenium"
        hint='Luôn dùng "Điền thử" trước — chế độ này không bấm Lưu.'
        actions={<>
          <Btn variant="default" onClick={() => runSelected(true)} style={{ padding: '6px 10px', fontSize: 11 }}>Điền thử 1 hồ sơ</Btn>
          <Btn variant="danger" onClick={() => { if (!selected.size) { toast?.('Hãy chọn hồ sơ cần nhập.', 'error'); return; } setConfirmText(''); setConfirmOpen(true); }} style={{ padding: '6px 10px', fontSize: 11 }}>
            Nhập thật hồ sơ đã chọn
          </Btn>
          <Btn variant="default" onClick={handleStop} disabled={!workerStatus.running} style={{ padding: '6px 10px', fontSize: 11 }}>Dừng</Btn>
        </>}
      >
        <div style={{ display: 'flex', gap: 12, fontSize: 10.5, color: C.text3, flexWrap: 'wrap' }}>
          <span>Tổng {summary.total || 0} hồ sơ</span>
          <span>· Thiếu dữ liệu {summary.not_ready || 0}</span>
          <span>· Giấy nghỉ 07: {Object.values(summary.by_type?.BHXH07 || {}).reduce((a, b) => a + b, 0)}</span>
          <span>· Giấy ra viện 03: {Object.values(summary.by_type?.GRV03 || {}).reduce((a, b) => a + b, 0)}</span>
          {workerStatus.running && <span style={{ color: C.blue, fontWeight: 700 }}><Spinner size={9} /> {workerStatus.message || 'Đang chạy...'}</span>}
        </div>
      </StepCard>

      <div style={{ marginTop: 16 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 8 }}>
          <div style={{ fontSize: 13, fontWeight: 800, color: C.text }}>Danh sách hồ sơ</div>
          <Badge text={`${records.length} hồ sơ`} bg={C.surface2} color={C.text2} size={10} />
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
            style={{ fontSize: 11, color: C.blue, textDecoration: 'none', border: `1px solid ${C.border}`, borderRadius: 4, padding: '4px 8px' }}>
            Xuất trạng thái CSV
          </a>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6, fontSize: 11 }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 5, cursor: 'pointer' }}>
            <input type="checkbox" checked={allSelected} onChange={e => toggleSelectAll(e.target.checked)} /> Chọn tất cả đang hiển thị
          </label>
          <span style={{ color: C.text3 }}>Đã chọn {selected.size}</span>
          <button type="button" onClick={handleResetSelected} style={{ fontSize: 11, color: C.blue, background: 'none', border: 'none', cursor: 'pointer', textDecoration: 'underline', padding: 0 }}>
            Đặt lại trạng thái đã chọn
          </button>
        </div>

        <div style={{ border: `1px solid ${C.border2}`, borderRadius: 8, overflow: 'hidden' }}>
          {records.length === 0 ? (
            <div style={{ padding: 16, fontSize: 12, color: C.text3, textAlign: 'center' }}>Chưa có dữ liệu. Hãy nhập ở bước 2.</div>
          ) : records.map(r => (
            <div key={r.id} style={{
              display: 'flex', gap: 10, alignItems: 'flex-start', padding: '9px 10px',
              borderBottom: `1px solid ${C.border2}`, background: r.status === 'success' ? C.greenBg : (r.status === 'error' ? C.redBg : C.surface),
            }}>
              <input type="checkbox" checked={selected.has(r.id)} onChange={() => toggleSelect(r.id)} style={{ marginTop: 2 }} />
              <div style={{ flex: '1 1 140px', minWidth: 0 }}>
                <div style={{ fontSize: 11.5, fontWeight: 700, color: C.text }}>{r.patient_name || '—'}</div>
                <div style={{ fontSize: 10, color: C.text3 }}>{r.doc_type} · {r.doctor_name || '—'}</div>
              </div>
              <div style={{ flex: '1 1 140px', minWidth: 0, fontSize: 10.5, color: C.text2 }}>
                {r.doc_type === 'BHXH07' ? `Số KCB: ${r.fields?.so_kcb || '—'}` : `Mã y tế: ${r.fields?.so_seri || '—'}`}
                <div style={{ color: C.text3 }}>{r.fields?.tu_ngay || ''} → {r.fields?.den_ngay || ''}</div>
              </div>
              <div style={{ flex: '0 0 110px', fontSize: 10.5 }}>
                {r.ready
                  ? <Badge text="Sẵn sàng" bg={C.greenBg} color={C.green} size={10} />
                  : <><Badge text="Chưa" bg={C.amberBg} color={C.amber} size={10} /><div style={{ color: C.text3, marginTop: 3 }}>{(r.issues || []).join('; ')}</div></>}
              </div>
              <div style={{ flex: '0 0 110px', fontSize: 10.5 }}>
                <Badge text={STATUS_LABELS[r.status] || r.status} bg={r.status === 'success' ? C.greenBg : (r.status === 'error' ? C.redBg : C.surface2)} color={r.status === 'success' ? C.green : (r.status === 'error' ? C.red : C.text2)} size={10} />
                {r.message && <div style={{ color: C.text3, marginTop: 3 }}>{r.message}</div>}
              </div>
              <button type="button" onClick={() => openEdit(r)} style={{
                flexShrink: 0, padding: '4px 8px', fontSize: 10.5, cursor: 'pointer', fontFamily: 'inherit',
                border: `1px solid ${C.border}`, background: C.surface, color: C.text2, borderRadius: 4,
              }}>Bổ sung</button>
            </div>
          ))}
        </div>
      </div>

      <div style={{ marginTop: 16 }}>
        <button type="button" onClick={() => { setLogsOpen(o => !o); if (!logsOpen) loadLogs(); }} style={{
          fontSize: 11, color: C.blue, background: 'none', border: 'none', cursor: 'pointer', padding: 0, textDecoration: 'underline',
        }}>
          {logsOpen ? '▾' : '▸'} Nhật ký gần đây
        </button>
        {logsOpen && (
          <div style={{ marginTop: 8, border: `1px solid ${C.border2}`, borderRadius: 8, padding: 10, maxHeight: 200, overflowY: 'auto' }}>
            {logs.length === 0 ? <span style={{ fontSize: 11, color: C.text3 }}>Chưa có nhật ký.</span> : logs.map((l, i) => (
              <div key={i} style={{ display: 'flex', gap: 8, fontSize: 10.5, padding: '3px 0', borderBottom: i < logs.length - 1 ? `1px dashed ${C.border2}` : 'none' }}>
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
            <div style={{ fontSize: 14, fontWeight: 800, color: C.text, marginBottom: 4 }}>Bổ sung: {editing.patient_name}</div>
            <div style={{ fontSize: 10.5, color: C.text3, marginBottom: 10 }}>{editing.doc_type} · {editing.source_file}, dòng {editing.source_row}</div>
            {(editing.issues || []).length > 0 && (
              <div style={{ fontSize: 10.5, color: C.red, background: C.redBg, borderRadius: 5, padding: '6px 8px', marginBottom: 10 }}>
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
              <Btn variant="default" onClick={() => setEditing(null)} style={{ padding: '6px 14px', fontSize: 12 }}>Hủy</Btn>
              <Btn variant="primary" type="submit" style={{ padding: '6px 14px', fontSize: 12 }}>Lưu thay đổi</Btn>
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
            <div style={{ fontSize: 14, fontWeight: 800, color: C.text, marginBottom: 8 }}>Xác nhận nhập thật</div>
            <div style={{ fontSize: 11.5, color: C.text2, lineHeight: 1.6, marginBottom: 10 }}>
              Selenium sẽ bấm <b>Lưu</b> trên cổng BHYT cho {selected.size} hồ sơ đã chọn. Gõ chính xác <code>NHẬP THẬT</code> để tiếp tục.
            </div>
            <input value={confirmText} onChange={e => setConfirmText(e.target.value)} placeholder="NHẬP THẬT" autoComplete="off" style={INPUT_STYLE} />
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 14 }}>
              <Btn variant="default" onClick={() => setConfirmOpen(false)} style={{ padding: '6px 14px', fontSize: 12 }}>Hủy</Btn>
              <Btn variant="danger" type="submit" style={{ padding: '6px 14px', fontSize: 12 }}>Bắt đầu nhập thật</Btn>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
