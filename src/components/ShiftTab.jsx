import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { C } from '../tokens.js';
import { Btn, Spinner } from './shared.jsx';
import BedBoard from './BedBoard.jsx';
import * as api from '../api.js';
import SessionPicker from './shift/SessionPicker.jsx';
import ShiftMobileView from './shift/ShiftMobileView.jsx';
import ShiftDesktopView from './shift/ShiftDesktopView.jsx';
import ShiftToolbar from './shift/ShiftToolbar.jsx';
import {
  buildInputTargets,
  filterPatientsByRoom,
  getRooms,
  patientRoom,
  patientIdOf,
  patientNameOf,
  getShiftStats,
  normalizeClockTime,
  useWindowWidth,
} from './shift/shiftUtils.js';
import { inputDateToDmy, sanitizeWorkDateRange, workDateRangeToDmy, workDateRangeLabel } from '../utils/workDateRange.js';
import { getPatientWorkflowDates, scopePatientToDates, withPatientWorkflowScope } from '../utils/patientScope.js';
import { getMatchingDischargeDate, isDischargePrintPatientOnDates } from '../utils/dischargePrint.js';
import { useFeatureStates } from '../features/runtime.js';

function LoadingState() {
  return (
    <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', flexDirection: 'column', gap: 10, color: C.text2 }}>
      <Spinner size={20} />
      <span style={{ fontSize: 12 }}>Đang tải dữ liệu...</span>
    </div>
  );
}

function StartupState({ showPicker, setShowPicker, handleUseSession, handleFetchNew, toast, setSubTab }) {
  return (
    <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}>
      <div style={{
        background: C.surface, border: `1px solid ${C.border}`,
        borderRadius: 6, padding: 28, width: '100%', maxWidth: 400, textAlign: 'center',
      }}>
        <div style={{ fontSize: 28, marginBottom: 12 }}>🏥</div>
        <div style={{ fontSize: 15, fontWeight: 600, color: C.text, marginBottom: 6 }}>Chưa có dữ liệu ca trực</div>
        <div style={{ fontSize: 12, color: C.text3, marginBottom: 24, lineHeight: 1.6 }}>
          Kết nối EMR để quét danh sách bệnh nhân và lấy y lệnh.
        </div>
        <Btn variant="primary" onClick={() => setSubTab('board')}
          style={{ width: '100%', justifyContent: 'center', padding: '10px', fontSize: 14, marginBottom: 10 }}>
          ⟳ Quét dữ liệu từ EMR
        </Btn>
        <Btn variant="default" onClick={() => setShowPicker(true)}
          style={{ width: '100%', justifyContent: 'center', padding: '8px', fontSize: 12 }}>
          📂 Chọn dữ liệu đã lưu
        </Btn>
      </div>
      {showPicker && (
        <SessionPicker onUseSession={handleUseSession} onFetchNew={handleFetchNew}
          onClose={() => setShowPicker(false)} toast={toast} />
      )}
    </div>
  );
}


function countTargetDays(targets = {}) {
  const ids = Array.isArray(targets.patientIds) ? targets.patientIds : [];
  const patientDates = targets.patientDates && typeof targets.patientDates === 'object' ? targets.patientDates : {};
  let total = 0;
  for (const id of ids) {
    const dates = Array.isArray(patientDates[id]) ? patientDates[id] : [];
    total += dates.length || 1;
  }
  return total;
}


function inputDateStamp(value) {
  const m = String(value || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return NaN;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime();
}

function dmyStamp(value) {
  const m = String(value || '').trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) return 0;
  return new Date(Number(m[3]), Number(m[2]) - 1, Number(m[1])).getTime();
}

function refreshDateOptions(selectedDate, fallbackRange) {
  if (Array.isArray(selectedDate)) {
    const dates = [...new Set(selectedDate.map(x => String(x || '').trim()).filter(Boolean))]
      .filter(d => dmyStamp(d))
      .sort((a, b) => dmyStamp(a) - dmyStamp(b));
    if (dates.length) {
      return {
        dateFrom: dates[0],
        dateTo: dates[dates.length - 1],
        selectedDates: dates,
        label: dates.length === 1 ? dates[0] : `${dates[0]} → ${dates[dates.length - 1]}`,
      };
    }
  }
  const single = String(selectedDate || '').trim();
  if (single) return { dateFrom: single, dateTo: single, selectedDates: [single], label: single };
  const range = workDateRangeToDmy(fallbackRange);
  const label = range.dateFrom === range.dateTo ? range.dateFrom : workDateRangeLabel(fallbackRange);
  return { ...range, label };
}

function workDateRangeDatesDmy(range) {
  const clean = sanitizeWorkDateRange(range);
  const startStamp = inputDateStamp(clean.from);
  const endStamp = inputDateStamp(clean.to || clean.from);
  if (!Number.isFinite(startStamp) || !Number.isFinite(endStamp)) return [];
  const start = Math.min(startStamp, endStamp);
  const end = Math.max(startStamp, endStamp);
  const dates = [];
  const d = new Date(start);
  let guard = 0;
  while (d.getTime() <= end && guard < 370) {
    dates.push(inputDateToDmy(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`));
    d.setDate(d.getDate() + 1);
    guard += 1;
  }
  return dates.sort((a, b) => dmyStamp(b) - dmyStamp(a));
}

function singleDateRangeFromDmy(value) {
  const m = String(value || '').trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) return null;
  const inputDate = `${m[3]}-${String(m[2]).padStart(2, '0')}-${String(m[1]).padStart(2, '0')}`;
  return { from: inputDate, to: inputDate };
}


function makePrecheckReport(result, label, targets, statusOverride = '') {
  const status = statusOverride || result?.status || 'info';
  return {
    status,
    label,
    checkedAt: result?.checked_at || new Date().toISOString(),
    updatedAt: result?.updated_at || '',
    checkedCount: Number(result?.checked_count || 0),
    changedCount: Number(result?.changed_count || 0),
    message: result?.message || '',
    changed: Array.isArray(result?.changed) ? result.changed : [],
    selectedDates: Array.isArray(targets?.selectedDates) ? targets.selectedDates : [],
    targetRooms: Array.isArray(targets?.targetRooms) ? targets.targetRooms : [],
  };
}

function formatPrecheckConfirmSummary(result, maxItems = 8) {
  const rows = Array.isArray(result?.changed) ? result.changed : [];
  if (!rows.length) return 'Không có danh sách thay đổi chi tiết.';
  const lines = rows.slice(0, maxItems).map((item, idx) => {
    const name = item.ho_ten || item.name || item.ma_bn || item.key || `BN ${idx + 1}`;
    const date = item.ngay_lam ? ` ngày ${item.ngay_lam}` : '';
    const time = item.changed_at || item.last_order_time ? ` | mốc mới nhất: ${item.changed_at || item.last_order_time}` : '';
    const changes = Array.isArray(item.changes) && item.changes.length ? ` | ${item.changes.join(', ')}` : (item.reason ? ` | ${item.reason}` : '');
    return `- ${name}${date}${time}${changes}`;
  });
  if (rows.length > maxItems) lines.push(`- ... còn ${rows.length - maxItems} BN/ngày khác`);
  return lines.join('\n');
}

function waitForUiPaint(ms = 80) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function confirmInputAction(targets, label, precheck = null) {
  if (typeof window === 'undefined') return true;
  const ids = Array.isArray(targets.patientIds) ? targets.patientIds : [];
  const patientCount = ids.length;
  const dayCount = countTargetDays(targets);
  let checkLine = 'Sau khi bấm OK, hệ thống sẽ kiểm tra y lệnh mới trước khi nhập.';
  if (precheck?.precheck_expires_at) {
    const expires = new Date(precheck.precheck_expires_at).toLocaleTimeString('vi-VN', {
      hour: '2-digit',
      minute: '2-digit',
    });
    checkLine = `Kiểm tra y lệnh mới: đã đạt, hiệu lực đến ${expires}.`;
  }
  const selectedDates = Array.isArray(targets.selectedDates) ? targets.selectedDates.filter(Boolean) : [];
  const summaries = Array.isArray(targets.patientSummaries) ? targets.patientSummaries : [];
  const patientLines = summaries.slice(0, 12).map((item, idx) => {
    const id = String(item?.id || ids[idx] || '').trim();
    const name = String(item?.name || '').trim();
    const room = String(item?.room || '').trim();
    return `- ${id}${name && name !== id ? ` — ${name}` : ''}${room ? ` (${room})` : ''}`;
  });
  if (summaries.length > 12) patientLines.push(`- ... còn ${summaries.length - 12} bệnh nhân khác`);
  const excluded = Array.isArray(targets.excludedPatients) ? targets.excludedPatients : [];
  const excludedLines = excluded.slice(0, 8).map(item => {
    const id = String(item?.id || '').trim();
    const name = String(item?.name || '').trim();
    const room = String(item?.room || '').trim();
    return `- ${id}${name && name !== id ? ` — ${name}` : ''}${room ? ` (${room})` : ''}`;
  });
  if (excluded.length > 8) excludedLines.push(`- ... còn ${excluded.length - 8} bệnh nhân bị loại`);
  const normalizedLabel = String(label || '').toLowerCase();
  const mutationLine = normalizedLabel.includes('chăm sóc')
    ? 'Mỗi BN/ngày đều được mở kiểm tra trực tiếp trên HIS: chưa có → tạo mới; đã đúng → giữ nguyên; đã có nhưng sai → thu hồi và cập nhật; chỉ bỏ qua khi phiếu không có mã sửa hoặc EMR không cho phép can thiệp.'
    : '';
  return window.confirm(
    `XÁC NHẬN NHẬP EMR\n\n` +
    `Loại nhập: ${label}\n` +
    `Số bệnh nhân: ${patientCount}\n` +
    `Số BN/ngày: ${dayCount}\n` +
    `${selectedDates.length ? `Ngày nhập: ${selectedDates.join(', ')}\n` : ''}` +
    `${Array.isArray(targets.targetRooms) && targets.targetRooms.length ? `Phòng nhập: ${targets.targetRooms.join(', ')}\n` : ''}` +
    `${patientLines.length ? `\nDANH SÁCH SẼ NHẬP:\n${patientLines.join('\n')}\n` : ''}` +
    `${excludedLines.length ? `\nĐÃ LOẠI KHỎI PHẠM VI:\n${excludedLines.join('\n')}\n` : ''}` +
    `${checkLine}\n` +
    `${mutationLine ? `${mutationLine}\n` : ''}` +
    `\nChỉ bấm OK khi đã xem lại danh sách/cảnh báo và đang ở đúng phiên EMR.`
  );
}

function BoardView({ toolbarProps, toast, showPicker, setShowPicker, handleUseSession, handleFetchNew, handleBoardDone, workDateRange, setWorkDateRange }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, overflow: 'hidden' }}>
      {toolbarProps && <ShiftToolbar {...toolbarProps} />}
      <BedBoard toast={toast} onDone={handleBoardDone} workDateRange={workDateRange} setWorkDateRange={setWorkDateRange} />
      {showPicker && (
        <SessionPicker onUseSession={handleUseSession} onFetchNew={handleFetchNew}
          onClose={() => setShowPicker(false)} toast={toast} />
      )}
    </div>
  );
}

export default function ShiftTab({ toast, mode = 'combined', workDateRange, setWorkDateRange, workflowTitle = 'Bệnh nhân & nhập liệu', workflowHint = '' }) {
  const windowWidth = useWindowWidth();
  const isMobile = windowWidth < 640;
  const lockedSubTab = mode === 'bed' ? 'board' : (mode === 'ward' || mode === 'duty' ? 'patients' : null);

  const [subTab, setSubTab] = useState(null);
  const [allPatients, setAllPatients] = useState([]);
  const [selRoom, setSelRoom] = useState(null);
  const [selPx, setSelPx] = useState(null);
  const [loading, setLoading] = useState(false);
  const [running, setRunning] = useState(null);
  const [showPicker, setShowPicker] = useState(false);
  const [selectedInputRooms, setSelectedInputRooms] = useState([]);
  const [inputMode, setInputMode] = useState('rooms');
  const [manualInputPatientIds, setManualInputPatientIds] = useState(() => new Set());
  const [excludedInputPatientIds, setExcludedInputPatientIds] = useState(() => new Set());
  const [precheckReport, setPrecheckReport] = useState(null);
  const inputRoomsInitializedRef = useRef(false);
  const previousInputRoomsRef = useRef([]);
  const { states: inputFeatureStates } = useFeatureStates(['care.input', 'infusion.input', 'procedure.input']);
  const careInputEnabled = inputFeatureStates['care.input']?.enabled !== false;
  const infusionInputEnabled = inputFeatureStates['infusion.input']?.enabled !== false;
  const procedureInputEnabled = inputFeatureStates['procedure.input']?.enabled !== false;
  const featureAvailability = { care: careInputEnabled, infusion: infusionInputEnabled, procedure: procedureInputEnabled };
  const disabledFeatureLabels = [
    !careInputEnabled ? 'Nhập chăm sóc' : '',
    !infusionInputEnabled ? 'Nhập dịch truyền' : '',
    !procedureInputEnabled ? 'Nhập thủ thuật' : '',
  ].filter(Boolean);

  const inputTargetDates = useMemo(() => workDateRangeDatesDmy(workDateRange), [workDateRange?.from, workDateRange?.to]);
  const inputTargetDatesKey = inputTargetDates.join('\u0001');
  const dateScopedPatients = useMemo(() => {
    if (!inputTargetDates.length) return allPatients;
    return allPatients.map(p => scopePatientToDates(p, inputTargetDates)).filter(Boolean);
  }, [allPatients, inputTargetDatesKey]);
  const workflowBuckets = useMemo(() => {
    const buildBucket = (scope) => allPatients.map(patient => {
      const dates = getPatientWorkflowDates(patient, inputTargetDates, scope);
      if (!dates.length) return null;
      const scoped = scopePatientToDates(patient, dates);
      if (!scoped) return null;
      const activeDate = dates[0] || scoped.ngay_lam;
      const dayRange = singleDateRangeFromDmy(activeDate) || workDateRange;
      return withPatientWorkflowScope(scoped, dayRange);
    }).filter(Boolean);
    return {
      ward: buildBucket('ward'),
      duty: buildBucket('duty'),
      unknown: buildBucket('unknown'),
    };
  }, [allPatients, inputTargetDatesKey, workDateRange?.from, workDateRange?.to]);
  const scopedPatients = mode === 'ward' || mode === 'duty' || mode === 'unknown'
    ? workflowBuckets[mode]
    : dateScopedPatients.map(p => withPatientWorkflowScope(p, workDateRange));
  const dutyCount = workflowBuckets.duty.length;
  const unknownScopeCount = workflowBuckets.unknown.length;
  const patients = scopedPatients;
  const stats = getShiftStats(patients);
  const rooms = getRooms(patients);
  const filtered = filterPatientsByRoom(patients, selRoom);
  const roomsKey = rooms.join('\u0001');

  useEffect(() => {
    const previousRooms = previousInputRoomsRef.current || [];
    if (!rooms.length) {
      setSelectedInputRooms([]);
      inputRoomsInitializedRef.current = false;
      previousInputRoomsRef.current = [];
      return;
    }
    setSelectedInputRooms(prev => {
      const valid = prev.filter(room => rooms.includes(room));
      const previousWasFullySelected = previousRooms.length > 0
        && previousRooms.every(room => prev.includes(room))
        && prev.every(room => previousRooms.includes(room));
      const roomListExpanded = previousRooms.length > 0 && rooms.some(room => !previousRooms.includes(room));
      if (!inputRoomsInitializedRef.current || (!valid.length && prev.length) || (roomListExpanded && previousWasFullySelected)) {
        inputRoomsInitializedRef.current = true;
        return rooms;
      }
      inputRoomsInitializedRef.current = true;
      if (valid.length === prev.length && valid.every((room, idx) => room === prev[idx])) return prev;
      return valid;
    });
    previousInputRoomsRef.current = rooms;
  }, [roomsKey]);

  const patientIdsKey = useMemo(() => patients.map(patientIdOf).filter(Boolean).join('\u0001'), [patients]);

  useEffect(() => {
    const validIds = new Set(patients.map(patientIdOf).filter(Boolean));
    setManualInputPatientIds(prev => {
      const next = new Set([...prev].filter(id => validIds.has(id)));
      return next.size === prev.size ? prev : next;
    });
    setExcludedInputPatientIds(prev => {
      const next = new Set([...prev].filter(id => validIds.has(id)));
      return next.size === prev.size ? prev : next;
    });
  }, [patientIdsKey]);

  const selectedInputRoomSet = useMemo(() => new Set(selectedInputRooms), [selectedInputRooms]);
  const roomScopedInputPatients = useMemo(() => {
    if (!rooms.length) return patients;
    if (!selectedInputRooms.length) return [];
    return patients.filter(p => selectedInputRoomSet.has(patientRoom(p)));
  }, [patients, rooms.length, selectedInputRooms.length, selectedInputRoomSet]);
  const selectedInputPatients = useMemo(() => {
    if (inputMode === 'manual') {
      return patients.filter(p => manualInputPatientIds.has(patientIdOf(p)));
    }
    return roomScopedInputPatients.filter(p => !excludedInputPatientIds.has(patientIdOf(p)));
  }, [patients, inputMode, manualInputPatientIds, roomScopedInputPatients, excludedInputPatientIds]);
  const dischargePrintPatients = useMemo(
    () => selectedInputPatients.filter(patient => isDischargePrintPatientOnDates(patient, inputTargetDates)),
    [selectedInputPatients, inputTargetDatesKey],
  );
  const dischargePrintPatientsCount = dischargePrintPatients.length;

  const inputRoomPatientCounts = useMemo(() => {
    const counts = {};
    for (const room of rooms) counts[room] = patients.filter(p => patientRoom(p) === room).length;
    return counts;
  }, [patients, roomsKey]);
  const toggleInputRoom = useCallback((room) => {
    setSelectedInputRooms(prev => {
      const next = prev.includes(room) ? prev.filter(r => r !== room) : [...prev, room];
      return next.filter(r => rooms.includes(r)).sort((a, b) => rooms.indexOf(a) - rooms.indexOf(b));
    });
  }, [roomsKey]);
  const selectAllInputRooms = useCallback(() => setSelectedInputRooms(rooms), [roomsKey]);
  const clearInputRooms = useCallback(() => setSelectedInputRooms([]), []);
  const selectOnlyInputRoom = useCallback((room) => {
    if (!room || !rooms.includes(room)) return;
    setSelectedInputRooms([room]);
    setInputMode('rooms');
  }, [roomsKey]);
  const setInputModeSafe = useCallback((mode) => {
    setInputMode(mode === 'manual' ? 'manual' : 'rooms');
  }, []);
  const clearPatientInputScope = useCallback(() => {
    setManualInputPatientIds(new Set());
    setExcludedInputPatientIds(new Set());
  }, []);
  const toggleInputPatient = useCallback((patient) => {
    const id = patientIdOf(patient);
    if (!id) return;
    if (inputMode === 'manual') {
      setManualInputPatientIds(prev => {
        const next = new Set(prev);
        next.has(id) ? next.delete(id) : next.add(id);
        return next;
      });
      return;
    }
    setExcludedInputPatientIds(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }, [inputMode]);
  const isPatientInInputScope = useCallback((patient) => {
    const id = patientIdOf(patient);
    if (!id) return false;
    if (inputMode === 'manual') return manualInputPatientIds.has(id);
    const inRoomScope = !rooms.length || selectedInputRoomSet.has(patientRoom(patient));
    return inRoomScope && !excludedInputPatientIds.has(id);
  }, [inputMode, manualInputPatientIds, rooms.length, selectedInputRoomSet, excludedInputPatientIds]);

  useEffect(() => {
    if (lockedSubTab) {
      setSubTab(lockedSubTab);
      return;
    }
    api.getDataInfo()
      .then(info => {
        if (info?.processed?.exists) setSubTab('patients');
        else if (info?.sorted?.exists || info?.raw?.exists) setSubTab('board');
        else setSubTab('startup');
      })
      .catch(() => setSubTab('startup'));
  }, [lockedSubTab]);

  const loadPatients = useCallback(() => {
    setLoading(true);
    api.getPatients()
      .then(data => setAllPatients(Array.isArray(data) ? data : []))
      .catch(e => toast?.(String(e.message || 'Không tải được danh sách BN'), 'error'))
      .finally(() => setLoading(false));
  }, [toast]);

  useEffect(() => {
    if (subTab === 'patients') loadPatients();
  }, [subTab, loadPatients]);

  const handleUseSession = useCallback((item) => {
    setShowPicker(false);
    if (item.primary === 'processed') setSubTab('patients');
    else setSubTab('board');
  }, []);

  const handleFetchNew = useCallback(() => {
    setShowPicker(false);
    setSubTab('board');
  }, []);

  const handleBoardDone = useCallback(async () => {
    try {
      const r = await api.runPostprocess();
      if (r.status === 'ok') {
        toast?.(lockedSubTab === 'board' ? 'Xử lý xong! Có thể sang tab nhập liệu.' : 'Xử lý xong! Chuyển sang xem bệnh nhân.', 'ok');
        if (!lockedSubTab) setSubTab('patients');
      } else {
        toast?.(r.message, 'error');
      }
    } catch (e) {
      toast?.(String(e?.message || 'Không xử lý & phân loại được dữ liệu'), 'error');
    }
  }, [toast, lockedSubTab]);

  const handlePostprocess = useCallback(async () => {
    setRunning('process');
    try {
      const r = await api.runPostprocess();
      toast?.(r.status === 'ok' ? 'Xử lý xong!' : r.message, r.status);
      if (r.status === 'ok') loadPatients();
    } catch (e) {
      toast?.(String(e.message), 'error');
    } finally {
      setRunning(null);
    }
  }, [toast, loadPatients]);

  const ensureInputDataFresh = useCallback(async (targets, label, runningKey) => {
    setRunning(`check-${runningKey}`);
    setPrecheckReport(makePrecheckReport({
      status: 'running',
      message: `Đang kiểm tra y lệnh mới trước khi nhập ${label}...`,
    }, label, targets, 'running'));
    try {
      const r = await api.checkInputChanges(targets);
      const report = makePrecheckReport(r, label, targets);
      setPrecheckReport(report);
      if (r.status === 'changed') {
        toast?.(r.message || `Có thay đổi mới trước khi nhập ${label}. Đã cập nhật dữ liệu.`, 'info');
        await loadPatients();
        if (r.precheck_token) {
          // Chỉ tiền kiểm + cập nhật dữ liệu tại đây. Xác nhận duy nhất được
          // thực hiện ở confirmInputAction() ngay trước endpoint ghi EMR.
          await waitForUiPaint();
          return r;
        }
        toast?.(`Đã cập nhật dữ liệu mới. Vui lòng xem lại danh sách rồi bấm nhập ${label} lại một lần nữa.`, 'error');
        return null;
      }
      if (r.status !== 'ok') {
        setPrecheckReport(makePrecheckReport(r, label, targets, 'error'));
        toast?.(r.message || `Không kiểm tra được thay đổi trước khi nhập ${label}.`, 'error');
        return null;
      }
      return r;
    } catch (e) {
      const message = `Không kiểm tra được y lệnh mới trước khi nhập ${label}. Chưa nhập để tránh sai: ${String(e.message || e)}`;
      setPrecheckReport(makePrecheckReport({ status: 'error', message }, label, targets, 'error'));
      toast?.(message, 'error');
      return null;
    } finally {
      setRunning(null);
    }
  }, [toast, loadPatients]);

  const resolveInputDates = useCallback((selectedDate = null) => {
    if (selectedDate) return selectedDate;
    return inputTargetDates.length ? inputTargetDates : null;
  }, [inputTargetDatesKey]);

  const handleInputCare = useCallback(async (items, selectedDate = null, options = {}) => {
    if (!careInputEnabled) { toast?.('Module nhập chăm sóc đang tắt; các module khác vẫn dùng được.', 'error'); return; }
    if (running) { toast?.('Đang có tác vụ chạy, vui lòng chờ.', 'error'); return; }

    // Luồng chăm sóc hợp nhất: luôn đưa cả ngày đã đánh dấu done vào danh sách.
    // Worker sẽ kiểm tra trực tiếp trên EMR rồi quyết định PERFECT / UPDATE / MISSING.
    const targets = buildInputTargets(items, resolveInputDates(selectedDate), 'care', {
      includeDone: true,
      repairExisting: true,
      onlyDone: false,
    });
    if (Array.isArray(options.targetRooms)) targets.targetRooms = options.targetRooms;
    targets.inputMode = options.inputMode || (targets.targetRooms?.length ? 'rooms' : 'manual');
    targets.excludedPatientIds = Array.isArray(options.excludedPatientIds) ? options.excludedPatientIds : [];
    targets.excludedPatients = Array.isArray(options.excludedPatients) ? options.excludedPatients : [];
    targets.unifiedCare = true;
    targets.recheckExisting = true;
    targets.repairExisting = true;
    targets.includeDone = true;
    targets.onlyDone = false;
    // Đồng bộ trực tiếp: worker Selenium tự mở EMR, kiểm tra phiếu rồi nhập/sửa.
    // Không chạy details + post_process trước mỗi lần bấm nút.
    targets.directEmrSync = true;
    targets.visibleBrowser = true;

    if (!targets.patientIds.length) {
      toast?.('Không có BN/ngày cần chăm sóc trong phạm vi đang chọn.', 'error');
      return;
    }

    const precheck = await ensureInputDataFresh(targets, 'chăm sóc', 'care');
    if (!precheck?.precheck_token) return;
    targets.precheck_token = precheck.precheck_token;

    const okToRun = confirmInputAction(targets, 'chăm sóc — kiểm tra / nhập / sửa', precheck);
    if (!okToRun) {
      toast?.('Đã hủy kiểm tra/đồng bộ chăm sóc.', 'error');
      return;
    }

    // Hỏi giờ nhận máu theo từng BN/ngày để không áp nhầm sang ngày khác của cùng BN.
    const arr = Array.isArray(items) ? items : [items];
    const truyen_mau_times = {};
    for (const item of arr) {
      const id = patientIdOf(item);
      if (!id) continue;
      const targetDates = Array.isArray(targets.patientDates?.[id])
        ? targets.patientDates[id].map(x => String(x || '').trim()).filter(Boolean)
        : [];
      const datesForPrompt = targetDates.length ? targetDates : [''];
      for (const date of datesForPrompt) {
        const day = date ? (item?.day_map?.[date] || item) : item;
        if (!day?.cs_extra?.truyen_mau?.co_truyen_mau) continue;
        const ten = item.ho_ten || item.ma_bn || 'Bệnh nhân';
        const gio = window.prompt(
          `🩸 ${ten}${date ? ` ngày ${date}` : ''} có dự trù truyền máu.
` +
          `Nhập giờ nhận máu (HH:MM) — để trống nếu BN đi mổ hoặc chưa truyền:`
        );
        const rawTime = (gio || '').trim();
        const cleaned = normalizeClockTime(rawTime);
        if (rawTime && cleaned === null) {
          toast?.(`Giờ nhận máu không hợp lệ: "${rawTime}". Vui lòng nhập từ 00:00 đến 23:59. Chưa chạy nhập chăm sóc.`, 'error');
          return;
        }
        if (cleaned) {
          truyen_mau_times[date ? `${id}::${date}` : id] = cleaned;
        }
      }
    }
    if (Object.keys(truyen_mau_times).length > 0) {
      targets.truyen_mau_times = truyen_mau_times;
    }

    setRunning('care');
    try {
      const r = await api.runInputCare(targets);
      const ok = r.status === 'ok' || r.status === 'partial' || r.status === 'skipped';
      const message = r.status === 'ok'
        ? 'Đã kiểm tra và đồng bộ chăm sóc: phiếu đúng được giữ nguyên, phiếu thiếu đã được nhập, phiếu sai đã được sửa.'
        : (r.message || 'Đã hoàn tất kiểm tra/đồng bộ chăm sóc.');
      toast?.(message, r.status === 'skipped' ? 'info' : (ok ? 'ok' : 'error'));
      if (ok) await loadPatients();
    } catch (e) {
      toast?.(String(e.message), 'error');
    } finally {
      setRunning(null);
    }
  }, [running, toast, loadPatients, resolveInputDates, careInputEnabled, ensureInputDataFresh]);

  const handleInputInfusion = useCallback(async (items, selectedDate = null, options = {}) => {
    if (!infusionInputEnabled) { toast?.('Module nhập dịch truyền đang tắt; các module khác vẫn dùng được.', 'error'); return; }
    if (running) { toast?.('Đang có tác vụ chạy, vui lòng chờ.', 'error'); return; }

    // Luồng dịch truyền hợp nhất: luôn kiểm tra trực tiếp trên EMR, kể cả ngày đã done.
    // Worker tự quyết định: đúng -> bỏ qua; thiếu -> nhập; sai/thừa -> xóa dòng sai và nhập lại.
    const targets = buildInputTargets(items, resolveInputDates(selectedDate), 'infusion', {
      includeDone: true,
      repairExisting: true,
      onlyDone: false,
    });
    if (Array.isArray(options.targetRooms)) targets.targetRooms = options.targetRooms;
    targets.unifiedInfusions = true;
    targets.recheckExisting = true;
    targets.repairExisting = true;
    targets.includeDone = true;
    targets.onlyDone = false;
    targets.directEmrSync = true;
    targets.visibleBrowser = true;
    if (!targets.patientIds.length) {
      toast?.('Không có BN/ngày có dịch truyền cần kiểm tra trong phạm vi đang chọn.', 'error');
      return;
    }
    const precheck = await ensureInputDataFresh(targets, 'dịch truyền', 'infus');
    if (!precheck?.precheck_token) return;
    targets.precheck_token = precheck.precheck_token;
    const okToRun = confirmInputAction(targets, 'dịch truyền — kiểm tra / nhập / sửa', precheck);
    if (!okToRun) {
      toast?.('Đã hủy kiểm tra/đồng bộ dịch truyền.', 'error');
      return;
    }
    setRunning('infus');
    try {
      const r = await api.runInputInfusions(targets);
      const ok = r.status === 'ok' || r.status === 'partial' || r.status === 'skipped';
      const message = r.status === 'ok'
        ? 'Đã kiểm tra và đồng bộ dịch truyền: dòng đúng được giữ nguyên, dòng thiếu đã được nhập, dòng sai/thừa đã được sửa.'
        : (r.message || 'Đã hoàn tất kiểm tra/đồng bộ dịch truyền.');
      toast?.(message, r.status === 'skipped' ? 'info' : (ok ? 'ok' : 'error'));
      if (ok) await loadPatients();
    } catch (e) {
      toast?.(String(e.message), 'error');
    } finally {
      setRunning(null);
    }
  }, [running, toast, loadPatients, resolveInputDates, infusionInputEnabled, ensureInputDataFresh]);

  const handleInputProcedure = useCallback(async (items, selectedDate = null, options = {}) => {
    if (!procedureInputEnabled) { toast?.('Module nhập thủ thuật đang tắt; các module khác vẫn dùng được.', 'error'); return; }
    if (running) { toast?.('Đang có tác vụ chạy, vui lòng chờ.', 'error'); return; }

    // Luồng thủ thuật hợp nhất: ngày đã done vẫn được mở kiểm tra trên EMR.
    const targets = buildInputTargets(items, resolveInputDates(selectedDate), 'procedure', {
      includeDone: true,
      repairExisting: true,
      onlyDone: false,
    });
    if (Array.isArray(options.targetRooms)) targets.targetRooms = options.targetRooms;
    targets.unifiedProcedures = true;
    targets.recheckExisting = true;
    targets.repairExisting = true;
    targets.includeDone = true;
    targets.onlyDone = false;
    targets.directEmrSync = true;
    targets.visibleBrowser = true;
    if (!targets.patientIds.length) {
      toast?.('Không có BN/ngày có thủ thuật cần kiểm tra trong phạm vi đang chọn.', 'error');
      return;
    }
    const precheck = await ensureInputDataFresh(targets, 'thủ thuật', 'procedure');
    if (!precheck?.precheck_token) return;
    targets.precheck_token = precheck.precheck_token;
    if (!confirmInputAction(targets, 'thủ thuật — kiểm tra / nhập / sửa', precheck)) {
      toast?.('Đã hủy kiểm tra/đồng bộ thủ thuật.', 'error');
      return;
    }
    setRunning('procedure');
    try {
      const r = await api.runInputProcedures(targets);
      const ok = r.status === 'ok' || r.status === 'partial' || r.status === 'skipped';
      const message = r.status === 'ok'
        ? 'Đã kiểm tra và đồng bộ thủ thuật: phiếu đúng được giữ nguyên, phiếu chưa thực hiện đã được nhập, phiếu sai đã được thu hồi và cập nhật.'
        : (r.message || 'Đã hoàn tất kiểm tra/đồng bộ thủ thuật.');
      toast?.(
        message,
        r.status === 'skipped' ? 'info' : (ok ? 'ok' : 'error')
      );
      if (ok) await loadPatients();
    } catch (e) {
      toast?.(String(e.message), 'error');
    } finally {
      setRunning(null);
    }
  }, [running, toast, loadPatients, resolveInputDates, procedureInputEnabled, ensureInputDataFresh]);


  const handleRefreshDetailsOne = useCallback(async (patient, selectedDate = null) => {
    if (running) { toast?.('Đang có tác vụ chạy, vui lòng chờ.', 'error'); return; }
    const pid = patient?.ma_bn || patient?.id;
    if (!pid) { toast?.('Không xác định được mã bệnh nhân để cập nhật y lệnh.', 'error'); return; }
    const dateOptions = refreshDateOptions(selectedDate, workDateRange);
    setRunning('details-one');
    try {
      const r = await api.runDetailsOne(patient, dateOptions);
      const accepted = r.status === 'ok' || r.status === 'partial';
      toast?.(r.message || `Đã cập nhật y lệnh người bệnh (${dateOptions.label}).`, r.status === 'ok' ? 'ok' : (accepted ? 'info' : 'error'));
      if (accepted) await loadPatients();
    } catch (e) { toast?.(String(e.message), 'error'); }
    finally { setRunning(null); }
  }, [running, toast, loadPatients, workDateRange]);

  const handlePrintDischargeBundle = useCallback(async (patient, selectedDate = null) => {
    if (running) { toast?.('Đang có tác vụ chạy, vui lòng chờ.', 'error'); return; }
    const pid = patient?.ma_bn || patient?.id;
    if (!pid) { toast?.('Không xác định được mã bệnh nhân để tổng hợp file in.', 'error'); return; }
    const name = patient?.ho_ten || patient?.name || '';
    const selectedDates = (Array.isArray(selectedDate) ? selectedDate : [selectedDate || patient?.ngay_lam || '']).filter(Boolean);
    const dischargeDate = getMatchingDischargeDate(patient, selectedDates);
    if (!dischargeDate) {
      toast?.(`Người bệnh ${name || pid} không ra viện đúng ngày đang chọn. Hệ thống chưa in để tránh nhầm ca.`, 'error');
      return;
    }
    const dateTo = dischargeDate;
    const ok = typeof window === 'undefined' ? true : window.confirm(
      `TỔNG HỢP FILE IN RA VIỆN\n\n` +
      `Người bệnh: ${name || pid}\n` +
      `Mã BN: ${pid}\n` +
      `Ngày ra viện: ${dischargeDate}\n` +
      `Các phiếu sẽ lấy: Phiếu chăm sóc, Phiếu theo dõi truyền dịch, Phiếu chức năng sống vẽ.\n\n` +
      `Chỉ ca có ngày ra viện trùng ngày đang chọn mới được in.\n` +
      `Hệ thống sẽ gọi trực tiếp OnReportPdf(), lưu PDF vào thư mục in và ghép thành 1 file để in hai mặt. Không tự tải file về trình duyệt để tránh hiện hộp thoại Save As.\n\n` +
      `Tiếp tục?`
    );
    if (!ok) return;
    setRunning('print-discharge-bundle');
    try {
      const result = await api.printWard_DischargeBundle(pid, name, dateTo, dischargeDate);
      const failed = Array.isArray(result?.failures) ? result.failures.length : 0;
      const savedAt = result?.bundle_path || (result?.print_dir && result?.file_name ? `${result.print_dir}\\${result.file_name}` : '');
      const msg = savedAt
        ? `${result?.message || 'Đã tạo file tổng hợp in ra viện.'} Lưu tại: ${savedAt}`
        : (result?.message || 'Đã tạo file tổng hợp in ra viện trong thư mục in.');
      toast?.(msg, failed ? 'info' : 'ok');
    } catch (e) {
      toast?.(`Không tổng hợp được file in ra viện: ${String(e.message || e)}`, 'error');
    } finally {
      setRunning(null);
    }
  }, [running, toast]);

  const handlePrintDischargeBundleAll = useCallback(async () => {
    if (running) { toast?.('Đang có tác vụ chạy, vui lòng chờ.', 'error'); return; }
    const targets = dischargePrintPatients
      .map(p => {
        const dischargeDate = getMatchingDischargeDate(p, inputTargetDates);
        return {
          ma_bn: patientIdOf(p),
          ho_ten: p?.ho_ten || p?.name || '',
          so_phong: p?.so_phong || p?.room || p?.Vi_Tri || '',
          ngay_ra_vien: dischargeDate,
          ngay_ra_vien_date: dischargeDate,
        };
      })
      .filter(p => p.ma_bn && p.ngay_ra_vien_date);
    if (!targets.length) {
      toast?.('Không có bệnh xuất viện trong phạm vi đã chọn.', 'error');
      return;
    }
    const dateTo = workDateRangeToDmy(workDateRange)?.dateTo || '';
    const selectedDatesLabel = inputTargetDates.join(', ');
    const preview = targets.slice(0, 12).map((p, idx) => `${idx + 1}. ${p.ho_ten || p.ma_bn} (${p.ma_bn})`).join('\n');
    const more = targets.length > 12 ? `\n... và ${targets.length - 12} BN khác` : '';
    const ok = typeof window === 'undefined' ? true : window.confirm(
      `TỔNG HỢP FILE IN CHO TẤT CẢ BỆNH XUẤT VIỆN\n\n` +
      `Ngày ra viện được in: ${selectedDatesLabel || dateTo}\n` +
      `Số BN ra viện đúng ngày: ${targets.length}\n` +
      `${preview}${more}\n\n` +
      `Mỗi BN sẽ được tổng hợp riêng theo Hoàn tất → Đang thực hiện, sau đó ghép chung thành một file PDF. Nếu bộ của một BN lẻ trang sẽ chèn 1 trang trắng trước BN tiếp theo để in 2 mặt.\n\n` +
      `Tiếp tục?`
    );
    if (!ok) return;
    setRunning('print-discharge-bundle-all');
    try {
      const result = await api.printWard_DischargeBundleBatch(targets, dateTo, inputTargetDates);
      const failed = Number(result?.failed_count || 0);
      const savedAt = result?.bundle_path || (result?.print_dir && result?.file_name ? `${result.print_dir}\\${result.file_name}` : '');
      const msg = savedAt
        ? `${result?.message || 'Đã tạo file tổng hợp in chung.'} Lưu tại: ${savedAt}`
        : (result?.message || 'Đã tạo file tổng hợp in chung trong thư mục in.');
      toast?.(msg, failed ? 'info' : 'ok');
    } catch (e) {
      toast?.(`Không tổng hợp được file in chung: ${String(e.message || e)}`, 'error');
    } finally {
      setRunning(null);
    }
  }, [running, toast, dischargePrintPatients, workDateRange, inputTargetDatesKey]);

  const toolbarProps = lockedSubTab ? null : {
    subTab,
    isMobile,
    setSubTab,
    onShowPicker: () => setShowPicker(true),
  };

  const excludedPatientsForAudit = inputMode === 'rooms'
    ? patients
      .filter(patient => excludedInputPatientIds.has(patientIdOf(patient)))
      .map(patient => ({ id: patientIdOf(patient), name: patientNameOf(patient), room: patientRoom(patient) }))
    : [];
  const bulkTargetOptions = {
    targetRooms: inputMode === 'manual' ? [] : selectedInputRooms,
    inputMode,
    excludedPatientIds: excludedPatientsForAudit.map(patient => patient.id),
    excludedPatients: excludedPatientsForAudit,
  };

  const sharedViewProps = {
    patients, filtered, rooms, selRoom, selPx, setSelRoom, setSelPx,
    selectedInputRooms, selectedInputPatients, inputRoomPatientCounts,
    inputMode, manualInputPatientIds, excludedInputPatientIds,
    toggleInputRoom, selectAllInputRooms, selectOnlyInputRoom, clearInputRooms,
    setInputMode: setInputModeSafe, clearPatientInputScope, toggleInputPatient, isPatientInInputScope,
    bulkTargetOptions,
    stats, loading, running, showPicker, setShowPicker, toolbarProps,
    handlePostprocess, handleInputCare, handleInputInfusion, handleInputProcedure, handleRefreshDetailsOne, handlePrintDischargeBundle, handlePrintDischargeBundleAll,
    dischargePrintPatientsCount,
    handleUseSession, handleFetchNew, toast, workflowTitle, workflowHint, workDateRange,
    precheckReport, onClearPrecheckReport: () => setPrecheckReport(null),
    featureAvailability, disabledFeatureLabels,
    scopeInfo: mode === 'duty'
      ? `Hiển thị ${patients.length} người bệnh có ngày thuộc người trực trong khoảng đã chọn${unknownScopeCount ? `; ${unknownScopeCount} người bệnh có ngày cần xem phân luồng.` : '.'}`
      : mode === 'ward'
        ? `Chỉ giữ các ngày thuộc bệnh phòng; đã tách ngày trực của ${dutyCount} người bệnh${unknownScopeCount ? ` và ngày chưa đủ dữ liệu của ${unknownScopeCount} người bệnh` : ''}. Hiện ${patients.length} người bệnh.`
        : (unknownScopeCount ? `Có ${unknownScopeCount} ca cần xem phân luồng trước khi nhập hàng loạt.` : ''),
  };

  if (subTab === null) return <LoadingState />;

  if (subTab === 'startup') {
    return (
      <StartupState
        showPicker={showPicker}
        setShowPicker={setShowPicker}
        handleUseSession={handleUseSession}
        handleFetchNew={handleFetchNew}
        toast={toast}
        setSubTab={setSubTab}
      />
    );
  }

  if (subTab === 'board') {
    return (
      <BoardView
        toolbarProps={toolbarProps}
        toast={toast}
        showPicker={showPicker}
        setShowPicker={setShowPicker}
        handleUseSession={handleUseSession}
        handleFetchNew={handleFetchNew}
        handleBoardDone={handleBoardDone}
        workDateRange={workDateRange}
        setWorkDateRange={setWorkDateRange}
      />
    );
  }

  if (isMobile) return <ShiftMobileView {...sharedViewProps} />;
  return <ShiftDesktopView {...sharedViewProps} />;
}
