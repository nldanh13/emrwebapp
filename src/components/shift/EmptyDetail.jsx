import { C } from '../../tokens.js';
import { Btn, Spinner } from '../shared.jsx';

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
        <div style={{ fontSize: 12, fontWeight: 700, color: style.color, flex: 1 }}>
          {report.status === 'running' ? <><Spinner size={10} /> </> : null}{style.title}
        </div>
        {onClear && (
          <button type="button" onClick={onClear} style={{
            border: `1px solid ${style.border}`,
            background: 'rgba(255,255,255,0.55)',
            color: C.text2,
            borderRadius: 5,
            padding: '2px 6px',
            fontSize: 10,
            cursor: 'pointer',
            fontFamily: 'inherit',
          }}>Ẩn</button>
        )}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6, marginBottom: 8 }}>
        <div style={{ fontSize: 11, color: C.text2 }}>
          <b style={{ color: C.text }}>Loại:</b> {report.label || 'nhập EMR'}
        </div>
        <div style={{ fontSize: 11, color: C.text2 }}>
          <b style={{ color: C.text }}>Kiểm tra lúc:</b> {formatDateTime(report.checkedAt) || '—'}
        </div>
        <div style={{ fontSize: 11, color: C.text2 }}>
          <b style={{ color: C.text }}>BN/ngày:</b> {Number(report.changedCount || 0)}/{Number(report.checkedCount || 0)} thay đổi
        </div>
        <div style={{ fontSize: 11, color: C.text2 }}>
          <b style={{ color: C.text }}>Cập nhật dữ liệu:</b> {formatDateTime(report.updatedAt) || (report.status === 'changed' ? formatDateTime(report.checkedAt) : '—')}
        </div>
      </div>

      {(dates.length || rooms.length) ? (
        <div style={{ fontSize: 11, color: C.text2, marginBottom: 8 }}>
          {dates.length ? <span><b style={{ color: C.text }}>Ngày:</b> {dates.join(', ')}</span> : null}
          {dates.length && rooms.length ? <span> · </span> : null}
          {rooms.length ? <span><b style={{ color: C.text }}>Phòng:</b> {rooms.join(', ')}</span> : null}
        </div>
      ) : null}

      {report.message ? (
        <div style={{ fontSize: 11, color: C.text2, lineHeight: 1.45, marginBottom: rows.length ? 8 : 0 }}>
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
                  <span style={{ fontSize: 11, fontWeight: 700, color: C.text }}>{item.ho_ten || item.ma_bn || item.key}</span>
                  <span style={{ fontSize: 10, color: C.text3 }}>{item.ma_bn && item.ho_ten ? item.ma_bn : ''}</span>
                  {item.ngay_lam ? <span style={{ fontSize: 10, color: C.text2 }}>Ngày {item.ngay_lam}</span> : null}
                  {(item.changed_at || item.last_order_time) ? (
                    <span style={{ fontSize: 10, color: style.color, fontWeight: 700 }}>
                      Mốc mới nhất {item.changed_at || item.last_order_time}
                    </span>
                  ) : null}
                </div>
                <div style={{ fontSize: 10.5, color: C.text2, marginTop: 3, lineHeight: 1.35 }}>
                  {changes.filter(Boolean).join(' · ')}
                </div>
              </div>
            );
          })}
          {rows.length > 12 ? (
            <div style={{ fontSize: 10, color: C.text3 }}>Còn {rows.length - 12} BN/ngày khác không hiển thị.</div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export default function EmptyDetail({
  stats,
  onInputCareAll,
  onInputInfAll,
  onInputProcedureAll,
  onPrintDischargeBundleAll,
  dischargePrintCount = 0,
  running,
  title = 'Tổng quan nhập liệu',
  inputRoomSelector = null,
  bulkInputDisabled = false,
  precheckReport = null,
  onClearPrecheckReport = null,
  featureAvailability = {},
  disabledFeatureLabels = [],
}) {
  const inputDisabled = !!running || !!bulkInputDisabled;
  const careDisabled = inputDisabled || featureAvailability.care === false;
  const infusionDisabled = inputDisabled || featureAvailability.infusion === false;
  const procedureDisabled = inputDisabled || featureAvailability.procedure === false;

  return (
    <div style={{ padding: 12, overflow: 'auto', height: '100%' }}>
      {disabledFeatureLabels.length ? <div style={{ marginBottom: 10, padding: '7px 9px', borderRadius: 7, border: `1px solid ${C.amberBorder}`, background: C.amberBg, color: C.amber, fontSize: 11 }}>Đang tắt: {disabledFeatureLabels.join(', ')}. Các nút còn lại vẫn hoạt động.</div> : null}
      <div style={{ fontSize: 13, fontWeight: 800, color: C.text, marginBottom: 8 }}>{String(title || 'Tổng quan nhập liệu')}</div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', columnGap: 12, marginBottom: 14 }}>
        {[
          { label: 'Tổng BN', val: stats.total, color: C.text },
          { label: 'Chưa xử lý', val: stats.gray, color: C.text2 },
          { label: 'Cần xem', val: stats.amber, color: C.amber },
          { label: 'Đã ổn', val: stats.green, color: C.green },
        ].map(s => (
          <div key={s.label} style={{ borderRight: `1px solid ${C.border2}`, padding: '4px 12px 5px 0' }}>
            <div style={{ fontSize: 10, color: C.text3, marginBottom: 2 }}>{s.label}</div>
            <div style={{ fontSize: 20, fontWeight: 800, color: s.color, fontVariantNumeric: 'tabular-nums' }}>{s.val}</div>
          </div>
        ))}
      </div>
      {inputRoomSelector}
      <div style={{ fontSize: 10, fontWeight: 750, letterSpacing: '0.04em', color: C.text3, marginBottom: 6 }}>Hành động hàng loạt</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <Btn variant="success" onClick={onInputCareAll} disabled={careDisabled} style={{ justifyContent: 'flex-start', width: '100%' }}>
          {running === 'check-care' ? <><Spinner size={10} /> Đang kiểm tra YL...</> : (running === 'care' ? <><Spinner size={10} /> Đang kiểm tra/nhập/sửa...</> : 'Chăm sóc — kiểm tra / nhập / sửa')}
        </Btn>
        <Btn variant="primary" onClick={onInputInfAll} disabled={infusionDisabled} style={{ justifyContent: 'flex-start', width: '100%' }}>
          {running === 'check-infus' ? <><Spinner size={10} /> Đang kiểm tra YL...</> : (running === 'infus' ? <><Spinner size={10} /> Đang kiểm tra/nhập/sửa...</> : 'Dịch truyền — kiểm tra / nhập / sửa')}
        </Btn>
        <Btn variant="default" onClick={onInputProcedureAll} disabled={procedureDisabled} style={{ justifyContent: 'flex-start', width: '100%' }}>
          {running === 'check-procedure' ? <><Spinner size={10} /> Đang kiểm tra YL...</> : (running === 'procedure' ? <><Spinner size={10} /> Đang kiểm tra/nhập/sửa...</> : 'Thủ thuật — kiểm tra / nhập / sửa')}
        </Btn>
        <Btn variant="primary" onClick={onPrintDischargeBundleAll} disabled={!!running || !dischargePrintCount} style={{ justifyContent: 'flex-start', width: '100%' }}>
          {running === 'print-discharge-bundle-all' ? <><Spinner size={10} /> Đang tổng hợp in...</> : `In BN ra viện (${dischargePrintCount || 0})`}
        </Btn>
      </div>
      {bulkInputDisabled && (
        <div style={{ marginTop: 8, fontSize: 11, color: C.red }}>
          Chọn ít nhất một phòng hoặc người bệnh trước khi nhập hàng loạt.
        </div>
      )}
      <PrecheckChangePanel report={precheckReport} onClear={onClearPrecheckReport} />
      <div style={{ marginTop: 12, fontSize: 11, color: C.text3 }}>Chọn BN để nhập từng ca riêng</div>
    </div>
  );
}
