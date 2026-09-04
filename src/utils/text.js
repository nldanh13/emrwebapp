export function normalizeText(value) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/\s+/g, ' ')
    .trim();
}

export function normalizeName(value) {
  return String(value || '').trim().replace(/\s+/g, ' ').toLowerCase();
}

export function includesAny(text, keywords = []) {
  const s = normalizeText(text);
  return keywords.some((k) => s.includes(normalizeText(k)));
}

export function toNumber(value, fallback = 0) {
  const n = Number(String(value || '').replace(/[, ]/g, ''));
  return Number.isFinite(n) ? n : fallback;
}

export function normalizeRoom(room) {
  const match = String(room || '').match(/P?0?(\d{1,2})/i);
  if (!match) return '';
  return `P${match[1].padStart(2, '0')}`;
}

export function safeText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}
