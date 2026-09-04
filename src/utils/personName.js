/**
 * Chuẩn hóa tên người bệnh để hiển thị trên giao diện.
 * Mọi component cần hiển thị tên người bệnh nên gọi hàm này thay vì tự cắt chuỗi.
 */
export function formatPersonName(value, fallback = '—') {
  const normalized = String(value ?? '')
    .replace(/\u00a0/g, ' ')
    .replace(/[\r\n]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (!normalized) return fallback;

  const cleaned = normalized
    .replace(/\s*(?:[-–—]\s*)PM\s*:\s*.*$/iu, '')
    .trim();

  return cleaned || normalized || fallback;
}

export const cleanPersonName = formatPersonName;
