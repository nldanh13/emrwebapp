import { useCallback, useEffect, useMemo, useState } from 'react';
import { C } from '../../tokens.js';
import { Btn, Badge } from '../shared.jsx';
import * as api from '../../api.js';
import { EmptyBlock, LoadingBlock, PageHeader, Panel } from './DataHubShared.jsx';

function tail(text, maxLines = 400) {
  return String(text || '').split(/\r?\n/).slice(-maxLines).join('\n');
}

export default function SystemLogsPage({ toast }) {
  const [loading, setLoading] = useState(true);
  const [logs, setLogs] = useState(null);
  const [active, setActive] = useState('activity_log');

  const load = useCallback(async () => {
    setLoading(true);
    try { setLogs(await api.getSessionLogs()); }
    catch (e) { toast?.(String(e.message || e), 'error'); }
    finally { setLoading(false); }
  }, [toast]);

  useEffect(() => { load(); }, [load]);

  const sections = useMemo(() => ([
    ['activity_log', 'Hoạt động UI/API', logs?.activity_log || ''],
    ['scan_history', 'Scan / worker', logs?.scan_history || ''],
    ['diagnostics', 'Chẩn đoán JSON', logs?.diagnostics ? JSON.stringify(logs.diagnostics, null, 2) : ''],
  ]), [logs]);
  const selected = sections.find(([id]) => id === active) || sections[0];

  return (
    <div style={{ display: 'grid', gap: 12 }}>
      <PageHeader title="Nhật ký hệ thống" subtitle="Theo dõi thao tác UI/API, worker Python/Selenium và lỗi runtime." right={<Btn onClick={load} disabled={loading}>↻ Làm mới</Btn>} />
      {loading ? <LoadingBlock text="Đang tải log session..." /> : (
        <Panel title="Log phiên hiện tại" right={<Badge text={selected?.[1] || 'log'} bg={C.blueBg} color={C.blue} />}>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
            {sections.map(([id, label, content]) => (
              <button key={id} type="button" onClick={() => setActive(id)} style={{ border: `1px solid ${active === id ? C.blueBorder : C.border}`, background: active === id ? C.blueBg : C.surface2, color: active === id ? C.blue : C.text2, borderRadius: 4, padding: '7px 11px', fontWeight: 850, cursor: 'pointer', fontFamily: 'inherit', fontSize: 12 }}>
                {label} <span style={{ color: C.text3 }}>({String(content || '').split(/\r?\n/).filter(Boolean).length})</span>
              </button>
            ))}
          </div>
          {selected?.[2] ? (
            <pre style={{ margin: 0, height: 'min(62vh, 560px)', overflow: 'auto', background: '#0f172a', color: '#dbeafe', borderRadius: 9, padding: 14, fontSize: 11, lineHeight: 1.55, fontFamily: '"Cascadia Mono",Consolas,monospace' }}>{tail(selected[2])}</pre>
          ) : <EmptyBlock title="Chưa có log" hint="Log sẽ xuất hiện khi chạy scan/details/postprocess hoặc thao tác API." />}
        </Panel>
      )}
    </div>
  );
}
