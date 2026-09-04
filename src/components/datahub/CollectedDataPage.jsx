import { useCallback, useEffect, useMemo, useState } from 'react';
import { C } from '../../tokens.js';
import { Btn, Badge } from '../shared.jsx';
import * as api from '../../api.js';
import { EmptyBlock, LoadingBlock, PageHeader, Panel, fmtTime, formatNumber } from './DataHubShared.jsx';

function pid(row) { return String(row?.ma_bn || row?.MaBN || row?.['Mã BN'] || row?.ma_yt || row?.['Mã YT'] || '').trim(); }
function pname(row) { return String(row?.ho_ten || row?.HoTen || row?.['Họ tên'] || row?.name || '').trim(); }
function room(row) { return String(row?.Vi_Tri || row?.so_phong || row?.room || row?.['Phòng'] || '').trim(); }
function dateOf(row) { return String(row?.ngay_lam || row?.work_date || row?.date || row?.ngay_y_lenh || '').trim(); }

export default function CollectedDataPage({ toast, onNavigate }) {
  const [loading, setLoading] = useState(true);
  const [raw, setRaw] = useState([]);
  const [board, setBoard] = useState([]);
  const [processed, setProcessed] = useState([]);
  const [info, setInfo] = useState(null);
  const [query, setQuery] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [r, b, p, i] = await Promise.all([
        api.getRaw().catch(() => []),
        api.getBoardData().catch(() => []),
        api.getPatients().catch(() => []),
        api.getDataInfo().catch(() => null),
      ]);
      setRaw(Array.isArray(r) ? r : []);
      setBoard(Array.isArray(b) ? b : []);
      setProcessed(Array.isArray(p) ? p : []);
      setInfo(i);
    } catch (e) {
      toast?.(String(e.message || e), 'error');
    } finally { setLoading(false); }
  }, [toast]);

  useEffect(() => { load(); }, [load]);

  const sourceRows = processed.length ? processed : board.length ? board : raw;
  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return sourceRows.slice(0, 80);
    return sourceRows.filter(row => [pid(row), pname(row), room(row), dateOf(row)].join(' ').toLowerCase().includes(q)).slice(0, 80);
  }, [sourceRows, query]);

  const uniqueRaw = useMemo(() => new Set(raw.map(pid).filter(Boolean)).size || raw.length, [raw]);
  const uniqueBoard = useMemo(() => new Set(board.map(pid).filter(Boolean)).size || board.length, [board]);
  const uniqueProcessed = useMemo(() => new Set(processed.map(pid).filter(Boolean)).size || processed.length, [processed]);
  const normalized = info?.v2?.classified_days?.count || info?.v2?.order_days?.count || 0;

  return (
    <div style={{ display: 'grid', gap: 12 }}>
      <PageHeader
        title="Dữ liệu đã lấy"
        subtitle="Kiểm tra nhanh dữ liệu thô, bảng làm việc và dữ liệu đã xử lý."
        right={<>
          <Btn onClick={load} disabled={loading}>↻ Làm mới</Btn>
          <Btn variant="primary" onClick={() => onNavigate?.('acquire')}>Thu thập thêm</Btn>
        </>}
      />
      {loading ? <LoadingBlock /> : (
        <>
          <SummaryStrip items={[
            ['Dữ liệu thô', uniqueRaw],
            ['Bảng làm việc', uniqueBoard],
            ['Đã xử lý', uniqueProcessed],
            ['Nguồn chuẩn', normalized],
          ]} />

          <Panel title="Nguồn dữ liệu">
            <div style={{ border: `1px solid ${C.border2}`, borderRadius: 6, overflow: 'hidden' }}>
              <SourceRow title="01 Raw scan" count={info?.raw?.count || raw.length} modified={info?.raw?.modified} hint="Dữ liệu quét trực tiếp từ web bệnh viện." />
              <SourceRow title="02 Board state" count={info?.sorted?.count || board.length} modified={info?.sorted?.modified} hint="Danh sách đã sắp/xếp phạm vi làm việc." />
              <SourceRow title="03 Order days" count={info?.v2?.order_days?.count || info?.final?.count || 0} modified={info?.v2?.order_days?.modified || info?.final?.modified} hint="Dữ liệu chi tiết theo BN/ngày." />
              <SourceRow title="04 Classified" count={info?.v2?.classified_days?.count || info?.processed?.count || 0} modified={info?.v2?.classified_days?.modified || info?.processed?.modified} hint="Dữ liệu đã phân loại." last />
            </div>
          </Panel>

          <Panel title="Bảng kiểm tra nhanh" right={<Badge text={processed.length ? 'processed' : board.length ? 'board' : raw.length ? 'raw' : 'empty'} bg={C.blueBg} color={C.blue} />}>
            <div style={{ display: 'flex', gap: 8, marginBottom: 10 }}>
              <input value={query} onChange={e => setQuery(e.target.value)} placeholder="Tìm mã BN, tên, phòng, ngày..." style={{ flex: 1, border: `1px solid ${C.border}`, background: C.surface2, color: C.text, borderRadius: 5, padding: '7px 9px', outline: 'none', fontFamily: 'inherit' }} />
            </div>
            {!rows.length ? <EmptyBlock title="Chưa có dòng dữ liệu" hint="Chạy quét danh sách hoặc xử lý dữ liệu trước." /> : (
              <div style={{ border: `1px solid ${C.border2}`, borderRadius: 6, overflow: 'hidden' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                  <thead style={{ background: C.surface2, color: C.text2 }}>
                    <tr>
                      <Th>Mã BN</Th><Th>Họ tên</Th><Th>Phòng/Giường</Th><Th>Ngày dữ liệu</Th><Th>Nguồn</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((row, idx) => <tr key={`${pid(row)}_${idx}`} style={{ borderTop: `1px solid ${C.border2}` }}>
                      <Td strong>{pid(row) || '—'}</Td>
                      <Td>{pname(row) || '—'}</Td>
                      <Td>{room(row) || '—'}</Td>
                      <Td>{dateOf(row) || '—'}</Td>
                      <Td><Badge text={row?.data_source || (processed.length ? 'processed' : board.length ? 'board' : 'raw')} bg={C.surface3} color={C.blue} /></Td>
                    </tr>)}
                  </tbody>
                </table>
              </div>
            )}
          </Panel>
        </>
      )}
    </div>
  );
}

function SummaryStrip({ items }) {
  return (
    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
      {items.map(([label, value]) => <div key={label} style={{ minWidth: 135, background: C.surface, borderRight: `1px solid ${C.border2}`, borderRadius: 0, padding: '5px 14px 5px 0' }}>
        <div style={{ fontSize: 10, color: C.text3, fontWeight: 700, letterSpacing: '0.02em' }}>{label}</div>
        <div style={{ marginTop: 4, fontSize: 20, fontWeight: 700, color: Number(value) ? C.blue : C.text3 }}>{formatNumber(value)}</div>
      </div>)}
    </div>
  );
}

function SourceRow({ title, count, modified, hint, last }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '190px 110px minmax(0,1fr) 170px', gap: 12, alignItems: 'center', padding: '10px 12px', borderBottom: last ? 'none' : `1px solid ${C.border2}` }}>
      <div style={{ fontWeight: 700, color: C.text }}>{title}</div>
      <Badge text={`${formatNumber(count)} dòng`} bg={count ? C.greenBg : C.surface2} color={count ? C.green : C.text3} />
      <div style={{ fontSize: 11, color: C.text2 }}>{hint}</div>
      <div style={{ fontSize: 10.5, color: C.text3, textAlign: 'right' }}>{fmtTime(modified)}</div>
    </div>
  );
}
function Th({ children }) { return <th style={{ textAlign: 'left', padding: '9px 11px', fontWeight: 700, fontSize: 11 }}>{children}</th>; }
function Td({ children, strong }) { return <td style={{ padding: '9px 11px', color: strong ? C.text : C.text2, fontWeight: strong ? 700 : 500, verticalAlign: 'top' }}>{children}</td>; }
