import { C } from '../../tokens.js';
import { Badge, Btn, Spinner } from '../shared.jsx';
import PatientDetail from '../PatientDetail.jsx';
import PatientCard from './PatientCard.jsx';
import RoomChips from './RoomChips.jsx';
import SessionPicker from './SessionPicker.jsx';
import ShiftToolbar from './ShiftToolbar.jsx';
import InputRoomSelector from './InputRoomSelector.jsx';

export default function ShiftMobileView({
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
  featureAvailability = {}, disabledFeatureLabels = [],
}) {
  const bulkInputDisabled = selectedInputPatients.length === 0;
  const inputDisabled = !!running || bulkInputDisabled;
  const careDisabled = inputDisabled || featureAvailability.care === false;
  const infusionDisabled = inputDisabled || featureAvailability.infusion === false;
  const procedureDisabled = inputDisabled || featureAvailability.procedure === false;

  if (selPx) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', flex: 1, overflow: 'hidden' }}>
        <div style={{
          display: 'flex', alignItems: 'center', gap: 8,
          padding: '10px 14px', borderBottom: `1px solid ${C.border}`,
          background: C.surface, flexShrink: 0,
        }}>
          <button type="button" onClick={() => setSelPx(null)} style={{
            background: C.surface2, border: `1px solid ${C.border}`,
            color: C.text, borderRadius: 6, padding: '6px 12px',
            cursor: 'pointer', fontSize: 13, fontFamily: 'inherit',
          }}>← Quay lại</button>
          <span style={{ fontSize: 13, fontWeight: 500, color: C.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {selPx.ho_ten || selPx.name}
          </span>
        </div>
        <PatientDetail patient={selPx} onClose={() => setSelPx(null)}
          onInputCare={handleInputCare} onInputInfusion={handleInputInfusion}
          onInputProcedure={handleInputProcedure}
              onRefreshDetails={handleRefreshDetailsOne} onPrintDischargeBundle={handlePrintDischargeBundle} running={running}
        />
        {showPicker && (
          <SessionPicker onUseSession={handleUseSession} onFetchNew={handleFetchNew}
            onClose={() => setShowPicker(false)} toast={toast} />
        )}
      </div>
    );
  }

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

      {rooms.length > 0 && (
        <RoomChips rooms={rooms} patients={patients} selRoom={selRoom}
          onSelect={r => { setSelRoom(r); setSelPx(null); }} />
      )}

      {rooms.length > 0 && (
        <div style={{ padding: '8px 12px', borderBottom: `1px solid ${C.border2}`, flexShrink: 0 }}>
          <InputRoomSelector
            compact
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
        </div>
      )}

      <div style={{
        display: 'flex', gap: 8, padding: '6px 12px', flexShrink: 0,
        borderBottom: `1px solid ${C.border2}`, alignItems: 'center',
      }}>
        <span style={{ fontSize: 12, color: C.text2 }}>{filtered.length} BN</span>
        {loading && <Spinner size={11} />}
        {stats.gray > 0 && <Badge text={`${stats.gray} chưa xử lý`} bg={C.surface2} color={C.text2} size={10} />}
        {stats.amber > 0 && <Badge text={`${stats.amber} cần xem`} bg={C.amberBg} color={C.amber} size={10} />}
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 5 }}>
          <Btn variant="success" onClick={() => handleInputCare(selectedInputPatients, null, bulkTargetOptions)} disabled={careDisabled}
            style={{ padding: '4px 9px', fontSize: 11 }} title="Kiểm tra, nhập thiếu và sửa sai chăm sóc">
            {running === 'care' ? <Spinner size={10} /> : '♥ CS ✓/+ /↻'}
          </Btn>
          <Btn variant="primary" onClick={() => handleInputInfusion(selectedInputPatients.filter(p => p.has_infusion || p.has_inf || p.infus_done), null, bulkTargetOptions)} disabled={infusionDisabled}
            style={{ padding: '4px 9px', fontSize: 11 }} title="Kiểm tra, nhập thiếu và sửa sai dịch truyền">
            {running === 'infus' ? <Spinner size={10} /> : '⊕ DT ✓/+ /↻'}
          </Btn>
          <Btn variant="default" onClick={() => handleInputProcedure(selectedInputPatients, null, bulkTargetOptions)} disabled={procedureDisabled}
            style={{ padding: '4px 9px', fontSize: 11 }} title="Kiểm tra, nhập thiếu và sửa sai thủ thuật">
            {running === 'procedure' ? <Spinner size={10} /> : '⚕ TT ✓/+ /↻'}
          </Btn>
          <Btn variant="primary" onClick={handlePrintDischargeBundleAll} disabled={!!running || !dischargePrintPatientsCount}
            style={{ padding: '4px 9px', fontSize: 11 }} title={`Tổng hợp in ${dischargePrintPatientsCount || 0} BN xuất viện`}>
            {running === 'print-discharge-bundle-all' ? <Spinner size={10} /> : `🖨 RV ${dischargePrintPatientsCount || 0}`}
          </Btn>
        </div>
      </div>

      <div style={{ flex: 1, overflowY: 'auto' }}>
        {filtered.length === 0 && !loading && (
          <div style={{ padding: 24, color: C.text3, fontSize: 13, textAlign: 'center' }}>
            {patients.length === 0 ? 'Chưa có dữ liệu — bấm ⚙ để xử lý & phân loại' : 'Không có BN trong phòng này'}
          </div>
        )}
        {filtered.map(p => (
          <PatientCard
            key={p.ma_bn || p.id}
            p={p}
            selected={false}
            onClick={() => setSelPx(p)}
            showInputToggle
            inputMode={inputMode}
            inputChecked={isPatientInInputScope?.(p)}
            onToggleInput={toggleInputPatient}
          />
        ))}
      </div>

      {showPicker && (
        <SessionPicker onUseSession={handleUseSession} onFetchNew={handleFetchNew}
          onClose={() => setShowPicker(false)} toast={toast} />
      )}
    </div>
  );
}
