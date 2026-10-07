// Hàm thuần cho màn Kiểm tra ngẫu nhiên (để test không cần vẽ giao diện).

const VERDICT_LABELS = { dung: 'Đúng', sai: 'Sai', khong_chac: 'Không chắc' };
const GROUP_ORDER = ['encounter', 'labs', 'imaging', 'medications', 'surgeries', 'unassigned'];
const GROUP_LABELS = {
  encounter: 'Mốc đợt (vào/ra viện, chẩn đoán)',
  labs: 'Xét nghiệm',
  imaging: 'CĐHA',
  medications: 'Thuốc / y lệnh',
  surgeries: 'Phẫu thuật / thủ thuật',
  unassigned: 'Dòng không gắn vào đợt',
};

export function auditVerdictLabel(v) {
  return VERDICT_LABELS[v] || '';
}

export function groupAuditItems(items = []) {
  return GROUP_ORDER
    .map(group => ({ group, label: GROUP_LABELS[group], items: items.filter(i => i.group === group) }))
    .filter(g => g.items.length);
}

export function auditProgress(audit) {
  const items = audit?.items || [];
  const reviewed = items.filter(i => i.verdict).length;
  return { total: items.length, reviewed, sai: items.filter(i => i.verdict === 'sai').length, done: !!items.length && reviewed === items.length };
}

const pct = v => `${(v * 100).toFixed(1).replace('.', ',')}%`;

// "95,0% (75,1–99,9%)" — khoảng tin cậy để biết mẫu đã đủ lớn chưa.
export function formatAccuracy(g) {
  if (!g || g.accuracy == null) return '—';
  const ci = g.ci95 ? ` (${pct(g.ci95.low)}–${pct(g.ci95.high)})` : '';
  return `${pct(g.accuracy)}${ci}`;
}
