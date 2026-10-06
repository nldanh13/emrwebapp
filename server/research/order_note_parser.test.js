'use strict';

const { describe, it, expect } = require('vitest');
const {
  medicationRowsFromOrderRow,
  extractClinicalEvents,
  dedupeOrderFields,
} = require('./order_note_parser');

describe('research order/clinical processing', () => {
  it('tách thuốc từ y lệnh nhưng không dựng thuốc từ câu tham chiếu mơ hồ', () => {
    const rows = medicationRowsFromOrderRow({
      'Diễn biến': 'Bệnh nhân tỉnh',
      'Tên y lệnh': 'Paracetamol 500mg x 3 (U) 8h-14h-20h',
      'Y lệnh khác': 'Thực hiện y lệnh thuốc đã có.',
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].drug_name_norm).toContain('paracetamol');
    expect(rows[0].times_per_day).toBe('3');
    expect(rows[0].schedule).toContain('08:00');
    expect(rows[0].route_norm).toBeTruthy();
  });

  it('giữ diễn biến gốc và sinh sự kiện có bằng chứng rõ', () => {
    const row = {
      'Diễn biến': 'Bệnh nhân tỉnh\nVAS 3/10\nVết mổ khô\nKhông buồn nôn',
      'Tên y lệnh': 'Theo dõi',
      'Y lệnh khác': '',
    };
    const fields = dedupeOrderFields(row);
    expect(fields.clinical_text).toContain('VAS 3/10');

    const events = extractClinicalEvents(fields.clinical_text);
    const byType = Object.fromEntries(events.map(e => [e.event_type, e]));
    expect(byType.consciousness.value_norm).toBe('alert');
    expect(byType.pain_vas.value_norm).toBe('3');
    expect(byType.wound_status.value_norm).toBe('dry');
    expect(byType.nausea_vomiting.negated).toBe('1');
  });

  it('không biến không thấy nhắc thành phủ định', () => {
    const events = extractClinicalEvents('Bệnh nhân tỉnh, tiếp xúc tốt.');
    expect(events.some(e => e.event_type === 'nausea_vomiting')).toBe(false);
  });
});
