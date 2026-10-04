// Vai trò của biến trong nghiên cứu: giúp xác định biến chính, biến so sánh và biến hiệu chỉnh.
import { C } from '../../tokens.js';

export const VARIABLE_ROLE_OPTIONS = [
  ['', 'Chưa xếp vai trò'],
  ['primary_outcome', 'Kết cục chính (biến phụ thuộc)'],
  ['secondary_outcome', 'Kết cục phụ'],
  ['exposure', 'Biến độc lập / yếu tố nguy cơ'],
  ['covariate', 'Biến gây nhiễu / hiệu chỉnh'],
  ['descriptive', 'Đặc điểm mô tả'],
];

export const VARIABLE_ROLE_SHORT = {
  primary_outcome: 'Kết cục chính',
  secondary_outcome: 'Kết cục phụ',
  exposure: 'Biến độc lập',
  covariate: 'Gây nhiễu',
  descriptive: 'Mô tả',
};

export const VARIABLE_ROLE_ORDER = ['primary_outcome', 'secondary_outcome', 'exposure', 'covariate', 'descriptive', ''];

export function roleTone(role) {
  if (role === 'primary_outcome') return [C.red, C.redBg];
  if (role === 'secondary_outcome') return [C.amber, C.amberBg];
  if (role === 'exposure') return [C.blue, C.blueBg];
  if (role === 'covariate') return [C.green, C.greenBg];
  return [C.text2, C.surface2];
}

export function sortByRole(list, roleOf = v => v.role) {
  return list
    .map((v, i) => ({ v, i, r: VARIABLE_ROLE_ORDER.indexOf(roleOf(v) || '') }))
    .sort((a, b) => a.r - b.r || a.i - b.i)
    .map(x => x.v);
}
