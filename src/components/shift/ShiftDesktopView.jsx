import { C } from '../../tokens.js';
import { Badge, Dot, SectionLabel, Spinner } from '../shared.jsx';
import PatientDetail from '../PatientDetail.jsx';
import PatientCard from './PatientCard.jsx';
import EmptyDetail from './EmptyDetail.jsx';
import SessionPicker from './SessionPicker.jsx';
import ShiftToolbar from './ShiftToolbar.jsx';
import InputRoomSelector from './InputRoomSelector.jsx';
import { patientsInRoom } from './shiftUtils.js';

export default function ShiftDesktopView({
  patients, filtered, rooms, selRoom, selPx, setSelRoom, setSelPx,
  selectedInputRooms, selectedInputPatients, inputRoomPatientCounts,
  inputMode, manualInputPatientIds, excludedInputPatientIds,
  toggleInputRoom, selectAllInputRooms, selectOnlyInputRoom, clearInputRooms,
  setInputMode, clearPatientInputScope, toggleInputPatient, isPatientInInputScope,
  bulkTargetOptions,
  stats, loading, running, showPicker, setShowPicker, toolbarProps,
  handlePostprocess, handleInputCare, handleInputInfusion, handleInputProcedure, handleRefreshDetailsOne, handlePrintDischargeBundle, handlePrintDischargeBundleAll,
  dischargePrintPatientsCount = 0,
  handleUseSession, handleFetchNew, toast,
  workflowTitle, workflowHint, scopeInfo,
  precheckReport, onClearPrecheckReport,
  featureAvailability = {}, disabledFeatureLabels = [],
}) {
  const bulkInputDisabled = selectedInputPatients.length === 0;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, overflow: 'hidden' }}>
      {toolbarProps ? <ShiftToolbar {...toolbarProps} /> : (
        <div style={{ padding: '10px 14px', borderBottom: `1px solid ${C.border}`, background: C.surface, flexShrink: 0 }}>
          <div style={{ fontWeight: 850, color: C.text, fontSize: 14 }}>{workflowTitle || 'Bệnh nhân & nhập liệu'}</div>
          {workflowHint ? <div style={{ color: C.text3, fontSize: 11, marginTop: 3 }}>{workflowHint}</div> : null}
          {scopeInfo ? <div style={{ color: C.blue, fontSize: 11, marginTop: 3 }}>{scopeInfo}</div> : null}
        </div>
      )}
      {disabledFeatureLabels.length ? <div style={{ padding: '6px 12px', borderBottom: `1px solid ${C.amberBorder}`, background: C.amberBg, color: C.amber, fontSize: 11 }}>Đang tắt: {disabledFeatureLabels.join(', ')}. Các module khác vẫn tiếp tục.</div> : null}
      <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>
        <div style={{ width: 'clamp(112px, 7vw, 142px)', borderRight: `1px solid ${C.border}`, overflow: 'auto', flexShrink: 0, background: C.surface }}>
          <SectionLabel>Phòng</SectionLabel>
          <div onClick={() => { setSelRoom(null); setSelPx(null); }} style={{
            padding: '8px 12px', cursor: 'pointer', fontSize: 12,
            background: !selRoom ? C.surface2 : 'transparent',
            borderBottom: `1px solid ${C.border2}`,
            color: C.text, fontWeight: !selRoom ? 750 : 500,
          }}>Tất cả ({patients.length})</div>
          {rooms.map(r => {
            const pts = patientsInRoom(patients, r);
            return (
              <div key={r} onClick={() => { setSelRoom(r); setSelPx(null); }} style={{
                padding: '8px 12px', cursor: 'pointer',
                background: selRoom === r ? C.surface2 : 'transparent',
                borderBottom: `1px solid ${C.border2}`,
              }}>
                <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                  <span style={{ fontWeight: 650, fontSize: 12, color: C.text }}>{r}</span>
                  <span style={{ fontSize: 11, color: C.text2 }}>{pts.length}</span>
                </div>
                <div style={{ display: 'flex', gap: 4, marginTop: 3 }}>
                  {pts.some(p => p.status === 'gray') && <Dot color={C.text3} />}
                  {pts.some(p => p.status === 'amber') && <Dot color={C.amber} />}
                </div>
              </div>
            );
          })}
        </div>

        <div style={{ width: 'clamp(275px, 18vw, 360px)', borderRight: `1px solid ${C.border}`, overflow: 'auto', flexShrink: 0, background: C.surface }}>
          <div style={{ padding: '6px 12px', borderBottom: `1px solid ${C.border2}`, display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
            <span style={{ fontSize: 11, color: C.text2 }}>{filtered.length} BN</span>
            {loading && <Spinner size={11} />}
            {stats.gray > 0 && <Badge text={`${stats.gray} chưa xử lý`} bg={C.surface2} color={C.text2} size={10} />}
            {stats.amber > 0 && <Badge text={`${stats.amber} cần xem`} bg={C.amberBg} color={C.amber} size={10} />}
          </div>
          {filtered.length === 0 && !loading && (
            <div style={{ padding: 16, color: C.text3, fontSize: 12, textAlign: 'center' }}>
              {patients.length === 0 ? 'Chưa có dữ liệu — chạy Xử lý & phân loại trước' : 'Không có BN'}
            </div>
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
              onInputProcedure={handleInputProcedure}
              onRefreshDetails={handleRefreshDetailsOne} onPrintDischargeBundle={handlePrintDischargeBundle} running={running}
            />
          ) : (
            <EmptyDetail stats={stats} running={running} title={workflowTitle}
              onRunPostprocess={handlePostprocess}
              onInputCareAll={() => handleInputCare(selectedInputPatients, null, bulkTargetOptions)}
              onInputInfAll={() => handleInputInfusion(selectedInputPatients.filter(p => p.has_infusion || p.has_inf || p.infus_done), null, bulkTargetOptions)}
              onInputProcedureAll={() => handleInputProcedure(selectedInputPatients, null, bulkTargetOptions)}
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
