// Ghi chú khi chuẩn hóa bằng tiếng Việt, gọn: không còn tên bảng tiếng Anh hay biểu thức kỹ thuật.
import { describe, it, expect } from 'vitest';
import { describeQaWarnings } from './qaNotes.js';

const W = [
  { code: 'child_match_ambiguous', message: 'lab_results: 24478 dòng khớp nhiều đợt, chưa gắn vào đợt nào.', count: 24478 },
  { code: 'child_match_ambiguous', message: 'imaging_results: 2351 dòng khớp nhiều đợt, chưa gắn vào đợt nào.', count: 2351 },
  { code: 'child_outside_encounter', message: 'lab_results: 5296 dòng đã gắn đợt nhưng nằm ngoài thời gian nằm viện (is_within_encounter = 0).', count: 5296 },
  { code: 'conflicting_results', message: 'lab_results: 153 nhóm cùng BN/thời điểm/chỉ số có kết quả khác nhau.', count: 153 },
  { code: 'missing_discharge_date', message: '408 đợt chưa có ngày ra viện: khoảng nằm viện được tính tới hôm nay khi ghép kết quả.', count: 408 },
  { code: 'possible_same_stay', message: '1577 cặp đợt của cùng người bệnh có thể là một đợt nằm viện (chuyển khoa). Xem encounter_review.csv.', count: 1577 },
];

describe('describeQaWarnings', () => {
  it('gộp theo loại, tên phần bằng tiếng Việt, không chữ kỹ thuật', () => {
    const lines = describeQaWarnings(W);
    const text = lines.join('\n');
    expect(lines[0]).toBe('Kết quả khớp nhiều lượt nên chưa gắn vào lượt nào: Xét nghiệm 24.478, CĐHA 2.351.');
    expect(text).toContain('ngoài thời gian nằm viện: Xét nghiệm 5.296.');
    expect(text).toContain('408 lượt chưa có ngày ra viện');
    expect(text).toContain('1.577 cặp lượt');
    expect(text).not.toMatch(/lab_results|imaging_results|is_within_encounter|encounter_review\.csv/);
    expect(lines.length).toBe(5);
  });

  it('bảng cũ không có count/table: đọc từ câu', () => {
    expect(describeQaWarnings([{ code: 'duplicate_raw_rows_removed', message: 'lab_results: bỏ 49 dòng thô giống hệt dòng khác (giữ một).' }]))
      .toEqual(['Bỏ dòng trùng y hệt (giữ một): Xét nghiệm 49.']);
  });
});
