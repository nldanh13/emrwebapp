import { IconArrowLeft } from '@tabler/icons-react';
import { C, FS } from '../../tokens.js';
import { Btn } from '../shared.jsx';
import { ListSummary, EmptyList } from './ShiftDesktopView.jsx';
import { WARD_BULK_ACTIONS, WARD_PRINT_ACTION, actionPhase } from './wardActions.js';
import PatientDetail from '../PatientDetail.jsx';
import PatientCard from './PatientCard.jsx';
import RoomChips from './RoomChips.jsx';
import SessionPicker from './SessionPicker.jsx';
import ShiftToolbar from './ShiftToolbar.jsx';
import InputRoomSelector from './InputRoomSelector.jsx';
import MissingRangeWarning from './MissingRangeWarning.jsx';
import NurseDutyInfo from './NurseDutyInfo.jsx';

export default function ShiftMobileView({
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
  featureAvailability = {}, disabledFeatureLabels = [],
  missingRangeDates = [], missingRangeDatesLabel = '', requestedDayCount = 0,
  nurseDutyLines = [],
}) {
  const bulkInputDisabled = selectedInputPatients.length === 0;
  const inputDisabled = !!running || bulkInputDisabled;
  const bulkHandlers = {
    care: () => handleInputCare(selectedInputPatients, null, bulkTargetOptions),
    infusion: () => handleInputInfusion(selectedInputPatients.filter(p => p.has_infusion || p.has_inf || p.infus_done), null, bulkTargetOptions),
    procedure: () => handleInputProcedure(selectedInputPatients, null, bulkTargetOptions),
    vtyt: () => handleInputVtyt(selectedInputPatients, null, bulkTargetOptions),
  };

  if (selPx) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', flex: 1, overflow: 'hidden' }}>
        <div style={{
          display: 'flex', alignItems: 'center', gap: 8,
          padding: '10px 14px', borderBottom: `1px solid ${C.border}`,
          background: C.surface, flexShrink: 0,
        }}>
          <Btn icon={IconArrowLeft} onClick={() => setSelPx(null)} style={{ minHeight: 40 }}>Danh sách</Btn>
          <span style={{ fontSize: 14, fontWeight: 650, color: C.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {selPx.ho_ten || selPx.name}
          </span>
        </div>
        <PatientDetail patient={selPx} onClose={() => setSelPx(null)}
          onInputCare={handleInputCare} onInputInfusion={handleInputInfusion}
          onInputProcedure={handleInputProcedure} onInputVtyt={handleInputVtyt}
              onRefreshDetails={handleRefreshDetailsOne} onPrintDischargeBundle={handlePrintDischargeBundle} running={running}
              onInfusionUpdated={onInfusionUpdated} toast={toast}
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

      {disabledFeatureLabels.length ? <div style={{ padding: '8px 12px', borderBottom: `1px solid ${C.amberBorder}`, background: C.amberBg, color: C.amber, fontSize: FS.sm }}>Đang tắt: {disabledFeatureLabels.join(', ')}. Các module khác vẫn tiếp tục.</div> : null}

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

      <div className="emr-hscroll" role="group" aria-label="Nhập hàng loạt" style={{ display: 'flex', gap: 6, padding: '8px 12px', flexShrink: 0, overflowX: 'auto', borderBottom: `1px solid ${C.border2}`, background: C.surface }}>
        {WARD_BULK_ACTIONS.map(action => (
          <Btn key={action.id} icon={action.icon} loading={Boolean(actionPhase(action, running))}
            disabled={inputDisabled || featureAvailability[action.feature] === false}
            onClick={bulkHandlers[action.id]} title={action.hint || `${action.label}: ${action.detail.toLowerCase()}`}
            style={{ minHeight: 40, flexShrink: 0 }}>
            {action.label}
          </Btn>
        ))}
        <Btn icon={WARD_PRINT_ACTION.icon} loading={Boolean(actionPhase(WARD_PRINT_ACTION, running))}
          disabled={!!running || !dischargePrintPatientsCount} onClick={handlePrintDischargeBundleAll}
          style={{ minHeight: 40, flexShrink: 0 }}>
          In ra viện ({dischargePrintPatientsCount || 0})
        </Btn>
      </div>
      <ListSummary count={filtered.length} stats={stats} loading={loading} />

      <div style={{ flex: 1, overflowY: 'auto' }}>
        {filtered.length === 0 && !loading && (
          <EmptyList hasData={patients.length > 0} />
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
