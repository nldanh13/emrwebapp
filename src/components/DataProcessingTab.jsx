import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { C } from '../tokens.js';
import { Badge, Btn, Spinner } from './shared.jsx';
import SessionPicker from './shift/SessionPicker.jsx';
import * as api from '../api.js';
import { workDateRangeLabel, workDateRangeToDmy } from '../utils/workDateRange.js';
import { filterPatientsByWorkflow, getUniqueRooms, patientRoom } from '../utils/patientScope.js';
import { getSessionId, setSessionId } from '../hooks/useSession.js';

function pickPatientId(row) {
  return String(row?.ma_bn || row?.MaBN || row?.['Mã BN'] || row?.ma_yt || row?.['Mã YT'] || '').trim();
}

function uniquePatientCount(rows) {
  if (!Array.isArray(rows)) return 0;
  const ids = new Set(rows.map(pickPatientId).filter(Boolean));
  return ids.size || rows.length;
}

function MiniStat({ title, value, tone = 'neutral' }) {
  const colors = {
    neutral: [C.surface2, C.text2, C.border],
    info: [C.blueBg, C.blue, C.blueBorder],
    ok: [C.greenBg, C.green, C.greenBorder],
    warn: [C.amberBg, C.amber, C.amberBorder],
  }[tone] || [C.surface2, C.text2, C.border];
  return (
    <div style={{ borderRight: `1px solid ${C.border2}`, padding: '4px 16px 5px 0', minWidth: 135 }}>
      <div style={{ fontSize: 9.5, color: C.text3, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.05em' }}>{title}</div>
      <div style={{ marginTop: 2, fontSize: 20, fontWeight: 850, color: colors[1], fontVariantNumeric: 'tabular-nums' }}>{value}</div>
    </div>
  );
}

function ScopeButton({ active, onClick, children }) {
  return (
    <button type="button" onClick={onClick} style={{
      padding: '6px 9px', borderRadius: 5, cursor: 'pointer', fontSize: 12, fontFamily: 'inherit',
      border: `1px solid ${active ? C.blueBorder : C.border}`,
      background: active ? C.blueBg : C.surface2,
      color: active ? C.blue : C.text2,
      fontWeight: active ? 850 : 650,
      whiteSpace: 'nowrap',
    }}>{children}</button>
  );
}

export default function DataProcessingTab({ toast, workDateRange }) {
  const [rawRows, setRawRows] = useState([]);
  const [boardRows, setBoardRows] = useState([]);
  const [info, setInfo] = useState(null);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState('');
  const [showPicker, setShowPicker] = useState(false);
  const [detailsScope, setDetailsScope] = useState('all');
  const [selectedRooms, setSelectedRooms] = useState([]);
  const recoveryAttemptedRef = useRef(false);

  const rangeLabel = workDateRangeLabel(workDateRange);
  const dmyRange = useMemo(() => workDateRangeToDmy(workDateRange), [workDateRange]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      let [raw, board, dataInfo] = await Promise.all([
        api.getRaw().catch(() => []),
        api.getBoardData().catch(() => []),
        api.getDataInfo().catch(() => null),
      ]);

      const currentLooksEmpty =
        (!Array.isArray(raw) || raw.length === 0) &&
        (!Array.isArray(board) || board.length === 0) &&
        !dataInfo?.raw?.exists && !dataInfo?.sorted?.exists && !dataInfo?.processed?.exists &&
        !dataInfo?.v2?.patients && !dataInfo?.v2?.board_state && !dataInfo?.v2?.classified_days;

      if (currentLooksEmpty && !recoveryAttemptedRef.current) {
        recoveryAttemptedRef.current = true;
        const currentSid = getSessionId();
        const saved = await api.getDataSessions().catch(() => null);
        const sessions = Array.isArray(saved?.sessions) ? saved.sessions : [];
        const best = sessions.find(item => item.sid !== currentSid && item.primary === 'processed' && Number(item.count || 0) > 0)
          || sessions.find(item => item.sid !== currentSid && Number(item.count || 0) > 0);
        if (best?.sid) {
          setSessionId(best.sid);
          toast?.(`Đã tự khôi phục dữ liệu đã lưu (${best.count || 0} BN).`, 'ok');
          [raw, board, dataInfo] = await Promise.all([
            api.getRaw().catch(() => []),
            api.getBoardData().catch(() => []),
            api.getDataInfo().catch(() => null),
          ]);
        }
      }

      setRawRows(Array.isArray(raw) ? raw : []);
      setBoardRows(Array.isArray(board) ? board : []);
      setInfo(dataInfo);
    } catch (e) {
      toast?.(String(e.message || e), 'error');
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => { load(); }, [load]);

  const rowsForDetails = useMemo(() => {
    const assigned = boardRows.filter(row => String(row?.Vi_Tri || row?.so_phong || row?.room || '').trim());
    if (assigned.length) return boardRows;
    if (boardRows.length) return boardRows;
    return rawRows.map(row => ({ ...row, Vi_Tri: row.Vi_Tri || '' }));
  }, [boardRows, rawRows]);

  const availableRooms = useMemo(() => getUniqueRooms(rowsForDetails), [rowsForDetails]);

  const targetRowsForDetails = useMemo(() => {
    const list = Array.isArray(rowsForDetails) ? rowsForDetails : [];
    if (detailsScope === 'rooms') {
      const roomSet = new Set(selectedRooms);
      return list.filter(row => roomSet.has(patientRoom(row)));
    }
    if (detailsScope === 'dutyNew') {
      return filterPatientsByWorkflow(list, 'duty', workDateRange);
    }
    return list;
  }, [rowsForDetails, detailsScope, selectedRooms, workDateRange]);

  const toggleRoom = useCallback((room) => {
    setSelectedRooms(prev => prev.includes(room) ? prev.filter(x => x !== room) : [...prev, room].sort());
  }, []);

  const selectAllRooms = useCallback(() => setSelectedRooms(availableRooms), [availableRooms]);
  const clearRooms = useCallback(() => setSelectedRooms([]), []);

  const runScan = useCallback(async () => {
    setRunning('scan');
    try {
      const r = await api.runScan();
      toast?.(r.status === 'ok' ? (r.message || `Đã quét ${r.count || 0} BN`) : r.message, r.status === 'ok' ? 'ok' : 'error');
      await load();
    } catch (e) {
      toast?.(String(e.message || e), 'error');
    } finally {
      setRunning('');
    }
  }, [toast, load]);

  const runDetails = useCallback(async () => {
    if (!rowsForDetails.length) {
      toast?.('Chưa có danh sách bệnh nhân. Hãy quét dữ liệu trước.', 'error');
      return;
    }
    if (detailsScope === 'rooms' && selectedRooms.length === 0) {
      toast?.('Hãy chọn ít nhất 1 phòng, hoặc đổi phạm vi sang Tất cả phòng.', 'error');
      return;
    }
    if (!targetRowsForDetails.length) {
      toast?.('Không có bệnh nhân phù hợp với phạm vi đang chọn.', 'error');
      return;
    }
    setRunning('details');
    try {
      const r = await api.runDetails(targetRowsForDetails, {
        ...dmyRange,
        rooms: detailsScope === 'rooms' ? selectedRooms : [],
        partial: detailsScope !== 'all',
        scope: detailsScope,
      });
      toast?.(r.status === 'ok' ? `Đã lấy y lệnh ${targetRowsForDetails.length} BN theo khoảng ${rangeLabel}` : r.message, r.status === 'ok' ? 'ok' : 'error');
      await load();
    } catch (e) {
      toast?.(String(e.message || e), 'error');
    } finally {
      setRunning('');
    }
  }, [rowsForDetails, targetRowsForDetails, detailsScope, selectedRooms, dmyRange, rangeLabel, toast, load]);

  const runPostprocess = useCallback(async () => {
    setRunning('process');
    try {
      const r = await api.runPostprocess();
      toast?.(r.status === 'ok' ? 'Đã xử lý và phân loại dữ liệu.' : r.message, r.status === 'ok' ? 'ok' : 'error');
      await load();
    } catch (e) {
      toast?.(String(e.message || e), 'error');
    } finally {
      setRunning('');
    }
  }, [toast, load]);

  const useSession = useCallback(async () => {
    setShowPicker(false);
    await load();
    toast?.('Đã nạp lại dữ liệu đã lưu.', 'ok');
  }, [load, toast]);

  const rawCount = uniquePatientCount(rawRows);
  const boardCount = uniquePatientCount(boardRows);
  const processedCount = info?.processed?.count || 0;
  const canFetchDetails = rowsForDetails.length > 0 && targetRowsForDetails.length > 0;
  const activeScopeLabel = detailsScope === 'rooms' ? `${selectedRooms.length || 0} phòng` : detailsScope === 'dutyNew' ? 'BN mới của trực' : 'Tất cả phòng';

  return (
    <div style={{ flex: 1, overflow: 'auto', padding: 12 }}>
      <div style={{ maxWidth: 1320, margin: '0 auto', display: 'grid', gap: 12 }}>
        <div style={{ background: C.surface, borderBottom: `1px solid ${C.border2}`, padding: '4px 0 10px' }}>
          <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
            <div style={{ flex: 1, minWidth: 260 }}>
              <div style={{ fontSize: 17, fontWeight: 800, color: C.text }}>Thu thập dữ liệu</div>
              <div style={{ fontSize: 11, color: C.text2, marginTop: 3 }}>Quét danh sách → lấy chi tiết → phân loại.</div>
            </div>
            <Badge text={rangeLabel} bg={C.blueBg} color={C.blue} />
            <Btn onClick={load} disabled={loading || !!running}>{loading ? <><Spinner size={10} /> Đang tải...</> : '↻ Làm mới'}</Btn>
            <Btn onClick={() => setShowPicker(true)} disabled={!!running}>Đổi dữ liệu</Btn>
          </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'stretch', gap: 16, flexWrap: 'wrap', padding: '2px 0 6px' }}>
          <MiniStat title="Danh sách quét" value={rawCount} tone={rawCount ? 'info' : 'neutral'} />
          <MiniStat title="Đã xếp phòng" value={boardCount} tone={boardCount ? 'ok' : 'neutral'} />
          <MiniStat title="Đã phân loại" value={processedCount} tone={processedCount ? 'ok' : 'warn'} />
          <MiniStat title="BN sẽ lấy" value={`${targetRowsForDetails.length}/${rowsForDetails.length}`} tone={targetRowsForDetails.length ? 'info' : 'warn'} />
        </div>

        <div style={{ background: C.surface, borderTop: `1px solid ${C.border2}`, padding: '10px 0 0', display: 'grid', gap: 10 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <div style={{ fontSize: 12, fontWeight: 800, color: C.text, marginRight: 4 }}>Phạm vi lấy dữ liệu</div>
            <ScopeButton active={detailsScope === 'all'} onClick={() => setDetailsScope('all')}>Tất cả phòng</ScopeButton>
            <ScopeButton active={detailsScope === 'rooms'} onClick={() => setDetailsScope('rooms')}>Chọn phòng</ScopeButton>
            <ScopeButton active={detailsScope === 'dutyNew'} onClick={() => setDetailsScope('dutyNew')}>BN mới người trực</ScopeButton>
            <Badge text={activeScopeLabel} bg={targetRowsForDetails.length ? C.blueBg : C.amberBg} color={targetRowsForDetails.length ? C.blue : C.amber} />
          </div>

          {detailsScope === 'rooms' && (
            <div style={{ display: 'grid', gap: 8, paddingTop: 2 }}>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                <Btn onClick={selectAllRooms} disabled={!availableRooms.length}>Chọn tất cả phòng</Btn>
                <Btn onClick={clearRooms} disabled={!selectedRooms.length}>Bỏ chọn</Btn>
              </div>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                {availableRooms.length === 0 && <span style={{ fontSize: 11, color: C.text3 }}>Chưa có phòng đã xếp để chọn.</span>}
                {availableRooms.map(room => {
                  const active = selectedRooms.includes(room);
                  return (
                    <button type="button" key={room} onClick={() => toggleRoom(room)} style={{
                      padding: '5px 9px', borderRadius: 4, cursor: 'pointer', fontSize: 11, fontFamily: 'inherit',
                      border: `1px solid ${active ? C.blueBorder : C.border}`,
                      background: active ? C.blueBg : C.surface2,
                      color: active ? C.blue : C.text2,
                      fontWeight: active ? 850 : 600,
                    }}>{active ? '✓ ' : ''}{room}</button>
                  );
                })}
              </div>
            </div>
          )}

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 8 }}>
            <Btn variant="primary" onClick={runScan} disabled={!!running} style={{ justifyContent: 'flex-start', padding: '9px 11px' }}>
              {running === 'scan' ? <><Spinner size={12} /> Đang quét...</> : '① Quét danh sách BN'}
            </Btn>
            <Btn variant="primary" onClick={runDetails} disabled={!!running || !canFetchDetails} style={{ justifyContent: 'flex-start', padding: '9px 11px' }}>
              {running === 'details' ? <><Spinner size={12} /> Đang lấy chi tiết...</> : '② Lấy chi tiết'}
            </Btn>
            <Btn variant="success" onClick={runPostprocess} disabled={!!running} style={{ justifyContent: 'flex-start', padding: '9px 11px' }}>
              {running === 'process' ? <><Spinner size={12} /> Đang xử lý...</> : '③ Xử lý & phân loại'}
            </Btn>
          </div>

          <div style={{ color: C.text3, fontSize: 11, lineHeight: 1.5 }}>
            Ưu tiên danh sách đã xếp phòng; nếu chưa có sẽ dùng danh sách vừa quét.
          </div>
        </div>
      </div>

      {showPicker && (
        <SessionPicker onUseSession={useSession} onFetchNew={runScan} onClose={() => setShowPicker(false)} toast={toast} />
      )}
    </div>
  );
}
