import { useEffect, useMemo, useState } from 'react';
import { IconPrinter, IconRefresh } from '@tabler/icons-react';
import { C, FS } from '../tokens.js';
import { Btn, Segmented, Spinner } from './shared.jsx';
import * as api from '../api.js';
import { inputDateToDmy } from '../utils/workDateRange.js';
import { getPatientWorkflowDates, scopePatientToDates } from '../utils/patientScope.js';
import {
  GROUP_ORDER, todayDmy, parseDmy, addDaysDmy,
  collectDrugRows, routeCounts, summarize, isOddHour,
} from './report/reportUtils.js';
import { SelectBox, SummaryTable, DutyReport } from './report/ReportSections.jsx';

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
  // Toàn bộ thuốc theo y lệnh ngày mai: người trực cần cữ sáng mai và thuốc uống ngày mai khi mai là ngày nghỉ.
  const rawNextDayRows = useMemo(() => {
    if (!nextDate) return [];
    return collectDrugRows(nextWardPatients, nextDate);
  }, [nextWardPatients, nextDate]);

  // Giờ vào khoa của từng người bệnh, để biết ai mới vào trong tua trực.
  const admissions = useMemo(() => {
    const out = {};
    for (const patient of wardPatients) {
      const key = String(patient?.ma_bn || '').trim();
      const value = patient?.day_map?.[date]?.thoi_gian_vao_khoa || patient?.thoi_gian_vao_khoa || patient?.tg_vao || patient?.admission_time;
      if (key && value) out[key] = String(value);
    }
    return out;
  }, [wardPatients, date]);

  const routeOptions = useMemo(() => routeCounts([...allRows, ...rawNextDayRows]), [allRows, rawNextDayRows]);

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

  const nextDayRows = useMemo(() => {
    if (!selectedRoutes.length) return rawNextDayRows;
    return rawNextDayRows.filter(row => selectedRoutes.includes(row.route));
  }, [rawNextDayRows, selectedRoutes]);

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
      <div style={{ padding: '10px 12px', borderBottom: `1px solid ${C.border2}`, background: C.surface, display: 'grid', gap: 8 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: FS.sm, color: C.text2 }}>
            Ngày
            <SelectBox label="Ngày báo cáo" value={date} onChange={setDate}>
              {availableDates.length ? availableDates.map(d => <option key={d} value={d}>{d}</option>) : <option value={date}>{date}</option>}
            </SelectBox>
          </label>
          <Segmented
            label="Kiểu xem"
            value={view}
            onChange={setView}
            options={[{ value: 'duty', label: 'Phiếu bàn giao ca' }, { value: 'summary', label: 'Thống kê số lượng' }]}
          />
          <span style={{ flex: '1 1 0' }} />
          <Btn icon={IconRefresh} loading={loading} onClick={load} disabled={loading}>Tải lại</Btn>
          <Btn variant="solidPrimary" icon={IconPrinter} loading={printing} onClick={handlePrintReport} disabled={loading || printing || !allRows.length}>
            {printing ? 'Đang tạo phiếu…' : 'In phiếu'}
          </Btn>
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '2px 14px', color: C.text2, fontSize: FS.sm }}>
          <span><b style={{ color: C.text, fontVariantNumeric: 'tabular-nums' }}>{uniquePatients}</b> người bệnh</span>
          <span><b style={{ color: C.text, fontVariantNumeric: 'tabular-nums' }}>{filteredRows.length}</b> dòng thuốc</span>
          <span>{routeSummary}</span>
          {oddRowsCount > 0 && <span style={{ color: C.amber, fontWeight: 600 }}>{oddRowsCount} dòng giờ riêng</span>}
          <span style={{ color: C.text2, fontSize: FS.xs }}>Dữ liệu từ Nhập bệnh phòng; màn này chỉ lọc, nhóm và in.</span>
        </div>
      </div>

      <div style={{ flex: 1, overflow: 'auto', padding: 12 }}>
        {loading ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: C.text2 }}><Spinner /> Đang tải dữ liệu…</div>
        ) : !allRows.length ? (
          <div style={{ color: C.text2, fontSize: FS.md, padding: 20, background: C.surface, border: `1px solid ${C.border2}`, borderRadius: 7 }}>
            Chưa có thuốc trong ngày đã chọn. Vào <b>Lấy dữ liệu</b> để quét, lấy chi tiết và xử lý trước.
          </div>
        ) : view === 'summary' ? (
          <SummaryTable rows={total} />
        ) : (
          <DutyReport
            date={date}
            rows={routeFilteredRows}
            nextDayRows={nextDayRows}
            admissions={admissions}
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
