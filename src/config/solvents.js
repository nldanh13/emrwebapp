// Mã dung môi và tên hiển thị — MỘT nguồn: config/solvents.json (worker và máy chủ đọc cùng file).
import DATA from '../../config/solvents.json' with { type: 'json' };

const LIST = (DATA?.solvents || []).filter(x => x && x.code && x.label);

export const SOLVENT_LABEL = Object.fromEntries(LIST.map(x => [x.code, x.label]));
export const SOLVENT_SHORT = Object.fromEntries(LIST.map(x => [x.code, x.short || x.label]));
// [mã, tên] chọn được trong Quy tắc pha thuốc.
export const RULE_SOLVENTS = LIST.filter(x => x.in_rule).map(x => [x.code, x.label]);
