function inputDate(value) {
  const raw = String(value || '').trim();
  let match = raw.match(/(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (match) return `${match[1]}-${match[2].padStart(2, '0')}-${match[3].padStart(2, '0')}`;
  match = raw.match(/(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})/);
  if (match) {
    const year = match[3].length === 2 ? `20${match[3]}` : match[3];
    return `${year}-${match[2].padStart(2, '0')}-${match[1].padStart(2, '0')}`;
  }
  return '';
}

function dmy(value) {
  const match = String(value || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return match ? `${match[3]}/${match[2]}/${match[1]}` : '';
}

function addDays(value, days) {
  const match = String(value || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return '';
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  date.setDate(date.getDate() + days);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function datesBetween(from, to, limit = 366) {
  if (!from || !to || to < from) return [];
  const out = [];
  let current = from;
  while (current && current <= to && out.length < limit) {
    out.push(dmy(current));
    current = addDays(current, 1);
  }
  return out.filter(Boolean);
}

function admissionDate(card = {}) {
  return inputDate(
    card.admission_time
    || card?.profile?.ngay_vao_vien
    || card?.profile?.ngay_vao
    || card?.discharge?.ngay_vao
    || card?.source_row?.admission_time
    || card?.source_row?.['Ngày vào viện']
    || card?.source_row?.['T/G vào']
  );
}

function dischargeDate(card = {}) {
  return inputDate(
    card.discharge_time
    || card?.profile?.ngay_ra_vien
    || card?.profile?.ngay_ra
    || card?.discharge?.ngay_ra_vien
    || card?.discharge?.ngay_ra
    || card?.discharge?.raw_time
    || card?.source_row?.discharge_time
    || card?.source_row?.['Ngày ra viện']
    || card?.source_row?.['T/G ra']
  );
}

function selectedEndDate(workDateRange = {}) {
  const from = inputDate(workDateRange.from);
  const to = inputDate(workDateRange.to) || from;
  return to && (!from || to >= from) ? to : from;
}

export function isDischargeVtytCard(card = {}) {
  const status = String(card.inpatient_status || '').toLowerCase();
  return card.scope === 'discharge' || status.includes('hoàn tất') || status.includes('hoan tat');
}

export function buildVtytReviewWindow(card = {}, workDateRange = {}) {
  const maBn = String(card.ma_bn || card.patient_id || card.id || '').trim();
  if (isDischargeVtytCard(card)) {
    const from = admissionDate(card);
    const to = dischargeDate(card);
    const dates = datesBetween(from, to);
    return {
      ma_bn: maBn,
      mode: 'full_episode',
      label: 'Toàn đợt điều trị',
      from: dates[0] || '',
      to: dates[dates.length - 1] || '',
      dates,
      error: !from || !to ? 'Thiếu ngày vào hoặc ngày ra viện' : (to < from ? 'Ngày ra viện trước ngày vào viện' : ''),
    };
  }

  const next = addDays(selectedEndDate(workDateRange), 1);
  const date = dmy(next);
  return {
    ma_bn: maBn,
    mode: 'next_day',
    label: 'Y lệnh ngày hôm sau',
    from: date,
    to: date,
    dates: date ? [date] : [],
    error: date ? '' : 'Chưa chọn ngày làm việc',
  };
}

export function buildVtytReviewWindows(cards = [], workDateRange = {}) {
  return (Array.isArray(cards) ? cards : []).map(card => ({ card, ...buildVtytReviewWindow(card, workDateRange) }));
}
