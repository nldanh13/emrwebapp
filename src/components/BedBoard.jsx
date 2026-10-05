import { useState, useEffect, useCallback, useRef } from 'react';
import * as api from '../api.js';
import BedBoardDesktop from './bedboard/BedBoardDesktop.jsx';
import BedBoardMobile from './bedboard/BedBoardMobile.jsx';
import RoomMismatchWarning from './bedboard/RoomMismatchWarning.jsx';
import {
  useWindowWidth,
  loadRoomConfig,
  saveRoomConfig,
  canonicalRoomKey,
  matchesRoom,
  getPatientId,
  sortedRoomEntries,
  sanitizePatientsForSave,
  filterUnassignedPatients,
} from './bedboard/bedBoardUtils.js';



function mergeBoardWithRaw(savedRows, rawRows) {
  const saved = Array.isArray(savedRows) ? savedRows.filter(x => x && typeof x === 'object' && !Array.isArray(x)) : [];
  const raw = Array.isArray(rawRows) ? rawRows.filter(x => x && typeof x === 'object' && !Array.isArray(x)) : [];
  if (!raw.length) return saved;

  const rawById = new Map();
  const rawNoId = [];
  for (const row of raw) {
    const id = getPatientId(row);
    if (id) {
      if (!rawById.has(id)) rawById.set(id, row);
    } else {
      rawNoId.push({ ...row, Vi_Tri: '' });
    }
  }

  const savedById = new Map();
  for (const row of saved) {
    const id = getPatientId(row);
    if (id && !savedById.has(id)) savedById.set(id, row);
  }

  const merged = [];
  const seen = new Set();

  // Danh sách scan mới là nguồn chuẩn. Chỉ giữ BN còn xuất hiện trong raw,
  // nhưng bảo toàn Vi_Tri đã xếp trước đó theo mã BN.
  for (const rawRow of raw) {
    const id = getPatientId(rawRow);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const oldRow = savedById.get(id) || {};
    merged.push({
      ...oldRow,
      ...rawById.get(id),
      Vi_Tri: String(oldRow.Vi_Tri || '').trim(),
    });
  }

  merged.push(...rawNoId);
  return merged;
}

export default function BedBoard({ toast }) {
  const isMobile = useWindowWidth() < 640;
  const [inspectRoom, setInspectRoom] = useState(null);
  const [patients, setPatients] = useState([]);
  const [roomConfig, setRoomConfig] = useState(loadRoomConfig);
  const [selectedPxSet, setSelectedPxSet] = useState(new Set());
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [printingRooms, setPrintingRooms] = useState(false);
  const [newRoom, setNewRoom] = useState('');
  const [search, setSearch] = useState('');
  const [roomMismatches, setRoomMismatches] = useState([]);
  const [fixingRooms, setFixingRooms] = useState(false);

  const selCount = selectedPxSet.size;
  // Tự lưu xếp phòng: mỗi lần xếp/bỏ/ghi chú thì lưu sau 0,8 giây. Trước đây chỉ lưu khi bấm
  // "Lưu xếp phòng"; chuyển tab trước khi bấm là mất, và Lấy dữ liệu không thấy phòng nào để chọn.
  const [editVersion, setEditVersion] = useState(0);
  const [autoSave, setAutoSave] = useState({ state: 'idle', at: '' });
  const patientsRef = useRef(patients);
  patientsRef.current = patients;
  const pendingRef = useRef(false);
  const markEdited = useCallback(() => { pendingRef.current = true; setEditVersion(v => v + 1); }, []);

  const loadData = useCallback(({ silent = false } = {}) => {
    if (!silent) setLoading(true);
    Promise.all([api.getRaw(), api.getBoardData()])
      .then(([raw, saved]) => {
        const rawRows = Array.isArray(raw) ? raw : [];
        const savedRows = Array.isArray(saved) ? saved : [];
        if (rawRows.length > 0 && savedRows.length > 0) {
          setPatients(mergeBoardWithRaw(savedRows, rawRows));
        } else if (savedRows.length > 0) {
          setPatients(savedRows);
        } else if (rawRows.length > 0) {
          setPatients(rawRows.map(p => ({ ...p, Vi_Tri: p.Vi_Tri || '' })));
        } else {
          setPatients([]);
        }
      })
      .catch(() => { })
      .finally(() => setLoading(false));
  }, []);

  const loadRoomMismatches = useCallback(() => {
    api.getRoomMismatches()
      .then(r => setRoomMismatches(Array.isArray(r?.mismatches) ? r.mismatches : []))
      .catch(() => {});
  }, []);

  useEffect(() => { loadData(); loadRoomMismatches(); }, [loadData, loadRoomMismatches]);

  const saveNow = useCallback(async () => {
    pendingRef.current = false;
    setAutoSave({ state: 'saving', at: '' });
    try {
      await api.saveBoardData(sanitizePatientsForSave(patientsRef.current));
      setAutoSave({ state: 'saved', at: new Date().toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' }) });
      window.dispatchEvent(new CustomEvent('emr:board-saved'));
      loadRoomMismatches();
      return true;
    } catch (e) {
      pendingRef.current = true;
      setAutoSave({ state: 'error', at: '' });
      toast?.(`Chưa tự lưu được xếp phòng: ${String(e.message || e)}`, 'error');
      return false;
    }
  }, [toast, loadRoomMismatches]);

  useEffect(() => {
    if (!editVersion) return undefined;
    setAutoSave({ state: 'pending', at: '' });
    const id = setTimeout(() => { saveNow(); }, 800);
    return () => clearTimeout(id);
  }, [editVersion, saveNow]);

  // Rời màn hình khi còn thay đổi chưa lưu: lưu ngay.
  useEffect(() => () => {
    if (pendingRef.current) api.saveBoardData(sanitizePatientsForSave(patientsRef.current)).catch(() => {});
  }, []);

  // Quay lại tab Xếp phòng: cập nhật ngầm (danh sách vừa quét ở tab khác), không làm mất thay đổi đang chờ lưu.
  useEffect(() => {
    const onActive = (e) => {
      if (e.detail === 'bed') {
        if (!pendingRef.current) loadData({ silent: true });
      } else if (pendingRef.current) {
        // Rời tab khi còn thay đổi chưa lưu: lưu ngay để tab khác (vd. Lấy dữ liệu) thấy phòng mới xếp.
        saveNow();
      }
    };
    window.addEventListener('emr:tab-active', onActive);
    return () => window.removeEventListener('emr:tab-active', onActive);
  }, [loadData, saveNow]);

  const handleFixRooms = useCallback(async (patientIds) => {
    setFixingRooms(true);
    try {
      const r = await api.fixRooms(patientIds);
      toast?.(r.message || `Đã đồng bộ phòng cho ${r.fixed_patient_ids?.length || 0} BN.`, r.status === 'ok' ? 'ok' : 'error');
      loadRoomMismatches();
    } catch (e) {
      toast?.(String(e.message || e), 'error');
    } finally {
      setFixingRooms(false);
    }
  }, [toast, loadRoomMismatches]);

  const handleScan = useCallback(async () => {
    setLoading(true);
    try {
      const r = await api.runScan();
      if (r.status === 'ok') {
        const board = r.board || {};
        const extra = Number.isFinite(board.kept)
          ? ` · giữ ${board.kept}, mới ${board.added || 0}, xoá ${board.removed || 0}`
          : '';
        toast?.(`Quét xong: ${r.count} BN${extra}`, 'ok');
        loadData();
        loadRoomMismatches();
      } else {
        toast?.(r.message, 'error');
        setLoading(false);
      }
    } catch (e) {
      toast?.(String(e.message), 'error');
      setLoading(false);
    }
  }, [toast, loadData]);

  const roomPatients = useCallback((room) => (
    patients.filter(p => matchesRoom(p.Vi_Tri, room))
  ), [patients]);

  const unassigned = patients.filter(p => !canonicalRoomKey(p.Vi_Tri || ''));
  const assigned = patients.filter(p => canonicalRoomKey(p.Vi_Tri || ''));
  const filtered = filterUnassignedPatients(patients, search);
  const rooms = sortedRoomEntries(roomConfig);

  const toggleSelectPx = useCallback((id) => {
    setSelectedPxSet(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }, []);

  const clearSelection = useCallback(() => setSelectedPxSet(new Set()), []);
  const selectAllUnassigned = useCallback(() => {
    setSelectedPxSet(new Set(unassigned.map(getPatientId)));
  }, [unassigned]);

  const assignToRoom = useCallback((room) => {
    if (!selectedPxSet.size) return;
    setPatients(prev => prev.map(p =>
      selectedPxSet.has(getPatientId(p)) ? { ...p, Vi_Tri: room } : p
    ));
    markEdited();
    setSelectedPxSet(new Set());
    setInspectRoom(null);
  }, [selectedPxSet, markEdited]);

  const removeFromRoom = useCallback((pid) => {
    setPatients(prev => prev.map(p =>
      getPatientId(p) === pid ? { ...p, Vi_Tri: '' } : p
    ));
    markEdited();
  }, [markEdited]);

  const clearRoom = useCallback((room) => {
    setPatients(prev => prev.map(p =>
      matchesRoom(p.Vi_Tri, room) ? { ...p, Vi_Tri: '' } : p
    ));
    markEdited();
  }, [markEdited]);

  const addRoom = useCallback(() => {
    // Phòng dạng "P12" được chuẩn hoá như trước; phòng đặt tên tự do (không khớp
    // mẫu P + số) vẫn được thêm nguyên văn — theo yêu cầu cho ghi tự do tên phòng.
    const code = canonicalRoomKey(newRoom);
    if (!code) { toast?.('Tên phòng không hợp lệ', 'error'); return; }
    if (roomConfig[code]) { toast?.(`${code} đã tồn tại`, 'error'); return; }
    const next = { ...roomConfig, [code]: 6 };
    setRoomConfig(next);
    saveRoomConfig(next);
    setNewRoom('');
  }, [newRoom, roomConfig, toast]);

  const updatePatientNote = useCallback((id, field, value) => {
    setPatients(prev => prev.map(p =>
      getPatientId(p) === id ? { ...p, [field]: value } : p
    ));
    markEdited();
  }, [markEdited]);

  const deleteRoom = useCallback((room) => {
    clearRoom(room);
    const next = { ...roomConfig };
    delete next[room];
    setRoomConfig(next);
    saveRoomConfig(next);
  }, [roomConfig, clearRoom]);

  const handlePrintRooms = useCallback(async () => {
    const assignedRows = patients.filter(patient => canonicalRoomKey(patient?.Vi_Tri || patient?.vi_tri || ''));
    if (!assignedRows.length) {
      toast?.('Chưa có người bệnh nào được xếp phòng để tạo PDF.', 'error');
      return;
    }
    setPrintingRooms(true);
    try {
      const { blob, filename } = await api.downloadWardListPdf(assignedRows);
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = filename;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
      toast?.(`Đã lưu PDF ${assignedRows.length} người bệnh để in.`, 'ok');
    } catch (error) {
      toast?.(`Không tạo được PDF: ${String(error?.message || error)}`, 'error');
    } finally {
      setPrintingRooms(false);
    }
  }, [patients, toast]);

  const handleSaveOnly = useCallback(async () => {
    setSaving(true);
    try {
      pendingRef.current = false;
      await api.saveBoardData(sanitizePatientsForSave(patients));
      setAutoSave({ state: 'saved', at: new Date().toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' }) });
      window.dispatchEvent(new CustomEvent('emr:board-saved'));
      toast?.('Đã lưu xếp phòng!', 'ok');
      loadRoomMismatches();
    } catch (e) {
      toast?.(String(e.message), 'error');
    } finally {
      setSaving(false);
    }
  }, [patients, toast, loadRoomMismatches]);

  const commonProps = {
    roomConfig,
    roomPatients,
    selectedPxSet,
    toggleSelectPx,
    selectAllUnassigned,
    clearSelection,
    selCount,
    assignToRoom,
    removeFromRoom,
    updatePatientNote,
    loading,
    handleScan,
    loadData,
    search,
    setSearch,
    unassigned,
    assigned,
    filtered,
    patients,
    saving,
    autoSave,
    handleSaveOnly,
    handlePrintRooms,
    printingRooms,
  };

  if (isMobile) {
    return (
      <>
        <RoomMismatchWarning mismatches={roomMismatches} fixing={fixingRooms} onFix={handleFixRooms} />
        <BedBoardMobile
          {...commonProps}
          rooms={rooms}
          inspectRoom={inspectRoom}
          setInspectRoom={setInspectRoom}
        />
      </>
    );
  }

  return (
    <>
      <RoomMismatchWarning mismatches={roomMismatches} fixing={fixingRooms} onFix={handleFixRooms} />
      <BedBoardDesktop
        {...commonProps}
        clearRoom={clearRoom}
        deleteRoom={deleteRoom}
        newRoom={newRoom}
        setNewRoom={setNewRoom}
        addRoom={addRoom}
        handleSaveOnly={handleSaveOnly}
      />
    </>
  );
}
