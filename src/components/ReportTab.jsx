import { useEffect, useMemo, useState } from 'react';
import { C } from '../tokens.js';
import { Btn, Spinner } from './shared.jsx';
import * as api from '../api.js';
import { inputDateToDmy } from '../utils/workDateRange.js';
import { getPatientWorkflowDates, scopePatientToDates } from '../utils/patientScope.js';
import {
  ROUTE_FILTERS, TIME_GROUPS, GROUP_ORDER,
  todayDmy, parseDmy, addDaysDmy,
  getDaySchedule, dayTypeOf, collectDrugRows, collectOralDispenseData,
  routeCounts, summarize, isMorningRow, isOddHour,
} from './report/reportUtils.js';
import {
  Chip,
  SelectBox,
  StatCard,
  SummaryTable,
  DutyReport,
  DetailByGroup,
  DrugTable,
  EmptyFilter,
} from './report/ReportSections.jsx';

export default function ReportTab({ toast, workDateRange }) {
  const [patients, setPatients] = useState([]);
  const [nurseState, setNurseState] = useState({ roster: [], schedule: {} });
  const [loading, setLoading] = useState(false);
  const [date, setDate] = useState(() => inputDateToDmy(workDateRange?.from) || todayDmy());
  const [view, setView] = useState('duty');
  const [selectedRoutes, setSelectedRoutes] = useState([]);
  const [printing, setPrinting] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      const [data, nurseCfg] = await Promise.all([
        api.getPatients(),
        api.getNurseSettings().catch(() => ({ roster: [], schedule: {} })),
      ]);
      setPatients(Array.isArray(data) ? data : []);
      setNurseState({ roster: nurseCfg?.roster || [], schedule: nurseCfg?.schedule || {} });
    } catch (e) {
      toast?.(String(e.message || e), 'error');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const availableDates = useMemo(() => {
    const set = new Set();
    for (const patient of patients || []) {
      for (const d of getPatientWorkflowDates(patient, [], 'ward')) if (d) set.add(d);
    }
    return [...set].sort((a, b) => (parseDmy(b) || 0) - (parseDmy(a) || 0));
  }, [patients]);

  useEffect(() => {
    if (availableDates.length && !availableDates.includes(date)) setDate(availableDates[0]);
  }, [availableDates, date]);

  const wardPatients = useMemo(() => {
    return (patients || []).map(patient => {
      const dates = getPatientWorkflowDates(patient, [date], 'ward');
      return dates.length ? scopePatientToDates(patient, dates) : null;
    }).filter(Boolean);
  }, [patients, date]);

  const allRows = useMemo(() => collectDrugRows(wardPatients, date), [wardPatients, date]);

  const nextDate = useMemo(() => addDaysDmy(date, 1), [date]);
  const nextWardPatients = useMemo(() => {
    if (!nextDate) return [];
    return (patients || []).map(patient => {
      const dates = getPatientWorkflowDates(patient, [nextDate], 'ward');
      return dates.length ? scopePatientToDates(patient, dates) : null;
    }).filter(Boolean);
  }, [patients, nextDate]);
  const rawNextMorningRows = useMemo(() => {
    if (!nextDate) return [];
    return collectDrugRows(nextWardPatients, nextDate).filter(row => isMorningRow(row, nextDate));
  }, [nextWardPatients, nextDate]);

  const routeOptions = useMemo(() => routeCounts([...allRows, ...rawNextMorningRows]), [allRows, rawNextMorningRows]);

  useEffect(() => {
    if (!selectedRoutes.length) return;
    const available = new Set(routeOptions.map(x => x.route));
    setSelectedRoutes(prev => {
      const next = prev.filter(route => available.has(route));
      return next.length === prev.length ? prev : next;
    });
  }, [routeOptions, selectedRoutes.length]);

  const filteredRows = useMemo(() => {
    if (!selectedRoutes.length) return allRows;
    return allRows.filter(row => selectedRoutes.includes(row.route));
  }, [allRows, selectedRoutes]);

  const nextMorningRows = useMemo(() => {
    if (!selectedRoutes.length) return rawNextMorningRows;
    return rawNextMorningRows.filter(row => selectedRoutes.includes(row.route));
  }, [rawNextMorningRows, selectedRoutes]);

  const routeFilteredRows = filteredRows;

  const total = useMemo(() => summarize(filteredRows), [filteredRows]);

  const groupedRows = useMemo(() => {
    const map = new Map();
    for (const row of filteredRows) {
      if (!map.has(row.timeGroup)) map.set(row.timeGroup, []);
      map.get(row.timeGroup).push(row);
    }
    return [...map.entries()].sort((a, b) => (GROUP_ORDER[a[0]] || 99) - (GROUP_ORDER[b[0]] || 99));
  }, [filteredRows]);


  const toggleRoute = route => {
    setSelectedRoutes(prev => prev.includes(route) ? prev.filter(x => x !== route) : [...prev, route]);
  };

  const clearRouteSelection = () => setSelectedRoutes([]);

  const handlePrintReport = async () => {
    setPrinting(true);
    try {
      const url = await api.reportUrl({ date, rows: routeFilteredRows, source: 'ward', start: 0, end: 23, no0: false });
      const a = document.createElement('a');
      a.href = url;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      document.body.appendChild(a);
      a.click();
      a.remove();
      toast?.('Đã mở phiếu PDF để in.', 'success');
    } catch (e) {
      toast?.(String(e.message || e), 'error');
    } finally {
      setPrinting(false);
    }
  };

  const uniquePatients = new Set(filteredRows.map(x => x.patientId || x.patientName)).size;
  const uniqueDrugTypes = total.length;
  const oddRowsCount = filteredRows.filter(isOddHour).length;
  const routeSummary = selectedRoutes.length ? `Đang lọc: ${selectedRoutes.join(' + ')}` : ([...new Set(filteredRows.map(x => x.route).filter(Boolean))].join(' · ') || '—');

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
      <div style={{ padding: '10px 12px 8px', borderBottom: `1px solid ${C.border}`, background: C.surface }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
          <div>
            <div style={{ fontWeight: 700, color: C.text }}>Bảng thuốc ca trực</div>
            <div style={{ color: C.text3, fontSize: 11 }}>Dữ liệu lấy trực tiếp từ phạm vi Nhập bệnh phòng; báo cáo chỉ lọc, nhóm và in.</div>
          </div>
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
            <Btn variant="primary" onClick={handlePrintReport} disabled={loading || printing || !allRows.length}>
              {printing ? 'Đang tạo phiếu...' : '🖨 In phiếu'}
            </Btn>
            <Btn onClick={load} disabled={loading}>{loading ? 'Đang tải...' : '↻ Tải lại'}</Btn>
          </div>
        </div>

        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, marginBottom: 8, color: C.text2, fontSize: 12 }}>
          <span>Ngày đang xem: <b style={{ color: C.text }}>{date}</b></span>
          <span style={{ color: C.text3 }}>•</span>
          <span><b style={{ color: C.text }}>{uniquePatients}</b> người bệnh</span>
          <span style={{ color: C.text3 }}>•</span>
          <span><b style={{ color: C.text }}>{filteredRows.length}</b> dòng thuốc</span>
          <span style={{ color: C.text3 }}>•</span>
          <span>{routeSummary}</span>
          {oddRowsCount > 0 && <span style={{ color: C.amber, border: `1px solid ${C.amberBorder}`, background: C.amberBg, borderRadius: 4, padding: '2px 6px' }}>Giờ riêng: {oddRowsCount}</span>}
        </div>

        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8 }}>
          <div style={{ color: C.text3, fontSize: 11 }}>Ngày</div>
          <SelectBox value={date} onChange={setDate}>
            {availableDates.length ? availableDates.map(d => <option key={d} value={d}>{d}</option>) : <option value={date}>{date}</option>}
          </SelectBox>

          <div style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
            <Chip active={view === 'duty'} onClick={() => setView('duty')}>Phiếu bàn giao ca</Chip>
            <Chip active={view === 'summary'} onClick={() => setView('summary')}>Thống kê số lượng</Chip>
          </div>
        </div>
      </div>

      <div style={{ flex: 1, overflow: 'auto', padding: 16 }}>
        {loading ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: C.text2 }}><Spinner /> Đang tải dữ liệu...</div>
        ) : !allRows.length ? (
          <div style={{ color: C.text2, padding: 20, border: `1px dashed ${C.border}`, borderRadius: 8 }}>
            Chưa có thuốc trong ngày đã chọn. Hãy lấy dữ liệu / post-process trước.
          </div>
        ) : view === 'summary' ? (
          <SummaryTable rows={total} />
        ) : (
          <DutyReport
            date={date}
            rows={routeFilteredRows}
            nextMorningRows={nextMorningRows}
            nurseState={nurseState}
            routeOptions={routeOptions}
            selectedRoutes={selectedRoutes}
            onToggleRoute={toggleRoute}
            onClearRoutes={clearRouteSelection}
          />
        )}
      </div>
    </div>
  );
}
