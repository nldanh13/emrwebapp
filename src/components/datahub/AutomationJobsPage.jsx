import { useCallback, useEffect, useMemo, useState } from 'react';
import { C } from '../../tokens.js';
import { Btn, Badge } from '../shared.jsx';
import * as api from '../../api.js';
import { EmptyBlock, LoadingBlock, PageHeader, Panel, formatNumber } from './DataHubShared.jsx';

function parseActivityLines(text) {
  const lines = String(text || '').split(/\r?\n/).filter(Boolean).slice(-120).reverse();
  return lines.map((line, idx) => ({ id: idx, line }));
}

export default function AutomationJobsPage({ toast, onNavigate }) {
  const [loading, setLoading] = useState(true);
  const [logs, setLogs] = useState(null);
  const [info, setInfo] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [l, i] = await Promise.all([api.getSessionLogs().catch(() => null), api.getDataInfo().catch(() => null)]);
      setLogs(l); setInfo(i);
    } catch (e) { toast?.(String(e.message || e), 'error'); }
    finally { setLoading(false); }
  }, [toast]);

  useEffect(() => { load(); }, [load]);
  const events = useMemo(() => parseActivityLines(logs?.activity_log || logs?.scan_history), [logs]);
  const jobs = [
    ['Thu thập dữ liệu', 'Quét danh sách, lấy chi tiết và xử lý', info?.raw?.count || 0, () => onNavigate?.('acquire')],
    ['Kiểm tra dữ liệu', 'Rà lỗi, cảnh báo và key cũ', info?.v2?.classified_days?.count || info?.processed?.count || 0, () => onNavigate?.('quality')],
    ['Nhập bệnh phòng', 'Chăm sóc, dịch truyền, thủ thuật', '—', () => onNavigate?.('ward')],
    ['Hành chánh', 'Kiểm dữ liệu hành chánh và bảng kê', '—', () => onNavigate?.('hchanh')],
    ['Kho nghiên cứu', 'Chuẩn bị nguồn dữ liệu nghiên cứu', info?.v2?.classified_days?.count || 0, () => onNavigate?.('research')],
  ];

  return (
    <div style={{ display: 'grid', gap: 12 }}>
      <PageHeader title="Tác vụ tự động" subtitle="Theo dõi và mở nhanh các tác vụ tương tác web bệnh viện." right={<><Btn onClick={load} disabled={loading}>↻ Làm mới</Btn><Btn variant="primary" onClick={() => onNavigate?.('acquire')}>Thu thập dữ liệu</Btn></>} />
      {loading ? <LoadingBlock /> : (
        <>
          <Panel title="Danh sách tác vụ">
            <div style={{ border: `1px solid ${C.border2}`, borderRadius: 6, overflow: 'hidden' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                <thead style={{ background: C.surface2, color: C.text2 }}><tr><Th>Tác vụ</Th><Th>Mô tả</Th><Th>Kết quả</Th><Th></Th></tr></thead>
                <tbody>
                  {jobs.map(([name, hint, count, onClick], idx) => <tr key={name} style={{ borderTop: idx ? `1px solid ${C.border2}` : 'none' }}>
                    <Td strong>{name}</Td><Td>{hint}</Td><Td>{typeof count === 'number' ? formatNumber(count) : count}</Td><Td align="right"><Btn onClick={onClick}>Mở</Btn></Td>
                  </tr>)}
                </tbody>
              </table>
            </div>
          </Panel>
          <Panel title="Hoạt động gần đây" right={<Badge text={`${events.length}`} bg={C.blueBg} color={C.blue} />}>
            {!events.length ? <EmptyBlock title="Chưa có hoạt động" /> : <div style={{ display: 'grid', gap: 6 }}>{events.slice(0, 30).map(ev => <div key={ev.id} style={{ padding: '7px 9px', borderRadius: 8, background: C.surface2, color: C.text2, fontSize: 11, fontFamily: '"Cascadia Mono",Consolas,monospace', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{ev.line}</div>)}</div>}
          </Panel>
        </>
      )}
    </div>
  );
}
function Th({ children }) { return <th style={{ textAlign: 'left', padding: '9px 11px', fontWeight: 700, fontSize: 11 }}>{children}</th>; }
function Td({ children, strong, align }) { return <td style={{ padding: '9px 11px', color: strong ? C.text : C.text2, fontWeight: strong ? 700 : 500, textAlign: align || 'left' }}>{children}</td>; }
