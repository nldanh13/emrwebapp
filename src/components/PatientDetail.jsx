import {
  IconAlertTriangle, IconCheck, IconClockHour4, IconFileText, IconPlus, IconPrinter, IconRefresh, IconX,
} from '@tabler/icons-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { C, FS, STATUS } from '../tokens.js';
import { Btn, Dot, Spinner } from './shared.jsx';
import useIsMobile from '../hooks/useIsMobile.js';
import * as api from '../api.js';
import PatientTimeline from './patient/PatientTimeline.jsx';
import PatientPreview from './patient/PatientPreview.jsx';
import InfusionEditPanel from './patient/InfusionEditPanel.jsx';
import PatientLogModal from './patient/PatientLogModal.jsx';
import { getPatientNotices, PatientNoticePills } from './patientStatusNotice.jsx';
import { isDischargePrintPatientOnDates } from '../utils/dischargePrint.js';
import { wardVtytItems, manualVtytKey } from '../utils/patientScope.js';


function getWardAdmissionTime(patient, activeDay = {}) {
  return String(activeDay?.thoi_gian_vao_khoa ?? activeDay?.tg_vao ?? patient?.thoi_gian_vao_khoa ?? patient?.tg_vao ?? patient?.admission_time ?? '').trim();
}

function getDepartmentName(patient, activeDay = {}) {
  return String(activeDay?.ten_khoa_dieu_tri ?? activeDay?.khoa_dieu_tri ?? activeDay?.khoa_chuyen_den ?? patient?.ten_khoa_dieu_tri ?? patient?.khoa_dieu_tri ?? patient?.khoa_chuyen_den ?? patient?.department_name ?? patient?.department ?? '').trim();
}

function getWardHistory(patient, activeDay = {}) {
  const direct = activeDay?.lich_su_khoa_dieu_tri || activeDay?.ward_admissions || patient?.lich_su_khoa_dieu_tri || patient?.ward_admissions;
  return Array.isArray(direct) ? direct.filter(Boolean) : [];
}

function getAvailableDates(patient) {
  if (Array.isArray(patient.available_dates) && patient.available_dates.length) return patient.available_dates;
  return [patient.ngay_lam].filter(Boolean);
}

function getActiveDay(patient, activeDate, availableDates) {
  return (patient.day_map && patient.day_map[activeDate])
    || (patient.day_map && patient.day_map[availableDates[0]])
    || {
      timeline: patient.tl || patient.timeline || [],
      preview: patient.preview || {},
      thuoc: patient.thuoc,
      ncs: patient.ncs,
      cs_extra: patient.cs_extra,
      care_done: patient.care_done,
      infus_done: patient.infus_done,
      has_infusion: patient.has_inf || patient.has_infusion,
      has_procedure: patient.has_procedure || false,
      procedure_done: patient.procedure_done || false,
      procedure_stale: patient.procedure_stale || false,
      vtyt: patient.vtyt || { items: [] },
      vtyt_done: patient.vtyt_done || false,
      vtyt_stale: patient.vtyt_stale || false,
      raw_order_events: patient.raw_order_events || [],
      unparsed_orders: patient.unparsed_orders || [],
      processing_warnings: patient.processing_warnings || [],
      care_special_events: patient.care_special_events || [],
      care_mode: patient.care_mode || '',
      xu_tri: patient.xu_tri || '',
      ngay_ra_vien: patient.ngay_ra_vien || '',
      gio_ra_vien: patient.gio_ra_vien || '',
      ngay_ra_vien_date: patient.ngay_ra_vien_date || '',
      ra_vien_hom_nay: patient.ra_vien_hom_nay || false,
      surgery_out: patient.surgery_out || false,
      surgery_out_time: patient.surgery_out_time || '',
      surgery_out_reason: patient.surgery_out_reason || '',
      lich_su_khoa_dieu_tri: patient.lich_su_khoa_dieu_tri || [],
    };
}

const DETAIL_TABS = [
  { id: 'timeline', label: 'Timeline y lệnh' },
  { id: 'preview', label: 'Xem trước khi nhập' },
  { id: 'meds', label: 'Sửa dịch truyền', needsInfusion: true },
  { id: 'raw', label: 'Y lệnh gốc' },
];

// Chip tiến độ: "Chăm sóc: 1/2", "Dịch truyền: YL mới 1"…
function ProgressChip({ label, tone = 'gray' }) {
  const tones = {
    green: [C.green, C.greenBg, C.greenBorder],
    amber: [C.amber, C.amberBg, C.amberBorder],
    red: [C.red, C.redBg, C.redBorder],
    gray: [C.text2, C.surface2, C.border2],
  };
  const [fg, bg, border] = tones[tone] || tones.gray;
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '0 8px', lineHeight: '22px', borderRadius: 4, fontSize: FS.xs, fontWeight: 600, color: fg, background: bg, border: `1px solid ${border}`, whiteSpace: 'nowrap' }}>
      {tone === 'green' && <IconCheck size={13} stroke={2.2} aria-hidden="true" />}
      {tone === 'red' && <IconAlertTriangle size={13} stroke={2} aria-hidden="true" />}
      {label}
    </span>
  );
}

function PatientHeader({ patient, activeDay, status, subTab, setSubTab, availableDates, activeDate, setActiveDate, progress = [], hasInfusionAny, onClose, showClose = true }) {
  const p = patient;
  const notices = getPatientNotices(p, activeDay);
  const admissionTime = getWardAdmissionTime(p, activeDay);
  const departmentName = getDepartmentName(p, activeDay);
  const wardHistory = getWardHistory(p, activeDay);
  const room = p.so_phong || p.room;
  const metaLine = [
    p.chan_doan || p.dx || p.diagnosis,
    p.bac_si || p.doc,
    [p.bed && `Giường ${p.bed}`, room && `Phòng ${room}`].filter(Boolean).join(' / '),
  ].filter(Boolean).join(' · ');
  const tabs = DETAIL_TABS.filter(t => !t.needsInfusion || hasInfusionAny);
  return (
    <div style={{ padding: '12px 16px 0', borderBottom: `1px solid ${C.border}`, background: C.surface, flexShrink: 0 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8 }}>
        <div style={{ minWidth: 0 }}>
          <PatientNoticePills notices={notices} />
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <Dot color={status.border} size={9} />
            <h2 style={{ margin: 0, fontWeight: 700, fontSize: FS.xl, color: C.text }}>{p.ho_ten || p.name}</h2>
            <span style={{ fontSize: FS.sm, color: C.text2, fontVariantNumeric: 'tabular-nums' }}>{p.ma_bn || p.id}</span>
          </div>
          {metaLine && <div style={{ fontSize: FS.md, color: C.text2, marginTop: 3 }}>{metaLine}</div>}
          {(admissionTime || departmentName) && (
            <div style={{ fontSize: FS.xs, color: C.text2, marginTop: 3, display: 'flex', gap: '2px 12px', flexWrap: 'wrap' }}>
              {admissionTime && <span>Vào khoa <span style={{ fontVariantNumeric: 'tabular-nums' }}>{admissionTime}</span></span>}
              {departmentName && <span>{departmentName}</span>}
            </div>
          )}
          {wardHistory.length > 1 && (
            <details style={{ marginTop: 4, fontSize: FS.xs, color: C.text2 }}>
              <summary style={{ cursor: 'pointer' }}>Lịch sử khoa điều trị ({wardHistory.length} mốc)</summary>
              <div style={{ marginTop: 4, display: 'flex', flexDirection: 'column', gap: 2 }}>
                {wardHistory.map((w, idx) => (
                  <div key={`${w.thu_tu || idx}-${w.thoi_gian_vao_khoa || idx}`}>
                    <span style={{ fontVariantNumeric: 'tabular-nums' }}>{w.thoi_gian_vao_khoa || '—'}</span> · {w.ten_khoa_dieu_tri || w.khoa_dieu_tri || 'Không rõ khoa'}
                  </div>
                ))}
              </div>
            </details>
          )}
        </div>
        {showClose && <button type="button" className="emr-icon-btn" onClick={onClose} aria-label="Đóng chi tiết người bệnh" title="Đóng"><IconX size={18} stroke={1.75} /></button>}
      </div>

      {(progress.length > 0 || availableDates.length > 0) && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 10, flexWrap: 'wrap' }}>
          {availableDates.length > 0 && (
            <div role="group" aria-label="Ngày y lệnh" style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginRight: 6 }}>
              {availableDates.map(date => {
                const dayInfo = p.day_map?.[date] || {};
                const active = date === activeDate;
                const stale = dayInfo.care_stale || dayInfo.infus_stale || dayInfo.procedure_stale;
                const started = dayInfo.care_done || dayInfo.infus_done || dayInfo.procedure_done;
                const done = started && dayInfo.status === 'green';
                return (
                  <button type="button" key={date} aria-pressed={active} onClick={() => setActiveDate(date)} title={stale ? 'Có y lệnh mới sau lần nhập trước' : (done ? 'Đã nhập xong' : (started ? 'Đã nhập một phần' : 'Chưa nhập'))} style={{
                    display: 'inline-flex', alignItems: 'center', gap: 4, height: 28, padding: '0 9px', borderRadius: 5, border: '1px solid',
                    fontSize: FS.sm, cursor: 'pointer', fontFamily: 'inherit', fontVariantNumeric: 'tabular-nums',
                    borderColor: active ? C.blueBorder : C.border,
                    background: active ? C.blueBg : C.surface,
                    color: active ? C.blue : C.text2, fontWeight: active ? 650 : 500,
                  }}>
                    {date}
                    {stale
                      ? <span style={{ color: C.amber, fontWeight: 600 }}>· YL mới</span>
                      : done ? <IconCheck size={14} stroke={2.2} color={C.green} aria-hidden="true" />
                        : started ? <IconClockHour4 size={14} stroke={1.9} color={C.amber} aria-hidden="true" /> : null}
                  </button>
                );
              })}
            </div>
          )}
          {progress.map(item => <ProgressChip key={item.label} label={item.label} tone={item.tone} />)}
        </div>
      )}

      <div role="tablist" aria-label="Nội dung chi tiết" className="emr-hscroll" style={{ display: 'flex', gap: 2, marginTop: 8, overflowX: 'auto' }}>
        {tabs.map(t => {
          const active = subTab === t.id;
          return (
            <button type="button" role="tab" aria-selected={active} key={t.id} onClick={() => setSubTab(t.id)} style={{
              flexShrink: 0, height: 38, padding: '0 10px', border: 0, borderBottom: `2px solid ${active ? C.blue : 'transparent'}`, marginBottom: -1,
              background: 'transparent', color: active ? C.blue : C.text2, fontSize: FS.sm, fontWeight: active ? 650 : 550,
              cursor: 'pointer', fontFamily: 'inherit', whiteSpace: 'nowrap',
            }}>{t.label}</button>
          );
        })}
      </div>
    </div>
  );
}

const TIME_CELL = { fontVariantNumeric: 'tabular-nums', fontWeight: 600, color: C.text };

function RawOrdersPanel({ patientDay = {} }) {
  const warnings = Array.isArray(patientDay.processing_warnings) ? patientDay.processing_warnings : [];
  const unparsed = Array.isArray(patientDay.unparsed_orders) ? patientDay.unparsed_orders : [];
  const events = Array.isArray(patientDay.raw_order_events) ? patientDay.raw_order_events : [];

  if (!warnings.length && !unparsed.length && !events.length) {
    return <div style={{ fontSize: FS.md, color: C.text2 }}>Chưa có y lệnh gốc hoặc cảnh báo để hiển thị.</div>;
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {warnings.length > 0 && (
        <section style={{ border: `1px solid ${C.amberBorder}`, background: C.amberBg, borderRadius: 7, padding: '10px 12px' }}>
          <h3 style={{ margin: '0 0 6px', display: 'flex', alignItems: 'center', gap: 6, fontSize: FS.md, fontWeight: 700, color: C.amber }}>
            <IconAlertTriangle size={16} stroke={1.9} aria-hidden="true" /> Cảnh báo cần kiểm tra
          </h3>
          {warnings.map((w, i) => (
            <div key={`${w.code || 'warn'}-${i}`} style={{ fontSize: FS.sm, color: C.text, marginTop: i ? 4 : 0 }}>
              <span style={TIME_CELL}>{w.gio_y_lenh || '—'}</span> · {w.message || w.code}
            </div>
          ))}
        </section>
      )}

      {unparsed.length > 0 && (
        <section style={{ border: `1px solid ${C.redBorder}`, background: C.redBg, borderRadius: 7, padding: '10px 12px' }}>
          <h3 style={{ margin: '0 0 6px', fontSize: FS.md, fontWeight: 700, color: C.red }}>Y lệnh chưa phân loại</h3>
          {unparsed.map((u, i) => (
            <div key={`${u.ten_thuoc || 'raw'}-${i}`} style={{ fontSize: FS.sm, color: C.text, marginTop: i ? 4 : 0 }}>
              <span style={TIME_CELL}>{u.gio_y_lenh || '—'}</span> · {u.ten_thuoc || u.raw || 'Không rõ'}
              {u.reason && <span style={{ color: C.text2 }}> · {u.reason}</span>}
            </div>
          ))}
        </section>
      )}

      <section style={{ border: `1px solid ${C.border}`, borderRadius: 7, overflow: 'hidden', background: C.surface }}>
        <h3 style={{ margin: 0, padding: '8px 12px', background: C.surface2, fontSize: FS.md, fontWeight: 700, color: C.text }}>Y lệnh gốc</h3>
        <div style={{ padding: '8px 12px', display: 'flex', flexDirection: 'column', gap: 6 }}>
          {events.map((e, i) => (
            <div key={`${e.line_no || i}-${e.text}`} style={{ fontSize: FS.sm, color: C.text2, display: 'grid', gridTemplateColumns: '48px 72px minmax(0, 1fr)', gap: 8 }}>
              <span style={TIME_CELL}>{e.gio_y_lenh || '—'}</span>
              <span>{e.kind || 'raw'}</span>
              <span style={{ color: C.text }}>{e.text}</span>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

// Nhóm thao tác có nhãn: "Chăm sóc", "Dịch truyền"…
function ActionGroup({ label, children }) {
  return (
    <div role="group" aria-label={label} style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
      <span style={{ fontSize: FS.xs, fontWeight: 650, color: C.text2, whiteSpace: 'nowrap' }}>{label}</span>
      {children}
    </div>
  );
}

// Ô chọn VTYT lẻ (từ danh mục VTYT) cho ngày đang xem; nhập cùng lượt VTYT.
function VtytLePicker({ busy, onPicksChange }) {
  const [catalog, setCatalog] = useState([]);
  const [open, setOpen] = useState(false);
  const [key, setKey] = useState('');
  const [qty, setQty] = useState('1');
  const [picks, setPicks] = useState([]);

  useEffect(() => { onPicksChange?.(picks); }, [picks, onPicksChange]);
  useEffect(() => {
    if (!open || catalog.length) return;
    api.getVtytCatalog()
      .then(r => setCatalog((r.items || []).filter(i => !i.disabled)))
      .catch(() => setCatalog([]));
  }, [open, catalog.length]);

  const nameOf = k => catalog.find(i => i.key === k)?.name || k;
  const add = () => {
    const n = Number(String(qty).replace(',', '.'));
    if (!key || !(n > 0)) return;
    setPicks(prev => {
      const rest = prev.filter(p => p.key !== key);
      const cur = prev.find(p => p.key === key);
      return [...rest, { key, qty: (cur?.qty || 0) + n }];
    });
    setKey(''); setQty('1');
  };

  if (!open) {
    return (
      <Btn icon={IconPlus} disabled={busy}
        title="Chọn thêm VTYT lẻ từ danh mục VTYT để nhập cùng lượt" onClick={() => setOpen(true)}>
        VTYT lẻ{picks.length ? ` (${picks.length})` : ''}
      </Btn>
    );
  }
  const field = { height: 30, fontSize: FS.sm, padding: '0 6px', borderRadius: 5, border: `1px solid ${C.border}`, background: C.surface, color: C.text, fontFamily: 'inherit' };
  return (
    <span style={{ display: 'inline-flex', gap: 4, alignItems: 'center', flexWrap: 'wrap' }}>
      <select value={key} onChange={e => setKey(e.target.value)} disabled={busy} aria-label="Chọn VTYT lẻ"
        style={{ ...field, maxWidth: 220 }}>
        <option value="">Chọn VTYT…</option>
        {catalog.map(i => <option key={i.key} value={i.key}>{i.name}{i.code ? '' : ' (chưa có mã)'}</option>)}
      </select>
      <input value={qty} onChange={e => setQty(e.target.value)} disabled={busy} inputMode="decimal"
        style={{ ...field, width: 48 }} aria-label="Số lượng" />
      <Btn disabled={busy || !key} onClick={add}>Thêm</Btn>
      {picks.map(p => (
        <span key={p.key} style={{ display: 'inline-flex', alignItems: 'center', gap: 2, fontSize: FS.xs, padding: '0 2px 0 7px', borderRadius: 4, background: C.surface2, border: `1px solid ${C.border2}` }}>
          {nameOf(p.key)} ×{p.qty}
          <button type="button" className="emr-icon-btn" style={{ width: 24, height: 24 }} aria-label={`Bỏ ${nameOf(p.key)}`}
            onClick={() => setPicks(prev => prev.filter(x => x.key !== p.key))}><IconX size={13} stroke={1.9} /></button>
        </span>
      ))}
      <Btn onClick={() => setOpen(false)}>Xong</Btn>
    </span>
  );
}

function PatientActions({ patient, activeDate, availableDates, activeHasInfusion, activeHasProcedure, activeHasVtyt, activeInfusionIncomplete, hasInfusionAny, hasProcedureAny, hasVtytAny, infusionTotal, procedureTotal, vtytTotal, onInputCare, onInputInfusion, onInputProcedure, onInputVtyt, onRefreshDetails, onPrintDischargeBundle, onGotoMeds, onViewLog, running }) {
  const hasManyDays = availableDates.length > 1;
  const smallBtn = { whiteSpace: 'nowrap' };
  const busy = !!running;
  const dayText = activeDate || '—';
  const [vtytPicks, setVtytPicks] = useState([]);
  const careDay = patient?.day_map?.[activeDate]
    || (String(patient?.ngay_lam || '').trim() === String(activeDate || '').trim() ? patient : {});
  const canPrintDischarge = Boolean(activeDate && isDischargePrintPatientOnDates(patient, [activeDate]));
  const careDates = availableDates.filter(date => {
    const day = patient?.day_map?.[date]
      || (String(patient?.ngay_lam || '').trim() === String(date || '').trim() ? patient : {});
    return day?.care_required !== false;
  });

  return (
    <div style={{
      padding: '10px 16px', borderTop: `1px solid ${C.border}`,
      display: 'flex', gap: 8, alignItems: 'flex-start', flexWrap: 'wrap',
      background: C.surface, flexShrink: 0,
    }}>
      <div style={{
        display: 'flex', alignItems: 'center', gap: '8px 18px', flexWrap: 'wrap',
        minWidth: 0, flex: '1 1 600px',
      }}>
        <div style={{ fontSize: FS.sm, color: C.text2, whiteSpace: 'nowrap' }}>
          Thao tác cho ngày <b style={{ color: C.text, fontVariantNumeric: 'tabular-nums' }}>{dayText}</b>
          {hasManyDays ? <span> ({availableDates.length} ngày)</span> : null}
        </div>

        <ActionGroup label="Chăm sóc">
          <Btn
            variant="primary"
            disabled={busy || !activeDate || careDay?.care_required === false}
            style={smallBtn}
            title={`Kiểm tra, nhập thiếu và sửa sai chăm sóc ngày ${dayText}`}
            onClick={() => onInputCare?.([patient], activeDate)}
          >
            {running === 'check-care'
              ? <><Spinner size={10} /> Kiểm tra YL</>
              : (running === 'care' ? <><Spinner size={10} /> Đang đồng bộ</> : 'Kiểm tra / Nhập / Sửa')}
          </Btn>
          {hasManyDays && careDates.length > 0 && (
            <Btn
              variant="default"
              disabled={busy}
              style={smallBtn}
              title="Kiểm tra, nhập thiếu và sửa sai chăm sóc cho tất cả ngày của bệnh nhân đang chọn"
              onClick={() => onInputCare?.([patient], null)}
            >
              {running === 'care' ? <><Spinner size={10} /> Đang đồng bộ</> : `Tất cả ngày (${careDates.length})`}
            </Btn>
          )}
        </ActionGroup>

        {(activeHasInfusion || (hasInfusionAny && hasManyDays)) && (
          <ActionGroup label="Dịch truyền">
            {activeHasInfusion && (
              activeInfusionIncomplete ? (
                <Btn variant="solidWarn" style={smallBtn} title="Còn dịch truyền thiếu thể tích — bấm để vào tab Sửa dịch truyền nhập trước" onClick={() => onGotoMeds?.()}>
                  <IconAlertTriangle size={14} stroke={2} aria-hidden="true" /> Thiếu thể tích — Sửa ngay
                </Btn>
              ) : (
                <Btn variant="primary" disabled={busy || !activeDate} style={smallBtn} title={`Kiểm tra, nhập thiếu và sửa sai dịch truyền ngày ${dayText}`} onClick={() => onInputInfusion?.([patient], activeDate)}>
                  {running === 'check-infus' ? <><Spinner size={10} /> Kiểm tra YL</> : (running === 'infus' ? <><Spinner size={10} /> Đang đồng bộ</> : 'Kiểm tra / Nhập / Sửa')}
                </Btn>
              )
            )}
            {hasInfusionAny && hasManyDays && (
              <Btn variant="default" disabled={busy} style={smallBtn} title="Kiểm tra, nhập thiếu và sửa sai dịch truyền cho tất cả ngày của bệnh nhân đang chọn (ngày nào còn thiếu thể tích sẽ bị bỏ qua)" onClick={() => onInputInfusion?.([patient], null)}>
                Tất cả ngày ({infusionTotal || availableDates.length})
              </Btn>
            )}
          </ActionGroup>
        )}

        {(activeHasProcedure || (hasProcedureAny && hasManyDays)) && (
          <ActionGroup label="Thủ thuật">
            {activeHasProcedure && (
              <Btn variant="default" disabled={busy || !activeDate} style={smallBtn} title={`Kiểm tra, nhập thiếu và sửa sai thủ thuật ngày ${dayText}`} onClick={() => onInputProcedure?.([patient], activeDate)}>
                {running === 'check-procedure' ? <><Spinner size={10} /> Kiểm tra YL</> : (running === 'procedure' ? <><Spinner size={10} /> Đang đồng bộ</> : 'Kiểm tra / Nhập / Sửa')}
              </Btn>
            )}
            {hasProcedureAny && hasManyDays && (
              <Btn variant="default" disabled={busy} style={smallBtn} title="Kiểm tra, nhập thiếu và sửa sai thủ thuật cho tất cả ngày của bệnh nhân đang chọn" onClick={() => onInputProcedure?.([patient], null)}>
                Tất cả ngày ({procedureTotal || availableDates.length})
              </Btn>
            )}
          </ActionGroup>
        )}

        {activeDate && (
          <ActionGroup label="VTYT">
            <VtytLePicker
              key={`${patient?.ma_bn || patient?.id}-${activeDate}`}
              busy={busy}
              onPicksChange={setVtytPicks}
            />
            {(activeHasVtyt || vtytPicks.length > 0) && (
              <Btn variant="default" disabled={busy || !activeDate} style={smallBtn} title={`Nhập VTYT theo thủ thuật (thay băng: Urgotile/băng thun theo vị trí; kim luồn...)${vtytPicks.length ? ' + VTYT lẻ đã chọn' : ''} ngày ${dayText}`}
                onClick={() => onInputVtyt?.([patient], activeDate, vtytPicks.length ? { manualVtyt: { [manualVtytKey(patient?.ma_bn || patient?.id, activeDate)]: vtytPicks } } : {})}>
                {running === 'check-vtyt' ? <><Spinner size={10} /> Kiểm tra YL</> : (running === 'vtyt' ? <><Spinner size={10} /> Đang nhập</> : (vtytPicks.length ? `Kiểm tra / Nhập (+${vtytPicks.length} lẻ)` : 'Kiểm tra / Nhập'))}
              </Btn>
            )}
            {hasVtytAny && hasManyDays && (
              <Btn variant="default" disabled={busy} style={smallBtn} title="Kiểm tra/nhập VTYT theo thủ thuật cho tất cả ngày của bệnh nhân đang chọn" onClick={() => onInputVtyt?.([patient], null)}>
                Tất cả ngày ({vtytTotal || availableDates.length})
              </Btn>
            )}
          </ActionGroup>
        )}

        <ActionGroup label="Y lệnh">
          {hasManyDays ? (
            <>
              <Btn disabled={busy} style={smallBtn} title="Cập nhật y lệnh cho toàn bộ các ngày đang có của bệnh nhân này" onClick={() => onRefreshDetails?.(patient, availableDates)}>
                {running === 'details-one' ? <><Spinner size={10} /> Đang cập nhật</> : <><IconRefresh size={14} stroke={2} aria-hidden="true" /> Cập nhật YL tất cả ({availableDates.length} ngày)</>}
              </Btn>
              <Btn variant="default" disabled={busy || !activeDate} style={smallBtn} title={`Chỉ cập nhật y lệnh ngày ${dayText}`} onClick={() => onRefreshDetails?.(patient, activeDate)}>
                {running === 'details-one' ? <><Spinner size={10} /> Đang cập nhật</> : `YL ngày ${dayText}`}
              </Btn>
            </>
          ) : (
            <Btn variant="default" disabled={busy || !activeDate} style={smallBtn} onClick={() => onRefreshDetails?.(patient, activeDate)}>
              {running === 'details-one' ? <><Spinner size={10} /> Đang cập nhật</> : <><IconRefresh size={14} stroke={2} aria-hidden="true" /> Cập nhật y lệnh</>}
            </Btn>
          )}
        </ActionGroup>

        <ActionGroup label="In ra viện">
          <Btn
            icon={IconPrinter}
            disabled={busy || !canPrintDischarge}
            style={smallBtn}
            title={canPrintDischarge
              ? `Chỉ tổng hợp khi ngày ra viện đúng ${dayText}`
              : `Người bệnh không ra viện ngày ${dayText}`}
            onClick={() => onPrintDischargeBundle?.(patient, activeDate)}
          >
            {running === 'print-discharge-bundle'
              ? <><Spinner size={10} /> Đang tổng hợp</>
              : (canPrintDischarge ? 'Tổng hợp in' : 'Không RV ngày này')}
          </Btn>
        </ActionGroup>
      </div>

      <Btn icon={IconFileText} style={{ marginLeft: 'auto' }} onClick={onViewLog}>Xem log</Btn>
    </div>
  );
}

export default function PatientDetail({ patient, onClose, onInputCare, onInputInfusion, onInputProcedure, onInputVtyt, onRefreshDetails, onPrintDischargeBundle, onInfusionUpdated, running, toast }) {
  const [subTab, setSubTab] = useState('timeline');
  const p = patient;
  const st = STATUS[p.status] || STATUS.gray;
  const availableDates = useMemo(() => getAvailableDates(p), [p.available_dates, p.ngay_lam]);
  const [activeDate, setActiveDate] = useState(availableDates[0] || '');
  const [showLog, setShowLog]       = useState(false);
  const [logData, setLogData]       = useState(null);
  const [logLoading, setLogLoading] = useState(false);

  const handleViewLog = useCallback(async () => {
    setShowLog(true);
    setLogLoading(true);
    try {
      const d = await api.getSessionLogs();
      setLogData(d);
    } catch (e) {
      setLogData({ files: [], scan_history: String(e.message || 'Không tải được log.'), activity_log: '' });
    } finally {
      setLogLoading(false);
    }
  }, []);

  useEffect(() => {
    setActiveDate(prev => (availableDates.includes(prev) ? prev : (availableDates[0] || '')));
  }, [availableDates, p.ma_bn, p.id]);

  const activeDay = getActiveDay(p, activeDate, availableDates);
  const activeHasInfusion = Boolean(activeDay?.has_infusion || activeDay?.has_inf || activeDay?.infus_done);
  const activeHasProcedure = Boolean(activeDay?.has_procedure || activeDay?.procedure_done);
  const activeHasVtyt = wardVtytItems(activeDay).length > 0;
  const hasInfusionAny = Boolean(p.has_infusion_any || p.has_inf || p.has_infusion || p.infus_done);
  const hasProcedureAny = Boolean(p.has_procedure || p.procedure_done);
  const hasVtytAny = Boolean(p.has_vtyt || p.vtyt_done);
  const activeInfusionIncomplete = Boolean(activeDay?.infus_incomplete);

  const careTotal = Number.isFinite(p.care_total_dates) ? p.care_total_dates : (p.total_dates || 1);
  const careBadge = p.care_stale_count > 0 ? `CS: YL mới ${p.care_stale_count}` : (careTotal > 1
    ? `CS: ${p.care_done_count || 0}/${careTotal}`
    : `CS: ${p.care_done ? 'xong' : 'chưa'}`);
  const infusionTotal = Number.isFinite(p.infusion_total_dates) ? p.infusion_total_dates : (activeHasInfusion ? 1 : 0);
  const infusionBadge = p.has_infusion_incomplete ? `DT: thiếu thông tin (${p.infus_incomplete_count || 0})`
    : (p.infus_stale_count > 0 ? `DT: YL mới ${p.infus_stale_count}` : (infusionTotal > 1
      ? `DT: ${p.infus_done_count || 0}/${infusionTotal || 0}`
      : `DT: ${p.infus_done ? 'xong' : 'chưa'}`));
  const procedureTotal = Number.isFinite(p.procedure_total_dates) ? p.procedure_total_dates : (activeHasProcedure ? 1 : 0);
  const procedureBadge = p.procedure_stale_count > 0 ? `TT: YL mới ${p.procedure_stale_count}` : (procedureTotal > 1
    ? `TT: ${p.procedure_done_count || 0}/${procedureTotal || 0}`
    : `TT: ${p.procedure_done ? 'xong' : 'chưa'}`);
  const vtytTotal = Number.isFinite(p.vtyt_total_dates) ? p.vtyt_total_dates : (activeHasVtyt ? 1 : 0);
  // Cùng ngưỡng với ShiftTab: dưới 640px dùng giao diện điện thoại.
  const isMobile = useIsMobile(640);

  // Chip tiến độ ở đầu khung: đổi viết tắt CS/DT/TT sang chữ đầy đủ.
  const progress = [
    { label: careBadge.replace(/^CS:/, 'Chăm sóc:'), tone: p.care_stale_count > 0 ? 'amber' : (p.care_done ? 'green' : 'gray') },
    ...(hasInfusionAny ? [{ label: infusionBadge.replace(/^DT:/, 'Dịch truyền:'), tone: p.has_infusion_incomplete ? 'red' : (p.infus_stale_count > 0 ? 'amber' : (p.infus_done ? 'green' : 'gray')) }] : []),
    ...(hasProcedureAny ? [{ label: procedureBadge.replace(/^TT:/, 'Thủ thuật:'), tone: p.procedure_stale_count > 0 ? 'amber' : (p.procedure_done ? 'green' : 'gray') }] : []),
    ...(p.warning_count > 0 ? [{ label: `Cảnh báo: ${p.warning_count}`, tone: 'amber' }] : []),
  ];

  const actions = (
    <PatientActions
      patient={p}
      activeDate={activeDate}
      availableDates={availableDates}
      activeHasInfusion={activeHasInfusion}
      activeHasProcedure={activeHasProcedure}
      activeHasVtyt={activeHasVtyt}
      activeInfusionIncomplete={activeInfusionIncomplete}
      hasInfusionAny={hasInfusionAny}
      hasProcedureAny={hasProcedureAny}
      hasVtytAny={hasVtytAny}
      infusionTotal={infusionTotal}
      procedureTotal={procedureTotal}
      vtytTotal={vtytTotal}
      onInputCare={onInputCare}
      onInputInfusion={onInputInfusion}
      onInputProcedure={onInputProcedure}
      onInputVtyt={onInputVtyt}
      onRefreshDetails={onRefreshDetails}
      onPrintDischargeBundle={onPrintDischargeBundle}
      onGotoMeds={() => setSubTab('meds')}
      onViewLog={handleViewLog}
      running={running}
    />
  );

  return (
    <div style={{ height: isMobile ? 'auto' : '100%', display: 'flex', flexDirection: 'column', overflow: isMobile ? 'visible' : 'hidden', animation: 'fadeIn 0.15s ease' }}>
      <PatientHeader
        patient={p}
        activeDay={activeDay}
        status={st}
        subTab={subTab}
        setSubTab={setSubTab}
        availableDates={availableDates}
        activeDate={activeDate}
        setActiveDate={setActiveDate}
        progress={progress}
        hasInfusionAny={hasInfusionAny}
        onClose={onClose}
        showClose={!isMobile}
      />
      {isMobile && actions}

      <div style={{ flex: isMobile ? 'none' : 1, overflow: isMobile ? 'visible' : 'auto', padding: '12px 16px 16px', background: C.bg }}>
        <div style={{ maxWidth: 1220, width: '100%', margin: '0 auto 0 0' }}>
          {subTab === 'timeline'
            ? <>
                <p style={{ margin: '0 0 10px', color: C.text2, fontSize: FS.xs, lineHeight: 1.45 }}>
                  Timeline dự kiến. Khi nhập, hệ thống tự đối chiếu HIS và chỉ sửa khi đủ điều kiện an toàn.
                </p>
                <PatientTimeline items={activeDay.timeline || []} thuoc={activeDay.thuoc} />
              </>
            : subTab === 'raw'
              ? <RawOrdersPanel patientDay={activeDay} />
              : subTab === 'meds'
                ? (
                  <InfusionEditPanel
                    patientDay={activeDay}
                    patientId={p.ma_bn || p.id}
                    ngayLam={activeDate}
                    toast={toast}
                    onSaved={onInfusionUpdated}
                  />
                )
                : <PatientPreview patientDay={activeDay} />
          }
        </div>
      </div>

      {!isMobile && actions}

      <PatientLogModal
        open={showLog}
        onClose={() => setShowLog(false)}
        loading={logLoading}
        data={logData}
      />
    </div>
  );
}
