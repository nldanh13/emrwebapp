import { useCallback, useEffect, useMemo, useState } from 'react';
import { C, STATUS } from '../tokens.js';
import { Badge, Mono, Btn, Dot, Spinner } from './shared.jsx';
import * as api from '../api.js';
import PatientTimeline from './patient/PatientTimeline.jsx';
import PatientPreview from './patient/PatientPreview.jsx';
import PatientLogModal from './patient/PatientLogModal.jsx';
import { getPatientNotices, PatientNoticePills } from './patientStatusNotice.jsx';
import { isDischargePrintPatientOnDates } from '../utils/dischargePrint.js';


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

function PatientHeader({ patient, activeDay, status, subTab, setSubTab, availableDates, activeDate, setActiveDate, careBadge, infusionBadge, procedureBadge, hasInfusionAny, hasProcedureAny, onClose }) {
  const p = patient;
  const notices = getPatientNotices(p, activeDay);
  const admissionTime = getWardAdmissionTime(p, activeDay);
  const departmentName = getDepartmentName(p, activeDay);
  const wardHistory = getWardHistory(p, activeDay);
  return (
    <div style={{ padding: '11px 14px', borderBottom: `1px solid ${C.border}`, background: C.surface, flexShrink: 0 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div style={{ minWidth: 0 }}>
          <PatientNoticePills notices={notices} />
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 3 }}>
            <Dot color={status.border} size={9} />
            <span style={{ fontWeight: 600, fontSize: 14, color: C.text }}>{p.ho_ten || p.name}</span>
            <Mono style={{ color: C.text2 }}>{p.ma_bn || p.id}</Mono>
          </div>
          <div style={{ fontSize: 12, color: C.text2 }}>
            {p.chan_doan || p.dx || p.diagnosis}
            {(p.bac_si || p.doc) && ` · ${p.bac_si || p.doc}`}
            {p.bed && ` · Giường ${p.bed}`}
            {(p.so_phong || p.room) && ` / ${p.so_phong || p.room}`}
          </div>
          {(admissionTime || departmentName) && (
            <div style={{ fontSize: 11, color: C.text3, marginTop: 4, display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              {admissionTime && <span>Vào khoa: <Mono>{admissionTime}</Mono></span>}
              {departmentName && <span>Khoa điều trị: {departmentName}</span>}
            </div>
          )}
          {wardHistory.length > 1 && (
            <details style={{ marginTop: 5, fontSize: 11, color: C.text3 }}>
              <summary style={{ cursor: 'pointer' }}>Lịch sử khoa điều trị: {wardHistory.length} mốc</summary>
              <div style={{ marginTop: 4, display: 'flex', flexDirection: 'column', gap: 2 }}>
                {wardHistory.map((w, idx) => (
                  <div key={`${w.thu_tu || idx}-${w.thoi_gian_vao_khoa || idx}`}>
                    <Mono>{w.thoi_gian_vao_khoa || '—'}</Mono> · {w.ten_khoa_dieu_tri || w.khoa_dieu_tri || 'Không rõ khoa'}
                  </div>
                ))}
              </div>
            </details>
          )}
        </div>
        <button type="button" onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', color: C.text2, fontSize: 16, padding: '0 4px' }}>✕</button>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 9, flexWrap: 'wrap' }}>
        {[{ id: 'timeline', label: 'Timeline YL' }, { id: 'preview', label: 'Xem trước nhập' }, { id: 'raw', label: 'Y lệnh gốc' }].map(t => (
          <button type="button" key={t.id} onClick={() => setSubTab(t.id)} style={{
            padding: '3px 10px', borderRadius: 4, border: '1px solid',
            fontSize: 11, cursor: 'pointer', fontFamily: 'inherit',
            borderColor: subTab === t.id ? C.blue : C.border,
            background: subTab === t.id ? C.blueBg : 'transparent',
            color: subTab === t.id ? C.blue : C.text2,
          }}>{t.label}</button>
        ))}
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 4 }}>
          <Badge text={careBadge} bg={p.care_stale_count > 0 ? C.amberBg : (p.care_done ? C.greenBg : C.surface2)} color={p.care_stale_count > 0 ? C.amber : (p.care_done ? C.green : C.text2)} />
          {hasInfusionAny && (
            <Badge text={infusionBadge} bg={p.infus_stale_count > 0 ? C.amberBg : (p.infus_done ? C.greenBg : C.surface2)} color={p.infus_stale_count > 0 ? C.amber : (p.infus_done ? C.green : C.text2)} />
          )}
          {hasProcedureAny && (
            <Badge text={procedureBadge} bg={p.procedure_stale_count > 0 ? C.amberBg : (p.procedure_done ? C.greenBg : C.surface2)} color={p.procedure_stale_count > 0 ? C.amber : (p.procedure_done ? C.green : C.text2)} />
          )}
          {p.warning_count > 0 && <Badge text={`Cảnh báo: ${p.warning_count}`} bg={C.amberBg} color={C.amber} />}
        </div>
      </div>

      {availableDates.length > 0 && (
        <div style={{ display: 'flex', gap: 6, marginTop: 10, flexWrap: 'wrap' }}>
          {availableDates.map(date => {
            const dayInfo = p.day_map?.[date] || {};
            const active = date === activeDate;
            return (
              <button type="button" key={date} onClick={() => setActiveDate(date)} style={{
                padding: '4px 10px', borderRadius: 4, border: '1px solid',
                fontSize: 11, cursor: 'pointer', fontFamily: 'inherit',
                borderColor: active ? C.green : C.border,
                background: active ? C.greenBg : 'transparent',
                color: active ? C.green : C.text2,
              }}>
                {date}
                {dayInfo.care_stale || dayInfo.infus_stale || dayInfo.procedure_stale ? ' · YL mới' : (dayInfo.care_done || dayInfo.infus_done || dayInfo.procedure_done ? ` · ${dayInfo.status === 'green' ? '✓' : '…'}` : '')}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

function RawOrdersPanel({ patientDay = {} }) {
  const warnings = Array.isArray(patientDay.processing_warnings) ? patientDay.processing_warnings : [];
  const unparsed = Array.isArray(patientDay.unparsed_orders) ? patientDay.unparsed_orders : [];
  const events = Array.isArray(patientDay.raw_order_events) ? patientDay.raw_order_events : [];

  if (!warnings.length && !unparsed.length && !events.length) {
    return <div style={{ fontSize: 12, color: C.text3 }}>Chưa có y lệnh gốc/cảnh báo để hiển thị.</div>;
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {warnings.length > 0 && (
        <div style={{ border: `1px solid ${C.amberBorder}`, background: C.amberBg, borderRadius: 8, padding: 10 }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: C.amber, marginBottom: 6 }}>Cảnh báo cần kiểm tra</div>
          {warnings.map((w, i) => (
            <div key={`${w.code || 'warn'}-${i}`} style={{ fontSize: 11, color: C.text, marginTop: i ? 5 : 0 }}>
              <Mono>{w.gio_y_lenh || '—'}</Mono> · {w.message || w.code}
            </div>
          ))}
        </div>
      )}

      {unparsed.length > 0 && (
        <div style={{ border: `1px solid ${C.redBorder}`, background: C.redBg, borderRadius: 8, padding: 10 }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: C.red, marginBottom: 6 }}>Y lệnh chưa phân loại</div>
          {unparsed.map((u, i) => (
            <div key={`${u.ten_thuoc || 'raw'}-${i}`} style={{ fontSize: 11, color: C.text, marginTop: i ? 5 : 0 }}>
              <Mono>{u.gio_y_lenh || '—'}</Mono> · {u.ten_thuoc || u.raw || 'Không rõ'}
              {u.reason && <span style={{ color: C.text3 }}> · {u.reason}</span>}
            </div>
          ))}
        </div>
      )}

      <div style={{ border: `1px solid ${C.border}`, borderRadius: 8, overflow: 'hidden' }}>
        <div style={{ padding: '7px 9px', background: C.surface2, fontSize: 12, fontWeight: 700, color: C.text }}>Y lệnh gốc</div>
        <div style={{ padding: 9, display: 'flex', flexDirection: 'column', gap: 5 }}>
          {events.map((e, i) => (
            <div key={`${e.line_no || i}-${e.text}`} style={{ fontSize: 11, color: C.text2, display: 'grid', gridTemplateColumns: '54px 92px 1fr', gap: 6 }}>
              <Mono>{e.gio_y_lenh || '—'}</Mono>
              <span style={{ color: C.text3 }}>{e.kind || 'raw'}</span>
              <span style={{ color: C.text }}>{e.text}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function ActionCluster({ label, children, tone = 'default' }) {
  const toneMap = {
    success: { bg: C.greenBg, border: C.greenBorder, text: C.green },
    primary: { bg: C.blueBg, border: C.blueBorder, text: C.blue },
    warn: { bg: C.amberBg, border: C.amberBorder, text: C.amber },
    default: { bg: C.surface2, border: C.border2, text: C.text3 },
  };
  const t = toneMap[tone] || toneMap.default;
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 5,
      padding: '4px 5px 4px 7px', borderRadius: 11,
      background: t.bg, border: `1px solid ${t.border}`,
      minHeight: 36, flexWrap: 'wrap',
    }}>
      <span style={{
        fontSize: 10, lineHeight: '12px', fontWeight: 850,
        color: t.text, letterSpacing: '0.04em', whiteSpace: 'nowrap',
      }}>{label}</span>
      {children}
    </div>
  );
}

function PatientActions({ patient, activeDate, availableDates, activeHasInfusion, activeHasProcedure, hasInfusionAny, hasProcedureAny, infusionTotal, procedureTotal, onInputCare, onInputInfusion, onInputProcedure, onRefreshDetails, onPrintDischargeBundle, onViewLog, running }) {
  const hasManyDays = availableDates.length > 1;
  const smallBtn = { padding: '5px 9px', fontSize: 11, whiteSpace: 'nowrap', minHeight: 28 };
  const busy = !!running;
  const dayText = activeDate || '—';
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
      padding: '9px 14px', borderTop: `1px solid ${C.border}`,
      display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap',
      background: C.surface, boxShadow: '0 -4px 14px rgba(15,23,42,0.03)',
    }}>
      <div style={{
        display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap',
        minWidth: 0, flex: '1 1 760px',
      }}>
        <div style={{
          display: 'flex', flexDirection: 'column', justifyContent: 'center',
          minHeight: 36, padding: '3px 9px', borderRadius: 6,
          border: `1px solid ${C.border2}`, background: C.surface2,
          minWidth: 118,
        }}>
          <span style={{ fontSize: 10, color: C.text3, fontWeight: 800, letterSpacing: '0.03em' }}>ĐANG XEM</span>
          <span style={{ fontSize: 12, color: C.text, fontWeight: 800 }}>{dayText}{hasManyDays ? ` · ${availableDates.length} ngày` : ''}</span>
        </div>

        <ActionCluster label="CS" tone="success">
          <Btn
            variant="success"
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
              {running === 'care' ? <><Spinner size={10} /> Đang đồng bộ</> : `CS tất cả (${careDates.length})`}
            </Btn>
          )}
        </ActionCluster>

        {(activeHasInfusion || (hasInfusionAny && hasManyDays)) && (
          <ActionCluster label="DT" tone="primary">
            {activeHasInfusion && (
              <Btn variant="primary" disabled={busy || !activeDate} style={smallBtn} title={`Kiểm tra, nhập thiếu và sửa sai dịch truyền ngày ${dayText}`} onClick={() => onInputInfusion?.([patient], activeDate)}>
                {running === 'check-infus' ? <><Spinner size={10} /> Kiểm tra YL</> : (running === 'infus' ? <><Spinner size={10} /> Đang đồng bộ</> : 'Kiểm tra / Nhập / Sửa')}
              </Btn>
            )}
            {hasInfusionAny && hasManyDays && (
              <Btn variant="default" disabled={busy} style={smallBtn} title="Kiểm tra, nhập thiếu và sửa sai dịch truyền cho tất cả ngày của bệnh nhân đang chọn" onClick={() => onInputInfusion?.([patient], null)}>
                DT tất cả ({infusionTotal || availableDates.length})
              </Btn>
            )}
          </ActionCluster>
        )}

        {(activeHasProcedure || (hasProcedureAny && hasManyDays)) && (
          <ActionCluster label="TT">
            {activeHasProcedure && (
              <Btn variant="default" disabled={busy || !activeDate} style={smallBtn} title={`Kiểm tra, nhập thiếu và sửa sai thủ thuật ngày ${dayText}`} onClick={() => onInputProcedure?.([patient], activeDate)}>
                {running === 'check-procedure' ? <><Spinner size={10} /> Kiểm tra YL</> : (running === 'procedure' ? <><Spinner size={10} /> Đang đồng bộ</> : 'Kiểm tra / Nhập / Sửa')}
              </Btn>
            )}
            {hasProcedureAny && hasManyDays && (
              <Btn variant="default" disabled={busy} style={smallBtn} title="Kiểm tra, nhập thiếu và sửa sai thủ thuật cho tất cả ngày của bệnh nhân đang chọn" onClick={() => onInputProcedure?.([patient], null)}>
                TT tất cả ({procedureTotal || availableDates.length})
              </Btn>
            )}
          </ActionCluster>
        )}

        <ActionCluster label="Y LỆNH" tone="warn">
          {hasManyDays ? (
            <>
              <Btn variant="solidWarn" disabled={busy} style={smallBtn} title="Cập nhật y lệnh cho toàn bộ các ngày đang có của bệnh nhân này" onClick={() => onRefreshDetails?.(patient, availableDates)}>
                {running === 'details-one' ? <><Spinner size={10} /> Đang cập nhật</> : `↻ Cập nhật YL tất cả (${availableDates.length} ngày)`}
              </Btn>
              <Btn variant="default" disabled={busy || !activeDate} style={smallBtn} title={`Chỉ cập nhật y lệnh ngày ${dayText}`} onClick={() => onRefreshDetails?.(patient, activeDate)}>
                {running === 'details-one' ? <><Spinner size={10} /> Đang cập nhật</> : `YL ngày ${dayText}`}
              </Btn>
            </>
          ) : (
            <Btn variant="default" disabled={busy || !activeDate} style={smallBtn} onClick={() => onRefreshDetails?.(patient, activeDate)}>
              {running === 'details-one' ? <><Spinner size={10} /> Đang cập nhật</> : '↻ Cập nhật YL BN'}
            </Btn>
          )}
        </ActionCluster>

        <ActionCluster label="IN RA VIỆN" tone="primary">
          <Btn
            variant="primary"
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
        </ActionCluster>
      </div>

      <Btn variant="default" style={{ ...smallBtn, marginLeft: 'auto' }} onClick={onViewLog}>Xem log</Btn>
    </div>
  );
}

export default function PatientDetail({ patient, onClose, onInputCare, onInputInfusion, onInputProcedure, onRefreshDetails, onPrintDischargeBundle, running }) {
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
  const hasInfusionAny = Boolean(p.has_infusion_any || p.has_inf || p.has_infusion || p.infus_done);
  const hasProcedureAny = Boolean(p.has_procedure || p.procedure_done);

  const careTotal = Number.isFinite(p.care_total_dates) ? p.care_total_dates : (p.total_dates || 1);
  const careBadge = p.care_stale_count > 0 ? `CS: YL mới ${p.care_stale_count}` : (careTotal > 1
    ? `CS: ${p.care_done_count || 0}/${careTotal}`
    : `CS: ${p.care_done ? '✓' : '—'}`);
  const infusionTotal = Number.isFinite(p.infusion_total_dates) ? p.infusion_total_dates : (activeHasInfusion ? 1 : 0);
  const infusionBadge = p.infus_stale_count > 0 ? `DT: YL mới ${p.infus_stale_count}` : (infusionTotal > 1
    ? `DT: ${p.infus_done_count || 0}/${infusionTotal || 0}`
    : `DT: ${p.infus_done ? '✓' : '—'}`);
  const procedureTotal = Number.isFinite(p.procedure_total_dates) ? p.procedure_total_dates : (activeHasProcedure ? 1 : 0);
  const procedureBadge = p.procedure_stale_count > 0 ? `TT: YL mới ${p.procedure_stale_count}` : (procedureTotal > 1
    ? `TT: ${p.procedure_done_count || 0}/${procedureTotal || 0}`
    : `TT: ${p.procedure_done ? '✓' : '—'}`);

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden', animation: 'fadeIn 0.15s ease' }}>
      <PatientHeader
        patient={p}
        activeDay={activeDay}
        status={st}
        subTab={subTab}
        setSubTab={setSubTab}
        availableDates={availableDates}
        activeDate={activeDate}
        setActiveDate={setActiveDate}
        careBadge={careBadge}
        infusionBadge={infusionBadge}
        procedureBadge={procedureBadge}
        hasInfusionAny={hasInfusionAny}
        hasProcedureAny={hasProcedureAny}
        onClose={onClose}
      />

      <div style={{ flex: 1, overflow: 'auto', padding: '10px 12px 14px', background: C.bg }}>
        <div style={{ maxWidth: 1220, width: '100%', margin: '0 auto 0 0' }}>
          {subTab === 'timeline'
            ? <>
                <div style={{ margin: '0 0 8px', padding: '6px 8px', borderLeft: `2px solid ${C.blue}`, color: C.text3, fontSize: 10.5, lineHeight: 1.4 }}>
                  Timeline dự kiến; khi nhập hệ thống tự đối chiếu HIS và chỉ sửa khi đủ điều kiện an toàn.
                </div>
                <PatientTimeline items={activeDay.timeline || []} thuoc={activeDay.thuoc} />
              </>
            : subTab === 'raw'
              ? <RawOrdersPanel patientDay={activeDay} />
              : <PatientPreview patientDay={activeDay} />
          }
        </div>
      </div>

      <PatientActions
        patient={p}
        activeDate={activeDate}
        availableDates={availableDates}
        activeHasInfusion={activeHasInfusion}
        activeHasProcedure={activeHasProcedure}
        hasInfusionAny={hasInfusionAny}
        hasProcedureAny={hasProcedureAny}
        infusionTotal={infusionTotal}
        procedureTotal={procedureTotal}
        onInputCare={onInputCare}
        onInputInfusion={onInputInfusion}
        onInputProcedure={onInputProcedure}
        onRefreshDetails={onRefreshDetails}
        onPrintDischargeBundle={onPrintDischargeBundle}
        onViewLog={handleViewLog}
        running={running}
      />

      <PatientLogModal
        open={showLog}
        onClose={() => setShowLog(false)}
        loading={logLoading}
        data={logData}
      />
    </div>
  );
}
