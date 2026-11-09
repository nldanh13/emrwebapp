import { describe, expect, it } from 'vitest';
import { labChip, labSummary, patientLabEntry } from './labResults.js';

const okEntry = (phieu) => ({ status: 'ok', phieu });

describe('kết quả xét nghiệm trong ngày', () => {
  it('lấy đúng người bệnh theo mã', () => {
    const data = { items: { A: okEntry([]) } };
    expect(patientLabEntry(data, { ma_bn: 'A' })).toBe(data.items.A);
    expect(patientLabEntry(data, { ma_bn: 'B' })).toBeNull();
    expect(patientLabEntry(undefined, { ma_bn: 'A' })).toBeNull();
  });

  it('đếm phiếu, phiếu chờ và chỉ số bất thường chỉ trên phiếu Hoàn tất', () => {
    const s = labSummary(okEntry([
      { hoan_tat: true, ket_qua: [{ bat_thuong: 'bat_thuong' }, { bat_thuong: '' }] },
      { hoan_tat: false, ket_qua: [{ bat_thuong: 'bat_thuong' }] },
    ]));
    expect(s).toEqual({ total: 2, done: 1, pending: 1, values: 2, abnormal: 1 });
  });

  it('chip trên thẻ: bất thường đỏ, còn chờ cam, đủ xanh; không có XN hoặc chưa đọc thì không hiện', () => {
    expect(labChip(okEntry([{ hoan_tat: true, ket_qua: [{ bat_thuong: 'x' }] }]))).toMatchObject({ text: 'XN 1 bất thường', tone: 'red' });
    expect(labChip(okEntry([{ hoan_tat: true, ket_qua: [] }, { hoan_tat: false }]))).toMatchObject({ text: 'XN 1/2', tone: 'amber' });
    expect(labChip(okEntry([{ hoan_tat: true, ket_qua: [{}] }]))).toMatchObject({ text: 'XN 1/1', tone: 'green' });
    expect(labChip({ status: 'none', phieu: [] })).toBeNull();
    expect(labChip(null)).toBeNull();
    expect(labChip({ status: 'error', error: 'x' })).toMatchObject({ tone: 'amber' });
  });
});
