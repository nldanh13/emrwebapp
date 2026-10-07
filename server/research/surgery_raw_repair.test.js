import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const {
  BACKUP_FILE,
  AUDIT_FILE,
  repairSurgeryTimestamp,
  repairSurgeryRow,
  repairRawSurgeryCsv,
} = require('./surgery_raw_repair.js');

describe('research surgery raw repair', () => {
  it('combines the surgery list date with a detail start clock', () => {
    expect(repairSurgeryTimestamp('08:15', '21/04/2026 07:30', '08:15'))
      .toBe('21/04/2026 08:15');
  });

  it('keeps a complete explicit surgery datetime from detail when current value lacks a date', () => {
    expect(repairSurgeryTimestamp('08:15', '21/04/2026 07:30', '21/04/2026 08:15'))
      .toBe('21/04/2026 08:15');
  });

  it('preserves an existing complete surgery datetime instead of replacing its date from the list row', () => {
    expect(repairSurgeryTimestamp('20/04/2026 08:15', '21/04/2026 07:30', '08:15'))
      .toBe('20/04/2026 08:15');
  });

  it('recovers worker detail fields and current PT diagnosis aliases without inventing values', () => {
    const raw = {
      thoi_gian: '21/04/2026 07:30',
      noi_dung_phau_thuat: 'Kết hợp xương',
      detail: {
        bat_dau: '08:15',
        ket_thuc: '09:45',
        phuong_phap_pt: 'Kết hợp xương bằng nẹp vít',
        pp_vo_cam: 'Tê tủy sống',
        icd9: '79.36',
        chan_doan_truoc_pt: 'Gãy xương cẳng chân',
        icd10_truoc_pt: 'S82.2',
        chan_doan_sau_pt: 'Gãy xương cẳng chân đã kết hợp xương',
        icd10_sau_pt: 'S82.2',
        trinh_tu_phau_thuat: 'Rạch da · bộc lộ · kết hợp xương · đóng vết mổ',
        bs_mo_chinh: 'BS A',
        gay_me_chinh: 'BS B',
        ptv_phu_1: 'BS C',
        dd_dung_cu: 'ĐD D',
        dien_bien_benh: 'Ổn định',
        dan_do_sau_pt: 'Theo dõi mạch, nhiệt, HA',
        benh_kem_theo_sau_pt: ['Tăng huyết áp'],
        hoan_tat_text: 'BS A hoàn tất',
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
    expect(row.ICD9).toBe('79.36');
    expect(row['ICD10 trước mổ']).toBe('S82.2');
    expect(row['ICD10 sau mổ']).toBe('S82.2');
    expect(row['Trình tự phẫu thuật']).toContain('kết hợp xương');
    expect(row['Phẫu thuật viên chính']).toBe('BS A');
    expect(row['Bác sĩ gây mê chính']).toBe('BS B');
    expect(row['Phụ mổ 1']).toBe('BS C');
    expect(row['Điều dưỡng dụng cụ']).toBe('ĐD D');
    expect(row['Diễn biến bệnh']).toBe('Ổn định');
    expect(row['Dặn dò sau PT']).toContain('Theo dõi');
    expect(row['Bệnh kèm sau PT']).toBe('Tăng huyết áp');
    expect(row['Người hoàn tất']).toBe('BS A hoàn tất');
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

  it('backs up raw surgery and appends audit before/when repairing', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'surgery-repair-'));
    const raw = JSON.stringify({ thoi_gian: '21/04/2026 07:30', detail: { bat_dau: '08:15' } }).replaceAll('"', '""');
    const file = path.join(dir, 'hchanh_surgery.csv');
    fs.writeFileSync(file, `Mã BN,Ngày phẫu thuật,Raw JSON\nX,08:15,"${raw}"\n`, 'utf8');

    const result = repairRawSurgeryCsv(dir);
    expect(result.changed).toBe(1);
    expect(fs.existsSync(path.join(dir, BACKUP_FILE))).toBe(true);
    expect(fs.existsSync(path.join(dir, AUDIT_FILE))).toBe(true);
    expect(fs.readFileSync(file, 'utf8')).toContain('21/04/2026 08:15');

    // Idempotent: chạy lại không tạo thay đổi mới.
    expect(repairRawSurgeryCsv(dir).changed).toBe(0);
  });
});
