import { getHchanhPatientKey } from '../features/hchanh/model.js';

export function getHchanhPatientNavigation(cards, selectedCard) {
  const rows = Array.isArray(cards) ? cards : [];
  const selectedKey = getHchanhPatientKey(selectedCard);
  const index = rows.findIndex(card => getHchanhPatientKey(card) === selectedKey);

  return {
    total: rows.length,
    position: index >= 0 ? index + 1 : 0,
    previous: index > 0 ? rows[index - 1] : null,
    next: index >= 0
      ? (index < rows.length - 1 ? rows[index + 1] : null)
      : (rows[0] || null),
  };
}
