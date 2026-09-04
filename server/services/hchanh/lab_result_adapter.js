// server/services/hchanh/lab_result_adapter.js
//
// Adapter lấy trạng thái KSĐ (kháng sinh đồ) và GPB (giải phẫu bệnh) cho tab
// Kiểm hồ sơ. CHƯA xác định được màn hình/API EMR nào trả đúng chỉ định và kết
// quả KSĐ/GPB theo mã dịch vụ hoặc nhóm dịch vụ ổn định (khác với XQ/CT/MRI —
// đã có sẵn worker fetch_cls đọc tab "Lịch sử CĐHA").
//
// Theo yêu cầu nghiệp vụ: không được bịa selector/endpoint, không được suy đoán
// theo từ khóa khi chưa có mã dịch vụ hoặc cấu trúc dữ liệu ổn định, và không
// được đánh dấu "Đã có kết quả" khi chưa đọc được dữ liệu thật.
//
// Vì vậy adapter này luôn trả UNKNOWN kèm lý do rõ ràng cho tới khi:
//   1) Xác định được đúng màn hình/API EMR cấp KSĐ/GPB (mã dịch vụ hoặc nhóm
//      dịch vụ ổn định, không chỉ dò từ khóa tên dịch vụ), và
//   2) Worker Python thêm bước fetch tương ứng (giống fetch_cls hiện có), rồi
//   3) Nối kết quả đó vào registerKsdGpbFetcher() bên dưới.
//
// KHÔNG tự thêm suy đoán từ billing/CLS rows ở đây — dòng "giải phẫu bệnh" hay
// "vi sinh" trong bảng kê (server/services/hchanh/discharge_qa.js) chỉ để phân
// loại chi phí, không xác nhận đã có kết quả hay chưa.

'use strict';

const { ksdGpbInfo, KSD_GPB_STATUS } = require('./paper_record_status');

const NOT_CONFIGURED_REASON = 'Chưa xác định được nguồn dữ liệu KSĐ/GPB ổn định trong EMR (chưa có mã dịch vụ hoặc màn hình fetch tương ứng).';

let customFetcher = null;

// Cho phép nối một fetcher thật sau này (ví dụ đọc từ file cls đã mở rộng, hoặc
// từ output worker mới) mà không phải sửa lại toàn bộ hchanh.js.
// fetcher: (caseData) => { ksd: {status, evidence?}, gpb: {status, evidence?} } | null
function registerKsdGpbFetcher(fetcher) {
  customFetcher = typeof fetcher === 'function' ? fetcher : null;
}

function resetKsdGpbFetcher() {
  customFetcher = null;
}

// caseData: dữ liệu đã fetch của 1 hồ sơ (discharge, cls, ...) — dùng khi có fetcher thật.
function getKsdGpbStatus(caseData = {}) {
  if (customFetcher) {
    try {
      const result = customFetcher(caseData);
      if (result && typeof result === 'object') {
        return {
          ksd: ksdGpbInfo(result.ksd?.status, { source: 'adapter', evidence: result.ksd?.evidence || '' }),
          gpb: ksdGpbInfo(result.gpb?.status, { source: 'adapter', evidence: result.gpb?.evidence || '' }),
        };
      }
    } catch (err) {
      return {
        ksd: ksdGpbInfo(KSD_GPB_STATUS.UNKNOWN, { source: 'adapter_error', reason: String(err.message || err) }),
        gpb: ksdGpbInfo(KSD_GPB_STATUS.UNKNOWN, { source: 'adapter_error', reason: String(err.message || err) }),
      };
    }
  }
  return {
    ksd: ksdGpbInfo(KSD_GPB_STATUS.UNKNOWN, { source: 'not_configured', reason: NOT_CONFIGURED_REASON }),
    gpb: ksdGpbInfo(KSD_GPB_STATUS.UNKNOWN, { source: 'not_configured', reason: NOT_CONFIGURED_REASON }),
  };
}

module.exports = {
  getKsdGpbStatus,
  registerKsdGpbFetcher,
  resetKsdGpbFetcher,
  NOT_CONFIGURED_REASON,
};
