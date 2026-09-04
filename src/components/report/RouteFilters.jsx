import { C } from '../../tokens.js';
import { COMMON_SLOT_MIN_PATIENTS, patientKey, isSeparatedHour, timeToMinutes } from './reportUtils.js';
import { Chip } from './ReportShared.jsx';

function RouteFilterStrip({ options, selectedRoutes, onToggle, onClear }) {
  if (!options.length) return null;
  const selected = Array.isArray(selectedRoutes) ? selectedRoutes : [];
  const isAll = !selected.length;
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 10, alignItems: 'center' }}>
      <span style={{ color: C.text3, fontSize: 11 }}>Đường dùng</span>
      <Chip active={isAll} onClick={onClear} title="Hiện tất cả đường dùng đang có trong phiếu">Tất cả</Chip>
      {options.map(item => (
        <Chip
          key={item.route}
          active={selected.includes(item.route)}
          onClick={() => onToggle(item.route)}
          title={`Bấm để ${selected.includes(item.route) ? 'bỏ chọn' : 'chọn'} ${item.route}`}
        >
          {item.route} ({item.count})
        </Chip>
      ))}
    </div>
  );
}

function medicationTimeOverview(rows) {
  const byTime = new Map();
  for (const row of rows || []) {
    if (!row?.time) continue;
    if (!byTime.has(row.time)) byTime.set(row.time, { time: row.time, patients: new Set(), separated: false });
    const item = byTime.get(row.time);
    const pk = patientKey(row);
    if (pk) item.patients.add(pk);
    if (isSeparatedHour(row)) item.separated = true;
  }
  const common = [...byTime.values()]
    .filter(x => x.patients.size >= COMMON_SLOT_MIN_PATIENTS)
    .sort((a, b) => timeToMinutes(a.time) - timeToMinutes(b.time))
    .map(x => x.time);
  const separated = [...byTime.values()]
    .filter(x => x.separated && x.patients.size < COMMON_SLOT_MIN_PATIENTS)
    .sort((a, b) => timeToMinutes(a.time) - timeToMinutes(b.time))
    .map(x => x.time);
  return { common, separated };
}

function MedicationTimeSummary({ rows }) {
  const { common, separated } = medicationTimeOverview(rows);
  if (!common.length && !separated.length) return null;
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 10, alignItems: 'center' }}>
      {common.length > 0 && (
        <>
          <span style={{ color: C.text3, fontSize: 11 }}>Giờ thuốc chung</span>
          {common.slice(0, 10).map(t => <span key={`common-${t}`} style={{ color: C.blue, background: C.blueBg, border: `1px solid ${C.blueBorder}`, borderRadius: 4, padding: '3px 8px', fontSize: 11, fontWeight: 700 }}>{t}</span>)}
        </>
      )}
      {separated.length > 0 && (
        <>
          <span style={{ color: C.text3, fontSize: 11, marginLeft: common.length ? 8 : 0 }}>Giờ riêng cần nhớ</span>
          {separated.slice(0, 10).map(t => <span key={`sep-${t}`} style={{ color: C.amber, background: C.amberBg, border: `1px solid ${C.amberBorder}`, borderRadius: 4, padding: '3px 8px', fontSize: 11, fontWeight: 700 }}>{t}</span>)}
        </>
      )}
    </div>
  );
}

export { RouteFilterStrip, MedicationTimeSummary };
