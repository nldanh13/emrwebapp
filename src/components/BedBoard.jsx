import { useState, useEffect, useCallback } from 'react';
import * as api from '../api.js';
import BedBoardDesktop from './bedboard/BedBoardDesktop.jsx';
import BedBoardMobile from './bedboard/BedBoardMobile.jsx';
import {
  useWindowWidth,
  loadRoomConfig,
  saveRoomConfig,
  normalizeRoom,
  getPatientId,
  sortedRoomEntries,
  sanitizePatientsForSave,
  filterUnassignedPatients,
} from './bedboard/bedBoardUtils.js';
import { printRoomAssignment } from './bedboard/bedBoardPrint.js';



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
  const [newRoom, setNewRoom] = useState('');
  const [search, setSearch] = useState('');

  const selCount = selectedPxSet.size;

  const loadData = useCallback(() => {
    setLoading(true);
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

  useEffect(() => { loadData(); }, [loadData]);

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
    patients.filter(p => normalizeRoom(p.Vi_Tri || '') === room)
  ), [patients]);

  const unassigned = patients.filter(p => !normalizeRoom(p.Vi_Tri || ''));
  const assigned = patients.filter(p => normalizeRoom(p.Vi_Tri || ''));
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
    setSelectedPxSet(new Set());
    setInspectRoom(null);
  }, [selectedPxSet]);

  const removeFromRoom = useCallback((pid) => {
    setPatients(prev => prev.map(p =>
      getPatientId(p) === pid ? { ...p, Vi_Tri: '' } : p
    ));
  }, []);

  const clearRoom = useCallback((room) => {
    setPatients(prev => prev.map(p =>
      normalizeRoom(p.Vi_Tri || '') === room ? { ...p, Vi_Tri: '' } : p
    ));
  }, []);

  const addRoom = useCallback(() => {
    const code = normalizeRoom(newRoom);
    if (!code) { toast?.('Mã phòng không hợp lệ (ví dụ: P12)', 'error'); return; }
    if (roomConfig[code]) { toast?.(`${code} đã tồn tại`, 'error'); return; }
    const next = { ...roomConfig, [code]: 6 };
    setRoomConfig(next);
    saveRoomConfig(next);
    setNewRoom('');
  }, [newRoom, roomConfig, toast]);

  const deleteRoom = useCallback((room) => {
    clearRoom(room);
    const next = { ...roomConfig };
    delete next[room];
    setRoomConfig(next);
    saveRoomConfig(next);
  }, [roomConfig, clearRoom]);

  const handlePrintRooms = useCallback(() => {
    const result = printRoomAssignment(patients);
    toast?.(result.message, result.ok ? 'ok' : 'error');
  }, [patients, toast]);

  const handleSaveOnly = useCallback(async () => {
    setSaving(true);
    try {
      await api.saveBoardData(sanitizePatientsForSave(patients));
      toast?.('Đã lưu xếp phòng!', 'ok');
    } catch (e) {
      toast?.(String(e.message), 'error');
    } finally {
      setSaving(false);
    }
  }, [patients, toast]);

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
    handleSaveOnly,
    handlePrintRooms,
  };

  if (isMobile) {
    return (
      <BedBoardMobile
        {...commonProps}
        rooms={rooms}
        inspectRoom={inspectRoom}
        setInspectRoom={setInspectRoom}
      />
    );
  }

  return (
    <BedBoardDesktop
      {...commonProps}
      clearRoom={clearRoom}
      deleteRoom={deleteRoom}
      newRoom={newRoom}
      setNewRoom={setNewRoom}
      addRoom={addRoom}
      handleSaveOnly={handleSaveOnly}
    />
  );
}
