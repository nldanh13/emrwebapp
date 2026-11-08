// Báo cáo "Danh sách người bệnh": màn xem và bản in dùng chung danh sách dòng.
import { describe, it, expect } from 'vitest';
import { collectAdmissionRows, buildAdmissionListPrintHtml, parseAdmission } from './admissionListReport.js';

const DATE = '08/11/2026';
const patients = [
  { ma_bn: '3', ho_ten: 'Phạm C <x>', tg_vao: '14:10 05/11/2026' },
  { ma_bn: '1', ho_ten: 'Lê A', day_map: { [DATE]: { thoi_gian_vao_khoa: '08:25 05-11-2026' } }, tg_vao: '' },
  { ma_bn: '2', ho_ten: 'Trần B - PM: 12', 'T/G vào': '2026-10-30 22:00' },
  { ma_bn: '4', ho_ten: 'Ngô D' },
  { ma_bn: '5', ho_ten: 'Đỗ E', ngay_vao_vien: '01/11/2026', tg_vao: '09:00 03/11/2026' },
  { ma_bn: '1', ho_ten: 'Lê A', tg_vao: '08:25 05/11/2026' },
];

describe('Danh sách người bệnh theo ngày vào viện', () => {
  it('đọc các định dạng ngày giờ vào', () => {
    expect(parseAdmission('08:25 29-04-2026')).toMatchObject({ date: '29/04/2026', time: '08:25' });
    expect(parseAdmission('29/4/2026 7:05')).toMatchObject({ date: '29/04/2026', time: '07:05' });
    expect(parseAdmission('2026-04-29')).toMatchObject({ date: '29/04/2026', time: '' });
    expect(parseAdmission('31/02/2026')).toBeNull();
    expect(parseAdmission('')).toBeNull();
  });

  it('xếp theo ngày giờ vào, bỏ trùng, người bệnh chưa có ngày vào xếp cuối', () => {
    const rows = collectAdmissionRows(patients, DATE);
    expect(rows.map(r => [r.admissionDate, r.admissionTime, r.patientName])).toEqual([
      ['30/10/2026', '22:00', 'Trần B'],
      ['01/11/2026', '', 'Đỗ E'],
      ['05/11/2026', '08:25', 'Lê A'],
      ['05/11/2026', '14:10', 'Phạm C <x>'],
      ['', '', 'Ngô D'],
    ]);
  });

  it('bản in có đúng các dòng đang xem, ba cột yêu cầu, ghi chú để trống', () => {
    const rows = collectAdmissionRows(patients, DATE);
    const html = buildAdmissionListPrintHtml(rows, DATE);
    expect(html).toContain('DANH SÁCH NGƯỜI BỆNH');
    expect(html).toContain('Tổng số: 5 người bệnh');
    expect(html).toContain('<th style="width:18%">Ngày vào viện</th>');
    expect(html).toContain('Họ tên người bệnh</th>');
    expect(html).toContain('<th>Ghi chú</th>');
    expect((html.match(/<tr>/g) || []).length).toBe(rows.length + 1);
    expect((html.match(/<td class="note"><\/td>/g) || []).length).toBe(rows.length);
    expect(html.indexOf('Trần B')).toBeLessThan(html.indexOf('Ngô D'));
    expect(html).toContain('Phạm C &lt;x&gt;');
    expect(html).not.toContain('<x>');
    // Không in mã người bệnh.
    expect(html).not.toMatch(/<td[^>]*>\s*3\s*<br>/);
  });
});
