// Thông báo khóa tra cứu có định danh và điều kiện cần bật.
import { C, FS, FONT_MONO } from '../../tokens.js';

export function IdentifiedLockNotice({ identifiedAccess }) {
  return <div style={{ border: `1px solid ${C.amberBorder}`, background: C.amberBg, color: C.text, borderRadius: 7, padding: '10px 12px', fontSize: FS.xs, lineHeight: 1.55 }}>
    <div style={{ fontWeight: 700, color: C.amber, marginBottom: 4 }}>Chức năng đang khóa</div>
    <div>Tra cứu người bệnh hiện họ tên, Mã BN và toàn bộ lịch sử điều trị, nên chỉ mở khi đủ điều kiện:</div>
    <ul style={{ margin: '4px 0 4px 18px', padding: 0 }}>
      <li style={{ color: identifiedAccess?.env_enabled ? C.green : C.text }}>
        {identifiedAccess?.env_enabled ? '✓ ' : ''}Server được khởi động với <code style={{ fontFamily: FONT_MONO }}>EMR_ALLOW_IDENTIFIED_RESEARCH_EXPORT=1</code> (sau khi có phê duyệt và kiểm soát truy cập).
      </li>
      <li style={{ color: identifiedAccess?.role_ok ? C.green : C.text }}>
        {identifiedAccess?.role_ok ? '✓ ' : ''}Tài khoản có vai trò supervisor hoặc admin.
      </li>
    </ul>
    <div style={{ color: C.text3 }}>Các chức năng khác của Kho nghiên cứu vẫn dùng bình thường. Mỗi lần tra cứu có định danh đều được ghi nhật ký bảo mật.</div>
  </div>;
}
