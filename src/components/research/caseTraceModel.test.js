// Đường đi lấy dữ liệu: người dùng phải thấy ca vào màn hình EMR nào, thấy gì, lấy gì; bước lỗi nổi rõ.
import { describe, it, expect } from 'vitest';
import { buildCaseTraceView } from './caseTraceModel.js';

const CASES = [
  {
    case_id: 'k1', ts: '2026-11-08T10:00:00Z', mode: 'hchanh_auto', status: 'done',
    ma_bn: '9900****', research_code: 'NC001', date_from: '01/09/2026', date_to: '05/09/2026',
    files: ['profile', 'discharge'], counts: { profile: 1, discharge: 1 },
    events: [
      { tag: 'CASE.START', step: 'Bắt đầu ca' },
      { tag: 'FETCH.START', step: 'Mở thông tin nền', screen: 'D/s Điều trị nội trú → Thông tin nền', sees: 'ngày vào viện 08:00 01/09/2026', takes: 'profile' },
      { tag: 'ORDER_HISTORY.FALLBACK_CLICK_OPEN', step: 'Bấm tên người bệnh', screen: 'Lịch sử y lệnh', sees: 'markers=0' },
    ],
  },
  {
    case_id: 'k2', mode: 'xn_cdha', status: 'error', ma_bn: '9900****',
    events: [{ tag: 'ERROR.NO_URL_DISCHARGE', step: 'Không tạo được URL', screen: 'D/s Điều trị nội trú / link_map' }],
  },
];

describe('buildCaseTraceView', () => {
  it('mỗi ca hiện màn hình đã vào, thấy gì, lấy gì; bỏ bước chỉ đánh dấu bắt đầu', () => {
    const [a] = buildCaseTraceView(CASES);
    expect(a.title).toBe('Mã NC NC001 · Mã BN 9900****');
    expect(a.mode).toBe('Hồ sơ nền / Ra viện / Phẫu thuật / Chi phí');
    expect(a.status).toBe('Lấy xong');
    expect(a.steps.map(s => s.screen)).toEqual(['D/s Điều trị nội trú → Thông tin nền', 'Lịch sử y lệnh']);
    expect(a.steps[0].sees).toBe('ngày vào viện 08:00 01/09/2026');
    expect(a.steps[1].tone).toBe('warn');
    expect(a.tone).toBe('ok');
  });

  it('bước lỗi tô đỏ và có câu giải thích tiếng Việt', () => {
    const [, b] = buildCaseTraceView(CASES);
    expect(b.tone).toBe('error');
    expect(b.errors).toBe(1);
    expect(b.steps[0].hint).toBe('Không tìm thấy đường vào phiếu Ra viện');
    expect(b.mode).toBe('Xét nghiệm / CĐHA');
  });

  it('không có dữ liệu thì trả mảng rỗng', () => {
    expect(buildCaseTraceView(undefined)).toEqual([]);
    expect(buildCaseTraceView([null])).toEqual([]);
  });
});
