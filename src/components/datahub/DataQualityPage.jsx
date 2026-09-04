import { useCallback, useEffect, useMemo, useState } from 'react';
import { C } from '../../tokens.js';
import { Btn, Badge } from '../shared.jsx';
import * as api from '../../api.js';
import { EmptyBlock, LoadingBlock, PageHeader, Panel, formatNumber } from './DataHubShared.jsx';

function asList(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value;
  if (typeof value === 'object') return Object.entries(value).map(([key, val]) => ({ key, value: val }));
  return [String(value)];
}

export default function DataQualityPage({ toast, onNavigate }) {
  const [loading, setLoading] = useState(true);
  const [fixing, setFixing] = useState(false);
  const [health, setHealth] = useState(null);
  const [info, setInfo] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [h, i] = await Promise.all([
        api.getRuntimeHealth().catch((e) => ({ ok: false, errors: [String(e.message || e)], warnings: [] })),
        api.getDataInfo().catch(() => null),
      ]);
      setHealth(h); setInfo(i);
    } catch (e) { toast?.(String(e.message || e), 'error'); }
    finally { setLoading(false); }
  }, [toast]);

  useEffect(() => { load(); }, [load]);

  const runFix = useCallback(async () => {
    setFixing(true);
    try {
      const r = await api.runRuntimeMigrate();
      toast?.(r.message || 'Đã chuẩn hóa runtime.', r.status === 'ok' ? 'ok' : 'error');
      await load();
    } catch (e) { toast?.(String(e.message || e), 'error'); }
    finally { setFixing(false); }
  }, [toast, load]);

  const errors = useMemo(() => asList(health?.errors), [health]);
  const warnings = useMemo(() => asList(health?.warnings), [health]);
  const counts = health?.counts || {};
  const ok = !errors.length;

  return (
    <div style={{ display: 'grid', gap: 12 }}>
      <PageHeader
        title="Kiểm tra dữ liệu"
        subtitle="Rà trùng mã, lệch khóa, dữ liệu stale và key ngày cũ trước khi lưu nghiên cứu."
        right={<>
          <Btn onClick={load} disabled={loading}>↻ Làm mới</Btn>
          <Btn variant="primary" onClick={runFix} disabled={fixing}>{fixing ? 'Đang sửa...' : 'Sửa tự động'}</Btn>
        </>}
      />
      {loading ? <LoadingBlock text="Đang kiểm tra dữ liệu..." /> : (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))', gap: 10 }}>
            <SummaryCard title="Trạng thái" value={ok ? 'Đạt' : 'Có lỗi'} tone={ok ? 'green' : 'red'} />
            <SummaryCard title="Lỗi" value={formatNumber(errors.length)} tone={errors.length ? 'red' : 'green'} />
            <SummaryCard title="Cảnh báo" value={formatNumber(warnings.length)} tone={warnings.length ? 'amber' : 'green'} />
            <SummaryCard title="Dữ liệu thô" value={formatNumber(counts.raw || info?.raw?.count || 0)} tone="blue" />
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, alignItems: 'start' }}>
            <IssuePanel title="Lỗi" tone="red" items={errors} emptyTitle="Không có lỗi cấu trúc" emptyHint="Có thể tiếp tục sau khi kiểm tra nghiệp vụ." />
            <IssuePanel title="Cảnh báo" tone="amber" items={warnings} emptyTitle="Không có cảnh báo" emptyHint="Runtime hiện không phát hiện stale/trùng/key cũ." />
          </div>

          <Panel title="Hành động tiếp theo">
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <Btn onClick={() => onNavigate?.('acquire')}>Thu thập dữ liệu</Btn>
              <Btn onClick={() => onNavigate?.('collected')}>Xem dữ liệu</Btn>
              <Btn onClick={() => onNavigate?.('research')}>Kho nghiên cứu</Btn>
            </div>
          </Panel>
        </>
      )}
    </div>
  );
}

function SummaryCard({ title, value, tone }) {
  const colors = {
    green: [C.green, C.greenBg, C.greenBorder], red: [C.red, C.redBg, C.redBorder], amber: [C.amber, C.amberBg, C.amberBorder], blue: [C.blue, C.blueBg, C.blueBorder], neutral: [C.text2, C.surface2, C.border2],
  }[tone] || [C.text2, C.surface2, C.border2];
  return <div style={{ background: C.surface, borderRight: `1px solid ${C.border2}`, borderRadius: 0, padding: '5px 14px 5px 0' }}>
    <div style={{ fontSize: 10, color: C.text3, fontWeight: 700, letterSpacing: '0.02em' }}>{title}</div>
    <div style={{ marginTop: 6, fontSize: 22, fontWeight: 700, color: colors[0] }}>{value}</div>
  </div>;
}

function IssuePanel({ title, tone, items, emptyTitle, emptyHint }) {
  const color = tone === 'red' ? C.red : C.amber;
  const bg = tone === 'red' ? C.redBg : C.amberBg;
  return (
    <Panel title={title} right={<Badge text={`${items.length}`} bg={bg} color={color} />}>
      {!items.length ? <EmptyBlock title={emptyTitle} hint={emptyHint} /> : (
        <div style={{ display: 'grid', gap: 8 }}>
          {items.map((item, idx) => <div key={idx} style={{ background: C.surface2, border: `1px solid ${tone === 'red' ? C.redBorder : C.amberBorder}`, borderRadius: 6, padding: 10 }}>
            <div style={{ color, fontWeight: 700, fontSize: 12 }}>{item?.code || item?.key || `Vấn đề ${idx + 1}`}</div>
            <pre style={{ margin: '6px 0 0', color: C.text2, fontSize: 11, whiteSpace: 'pre-wrap', lineHeight: 1.45, fontFamily: '"Cascadia Mono",Consolas,monospace' }}>{typeof item === 'string' ? item : JSON.stringify(item, null, 2)}</pre>
          </div>)}
        </div>
      )}
    </Panel>
  );
}
