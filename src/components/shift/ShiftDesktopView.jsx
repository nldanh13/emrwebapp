import { C, FS } from '../../tokens.js';
import { Spinner } from '../shared.jsx';
import PatientDetail from '../PatientDetail.jsx';
import PatientCard from './PatientCard.jsx';
import EmptyDetail from './EmptyDetail.jsx';
import SessionPicker from './SessionPicker.jsx';
import ShiftToolbar from './ShiftToolbar.jsx';
import InputRoomSelector from './InputRoomSelector.jsx';
import MissingRangeWarning from './MissingRangeWarning.jsx';
import NurseDutyInfo from './NurseDutyInfo.jsx';
import { patientsInRoom } from './shiftUtils.js';

function RoomButton({ label, count, attention = 0, active, onClick }) {
  return (
    <button type="button" onClick={onClick} aria-current={active ? 'true' : undefined} style={{
      display: 'block', width: '100%', textAlign: 'left', padding: '7px 9px', marginBottom: 2, border: 0, borderRadius: 5, cursor: 'pointer',
      background: active ? C.blueBg : 'transparent', color: active ? C.blue : C.text,
    }}>
      <span style={{ display: 'flex', justifyContent: 'space-between', gap: 6, fontSize: FS.md, fontWeight: active ? 700 : 600 }}>
        <span>{label}</span>
        <span style={{ color: active ? C.blue : C.text3, fontWeight: 500, fontVariantNumeric: 'tabular-nums' }}>{count}</span>
      </span>
      {attention > 0 && <span style={{ display: 'block', fontSize: FS.xs, color: C.amber, fontWeight: 600, marginTop: 1 }}>{attention} cần xem</span>}
    </button>
  );
}

export function ListSummary({ count, stats, loading }) {
  const parts = [];
  if (stats.gray > 0) parts.push(<span key="g">{stats.gray} chưa xử lý</span>);
  if (stats.amber > 0) parts.push(<span key="a" style={{ color: C.amber, fontWeight: 600 }}>{stats.amber} cần xem</span>);
  if (stats.green > 0) parts.push(<span key="o" style={{ color: C.green }}>{stats.green} ổn</span>);
  return (
    <div style={{ padding: '8px 12px', borderBottom: `1px solid ${C.border2}`, display: 'flex', columnGap: 12, rowGap: 2, flexWrap: 'wrap', alignItems: 'center', fontSize: FS.sm, color: C.text2, background: C.surface2 }} aria-live="polite">
      <b style={{ color: C.text, fontWeight: 650 }}>{count} người bệnh</b>
      {parts}
      {loading && <Spinner size={12} />}
    </div>
  );
}

export function EmptyList({ hasData }) {
  return (
    <div style={{ padding: '28px 16px', color: C.text2, fontSize: FS.md, textAlign: 'center', lineHeight: 1.5 }}>
      {hasData ? 'Không có người bệnh trong phòng này.' : (
        <>
          <div style={{ fontWeight: 650, color: C.text }}>Chưa có dữ liệu cho ngày đã chọn</div>
          <div style={{ marginTop: 4 }}>Vào <b>Lấy dữ liệu</b>, chạy lần lượt Quét danh sách → Lấy chi tiết → Xử lý &amp; phân loại.</div>
        </>
      )}
    </div>
  );
}

export default function ShiftDesktopView({
  patients, filtered, rooms, selRoom, selPx, setSelRoom, setSelPx,
  selectedInputRooms, selectedInputPatients, inputRoomPatientCounts,
  inputMode, manualInputPatientIds, excludedInputPatientIds,
  toggleInputRoom, selectAllInputRooms, selectOnlyInputRoom, clearInputRooms,
  setInputMode, clearPatientInputScope, toggleInputPatient, isPatientInInputScope,
  bulkTargetOptions,
  stats, loading, running, showPicker, setShowPicker, toolbarProps,
  handlePostprocess, handleInputCare, handleInputInfusion, handleInputProcedure, handleInputVtyt, handleRefreshDetailsOne, handlePrintDischargeBundle, handlePrintDischargeBundleAll,
  dischargePrintPatientsCount = 0,
  handleUseSession, handleFetchNew, toast,
  workflowTitle, workflowHint, scopeInfo,
  onInfusionUpdated,
  precheckReport, onClearPrecheckReport,
  featureAvailability = {}, disabledFeatureLabels = [],
  missingRangeDates = [], missingRangeDatesLabel = '', requestedDayCount = 0,
  nurseDutyLines = [],
}) {
  const bulkInputDisabled = selectedInputPatients.length === 0;

  return (
    <div className="emr-fill" style={{ display: 'flex', flexDirection: 'column', flex: 1, overflow: 'hidden' }}>
      {toolbarProps ? <ShiftToolbar {...toolbarProps} /> : null}
      <NurseDutyInfo lines={nurseDutyLines} scopeInfo={scopeInfo} hint={workflowHint} />
      <MissingRangeWarning
        missingRangeDates={missingRangeDates}
        missingRangeDatesLabel={missingRangeDatesLabel}
        patients={selectedInputPatients}
        requestedDayCount={requestedDayCount}
        isPatientInInputScope={isPatientInInputScope}
        toggleInputPatient={toggleInputPatient}
      />
      {disabledFeatureLabels.length ? <div style={{ padding: '7px 16px', borderBottom: `1px solid ${C.amberBorder}`, background: C.amberBg, color: C.amber, fontSize: FS.sm }}>Đang tắt: {disabledFeatureLabels.join(', ')}. Các module khác vẫn tiếp tục.</div> : null}
      <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>
        <nav aria-label="Phòng" style={{ width: 'clamp(124px, 8vw, 156px)', borderRight: `1px solid ${C.border}`, overflow: 'auto', flexShrink: 0, background: C.surface, padding: 6 }}>
          <RoomButton label="Tất cả" count={patients.length} active={!selRoom} onClick={() => { setSelRoom(null); setSelPx(null); }} />
          {rooms.map(r => {
            const pts = patientsInRoom(patients, r);
            const attention = pts.filter(p => p.status === 'amber' || p.status === 'red').length;
            return (
              <RoomButton key={r} label={r} count={pts.length} attention={attention} active={selRoom === r}
                onClick={() => { setSelRoom(r); setSelPx(null); }} />
            );
          })}
        </nav>

        <div style={{ width: 'clamp(275px, 18vw, 360px)', borderRight: `1px solid ${C.border}`, overflow: 'auto', flexShrink: 0, background: C.surface }}>
          <ListSummary count={filtered.length} stats={stats} loading={loading} />
          {filtered.length === 0 && !loading && (
            <EmptyList hasData={patients.length > 0} />
          )}
          {filtered.map(p => (
            <PatientCard key={p.ma_bn || p.id} p={p}
              selected={selPx?.ma_bn === p.ma_bn}
              onClick={() => setSelPx(selPx?.ma_bn === p.ma_bn ? null : p)}
              showInputToggle
              inputMode={inputMode}
              inputChecked={isPatientInInputScope?.(p)}
              onToggleInput={toggleInputPatient}
            />
          ))}
        </div>

        <div style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
          {selPx ? (
            <PatientDetail patient={selPx} onClose={() => setSelPx(null)}
              onInputCare={handleInputCare} onInputInfusion={handleInputInfusion}
              onInputProcedure={handleInputProcedure} onInputVtyt={handleInputVtyt}
              onRefreshDetails={handleRefreshDetailsOne} onPrintDischargeBundle={handlePrintDischargeBundle} running={running}
              onInfusionUpdated={onInfusionUpdated} toast={toast}
            />
          ) : (
            <EmptyDetail running={running}
              onRunPostprocess={handlePostprocess}
              onInputCareAll={() => handleInputCare(selectedInputPatients, null, bulkTargetOptions)}
              onInputInfAll={() => handleInputInfusion(selectedInputPatients.filter(p => p.has_infusion || p.has_inf || p.infus_done), null, bulkTargetOptions)}
              onInputProcedureAll={() => handleInputProcedure(selectedInputPatients, null, bulkTargetOptions)}
              onInputVtytAll={() => handleInputVtyt(selectedInputPatients, null, bulkTargetOptions)}
              onPrintDischargeBundleAll={handlePrintDischargeBundleAll}
              dischargePrintCount={dischargePrintPatientsCount}
              bulkInputDisabled={bulkInputDisabled}
              precheckReport={precheckReport}
              onClearPrecheckReport={onClearPrecheckReport}
              featureAvailability={featureAvailability}
              disabledFeatureLabels={disabledFeatureLabels}
              inputRoomSelector={
                <InputRoomSelector
                  rooms={rooms}
                  selectedRooms={selectedInputRooms}
                  patientCounts={inputRoomPatientCounts}
                  selectedPatientCount={selectedInputPatients.length}
                  currentRoom={selRoom}
                  inputMode={inputMode}
                  onSetInputMode={setInputMode}
                  manualPatientCount={manualInputPatientIds?.size || 0}
                  excludedPatientCount={excludedInputPatientIds?.size || 0}
                  onClearPatientScope={clearPatientInputScope}
                  onToggleRoom={toggleInputRoom}
                  onSelectAll={selectAllInputRooms}
                  onSelectOnlyCurrent={selectOnlyInputRoom}
                  onClear={clearInputRooms}
                />
              }
            />
          )}
        </div>
      </div>

      {showPicker && (
        <SessionPicker onUseSession={handleUseSession} onFetchNew={handleFetchNew}
          onClose={() => setShowPicker(false)} toast={toast} />
      )}
    </div>
  );
}
