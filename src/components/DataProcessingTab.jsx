import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { IconChevronRight, IconDatabaseImport, IconFileAnalytics, IconFolderOpen, IconListSearch, IconRefresh, IconTrash } from '@tabler/icons-react';
import { C, FS } from '../tokens.js';
import { Btn, Segmented } from './shared.jsx';
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

// Một bước trong quy trình lấy dữ liệu. Thứ tự 1 → 2 → 3 là thông tin thật (phải chạy lần lượt),
// nên đánh số; trạng thái bước lấy từ số liệu đã có, không đoán.
function Step({ index, icon: Icon, title, status, statusTone = 'neutral', children, action }) {
  const toneColor = { ok: C.green, warn: C.amber, info: C.blue, neutral: C.text2 }[statusTone] || C.text2;
  return (
    <li style={{ display: 'grid', gridTemplateColumns: '32px minmax(0, 1fr)', gap: 12, padding: '14px 16px', borderTop: index > 1 ? `1px solid ${C.border2}` : 'none', listStyle: 'none' }}>
      <span aria-hidden="true" style={{ width: 32, height: 32, borderRadius: 999, display: 'grid', placeItems: 'center', background: C.blueBg, color: C.blue, fontWeight: 700, fontSize: FS.md }}>{index}</span>
      <div style={{ minWidth: 0, display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: 8 }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12, flexWrap: 'wrap' }}>
          <div style={{ flex: '1 1 260px', minWidth: 0 }}>
            <h3 style={{ margin: 0, display: 'flex', alignItems: 'center', gap: 7, fontSize: FS.lg, fontWeight: 700, color: C.text }}>
              <Icon size={18} stroke={1.75} color={C.text2} aria-hidden="true" />{title}
            </h3>
            <div style={{ marginTop: 3, fontSize: FS.sm, color: toneColor, fontWeight: statusTone === 'neutral' ? 500 : 600 }}>{status}</div>
          </div>
          {action}
        </div>
        {children}
      </div>
    </li>
  );
}

function RoomToggle({ room, active, onToggle, tone = 'accent' }) {
  const on = tone === 'danger'
    ? { border: C.redBorder, bg: C.redBg, color: C.red, accent: C.red }
    : { border: C.blueBorder, bg: C.blueBg, color: C.blue, accent: C.blue };
  return (
    <label style={{
      display: 'inline-flex', alignItems: 'center', gap: 6, height: 32, padding: '0 10px', borderRadius: 5, cursor: 'pointer',
      border: `1px solid ${active ? on.border : C.border}`, background: active ? on.bg : C.surface,
      color: active ? on.color : C.text, fontSize: FS.sm, fontWeight: 600,
    }}>
      <input type="checkbox" checked={active} onChange={() => onToggle(room)} style={{ margin: 0, accentColor: on.accent }} />
      {room}
    </label>
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
  const [removeRooms, setRemoveRooms] = useState([]);
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

  const toggleRemoveRoom = useCallback((room) => {
    setRemoveRooms(prev => prev.includes(room) ? prev.filter(x => x !== room) : [...prev, room].sort());
  }, []);

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

  const handleRemoveRooms = useCallback(async () => {
    if (!removeRooms.length) {
      toast?.('Chưa chọn phòng cần xoá dữ liệu.', 'error');
      return;
    }
    const ok = typeof window === 'undefined' ? true : window.confirm(
      `XOÁ DỮ LIỆU Y LỆNH ĐÃ LẤY NHẦM\n\n` +
      `Phòng: ${removeRooms.join(', ')}\n\n` +
      `Sẽ xoá toàn bộ dữ liệu y lệnh đã lấy cho (các) phòng này rồi xử lý & phân loại lại. Không ảnh hưởng phòng khác. Muốn lấy lại phải chạy bước 2 "Lấy chi tiết" cho phòng đó.\n\n` +
      `Tiếp tục?`
    );
    if (!ok) return;
    setRunning('remove-rooms');
    try {
      const r = await api.removeDetailsRooms(removeRooms);
      toast?.(r.message || (r.removed_count ? `Đã xoá ${r.removed_count} dòng.` : 'Không có dữ liệu nào để xoá.'), r.status === 'ok' ? 'ok' : 'error');
      setRemoveRooms([]);
      await load();
    } catch (e) {
      toast?.(String(e.message || e), 'error');
    } finally {
      setRunning('');
    }
  }, [removeRooms, toast, load]);

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

  const scopeHint = detailsScope === 'rooms'
    ? (selectedRooms.length ? `${selectedRooms.length} phòng đã chọn` : 'Chưa chọn phòng nào')
    : detailsScope === 'dutyNew' ? 'Người bệnh mới vào/chuyển khoa trong ca trực' : 'Mọi phòng đã xếp';

  return (
    <div style={{ flex: 1, overflow: 'auto', padding: '4px 0 16px' }}>
      <div style={{ maxWidth: 1080, margin: '0 auto', display: 'grid', gap: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <p style={{ margin: 0, flex: '1 1 240px', fontSize: FS.sm, color: C.text2 }}>
            Chạy lần lượt 3 bước cho khoảng ngày <b style={{ color: C.text }}>{rangeLabel}</b>. Danh sách đã xếp phòng được ưu tiên; nếu chưa xếp sẽ dùng danh sách vừa quét.
          </p>
          <div style={{ display: 'flex', gap: 8 }}>
            <Btn icon={IconRefresh} onClick={load} loading={loading} disabled={!!running}>Tải lại</Btn>
            <Btn icon={IconFolderOpen} onClick={() => setShowPicker(true)} disabled={!!running}>Đổi dữ liệu</Btn>
          </div>
        </div>

        <ol style={{ margin: 0, padding: 0, background: C.surface, border: `1px solid ${C.border}`, borderRadius: 7 }}>
          <Step
            index={1}
            icon={IconListSearch}
            title="Quét danh sách người bệnh"
            status={rawCount ? `Đã có ${rawCount} người bệnh · ${boardCount} đã xếp phòng` : 'Chưa quét'}
            statusTone={rawCount ? 'ok' : 'neutral'}
            action={<Btn variant="solidPrimary" loading={running === 'scan'} disabled={!!running} onClick={runScan}>{running === 'scan' ? 'Đang quét…' : 'Quét danh sách'}</Btn>}
          />
          <Step
            index={2}
            icon={IconDatabaseImport}
            title="Lấy chi tiết y lệnh"
            status={rowsForDetails.length ? `Sẽ lấy ${targetRowsForDetails.length}/${rowsForDetails.length} người bệnh · ${scopeHint}` : 'Cần quét danh sách trước'}
            statusTone={!rowsForDetails.length ? 'neutral' : (targetRowsForDetails.length ? 'info' : 'warn')}
            action={<Btn variant="solidPrimary" loading={running === 'details'} disabled={!!running || !canFetchDetails} onClick={runDetails}>{running === 'details' ? 'Đang lấy…' : 'Lấy chi tiết'}</Btn>}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <span style={{ fontSize: FS.sm, color: C.text2 }}>Phạm vi</span>
              <Segmented
                label="Phạm vi lấy chi tiết"
                value={detailsScope}
                onChange={setDetailsScope}
                options={[{ value: 'all', label: 'Tất cả phòng' }, { value: 'rooms', label: 'Chọn phòng' }, { value: 'dutyNew', label: 'Mới trong ca' }]}
              />
            </div>
            {detailsScope === 'rooms' && (
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
                {availableRooms.length === 0 && <span style={{ fontSize: FS.sm, color: C.text2 }}>Chưa có phòng đã xếp để chọn.</span>}
                {availableRooms.map(room => <RoomToggle key={room} room={room} active={selectedRooms.includes(room)} onToggle={toggleRoom} />)}
                {availableRooms.length > 0 && <Btn onClick={selectAllRooms} style={{ height: 32 }}>Chọn hết</Btn>}
                {selectedRooms.length > 0 && <Btn onClick={clearRooms} style={{ height: 32 }}>Bỏ hết</Btn>}
              </div>
            )}
          </Step>
          <Step
            index={3}
            icon={IconFileAnalytics}
            title="Xử lý và phân loại"
            status={processedCount ? `Đã phân loại ${processedCount} người bệnh` : 'Chưa phân loại'}
            statusTone={processedCount ? 'ok' : 'warn'}
            action={<Btn variant="solidPrimary" loading={running === 'process'} disabled={!!running} onClick={runPostprocess}>{running === 'process' ? 'Đang xử lý…' : 'Xử lý & phân loại'}</Btn>}
          />
        </ol>

        <details className="emr-danger-zone">
          <summary>
            <IconChevronRight size={16} stroke={1.9} className="emr-danger-zone__chevron" aria-hidden="true" />
            Xoá dữ liệu y lệnh đã lấy nhầm phòng
          </summary>
          <div style={{ display: 'grid', gap: 10, padding: '0 16px 14px' }}>
            <p style={{ margin: 0, fontSize: FS.sm, color: C.text2, lineHeight: 1.5 }}>
              Bước 2 chỉ cộng thêm hoặc cập nhật theo phạm vi đang chọn; bỏ chọn phòng ở lần sau không tự xoá dữ liệu của phòng đó.
              Nếu lỡ lấy nhầm phòng, chọn phòng dưới đây rồi xoá hẳn dữ liệu đã lấy cho phòng đó.
            </p>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              {availableRooms.length === 0 && <span style={{ fontSize: FS.sm, color: C.text2 }}>Chưa có phòng đã xếp để chọn.</span>}
              {availableRooms.map(room => <RoomToggle key={room} room={room} active={removeRooms.includes(room)} onToggle={toggleRemoveRoom} tone="danger" />)}
            </div>
            <div>
              <Btn variant="danger" icon={IconTrash} loading={running === 'remove-rooms'} disabled={!!running || !removeRooms.length} onClick={handleRemoveRooms}>
                {running === 'remove-rooms' ? 'Đang xoá…' : `Xoá dữ liệu ${removeRooms.length} phòng`}
              </Btn>
            </div>
          </div>
        </details>
      </div>

      {showPicker && (
        <SessionPicker onUseSession={useSession} onFetchNew={runScan} onClose={() => setShowPicker(false)} toast={toast} />
      )}
    </div>
  );
}
