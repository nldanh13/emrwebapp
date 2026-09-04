import { useCallback, useEffect, useState } from 'react';
import { C } from '../../tokens.js';
import { Btn, Badge } from '../shared.jsx';
import * as api from '../../api.js';
import { DataCard, EmptyBlock, LoadingBlock, PageHeader, Panel, fmtTime } from './DataHubShared.jsx';

export default function EmrConnectionPage({ toast, onNavigate, onDiagnostics, onViewLog }) {
  const [loading, setLoading] = useState(true);
  const [health, setHealth] = useState(null);
  const [diag, setDiag] = useState(null);
  const [info, setInfo] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [h, d, i] = await Promise.all([
        api.getHealth().catch((e) => ({ status: 'error', message: String(e.message || e) })),
        api.getDiagnostics().catch((e) => ({ status: 'error', message: String(e.message || e) })),
        api.getDataInfo().catch(() => null),
      ]);
      setHealth(h); setDiag(d); setInfo(i);
    } catch (e) {
      toast?.(String(e.message || e), 'error');
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => { load(); }, [load]);

  const ok = health?.status === 'ok';
  const runtime = diag?.runtime || diag?.session || {};
  const env = diag?.env || diag?.config || {};

  return (
    <div style={{ display: 'grid', gap: 12 }}>
      <PageHeader
        title="Kết nối"
        subtitle="Theo dõi server, session, worker và trạng thái đăng nhập trước khi lấy dữ liệu."
        right={<>
          <Btn onClick={load} disabled={loading}>↻ Làm mới</Btn>
          <Btn variant="primary" onClick={() => onNavigate?.('acquire')}>Thu thập dữ liệu</Btn>
        </>}
      />
      {loading ? <LoadingBlock /> : (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 10 }}>
            <DataCard title="Server" value={ok ? 'Sẵn sàng' : 'Cần kiểm tra'} tone={ok ? 'green' : 'amber'} icon="↔" hint={health?.message || 'Kiểm tra backend'} />
            <DataCard title="Phiên hiện tại" value={runtime?.sid || runtime?.session_id || 'Hiện tại'} tone="blue" icon="◌" hint="Session dữ liệu đang dùng" />
            <DataCard title="Lần quét gần nhất" value={fmtTime(info?.raw?.modified)} tone={info?.raw?.count ? 'cyan' : 'neutral'} icon="▦" hint={`${info?.raw?.count || 0} dòng thô`} />
          </div>

          <Panel title="Trạng thái thao tác web bệnh viện">
            <div style={{ display: 'grid', gap: 8 }}>
              <StatusRow label="Backend/API" value={ok ? 'Hoạt động' : 'Không ổn định'} tone={ok ? 'ok' : 'warn'} />
              <StatusRow label="Phiên dữ liệu" value={runtime?.sid || runtime?.session_id || 'session hiện tại'} />
              <StatusRow label="Lần xử lý gần nhất" value={fmtTime(info?.processed?.modified || info?.v2?.classified_days?.modified)} />
              <StatusRow label="Chế độ đọc" value={diag?.read_mode || env?.read_mode || 'Selenium/worker'} />
            </div>
            <div style={{ marginTop: 12, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <Btn onClick={onDiagnostics}>Chẩn đoán</Btn>
              <Btn onClick={onViewLog}>Xem log</Btn>
            </div>
          </Panel>

          <Panel title="Chẩn đoán rút gọn" right={<Badge text={diag?.status || health?.status || 'unknown'} bg={ok ? C.greenBg : C.amberBg} color={ok ? C.green : C.amber} />}>
            {diag ? <pre style={{ margin: 0, maxHeight: 220, overflow: 'auto', padding: 11, borderRadius: 6, background: C.surface2, color: C.text2, fontSize: 11, lineHeight: 1.5 }}>{JSON.stringify(diag, null, 2)}</pre> : <EmptyBlock title="Không có dữ liệu chẩn đoán" />}
          </Panel>
        </>
      )}
    </div>
  );
}

function StatusRow({ label, value, tone = 'neutral' }) {
  const color = tone === 'ok' ? C.green : tone === 'warn' ? C.amber : C.text;
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'center', padding: '7px 2px', borderRadius: 0, background: C.surface, borderBottom: `1px solid ${C.border2}` }}>
      <span style={{ color: C.text2, fontSize: 12, fontWeight: 650 }}>{label}</span>
      <span style={{ color, fontSize: 12, fontWeight: 750, textAlign: 'right' }}>{value || '—'}</span>
    </div>
  );
}
