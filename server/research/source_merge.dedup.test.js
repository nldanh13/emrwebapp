import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  aliasesIntersect,
  encounterIdentityAliases,
  combineEncounterSources,
} = require('./source_merge.js');

describe('research encounter anti-duplicate aliases', () => {
  it('recognizes the same stay from Mã BN and admission time', () => {
    const left = {
      'Mã BN': 'BN001',
      'T/G vào': '08:00 01/10/2026',
    };
    const right = {
      'Mã BN': 'BN001',
      admission_date: '2026-10-01 08:00',
    };

    expect(aliasesIntersect(encounterIdentityAliases(left), encounterIdentityAliases(right))).toBe(true);
  });

  it('merges duplicate rows for one stay and keeps complementary data', () => {
    const rows = combineEncounterSources({
      initialRows: [{
        'Mã BN': 'BN001',
        'T/G vào': '08:00 01/10/2026',
        'Họ tên': 'Người bệnh A',
      }],
      hchanhProfileRows: [{
        'Mã BN': 'BN001',
        admission_date: '2026-10-01 08:00',
        address: 'Địa chỉ từ hồ sơ',
      }],
    });

    expect(rows).toHaveLength(1);
    expect(rows[0].address).toBe('Địa chỉ từ hồ sơ');
    expect(rows[0].__source_status).toContain('initial');
    expect(rows[0].__source_status).toContain('hchanh_profile');
  });

  it('collapses duplicate initial rows with the same patient and admission time', () => {
    const rows = combineEncounterSources({
      initialRows: [
        {
          'Mã BN': 'BN001',
          'T/G vào': '20:26 05/03/2026',
          'Chẩn đoán': 'Gãy xương',
        },
        {
          'Mã BN': 'BN001',
          'T/G vào': '20:26 05/03/2026',
          'Ngày ra viện': '13:00 09/03/2026',
          'Chẩn đoán': 'Gãy xương',
        },
      ],
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]['Ngày ra viện']).toBe('13:00 09/03/2026');
  });

  it('collapses exact duplicate initial encounters instead of showing two visits', () => {
    const same = {
      'Mã BN': 'BN001',
      'T/G vào': '09:55 21/04/2026',
      'Ngày ra viện': '13:00 23/04/2026',
      'Chẩn đoán': 'Khám theo dõi sau điều trị gãy xương',
    };
    const rows = combineEncounterSources({ initialRows: [same, { ...same }] });
    expect(rows).toHaveLength(1);
  });

  it('does not merge separate admissions of the same patient just because research code is reused', () => {
    const rows = combineEncounterSources({
      initialRows: [
        {
          'Mã BN': 'BN001',
          'Mã NC': 'NC0001',
          'T/G vào': '08:00 01/09/2026',
          'Ngày ra viện': '05/09/2026',
        },
        {
          'Mã BN': 'BN001',
          'Mã NC': 'NC0001',
          'T/G vào': '09:00 01/10/2026',
          'Ngày ra viện': '05/10/2026',
        },
      ],
    });

    expect(rows).toHaveLength(2);
  });

  it('does not merge different patients when a legacy research code is duplicated', () => {
    const rows = combineEncounterSources({
      initialRows: [
        { 'Mã BN': 'BN001', 'Mã NC': 'NC0001', 'Họ tên': 'Người bệnh A' },
        { 'Mã BN': 'BN002', 'Mã NC': 'NC0001', 'Họ tên': 'Người bệnh B' },
      ],
    });

    expect(rows).toHaveLength(2);
    expect(rows.map(row => row['Mã BN']).sort()).toEqual(['BN001', 'BN002']);
  });

  it('ignores treatment-id-like fields and merges by Mã BN + admission time', () => {
    const rows = combineEncounterSources({
      initialRows: [
        { 'Mã BN': 'BN001', 'Mã điều trị': 'DT-A', 'T/G vào': '08:00 01/10/2026' },
        { 'Mã BN': 'BN001', 'Mã điều trị': 'DT-B', 'T/G vào': '08:00 01/10/2026' },
      ],
    });
    expect(rows).toHaveLength(1);
  });

  it('does not use patient code alone as a duplicate key', () => {
    const first = encounterIdentityAliases({ 'Mã BN': 'BN001', 'T/G vào': '01/09/2026' });
    const second = encounterIdentityAliases({ 'Mã BN': 'BN001', 'T/G vào': '01/10/2026' });
    expect(aliasesIntersect(first, second)).toBe(false);
  });

  it('một lần nằm viện là một đợt: các dòng khoa (Cấp cứu → CTCH → PHCN) có khoảng vào–ra chồng nhau gộp thành một', () => {
    // Dữ liệu thật: mỗi dòng khoa mang "Ngày vào viện" = giờ vào khoa và cùng ngày ra viện, nên trước đây
    // thành 3 đợt chồng nhau và XN rơi vào 2–5 đợt cùng lúc ("mơ hồ").
    const list = [['08:00 01/03/2026', 'k1'], ['10:00 01/03/2026', 'k2'], ['09:00 06/03/2026', 'k3']];
    const rows = combineEncounterSources({
      initialRows: list.map(([t, key]) => ({ 'Mã BN': 'BN9', 'T/G vào': t, 'Research key': key })),
      hchanhProfileRows: list.map(([t, key]) => ({ 'Mã BN': 'BN9', 'Research key': key, 'Ngày vào viện': t, 'Ngày ra viện': '10/03/2026' })),
      hchanhDischargeRows: list.map(([t, key]) => ({ 'Mã BN': 'BN9', 'Research key': key, 'Ngày vào viện': t, 'Ngày ra viện': '10/03/2026' })),
    });
    expect(rows).toHaveLength(1);
    expect(['08:00 01/03/2026', '2026-03-01 08:00']).toContain(rows[0]['Ngày vào viện']);
    expect(['10/03/2026', '2026-03-10']).toContain(rows[0]['Ngày ra viện']);
  });

  it('hai lần nằm viện không chồng thời gian vẫn là hai đợt; đợt chưa có ngày ra không nuốt đợt sau', () => {
    const rows = combineEncounterSources({
      initialRows: [
        { 'Mã BN': 'BN8', 'T/G vào': '08:00 01/03/2026', 'Ngày ra viện': '10/03/2026' },
        { 'Mã BN': 'BN8', 'T/G vào': '08:00 20/03/2026', 'Ngày ra viện': '25/03/2026' },
        { 'Mã BN': 'BN7', 'T/G vào': '08:00 01/03/2026' },
        { 'Mã BN': 'BN7', 'T/G vào': '08:00 20/04/2026', 'Ngày ra viện': '25/04/2026' },
      ],
    });
    expect(rows.filter(r => r['Mã BN'] === 'BN8')).toHaveLength(2);
    expect(rows.filter(r => r['Mã BN'] === 'BN7')).toHaveLength(2);
  });

  it('khoảng vào–ra ghi trên dòng y lệnh (cả lần nằm viện) kéo dài đợt bị ngắn; không tạo đợt mới, không nối hai đợt', () => {
    // Dữ liệu thật: 6.500 dòng y lệnh nằm ngoài đợt của kho nhưng trong khoảng vào–ra ghi trên chính dòng
    // (đợt kho dừng lúc ra khoa CTCH, y lệnh tiếp tục ở khoa sau tới ngày ra viện).
    const rows = combineEncounterSources({
      initialRows: [
        { 'Mã BN': 'BN6', 'T/G vào': '08:00 01/03/2026', 'Ngày ra viện': '05/03/2026' },
        { 'Mã BN': 'BN5', 'T/G vào': '08:00 01/03/2026', 'Ngày ra viện': '05/03/2026' },
        { 'Mã BN': 'BN5', 'T/G vào': '08:00 08/03/2026', 'Ngày ra viện': '12/03/2026' },
      ],
      stayEvidenceRows: [
        { 'Mã BN': 'BN6', 'Ngày vào viện': '08:00 01/03/2026', 'Ngày ra viện': '12/03/2026', 'TG y lệnh': '08:00 10/03/2026' },
        { 'Mã BN': 'BN6', 'Ngày vào viện': '08:00 01/06/2026', 'Ngày ra viện': '10/06/2026' },
        // Khoảng phủ 2 đợt của BN5: không đủ chắc để nối.
        { 'Mã BN': 'BN5', 'Ngày vào viện': '08:00 01/03/2026', 'Ngày ra viện': '12/03/2026' },
      ],
    });
    const bn6 = rows.filter(r => r['Mã BN'] === 'BN6');
    expect(bn6).toHaveLength(1);
    expect(['12/03/2026', '2026-03-12']).toContain(bn6[0]['Ngày ra viện']);
    expect(rows.filter(r => r['Mã BN'] === 'BN5')).toHaveLength(2);
  });

  it('gộp đợt dùng cùng mốc vào như bước ghép ("Ngày vào viện" trước "T/G vào"): không để lại đợt chồng nhau', () => {
    // Dữ liệu thật: 1.401 XN "mơ hồ" rơi vào 2–4 đợt chồng nhau sau khi đã gộp, vì bước gộp đọc "T/G vào"
    // (giờ vào khoa) còn bước ghép đọc "Ngày vào viện" trước.
    const rows = combineEncounterSources({
      initialRows: [
        { 'Mã BN': 'BN4', 'T/G vào': '08:00 07/03/2026', 'Ngày vào viện': '08:00 01/03/2026', 'Ngày ra viện': '10/03/2026' },
        { 'Mã BN': 'BN4', 'T/G vào': '08:00 02/03/2026', 'Ngày ra viện': '05/03/2026' },
      ],
    });
    expect(rows.filter(r => r['Mã BN'] === 'BN4')).toHaveLength(1);
  });

  it('khoảng vào–ra trên dòng y lệnh phủ hai đợt liền nhau (cách ≤ 1 ngày, chuyển khoa): một lần nằm viện', () => {
    // Dữ liệu thật: y lệnh/diễn biến nằm giữa hai đợt, cách đợt gần nhất ≤ 1 ngày (4.129 dòng).
    const rows = combineEncounterSources({
      initialRows: [
        { 'Mã BN': 'BN3', 'T/G vào': '08:00 01/03/2026', 'Ngày ra viện': '05/03/2026' },
        { 'Mã BN': 'BN3', 'T/G vào': '09:00 06/03/2026', 'Ngày ra viện': '12/03/2026' },
      ],
      stayEvidenceRows: [{ 'Mã BN': 'BN3', 'Ngày vào viện': '08:00 01/03/2026', 'Ngày ra viện': '12/03/2026' }],
    });
    const bn3 = rows.filter(r => r['Mã BN'] === 'BN3');
    expect(bn3).toHaveLength(1);
    expect(['12/03/2026', '2026-03-12']).toContain(bn3[0]['Ngày ra viện']);
  });
});

