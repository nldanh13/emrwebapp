// Thông báo khóa tra cứu có định danh và điều kiện cần bật.
import { C, FS, FONT_MONO } from '../../tokens.js';

const KEY_LINE = 'EMR_ALLOW_IDENTIFIED_RESEARCH_EXPORT=1';

// Máy chủ kiểm tra file .env và nói đúng bước còn thiếu (chỉ hiện cho supervisor/admin).
const ENV_FIX = {
  no_env_file: 'Chưa có file .env trong thư mục emrwebapp (cùng chỗ với server.js). Tạo file tên đúng là .env, thêm dòng dưới đây, lưu lại rồi khởi động lại máy chủ.',
  saved_as_txt: 'Thấy file .env.txt: Notepad đã tự thêm đuôi .txt nên máy chủ không đọc. Đổi tên thành .env (trong Notepad chọn "Save as type: All files"), rồi khởi động lại máy chủ.',
  missing_key: 'Đã có file .env nhưng chưa có dòng bật. Thêm dòng dưới đây vào .env, lưu lại rồi khởi động lại máy chủ.',
  value_off: 'File .env đang đặt giá trị tắt. Sửa thành dòng dưới đây, lưu lại rồi khởi động lại máy chủ.',
  restart_needed: 'File .env đã có dòng bật nhưng máy chủ đang chạy bản đọc từ trước. Đóng cửa sổ "EMR Web App" rồi chạy lại start-all.bat (hoặc npm start).',
  duplicate_key: 'File .env có dòng này nhiều lần và dòng cuối cùng đang tắt (máy chủ lấy dòng cuối). Xóa các dòng trùng, chỉ giữ dòng dưới đây, rồi khởi động lại máy chủ.',
  utf16: 'File .env đang lưu bằng mã hóa Unicode (UTF-16) nên máy chủ không đọc được. Mở bằng Notepad, chọn File → Save as, mục Encoding chọn UTF-8, lưu đè rồi khởi động lại máy chủ.',
  overridden_by_env: 'Windows đang có sẵn biến môi trường cùng tên với giá trị khác, che mất dòng trong .env. Xóa biến đó (System Properties → Environment Variables) hoặc đặt giá trị 1, rồi khởi động lại máy chủ.',
  not_loaded: 'File .env đã có dòng bật và máy chủ đã khởi động lại sau đó nhưng vẫn chưa nhận. Gửi ảnh màn hình này cho người hỗ trợ kỹ thuật.',
};

const fmtTime = (iso) => { const d = new Date(iso); return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString('vi-VN'); };

function EnvFix({ diagnosis }) {
  const text = ENV_FIX[diagnosis.reason];
  if (!text) return null;
  return (
    <div style={{ margin: '6px 0', padding: '7px 9px', borderRadius: 6, background: C.surface, border: `1px solid ${C.amberBorder}` }}>
      <div style={{ fontWeight: 700, color: C.text }}>Cách bật trên máy chủ này</div>
      <div style={{ marginTop: 2 }}>{text}</div>
      {diagnosis.reason === 'overridden_by_env' && <div style={{ marginTop: 2, color: C.text3 }}>Giá trị máy chủ đang thấy: <code style={{ fontFamily: FONT_MONO }}>{diagnosis.runtime_value}</code></div>}
      {(diagnosis.server_started_at || diagnosis.env_updated_at) && (
        <div style={{ marginTop: 2, color: C.text3 }}>
          Máy chủ khởi động lúc {fmtTime(diagnosis.server_started_at)}{diagnosis.env_updated_at ? ` · file .env sửa lúc ${fmtTime(diagnosis.env_updated_at)}` : ''}.
        </div>
      )}
      {!['restart_needed', 'utf16', 'not_loaded'].includes(diagnosis.reason) && <code style={{ display: 'inline-block', marginTop: 4, padding: '2px 6px', background: C.surface2, borderRadius: 4, fontFamily: FONT_MONO }}>{KEY_LINE}</code>}
    </div>
  );
}

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
    {identifiedAccess?.env_diagnosis && <EnvFix diagnosis={identifiedAccess.env_diagnosis} />}
    <div style={{ color: C.text3 }}>Các chức năng khác của Kho nghiên cứu vẫn dùng bình thường. Mỗi lần tra cứu có định danh đều được ghi nhật ký bảo mật.</div>
  </div>;
}
