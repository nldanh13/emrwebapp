const TARGETS = {
  checklist: { tab:'checklist', label:'Checklist' },
  fetch: { tab:'fetch', label:'Dữ liệu' },
  discharge: { tab:'discharge', label:'Ra viện' },
  billing: { tab:'billing', label:'Bảng kê' },
  bed_days: { tab:'bed_days', label:'Ngày giường' },
  surgery: { tab:'surgery', label:'Phẫu thuật' },
  order_history: { tab:'order_history', label:'Y lệnh' },
};

function normalize(value) {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

export function getHchanhIssueTarget(issue) {
  const group = normalize(issue?.group);
  const code = normalize(issue?.code);
  const text = `${group} ${normalize(issue?.title)} ${code}`;

  if (group.includes('kiem thu cong') || code.startsWith('manual_review_')) return TARGETS.checklist;
  if (group.includes('y lenh') || code.startsWith('order_')) return TARGETS.order_history;
  if (group.includes('phau thuat') || group.includes('pt/tt') || code.startsWith('surgery_')) return TARGETS.surgery;
  if (group.includes('tien giuong') || group.includes('ngay giuong') || code.startsWith('bed_days_')) return TARGETS.bed_days;

  if (/bang ke|bhyt|the bhyt|muc huong|vtyt|thuoc|dich vu|chi phi|trung dich vu|thoi gian dich vu/.test(text)) {
    return TARGETS.billing;
  }

  if (/ra vien|tai kham|nghi ngt|chan doan|cls|giay to kem theo/.test(text)) return TARGETS.discharge;
  if (/thong tin nen|tinh toan ven du lieu|profile_/.test(text)) return TARGETS.fetch;
  return null;
}
