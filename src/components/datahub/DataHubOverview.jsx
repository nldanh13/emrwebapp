import { useCallback, useEffect, useMemo, useState } from 'react';
import { C } from '../../tokens.js';
import { Btn, Badge } from '../shared.jsx';
import * as api from '../../api.js';
import { DataCard, EmptyBlock, LoadingBlock, PageHeader, Panel, Pipeline, formatNumber } from './DataHubShared.jsx';

function countFromInfo(info, key, fallback = 0) {
  return Number(info?.[key]?.count ?? fallback ?? 0) || 0;
}

function normalizedCount(info, key) {
  return Number(info?.v2?.[key]?.count ?? 0) || 0;
}

function recentLines(text, n = 6) {
  return String(text || '').split(/\r?\n/).filter(Boolean).slice(-n).reverse();
}

export default function DataHubOverview({ toast, onNavigate }) {
  const [loading, setLoading] = useState(true);
  const [info, setInfo] = useState(null);
  const [health, setHealth] = useState(null);
  const [runtime, setRuntime] = useState(null);
  const [logs, setLogs] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [dataInfo, quickHealth, runtimeHealth, sessionLogs] = await Promise.all([
        api.getDataInfo().catch(() => null),
        api.getHealth().catch((e) => ({ status: 'error', message: String(e.message || e) })),
        api.getRuntimeHealth().catch((e) => ({ ok: false, errors: [String(e.message || e)], warnings: [] })),
        api.getSessionLogs().catch(() => null),
      ]);
      setInfo(dataInfo);
      setHealth(quickHealth);
      setRuntime(runtimeHealth);
      setLogs(sessionLogs);
    } catch (e) {
      toast?.(String(e.message || e), 'error');
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => { load(); }, [load]);

  const stats = useMemo(() => {
    const raw = countFromInfo(info, 'raw');
    const orders = countFromInfo(info, 'final') || normalizedCount(info, 'order_days');
    const processed = countFromInfo(info, 'processed') || normalizedCount(info, 'classified_days');
    const errors = runtime?.errors?.length || 0;
    const warnings = runtime?.warnings?.length || 0;
    return { raw, orders, processed, errors, warnings };
  }, [info, runtime]);

  const steps = [
    { id: 'connect', title: 'Kết nối', hint: 'Kiểm tra đăng nhập và phiên làm việc.', status: health?.status === 'ok' ? 'done' : 'warn', badge: health?.status === 'ok' ? 'Sẵn sàng' : 'Cần kiểm tra' },
    { id: 'scan', title: 'Quét danh sách', hint: 'Lấy danh sách người bệnh/lượt điều trị.', status: stats.raw ? 'done' : 'waiting', badge: `${formatNumber(stats.raw)} dòng` },
    { id: 'fetch', title: 'Lấy chi tiết', hint: 'Thu thập y lệnh, thuốc, CLS và dữ liệu liên quan.', status: stats.orders ? 'done' : stats.raw ? 'active' : 'waiting', badge: `${formatNumber(stats.orders)} ngày` },
    { id: 'process', title: 'Xử lý', hint: 'Chuẩn hóa và phân loại dữ liệu.', status: stats.processed ? 'done' : stats.orders ? 'active' : 'waiting', badge: `${formatNumber(stats.processed)} bản ghi` },
    { id: 'quality', title: 'Kiểm tra', hint: 'Phát hiện trùng, stale hoặc lệch nguồn.', status: stats.errors ? 'warn' : (stats.raw || stats.processed) ? 'done' : 'waiting', badge: stats.errors ? `${stats.errors} lỗi` : `${stats.warnings} cảnh báo` },
    { id: 'archive', title: 'Lưu kho', hint: 'Chuẩn bị dữ liệu cho nghiên cứu.', status: stats.processed ? 'active' : 'waiting', badge: stats.processed ? 'Sẵn sàng' : 'Chờ dữ liệu' },
  ];

  const logLines = recentLines(logs?.activity_log || logs?.scan_history, 6);

  return (
    <div style={{ display: 'grid', gap: 12 }}>
      <PageHeader
        title="Trung tâm dữ liệu"
        subtitle="Điều khiển luồng kết nối, thu thập, xử lý, kiểm tra và lưu trữ dữ liệu bệnh viện."
        right={<>
          <Btn onClick={load} disabled={loading}>↻ Làm mới</Btn>
          <Btn variant="primary" onClick={() => onNavigate?.('acquire')}>Thu thập dữ liệu</Btn>
        </>}
      />

      {loading ? <LoadingBlock /> : (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))', gap: 10 }}>
            <DataCard title="Kết nối" value={health?.status === 'ok' ? 'Đạt' : 'Kiểm tra'} tone={health?.status === 'ok' ? 'green' : 'amber'} icon="↔" hint={health?.message || 'Trạng thái nền'} />
            <DataCard title="Đã quét" value={formatNumber(stats.raw)} tone={stats.raw ? 'blue' : 'neutral'} icon="▦" hint="Dòng dữ liệu thô" />
            <DataCard title="Đã xử lý" value={formatNumber(stats.processed)} tone={stats.processed ? 'green' : 'neutral'} icon="✓" hint="Bản ghi phân loại" />
            <DataCard title="Cảnh báo" value={stats.errors ? `${stats.errors} lỗi` : `${stats.warnings} cảnh báo`} tone={stats.errors ? 'red' : stats.warnings ? 'amber' : 'green'} icon="◇" hint="Kiểm tra dữ liệu" />
          </div>

          <Panel title="Luồng chính">
            <Pipeline steps={steps} />
          </Panel>

          <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(340px, 0.75fr)', gap: 12, alignItems: 'start' }}>
            <Panel title="Thao tác thường dùng">
              <div style={{ display: 'grid', gap: 8 }}>
                <QuickAction title="Kết nối" hint="Kiểm tra đăng nhập và phiên làm việc." onClick={() => onNavigate?.('connection')} />
                <QuickAction title="Thu thập dữ liệu" hint="Quét danh sách, lấy chi tiết và xử lý." onClick={() => onNavigate?.('acquire')} primary />
                <QuickAction title="Kiểm tra dữ liệu" hint="Rà lỗi trước khi dùng làm nguồn nghiên cứu." onClick={() => onNavigate?.('quality')} />
                <QuickAction title="Kho nghiên cứu" hint="Lưu và chuẩn bị dataset." onClick={() => onNavigate?.('research')} />
              </div>
            </Panel>

            <Panel title="Nhật ký gần đây" right={<Btn onClick={() => onNavigate?.('logs')}>Mở log</Btn>}>
              {logLines.length ? (
                <div style={{ display: 'grid', gap: 6 }}>
                  {logLines.map((line, idx) => <div key={idx} style={{ padding: '7px 9px', borderRadius: 8, background: C.surface2, color: C.text2, fontFamily: '"Cascadia Mono",Consolas,monospace', fontSize: 10.5, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{line}</div>)}
                </div>
              ) : <EmptyBlock title="Chưa có log" hint="Log sẽ xuất hiện sau khi chạy tác vụ." />}
            </Panel>
          </div>
        </>
      )}
    </div>
  );
}

function QuickAction({ title, hint, onClick, primary }) {
  return (
    <button type="button" onClick={onClick} style={{
      display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12,
      textAlign: 'left', border: `1px solid ${primary ? C.blueBorder : C.border2}`,
      background: primary ? C.blueBg : C.surface2, borderRadius: 6, padding: '10px 12px',
      cursor: 'pointer', fontFamily: 'inherit', color: C.text,
    }}>
      <span>
        <span style={{ display: 'block', fontWeight: 700, fontSize: 13 }}>{title}</span>
        <span style={{ display: 'block', color: C.text2, fontSize: 11, lineHeight: 1.4, marginTop: 2 }}>{hint}</span>
      </span>
      <Badge text="Mở" bg={primary ? C.blueBg : C.surface} color={primary ? C.blue : C.text2} />
    </button>
  );
}
