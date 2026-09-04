import { useCallback, useEffect, useMemo, useState } from 'react';
import { C } from '../tokens.js';
import * as api from '../api.js';

function todayInputDate() {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function daysAgoInputDate(days = 90) {
  const d = new Date();
  d.setDate(d.getDate() - Number(days || 90));
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function compactNumber(value) {
  const n = Number(value || 0);
  try { return new Intl.NumberFormat('vi-VN').format(n); } catch { return String(n); }
}

function Spinner({ size = 11 }) {
  return <span style={{ width: size, height: size, borderRadius: '50%', border: '2px solid currentColor', borderTopColor: 'transparent', display: 'inline-block', animation: 'spin 0.8s linear infinite' }} />;
}

function Btn({ children, variant = 'default', disabled = false, style = {}, ...props }) {
  const palette = variant === 'primary'
    ? { bg: C.blue, border: C.blue, color: '#fff' }
    : variant === 'success'
      ? { bg: C.greenBg, border: C.greenBorder, color: C.green }
      : { bg: C.surface2, border: C.border, color: C.text2 };
  return (
    <button type="button" disabled={disabled} {...props}
      style={{
        minHeight: 30, borderRadius: 5, border: `1px solid ${palette.border}`,
        background: palette.bg, color: palette.color, padding: '0 11px',
        fontSize: 12, fontWeight: 650, fontFamily: 'inherit', cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.55 : 1, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6,
        ...style,
      }}>
      {children}
    </button>
  );
}

function Panel({ title, subtitle, children, right }) {
  return (
    <section style={{ background: C.surface, borderTop: `1px solid ${C.border2}`, overflow: 'hidden' }}>
      <div style={{ padding: '9px 2px', borderBottom: `1px solid ${C.border2}`, display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'flex-start' }}>
        <div>
          <div style={{ fontSize: 14, fontWeight: 750, color: C.text }}>{title}</div>
          {subtitle && <div style={{ fontSize: 11, color: C.text3, marginTop: 3 }}>{subtitle}</div>}
        </div>
        {right}
      </div>
      <div style={{ padding: '10px 2px' }}>{children}</div>
    </section>
  );
}

function Field({ label, children, hint }) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
      <span style={{ fontSize: 11, color: C.text3, fontWeight: 650 }}>{label}</span>
      {children}
      {hint && <span style={{ fontSize: 10, color: C.text3 }}>{hint}</span>}
    </label>
  );
}

function Stat({ label, value, tone = 'neutral' }) {
  const colors = tone === 'ok'
    ? { bg: C.greenBg, border: C.greenBorder, text: C.green }
    : tone === 'warn'
      ? { bg: C.amberBg, border: C.amberBorder, text: C.amber }
      : { bg: C.surface2, border: C.border2, text: C.text };
  return (
    <div style={{ borderRight: `1px solid ${C.border2}`, background: 'transparent', borderRadius: 0, padding: '5px 14px 5px 0' }}>
      <div style={{ fontSize: 11, color: C.text3 }}>{label}</div>
      <div style={{ marginTop: 5, fontSize: 20, fontWeight: 800, color: colors.text }}>{value}</div>
    </div>
  );
}

const inputStyle = {
  height: 32, borderRadius: 5, border: `1px solid ${C.border}`,
  background: C.bg, color: C.text, padding: '0 9px', fontSize: 12,
  fontFamily: 'inherit', outline: 'none', minWidth: 0,
};

const defaultOptions = {
  headless: true,
  limit: 5,
  status: 'Đang thực hiện hoặc Hoàn tất',
  admissionFrom: daysAgoInputDate(90),
  admissionTo: todayInputDate(),
  careFrom: '',
  careTo: '',
  namesOnly: false,
  skipDone: false,
  minRowsToSkip: 3,
};

export default function CareBaselineTab({ toast }) {
  const [options, setOptions] = useState(defaultOptions);
  const [latest, setLatest] = useState(null);
  const [config, setConfig] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const t = useCallback((msg, type = 'info') => {
    if (typeof toast === 'function') toast(msg, type);
  }, [toast]);

  const loadLatest = useCallback(async ({ silent = false } = {}) => {
    if (!silent) setLoading(true);
    try {
      const r = await api.getCareBaselineLatest();
      setLatest(r.latest || null);
      setConfig(r.config || null);
      setError('');
    } catch (e) {
      setError(String(e.message || e));
      if (!silent) t(String(e.message || e), 'error');
    } finally {
      if (!silent) setLoading(false);
    }
  }, [t]);

  useEffect(() => { loadLatest(); }, [loadLatest]);

  const runCareBaseline = useCallback(async () => {
    setBusy(true);
    setError('');
    try {
      const r = await api.runCareBaseline(options);
      setLatest(r.summary || null);
      t(r.message || 'Đã lấy lường cơ bản.', 'ok');
      await loadLatest({ silent: true });
    } catch (e) {
      setError(String(e.message || e));
      t(String(e.message || e), 'error');
    } finally {
      setBusy(false);
    }
  }, [options, t, loadLatest]);

  const exportCareBaseline = useCallback(async () => {
    try {
      const runId = latest?.run_id || '';
      const blob = await api.exportCareBaseline(runId);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `care_baseline${runId ? `_${runId}` : ''}.csv`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (e) { t(String(e.message || e), 'error'); }
  }, [latest, t]);

  const canRun = useMemo(() => Boolean(config?.exists && config?.enabled_count > 0), [config]);
  const latestRows = latest?.rows || 0;
  const latestPatients = latest?.patients || 0;
  const latestAccounts = latest?.accounts || latest?.account_count || latest?.departments || 0;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <Panel
        title="Lường cơ bản"
        subtitle="Thu thập mẫu chăm sóc theo tài khoản/khoa."
        right={<Btn onClick={() => loadLatest()} disabled={loading || busy}>{loading ? <><Spinner /> Đang tải</> : 'Tải trạng thái'}</Btn>}
      >
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', gap: 10 }}>
          <Stat label="Config" value={config?.exists ? 'Đã có' : 'Chưa có'} tone={config?.exists ? 'ok' : 'warn'} />
          <Stat label="Tài khoản bật" value={`${compactNumber(config?.enabled_count || 0)}/${compactNumber(config?.account_count || 0)}`} tone={config?.enabled_count ? 'ok' : 'warn'} />
          <Stat label="Người bệnh lần gần nhất" value={compactNumber(latestPatients)} tone={latestPatients ? 'ok' : 'neutral'} />
          <Stat label="Dòng chăm sóc lần gần nhất" value={compactNumber(latestRows)} tone={latestRows ? 'ok' : 'neutral'} />
        </div>

        {!config?.exists && (
          <div style={{ marginTop: 12, border: `1px solid ${C.amberBorder}`, background: C.amberBg, color: C.amber, borderRadius: 6, padding: 10, fontSize: 12, lineHeight: 1.5 }}>
            Chưa có <b>config/care_baseline.json</b>. Hãy copy từ <b>config/care_baseline.example.json</b> rồi điền password cho từng tài khoản.
          </div>
        )}
        {error && <div style={{ marginTop: 12, border: `1px solid ${C.redBorder}`, background: C.redBg, color: C.red, borderRadius: 6, padding: 10, fontSize: 12 }}>{error}</div>}
      </Panel>

      <Panel title="Thiết lập chạy" subtitle="Phạm vi và điều kiện thu thập.">
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(6, minmax(0, 1fr))', gap: 10, alignItems: 'end' }}>
          <Field label="Số NB/khoa">
            <input type="number" min="1" max="20" value={options.limit}
              onChange={e => setOptions(p => ({ ...p, limit: Number(e.target.value || 5) }))}
              style={inputStyle} />
          </Field>
          <Field label="Trạng thái">
            <select value={options.status}
              onChange={e => setOptions(p => ({ ...p, status: e.target.value }))}
              style={inputStyle}>
              <option value="Đang thực hiện hoặc Hoàn tất">Đang thực hiện hoặc Hoàn tất</option>
              <option value="Hoàn tất">Hoàn tất</option>
              <option value="Đang thực hiện">Đang thực hiện</option>
            </select>
          </Field>
          <Field label="Chăm sóc từ ngày">
            <input type="date" value={options.careFrom}
              onChange={e => setOptions(p => ({ ...p, careFrom: e.target.value }))}
              style={inputStyle} />
          </Field>
          <Field label="Chăm sóc đến ngày">
            <input type="date" value={options.careTo}
              onChange={e => setOptions(p => ({ ...p, careTo: e.target.value }))}
              style={inputStyle} />
          </Field>
          <Field label="Nhập viện từ">
            <input type="date" value={options.admissionFrom}
              onChange={e => setOptions(p => ({ ...p, admissionFrom: e.target.value }))}
              style={inputStyle} />
          </Field>
          <Field label="Nhập viện đến">
            <input type="date" value={options.admissionTo}
              onChange={e => setOptions(p => ({ ...p, admissionTo: e.target.value }))}
              style={inputStyle} />
          </Field>
        </div>

        <div style={{ marginTop: 12, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <Btn
              variant={options.headless ? 'success' : 'default'}
              onClick={() => setOptions(p => ({ ...p, headless: !p.headless }))}
              disabled={busy}
              title={options.headless ? 'Đang chạy ẩn. Bấm để tắt chạy ẩn và mở trình duyệt khi chạy.' : 'Đang chạy hiện. Bấm để bật chạy ẩn.'}
            >
              {options.headless ? 'Chạy ẩn: Bật' : 'Chạy ẩn: Tắt'}
            </Btn>
            <Btn
              variant={options.namesOnly ? 'primary' : 'default'}
              onClick={() => setOptions(p => ({ ...p, namesOnly: !p.namesOnly }))}
              disabled={busy}
              title={options.namesOnly ? 'Chế độ chỉ lấy tên — nhanh. Bấm để tắt.' : 'Bấm để chỉ lấy tên BN (không vào mắt điều dưỡng, rất nhanh).'}
            >
              {options.namesOnly ? 'Chỉ lấy tên: Bật' : 'Chỉ lấy tên: Tắt'}
            </Btn>
            <Btn
              variant={options.skipDone ? 'success' : 'default'}
              onClick={() => setOptions(p => ({ ...p, skipDone: !p.skipDone }))}
              disabled={busy}
              title={options.skipDone ? 'Đang bỏ qua khoa đã đủ dữ liệu. Bấm để tắt.' : 'Bấm để bỏ qua khoa đã đủ dữ liệu từ lần chạy trước.'}
            >
              {options.skipDone ? 'Bỏ qua khoa đủ: Bật' : 'Bỏ qua khoa đủ: Tắt'}
            </Btn>
            <span style={{ fontSize: 11, color: C.text3 }}>
              {options.namesOnly ? 'Chỉ lấy tên BN — bỏ qua mắt điều dưỡng, rất nhanh.' : options.headless ? 'Worker chạy nền, không mở cửa sổ trình duyệt.' : 'Debug: mở cửa sổ trình duyệt để quan sát thao tác.'}
              {options.skipDone ? ' · Khoa đã có đủ BN + dữ liệu sẽ bị bỏ qua.' : ''}
            </span>
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <Btn variant="primary" onClick={runCareBaseline} disabled={busy || !canRun}>
              {busy ? <><Spinner /> Đang lấy</> : 'Lấy thông tin chăm sóc'}
            </Btn>
            <Btn onClick={exportCareBaseline} disabled={busy || !latest?.run_id}>Xuất CSV</Btn>
          </div>
        </div>
      </Panel>

      <Panel title="Kết quả gần nhất" subtitle={latest?.run_id ? `Run ${latest.run_id}` : 'Chưa có run'}>
        {latest ? (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', gap: 10 }}>
            <Stat label="Tài khoản/khoa đã chạy" value={compactNumber(latestAccounts)} tone={latestAccounts ? 'ok' : 'neutral'} />
            <Stat label="Người bệnh" value={compactNumber(latestPatients)} tone={latestPatients ? 'ok' : 'neutral'} />
            <Stat label="Dòng chăm sóc" value={compactNumber(latestRows)} tone={latestRows ? 'ok' : 'neutral'} />
            <Stat label="Ngày chạy" value={String(latest.created_at || latest.ts || todayInputDate()).slice(0, 10)} />
          </div>
        ) : (
          <div style={{ color: C.text3, fontSize: 12 }}>Chưa có dữ liệu lường cơ bản.</div>
        )}
      </Panel>
    </div>
  );
}
