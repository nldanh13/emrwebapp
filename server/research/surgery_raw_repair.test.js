'use strict';

const { describe, expect, it } = require('vitest');
const {
  repairSurgeryTimestamp,
  repairSurgeryRow,
} = require('./surgery_raw_repair');

describe('research surgery raw repair', () => {
  it('combines the surgery list date with a detail start clock', () => {
    expect(repairSurgeryTimestamp('08:15', '21/04/2026 07:30', '08:15'))
      .toBe('21/04/2026 08:15');
  });

  it('keeps a complete explicit surgery datetime', () => {
    expect(repairSurgeryTimestamp('08:15', '21/04/2026 07:30', '21/04/2026 08:15'))
      .toBe('21/04/2026 08:15');
  });

  it('recovers worker detail fields from Raw JSON without inventing values', () => {
    const raw = {
      thoi_gian: '21/04/2026 07:30',
      noi_dung_phau_thuat: 'Kết hợp xương',
      detail: {
        bat_dau: '08:15',
        ket_thuc: '09:45',
        phuong_phap_pt: 'Kết hợp xương bằng nẹp vít',
        pp_vo_cam: 'Tê tủy sống',
        chan_doan_truoc: 'Gãy xương cẳng chân',
        chan_doan_sau: 'Gãy xương cẳng chân đã kết hợp xương',
        bien_chung: 'Không ghi nhận',
      },
    };
    const row = repairSurgeryRow({
      'Ngày phẫu thuật': '08:15',
      'Tên phẫu thuật': '',
      'Phương pháp phẫu thuật': '',
      PPVC: '',
      'Chẩn đoán trước mổ': '',
      'Chẩn đoán sau mổ': '',
      'Raw JSON': JSON.stringify(raw),
    });

    expect(row['Ngày phẫu thuật']).toBe('21/04/2026 08:15');
    expect(row['Tên phẫu thuật']).toBe('Kết hợp xương');
    expect(row['Phương pháp phẫu thuật']).toBe('Kết hợp xương bằng nẹp vít');
    expect(row.PPVC).toBe('Tê tủy sống');
    expect(row['Chẩn đoán trước mổ']).toBe('Gãy xương cẳng chân');
    expect(row['Chẩn đoán sau mổ']).toBe('Gãy xương cẳng chân đã kết hợp xương');
    expect(row['Kết thúc phẫu thuật']).toBe('09:45');
    expect(row['Biến chứng phẫu thuật']).toBe('Không ghi nhận');
  });

  it('does not fabricate surgery facts when Raw JSON lacks them', () => {
    const row = repairSurgeryRow({
      'Ngày phẫu thuật': '',
      'Tên phẫu thuật': '',
      'Phương pháp phẫu thuật': '',
      PPVC: '',
      'Raw JSON': '{}',
    });
    expect(row['Ngày phẫu thuật']).toBe('');
    expect(row['Tên phẫu thuật']).toBe('');
    expect(row['Phương pháp phẫu thuật']).toBe('');
    expect(row.PPVC).toBe('');
  });
});
