import { IconAlertTriangle } from '@tabler/icons-react';
import { C, FS } from '../../tokens.js';
import { patientIdOf, patientNameOf, patientRoom } from './shiftUtils.js';

// Cảnh báo khi khoảng ngày đang chọn có ngày chưa từng "Lấy chi tiết" (chưa
// có dữ liệu y lệnh). Kèm danh sách BN đang nằm trong phạm vi nhập hàng loạt
// với checkbox bỏ chọn nhanh — để người dùng loại ca chưa muốn nhập ngay mà
// không phải quét/lấy dữ liệu lại toàn bộ.
export default function MissingRangeWarning({
  missingRangeDates = [],
  missingRangeDatesLabel = '',
  patients = [],
  requestedDayCount = 0,
  isPatientInInputScope,
  toggleInputPatient,
}) {
  if (!missingRangeDates.length) return null;

  return (
    <div style={{ borderBottom: `1px solid ${C.amberBorder}`, background: C.amberBg, flexShrink: 0 }}>
      <div role="alert" style={{ display: 'flex', gap: 8, padding: '9px 16px', color: C.amber, fontSize: FS.sm, lineHeight: 1.5 }}>
        <IconAlertTriangle size={17} stroke={1.9} style={{ flexShrink: 0, marginTop: 1 }} aria-hidden="true" />
        <span>
          <b>Chưa có y lệnh cho {missingRangeDates.length} ngày</b> trong khoảng đang chọn ({missingRangeDatesLabel}).
          {' '}Vào <b>Lấy dữ liệu</b>, chạy Lấy chi tiết rồi Xử lý &amp; phân loại để lấy đủ trước khi nhập.
          {patients.length ? ' Hoặc bỏ tích bên dưới những người bệnh chưa muốn nhập ngay.' : ''}
        </span>
      </div>
      {patients.length > 0 && (
        <div style={{ maxHeight: 170, overflowY: 'auto', borderTop: `1px solid ${C.amberBorder}`, background: C.surface }}>
          {patients.map(p => {
            const id = patientIdOf(p);
            const checked = isPatientInInputScope ? isPatientInInputScope(p) : true;
            const dayCount = Array.isArray(p.available_dates) ? p.available_dates.length : (p.total_dates || 1);
            const incomplete = requestedDayCount > 0 && dayCount < requestedDayCount;
            return (
              <label key={id || p.ma_bn} style={{
                display: 'flex', alignItems: 'center', gap: 8, padding: '7px 16px', minHeight: 36,
                borderBottom: `1px solid ${C.border2}`, cursor: 'pointer', fontSize: FS.sm,
                color: checked ? C.text : C.text3,
                background: checked ? 'transparent' : C.surface2,
              }}>
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={() => toggleInputPatient?.(p)}
                  style={{ cursor: 'pointer', flexShrink: 0, width: 16, height: 16, margin: 0, accentColor: C.blue }}
                />
                <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {patientNameOf(p) || id}
                  <span style={{ color: C.text3 }}> ({id})</span>
                </span>
                {patientRoom(p) && <span style={{ color: C.text3, fontSize: FS.xs, flexShrink: 0 }}>{patientRoom(p)}</span>}
                <span style={{ fontSize: FS.xs, flexShrink: 0, color: incomplete ? C.amber : C.text3, fontWeight: incomplete ? 700 : 500 }}>
                  {dayCount}/{requestedDayCount || dayCount} ngày
                </span>
              </label>
            );
          })}
        </div>
      )}
    </div>
  );
}
