// Tách danh sách gõ tay (tên khác, hoạt chất…) thành từng mục.
// Dấu phẩy thập phân trong tên thuốc ("NATRI CLORID 0,9%", "VIBATAZOL 1G/0,5G") KHÔNG phải dấu tách:
// chỉ tách ở dấu chấm phẩy, xuống dòng, hoặc dấu phẩy không nằm giữa hai chữ số.
export const LIST_SEPARATOR = /[;\n]|,(?!\d)|(?<!\d),/;

export function parseList(text) {
  return String(text || '').split(LIST_SEPARATOR).map(x => x.trim()).filter(Boolean);
}
