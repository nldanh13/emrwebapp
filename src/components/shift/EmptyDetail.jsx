import { IconChevronRight, IconHandClick } from '@tabler/icons-react';
import { C, FS } from '../../tokens.js';
import { Spinner } from '../shared.jsx';
import { WARD_BULK_ACTIONS, WARD_PRINT_ACTION, actionPhase, phaseLabel } from './wardActions.js';

function formatDateTime(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleString('vi-VN', {
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    day: '2-digit', month: '2-digit', year: 'numeric',
  });
}

function reportStyle(status) {
  if (status === 'changed') return { bg: C.amberBg, border: C.amberBorder, color: C.amber, title: 'Có thay đổi trước khi nhập' };
  if (status === 'ok') return { bg: C.greenBg, border: C.greenBorder, color: C.green, title: 'Đã kiểm tra — không thấy thay đổi' };
  if (status === 'error') return { bg: C.redBg, border: C.redBorder, color: C.red, title: 'Kiểm tra lỗi' };
  if (status === 'running') return { bg: C.blueBg, border: C.blueBorder, color: C.blue, title: 'Đang kiểm tra dữ liệu mới' };
  return { bg: C.surface2, border: C.border, color: C.text2, title: 'Kết quả kiểm tra trước nhập' };
}

function PrecheckChangePanel({ report, onClear }) {
  if (!report) return null;
  const style = reportStyle(report.status);
  const rows = Array.isArray(report.changed) ? report.changed : [];
  const dates = Array.isArray(report.selectedDates) ? report.selectedDates.filter(Boolean) : [];
  const rooms = Array.isArray(report.targetRooms) ? report.targetRooms.filter(Boolean) : [];

  return (
    <div style={{
      marginTop: 12,
      border: `1px solid ${style.border}`,
      background: style.bg,
      borderRadius: 8,
      padding: 10,
      color: C.text,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
        <div style={{ fontSize: FS.md, fontWeight: 700, color: style.color, flex: 1 }}>
          {report.status === 'running' ? <><Spinner size={10} /> </> : null}{style.title}
        </div>
        {onClear && (
          <button type="button" onClick={onClear} style={{
            border: `1px solid ${style.border}`,
            background: 'rgba(255,255,255,0.55)',
            color: C.text2,
            borderRadius: 5,
            padding: '3px 8px',
            fontSize: FS.xs,
            cursor: 'pointer',
            fontFamily: 'inherit',
          }}>Ẩn</button>
        )}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6, marginBottom: 8 }}>
        <div style={{ fontSize: FS.xs, color: C.text2 }}>
          <b style={{ color: C.text }}>Loại:</b> {report.label || 'nhập EMR'}
        </div>
        <div style={{ fontSize: FS.xs, color: C.text2 }}>
          <b style={{ color: C.text }}>Kiểm tra lúc:</b> {formatDateTime(report.checkedAt) || '—'}
        </div>
        <div style={{ fontSize: FS.xs, color: C.text2 }}>
          <b style={{ color: C.text }}>BN/ngày:</b> {Number(report.changedCount || 0)}/{Number(report.checkedCount || 0)} thay đổi
        </div>
        <div style={{ fontSize: FS.xs, color: C.text2 }}>
          <b style={{ color: C.text }}>Cập nhật dữ liệu:</b> {formatDateTime(report.updatedAt) || (report.status === 'changed' ? formatDateTime(report.checkedAt) : '—')}
        </div>
      </div>

      {(dates.length || rooms.length) ? (
        <div style={{ fontSize: FS.xs, color: C.text2, marginBottom: 8 }}>
          {dates.length ? <span><b style={{ color: C.text }}>Ngày:</b> {dates.join(', ')}</span> : null}
          {dates.length && rooms.length ? <span> · </span> : null}
          {rooms.length ? <span><b style={{ color: C.text }}>Phòng:</b> {rooms.join(', ')}</span> : null}
        </div>
      ) : null}

      {report.message ? (
        <div style={{ fontSize: FS.xs, color: C.text2, lineHeight: 1.45, marginBottom: rows.length ? 8 : 0 }}>
          {report.message}
        </div>
      ) : null}

      {rows.length ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, maxHeight: 220, overflow: 'auto' }}>
          {rows.slice(0, 12).map((item, idx) => {
            const changes = Array.isArray(item.changes) && item.changes.length ? item.changes : [item.reason || 'Có thay đổi'];
            return (
              <div key={item.key || `${item.ma_bn || idx}-${item.ngay_lam || idx}`} style={{
                background: 'rgba(255,255,255,0.6)',
                border: `1px solid ${style.border}`,
                borderRadius: 6,
                padding: '6px 7px',
              }}>
                <div style={{ display: 'flex', gap: 6, alignItems: 'baseline', flexWrap: 'wrap' }}>
                  <span style={{ fontSize: FS.sm, fontWeight: 700, color: C.text }}>{item.ho_ten || item.ma_bn || item.key}</span>
                  <span style={{ fontSize: FS.xs, color: C.text3 }}>{item.ma_bn && item.ho_ten ? item.ma_bn : ''}</span>
                  {item.ngay_lam ? <span style={{ fontSize: FS.xs, color: C.text2 }}>Ngày {item.ngay_lam}</span> : null}
                  {(item.changed_at || item.last_order_time) ? (
                    <span style={{ fontSize: FS.xs, color: style.color, fontWeight: 700 }}>
                      Mốc mới nhất {item.changed_at || item.last_order_time}
                    </span>
                  ) : null}
                </div>
                <div style={{ fontSize: FS.xs, color: C.text2, marginTop: 3, lineHeight: 1.35 }}>
                  {changes.filter(Boolean).join(' · ')}
                </div>
              </div>
            );
          })}
          {rows.length > 12 ? (
            <div style={{ fontSize: FS.xs, color: C.text3 }}>Còn {rows.length - 12} BN/ngày khác không hiển thị.</div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function ActionRow({ icon: Icon, label, detail, hint, phase, disabled, onClick }) {
  const busy = Boolean(phase);
  return (
    <button
      type="button"
      className="emr-action-row"
      onClick={disabled ? undefined : onClick}
      disabled={disabled}
      aria-busy={busy || undefined}
      title={hint}
    >
      <span className="emr-action-row__icon" aria-hidden="true">{busy ? <Spinner size={14} /> : <Icon size={18} stroke={1.75} />}</span>
      <span style={{ flex: 1, minWidth: 0 }}>
        <span className="emr-action-row__label">{label}</span>
        <span className="emr-action-row__detail">{busy ? phaseLabel(phase) : detail}</span>
      </span>
      <IconChevronRight size={16} stroke={1.75} aria-hidden="true" className="emr-action-row__chevron" />
    </button>
  );
}

export default function EmptyDetail({
  onInputCareAll,
  onInputInfAll,
  onInputProcedureAll,
  onInputVtytAll,
  onPrintDischargeBundleAll,
  dischargePrintCount = 0,
  running,
  inputRoomSelector = null,
  bulkInputDisabled = false,
  precheckReport = null,
  onClearPrecheckReport = null,
  featureAvailability = {},
  disabledFeatureLabels = [],
}) {
  const inputDisabled = !!running || !!bulkInputDisabled;
  const handlers = { care: onInputCareAll, infusion: onInputInfAll, procedure: onInputProcedureAll, vtyt: onInputVtytAll };

  return (
    <div style={{ padding: 16, overflow: 'auto', height: '100%' }}>
      {disabledFeatureLabels.length ? <div style={{ marginBottom: 12, padding: '8px 10px', borderRadius: 7, border: `1px solid ${C.amberBorder}`, background: C.amberBg, color: C.amber, fontSize: FS.sm }}>Đang tắt: {disabledFeatureLabels.join(', ')}. Các thao tác còn lại vẫn dùng được.</div> : null}
      {inputRoomSelector}
      <h2 style={{ margin: '0 0 8px', fontSize: FS.lg, fontWeight: 700, color: C.text }}>Nhập hàng loạt</h2>
      <div style={{ display: 'grid', gap: 6 }}>
        {WARD_BULK_ACTIONS.map(action => (
          <ActionRow
            key={action.id}
            icon={action.icon}
            label={action.label}
            detail={action.detail}
            hint={action.hint}
            phase={actionPhase(action, running)}
            disabled={inputDisabled || featureAvailability[action.feature] === false}
            onClick={handlers[action.id]}
          />
        ))}
        <ActionRow
          icon={WARD_PRINT_ACTION.icon}
          label={`${WARD_PRINT_ACTION.label} (${dischargePrintCount || 0})`}
          detail={dischargePrintCount ? 'Tổng hợp bộ phiếu của người bệnh ra viện' : 'Không có người bệnh ra viện trong ngày đã chọn'}
          phase={actionPhase(WARD_PRINT_ACTION, running)}
          disabled={!!running || !dischargePrintCount}
          onClick={onPrintDischargeBundleAll}
        />
      </div>
      <PrecheckChangePanel report={precheckReport} onClear={onClearPrecheckReport} />
      <p style={{ display: 'flex', alignItems: 'center', gap: 6, margin: '14px 0 0', fontSize: FS.sm, color: C.text3 }}>
        <IconHandClick size={16} stroke={1.75} aria-hidden="true" />
        Chọn một người bệnh trong danh sách để xem y lệnh và nhập riêng.
      </p>
    </div>
  );
}
