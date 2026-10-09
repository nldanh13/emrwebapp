// src/components/ClinicTab.jsx — Phòng khám: theo dõi Danh sách Khám bệnh, hoàn tất khám Cho về
// và nhập chăm sóc người bệnh nhập viện (ClinicAdmissionCare).
// Máy chủ chạy nền worker clinic_monitor.py giữ Chrome đăng nhập sẵn, tự đọc lại danh
// sách theo chu kỳ và tự đăng nhập lại khi EMR hết phiên; màn này chỉ hiển thị trạng thái.
import { useCallback, useEffect, useMemo, useState } from 'react';
import HistoryNote from './patient/HistoryNote.jsx';
import { IconChecks, IconPlayerPlay, IconPlayerStop, IconRefresh } from '@tabler/icons-react';
import { C, FS } from '../tokens.js';
import { Btn, Segmented } from './shared.jsx';
import * as api from '../api.js';
import ClinicAdmissionCare from './ClinicAdmissionCare.jsx';
import ClinicBbhc from './ClinicBbhc.jsx';
import { useOnTabReturn, useTabActive } from '../hooks/useTabActivity.js';
import { revalidate, useServerData } from '../hooks/useServerData.js';
import { useRealtimeConnected } from '../hooks/useRealtimeStatus.js';
import { SkeletonTable } from './Skeleton.jsx';
import { loadClinicConfig as loadConfig, saveClinicConfig as saveConfig } from '../utils/clinicLogin.js';

const CLINIC_MONITOR_KEY = 'screen:clinic-monitor';

const CASE_LABELS = {
  cho_ve: 'Cho về',
  nhap_vien: 'Nhập viện',
  chuyen_vien: 'Chuyển viện',
  chuyen_kham_ck: 'Chuyển khám CK',
  ngoai_tru: 'Điều trị ngoại trú',
  chua_xu_tri: 'Chưa xử trí',
  khac: 'Khác',
};
const ACTIONABLE_CASES = new Set(['cho_ve', 'nhap_vien', 'chuyen_vien']);

function hhmm(iso, withSeconds = false) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit', ...(withSeconds ? { second: '2-digit' } : {}) });
}

function rowGroup(r) {
  if (r.stage === 'xong') return 'xong';
  if (r.stage === 'cho_kham') return 'cho_kham';
  return r.case;
}

const inputStyle = {
  width: '100%', height: 32, padding: '0 8px', boxSizing: 'border-box', border: `1px solid ${C.border}`,
  borderRadius: 5, background: C.surface, color: C.text, fontSize: FS.md, fontFamily: 'inherit',
};

function Field({ label, children, style }) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: FS.sm, color: C.text2, fontWeight: 600, ...style }}>
      {label}
      {children}
    </label>
  );
}

function ServiceChip({ s }) {
  const pending = s.done < s.total;
  return (
    <span style={{
      display: 'inline-block', padding: '1px 6px', borderRadius: 4, fontSize: FS.xs, fontWeight: 600, whiteSpace: 'nowrap',
      background: pending ? C.amberBg : C.surface2, color: pending ? C.amber : C.text2,
      border: `1px solid ${pending ? C.amberBorder : C.border2}`,
    }}>{s.label} {s.done}/{s.total}</span>
  );
}

const CHECK_VIEW = {
  ready: { text: 'Sẵn sàng', color: C.green },
  waiting: { color: C.amber },
  need_weight: { color: C.amber },
  no_drug: { color: C.text2 },
  incomplete: { color: C.amber },
  done: { text: 'Đã hoàn tất', color: C.green },
  error: { color: C.red },
  session: { color: C.amber },
};

function WeightInput({ row, toast, onSaved }) {
  const [kg, setKg] = useState('');
  const [saving, setSaving] = useState(false);
  const save = async () => {
    setSaving(true);
    try {
      const r = await api.setClinicPatientWeight(row.khambenhid, kg);
      if (r.status !== 'ok') throw new Error(r.message);
      toast?.(r.message, 'ok');
      setKg('');
      onSaved?.();
    } catch (e) {
      toast?.(String(e.message || e), 'error');
    } finally {
      setSaving(false);
    }
  };
  return (
    <form onSubmit={e => { e.preventDefault(); if (kg) save(); }} style={{ display: 'flex', gap: 4, marginTop: 4 }}>
      <input type="number" min={1} max={300} step="0.1" value={kg} onChange={e => setKg(e.target.value)}
        placeholder="kg" aria-label={`Cân nặng của ${row.ho_ten}`}
        style={{ width: 64, height: 26, padding: '0 6px', border: `1px solid ${C.border}`, borderRadius: 4, fontFamily: 'inherit', fontSize: FS.sm }} />
      <Btn type="submit" loading={saving} disabled={!kg || saving} style={{ minHeight: 26, padding: '2px 8px', fontSize: FS.xs }}>Lưu</Btn>
    </form>
  );
}

const NGOAITRU_COLOR = { done: C.green, error: C.red, waiting: C.amber, incomplete: C.amber, session: C.amber };

function CompletionCell({ row, toast, onSaved }) {
  if (row.ngoaitru) {
    const st = row.ngoaitru_state;
    if (!st) return <span style={{ color: C.text2, fontSize: FS.sm }}>Chờ bấm Điều trị ngoại trú</span>;
    return <span style={{ color: NGOAITRU_COLOR[st.status] || C.text2, fontSize: FS.sm, fontWeight: 600 }}>{st.message || (st.status === 'done' ? 'Đã kết thúc điều trị' : st.status)}</span>;
  }
  if (!row.eligible) return <span style={{ color: C.text3 }}>—</span>;
  const check = row.check;
  if (!check) return <span style={{ color: C.text3, fontSize: FS.sm }}>Đang kiểm tra…</span>;
  const view = CHECK_VIEW[check.status] || { color: C.text2 };
  return (
    <div style={{ fontSize: FS.sm }}>
      <span style={{ color: view.color, fontWeight: 600 }}>{view.text || check.message}</span>
      {check.status === 'need_weight' && (row.weight_entered
        ? <div style={{ color: C.text2, fontSize: FS.xs }}>Đã nhập {row.weight_entered} kg, sẽ ghi khi hoàn tất</div>
        : <WeightInput row={row} toast={toast} onSaved={onSaved} />)}
    </div>
  );
}

function Stat({ label, value, tone }) {
  const color = tone === 'green' ? C.green : tone === 'amber' ? C.amber : C.text;
  return (
    <div style={{ padding: '8px 12px', border: `1px solid ${C.border2}`, borderRadius: 7, background: C.surface, minWidth: 120 }}>
      <div style={{ fontSize: FS.xs, color: C.text2 }}>{label}</div>
      <div style={{ fontSize: FS.stat, fontWeight: 700, color }}>{value}</div>
    </div>
  );
}

export default function ClinicTab({ toast }) {
  const [cfg, setCfg] = useState(loadConfig);
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState('');
  const [group, setGroup] = useState('can_lam');
  const [onlyBhyt, setOnlyBhyt] = useState(true);

  const setField = (key) => (e) => {
    const value = e.target.type === 'checkbox' ? e.target.checked : e.target.value;
    setCfg(prev => { const next = { ...prev, [key]: value }; saveConfig(next); return next; });
  };

  // Trạng thái theo dõi nằm trong kho dùng chung (UX_RULES mục 9): máy chủ báo khi file trạng thái
  // đổi (kênh sự kiện, khóa screen:clinic-monitor) nên không cần hẹn giờ hỏi lại; quay lại tab thì
  // hiện ngay bản đang có rồi cập nhật ngầm.
  const monitorQuery = useServerData(CLINIC_MONITOR_KEY, api.getClinicMonitorState);
  const monitor = monitorQuery.data?.monitor || null;
  const loadState = useCallback(() => revalidate(CLINIC_MONITOR_KEY), []);

  const running = Boolean(monitor?.running);
  // Tên đăng nhập/URL dùng chung với Nghỉ ốm: quay lại tab thì lấy bản mới nhất (trừ khi đang theo dõi).
  useOnTabReturn(() => {
    if (running) return;
    const { username, loginUrl, listUrl } = loadConfig();
    setCfg(prev => ({ ...prev, username, loginUrl, listUrl }));
  });
  const tabActive = useTabActive();
  const realtimeConnected = useRealtimeConnected();
  // ux-rules: polling-ok — chỉ là dự phòng khi mất kênh sự kiện; tab ẩn mà không chạy thì không hỏi.
  useEffect(() => {
    if (realtimeConnected || (!tabActive && !running)) return undefined;
    const id = setInterval(loadState, running ? 5000 : 15000);
    return () => clearInterval(id);
  }, [loadState, running, tabActive, realtimeConnected]);

  const start = async () => {
    setBusy('start');
    try {
      const r = await api.startClinicMonitor({ ...cfg, password, intervalMinutes: Number(cfg.intervalMinutes) || 3 });
      if (r.status !== 'ok') throw new Error(r.message);
      toast?.(r.message, 'ok');
      await loadState();
    } catch (e) {
      toast?.(String(e.message || e), 'error');
    } finally {
      setBusy('');
    }
  };

  const stop = async () => {
    setBusy('stop');
    try {
      const r = await api.stopClinicMonitor();
      toast?.(r.message, 'info');
      await loadState();
    } catch (e) {
      toast?.(String(e.message || e), 'error');
    } finally {
      setBusy('');
    }
  };

  const completeReady = async () => {
    const n = readyToComplete.length;
    if (!window.confirm(`Hoàn tất khám ${n} người bệnh đã sẵn sàng trên EMR?\n\nHệ thống sẽ kiểm tra lại từng người ngay trước khi thao tác (thủ thuật, đủ giờ, cân nặng, thời gian ra) và dừng lại ở người nào EMR báo lỗi hoặc hỏi xác nhận.`)) return;
    setBusy('complete');
    try {
      const r = await api.completeReadyClinicPatients();
      if (r.status !== 'ok') throw new Error(r.message);
      toast?.(r.message, 'info');
      await loadState();
    } catch (e) {
      toast?.(String(e.message || e), 'error');
    } finally {
      setBusy('');
    }
  };

  const runNgoaiTru = async () => {
    const n = ngoaitruRows.length;
    if (!window.confirm(`Làm điều trị ngoại trú cho ${n} người bệnh (BHYT) trên EMR?\n\nLần lượt: nhập khoa (D/s tiếp nhận ngoại trú) → kết thúc mổ nếu có (D/s Phẫu thuật) → Tổng kết ra khoa và Kết thúc điều trị. Dừng ở người nào EMR báo lỗi, hỏi xác nhận hoặc hồ sơ còn thiếu.`)) return;
    setBusy('ngoaitru');
    try {
      const r = await api.runClinicNgoaiTru();
      if (r.status !== 'ok') throw new Error(r.message);
      toast?.(r.message, 'info');
      await loadState();
    } catch (e) {
      toast?.(String(e.message || e), 'error');
    } finally {
      setBusy('');
    }
  };

  const refresh = async () => {
    setBusy('refresh');
    try {
      await api.refreshClinicMonitor();
      toast?.('Đã yêu cầu làm mới, danh sách sẽ cập nhật trong giây lát.', 'info');
    } catch (e) {
      toast?.(String(e.message || e), 'error');
    } finally {
      setBusy('');
    }
  };

  const rows = useMemo(() => (monitor?.rows || []).filter(r => !onlyBhyt || r.has_bhyt), [monitor?.rows, onlyBhyt]);
  const counts = useMemo(() => {
    const c = { can_lam: 0, all: rows.length, bbhc: 0 };
    for (const r of rows) {
      if (r.bbhc?.length) c.bbhc += 1;
      const g = rowGroup(r);
      c[g] = (c[g] || 0) + 1;
      if (ACTIONABLE_CASES.has(g)) c.can_lam += 1;
    }
    return c;
  }, [rows]);
  const visible = useMemo(() => rows.filter(r => {
    const g = rowGroup(r);
    if (group === 'all') return true;
    if (group === 'can_lam') return ACTIONABLE_CASES.has(g);
    if (group === 'bbhc') return Boolean(r.bbhc?.length);
    return g === group;
  }), [rows, group]);

  const groupOptions = [
    { value: 'can_lam', label: `Cần làm (${counts.can_lam})` },
    ...['cho_ve', 'nhap_vien', 'chuyen_vien', 'chuyen_kham_ck', 'ngoai_tru', 'chua_xu_tri']
      .map(k => ({ value: k, label: `${CASE_LABELS[k]} (${counts[k] || 0})` })),
    { value: 'bbhc', label: `Cần SBBHC (${counts.bbhc})` },
    { value: 'cho_kham', label: `Chờ khám (${counts.cho_kham || 0})` },
    { value: 'xong', label: `Đã xong (${counts.xong || 0})` },
    { value: 'all', label: `Tất cả (${counts.all})` },
  ];

  const readyCount = rows.filter(r => r.ready).length;
  const ngoaitruRows = rows.filter(r => r.ngoaitru && r.ngoaitru_state?.status !== 'done');
  const readyToComplete = rows.filter(r => r.eligible && (r.check?.status === 'ready' || (r.check?.status === 'need_weight' && r.weight_entered)));
  const actionLog = [...(monitor?.action_log || [])].reverse();
  const blockedCount = rows.filter(r => r.stage !== 'xong' && r.blockers?.length).length;
  const choDocKq = rows.filter(r => r.stage !== 'xong' && r.cho_doc_kq).length;

  let statusText = 'Chưa theo dõi.';
  let statusTone = C.text2;
  if (running) {
    statusText = monitor?.updated_at
      ? `Đang theo dõi (tài khoản ${monitor.account}) · cập nhật lúc ${hhmm(monitor.updated_at, true)} · lần tới ${hhmm(monitor.next_refresh_at)} · đã đăng nhập ${monitor.login_count || 0} lần`
      : 'Đang mở Chrome và đăng nhập EMR…';
    statusTone = C.green;
    if (monitor?.last_error) {
      statusText += ` · lần đọc gần nhất lỗi: ${monitor.last_error}`;
      statusTone = C.amber;
    }
  } else if (monitor?.exit_message) {
    statusText = monitor.exit_message;
    statusTone = C.red;
  } else if (monitor?.stopped_at) {
    statusText = `Đã dừng lúc ${hhmm(monitor.stopped_at)}. Danh sách bên dưới là lần đọc cuối (${hhmm(monitor.updated_at)}).`;
  }

  return (
    <div style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 12 }}>
      <section style={{ border: `1px solid ${C.border2}`, borderRadius: 8, background: C.surface, padding: 12 }}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: 10, alignItems: 'end' }}>
          <Field label="Tài khoản EMR">
            <input value={cfg.username} onChange={setField('username')} disabled={running} autoComplete="username" style={inputStyle} />
          </Field>
          <Field label="Mật khẩu">
            <input type="password" value={password} onChange={e => setPassword(e.target.value)} disabled={running} autoComplete="current-password" style={inputStyle} />
          </Field>
          <Field label="URL đăng nhập">
            <input value={cfg.loginUrl} onChange={setField('loginUrl')} disabled={running} style={inputStyle} />
          </Field>
          <Field label="URL Danh sách Khám bệnh">
            <input value={cfg.listUrl} onChange={setField('listUrl')} disabled={running} style={inputStyle} />
          </Field>
          <Field label="Làm mới mỗi (phút)">
            <input type="number" min={1} max={60} value={cfg.intervalMinutes} onChange={setField('intervalMinutes')} disabled={running} style={inputStyle} />
          </Field>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginTop: 10 }}>
          {running ? (
            <>
              <Btn variant="danger" icon={IconPlayerStop} loading={busy === 'stop'} onClick={stop}>Dừng theo dõi</Btn>
              <Btn icon={IconRefresh} loading={busy === 'refresh'} onClick={refresh}>Làm mới ngay</Btn>
            </>
          ) : (
            <Btn variant="primary" icon={IconPlayerPlay} loading={busy === 'start'} onClick={start}
              disabled={!cfg.username || !password || !cfg.loginUrl || !cfg.listUrl}>Bắt đầu theo dõi</Btn>
          )}
          <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: FS.sm, color: C.text2 }}>
            <input type="checkbox" checked={cfg.headless} onChange={setField('headless')} disabled={running} />
            Chạy Chrome ẩn
          </label>
          <span role="status" style={{ fontSize: FS.sm, color: statusTone, flex: '1 1 320px' }}>{statusText}</span>
        </div>
      </section>

      <ClinicAdmissionCare creds={{ ...cfg, password }} toast={toast} />

      {monitor?.rows?.length ? (
        <>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
            <Stat label="Người bệnh hôm nay" value={rows.length} />
            <Stat label="Sẵn sàng xử lý" value={readyCount} tone="green" />
            <Stat label="Còn vướng" value={blockedCount} tone="amber" />
            <Stat label="Chờ đọc kết quả" value={choDocKq} tone="amber" />
          </div>

          <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', padding: 10, border: `1px solid ${C.border2}`, borderRadius: 8, background: C.surface }}>
            <Btn variant="primary" icon={IconChecks} loading={busy === 'complete' || monitor?.action_running}
              disabled={!running || !readyToComplete.length || busy === 'complete' || monitor?.action_running} onClick={completeReady}>
              {monitor?.action_running ? 'Đang hoàn tất…' : `Hoàn tất ${readyToComplete.length} người bệnh đã sẵn sàng`}
            </Btn>
            <span style={{ fontSize: FS.sm, color: C.text2, flex: '1 1 320px' }}>
              Chỉ người có BHYT, xử trí Cho về hoặc Chuyển viện, dịch vụ đã xong. Thủ thuật chưa xong thì nhập trước (còn "Mới" thì bấm Thực hiện; giờ chỉ định → +10 phút, thủ thuật viên theo Lịch Phòng khám).
              Thời gian ra được giữ nếu hợp lệ, không thì đặt bằng giờ hiện tại của máy. Người chờ đọc KQ chưa có thuốc và người thiếu cân nặng sẽ không được hoàn tất.
            </span>
          </div>

          {ngoaitruRows.length > 0 && (
            <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', padding: 10, border: `1px solid ${C.border2}`, borderRadius: 8, background: C.surface }}>
              <Btn variant="primary" icon={IconChecks} loading={busy === 'ngoaitru'}
                disabled={!running || busy === 'ngoaitru' || monitor?.action_running} onClick={runNgoaiTru}>
                {`Điều trị ngoại trú ${ngoaitruRows.length} người bệnh`}
              </Btn>
              <span style={{ fontSize: FS.sm, color: C.text2, flex: '1 1 320px' }}>
                Người có BHYT xử trí Điều trị ngoại trú: nhập khoa (giữ giờ vào khoa nếu hợp lệ, Người nhận = Bác sĩ nhận bệnh), kết thúc mổ
                (bắt đầu = vào khoa + 1 phút, +15 phút, Gây Tê Tại Chỗ, Nằm ngửa, BS mổ chính = Gây mê chính = bác sĩ trong Lịch Phòng khám), Tổng kết ra khoa lấy từ hồ sơ (không có KQ XN, CLS thì ghi "."), rồi Kết thúc điều trị.
              </span>
            </div>
          )}

          <ClinicBbhc monitor={monitor} toast={toast} onChanged={loadState} />

          <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
            <Segmented value={group} options={groupOptions} onChange={setGroup} label="Nhóm người bệnh" />
            <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: FS.sm, color: C.text2 }}>
              <input type="checkbox" checked={onlyBhyt} onChange={e => setOnlyBhyt(e.target.checked)} />
              Chỉ người có BHYT
            </label>
          </div>

          <div style={{ border: `1px solid ${C.border2}`, borderRadius: 8, background: C.surface, overflow: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: FS.md }}>
              <thead>
                <tr style={{ background: C.surface2 }}>
                  {['STT', 'Mã BN', 'Họ tên', 'Thời gian', 'Trạng thái', 'Xử trí', 'Dịch vụ', 'Việc tiếp theo', 'Còn vướng', 'Hoàn tất khám'].map(h => (
                    <th key={h} style={{ padding: '8px 10px', textAlign: 'left', fontSize: FS.xs, color: C.text2, fontWeight: 700, borderBottom: `1px solid ${C.border}`, whiteSpace: 'nowrap' }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {visible.map(r => (
                  <tr key={r.khambenhid || `${r.ma_bn}-${r.thoi_gian}`} style={{
                    borderBottom: `1px solid ${C.border2}`,
                    boxShadow: r.ready ? `inset 3px 0 0 ${C.green}` : (r.blockers?.length && r.stage !== 'xong' ? `inset 3px 0 0 ${C.amber}` : 'none'),
                  }}>
                    <td style={{ padding: '8px 10px', color: C.text2 }}>{r.stt}</td>
                    <td style={{ padding: '8px 10px', fontVariantNumeric: 'tabular-nums' }}>{r.ma_bn}</td>
                    <td style={{ padding: '8px 10px' }}>
                      <div style={{ fontWeight: 600 }}>{r.ho_ten}</div>
                      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', fontSize: FS.xs, color: C.text2 }}>
                        <span>{r.doi_tuong}{r.nam_sinh ? ` · ${r.nam_sinh}` : ''}{r.uu_tien ? ` · ${r.uu_tien}` : ''}</span>
                        {r.cho_doc_kq && <span style={{ color: C.red, fontWeight: 600 }}>Chờ đọc KQ</span>}
                        {r.bbhc?.length > 0 && <span style={{ color: C.amber, fontWeight: 600 }} title="Cần lập Sổ biên bản hội chẩn">SBBHC: {r.bbhc.join(', ')}</span>}
                      </div>
                      {r.lich_su && <HistoryNote lichSu={r.lich_su} mode="clinic" />}
                    </td>
                    <td style={{ padding: '8px 10px', whiteSpace: 'nowrap', color: C.text2 }}>{r.thoi_gian}</td>
                    <td style={{ padding: '8px 10px', whiteSpace: 'nowrap' }}>{r.trang_thai}</td>
                    <td style={{ padding: '8px 10px', whiteSpace: 'nowrap' }}>{r.xu_tri || '—'}</td>
                    <td style={{ padding: '8px 10px' }}>
                      <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                        {(r.services || []).filter(s => s.code !== 'KB').map(s => <ServiceChip key={s.code} s={s} />)}
                      </div>
                    </td>
                    <td style={{ padding: '8px 10px', fontWeight: 600, color: r.ready ? C.green : C.text }}>{r.next_action}</td>
                    <td style={{ padding: '8px 10px', color: C.amber, fontSize: FS.sm }}>
                      {r.stage === 'xong' ? '' : (r.blockers || []).join(' · ')}
                    </td>
                    <td style={{ padding: '8px 10px', minWidth: 150 }}>
                      <CompletionCell row={r} toast={toast} onSaved={loadState} />
                    </td>
                  </tr>
                ))}
                {!visible.length && (
                  <tr><td colSpan={10} style={{ padding: 16, textAlign: 'center', color: C.text2 }}>Không có người bệnh trong nhóm này.</td></tr>
                )}
              </tbody>
            </table>
          </div>
          {actionLog.length > 0 && (
            <section style={{ border: `1px solid ${C.border2}`, borderRadius: 8, background: C.surface, padding: 12 }}>
              <div style={{ fontSize: FS.md, fontWeight: 700, marginBottom: 6 }}>Nhật ký hoàn tất khám</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: FS.sm }}>
                {actionLog.map((e, i) => (
                  <div key={`${e.at}-${i}`} style={{ color: e.result === 'done' ? C.green : e.result === 'error' ? C.red : C.text2 }}>
                    <b>{hhmm(e.at, true)}</b> · {e.ma_bn} {e.ho_ten} — {e.message}{e.steps?.length ? ` (${e.steps.join(' → ')})` : ''}
                  </div>
                ))}
              </div>
            </section>
          )}
        </>
      ) : monitorQuery.loading ? (
        <div role="status" aria-busy="true" aria-label="Đang tải danh sách Khám bệnh" style={{ padding: 14, border: `1px solid ${C.border}`, borderRadius: 8 }}>
          <SkeletonTable rows={6} cols={6} />
        </div>
      ) : (
        <div style={{ padding: 24, textAlign: 'center', color: C.text2, border: `1px dashed ${C.border}`, borderRadius: 8 }}>
          {running ? 'Đang đọc Danh sách Khám bệnh lần đầu…' : 'Nhập tài khoản EMR rồi bấm "Bắt đầu theo dõi" để hệ thống tự đọc Danh sách Khám bệnh theo chu kỳ.'}
        </div>
      )}
    </div>
  );
}
