import { C } from '../../tokens.js';
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
      <div style={{ padding: '6px 12px', color: C.amber, fontSize: 11, lineHeight: 1.5 }}>
        ⚠ Chưa có dữ liệu y lệnh cho {missingRangeDates.length} ngày trong khoảng đang chọn ({missingRangeDatesLabel}).
        {' '}Sang tab "Thu thập dữ liệu" → chỉnh khoảng ngày → bấm "② Lấy chi tiết" rồi "③ Xử lý & phân loại" để lấy đủ dữ liệu trước khi nhập.
        {patients.length ? ' Hoặc bỏ chọn bên dưới những ca chưa muốn nhập ngay, khỏi phải quét lại.' : ''}
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
                display: 'flex', alignItems: 'center', gap: 8, padding: '5px 12px',
                borderBottom: `1px solid ${C.border2}`, cursor: 'pointer', fontSize: 12,
                color: checked ? C.text : C.text3,
                background: checked ? 'transparent' : C.surface2,
              }}>
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={() => toggleInputPatient?.(p)}
                  style={{ cursor: 'pointer', flexShrink: 0 }}
                />
                <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {patientNameOf(p) || id}
                  <span style={{ color: C.text3 }}> ({id})</span>
                </span>
                {patientRoom(p) && <span style={{ color: C.text3, fontSize: 11, flexShrink: 0 }}>{patientRoom(p)}</span>}
                <span style={{ fontSize: 11, flexShrink: 0, color: incomplete ? C.amber : C.text3, fontWeight: incomplete ? 800 : 500 }}>
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
