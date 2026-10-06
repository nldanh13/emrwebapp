// Ảnh người dùng 06/10/2026 (Báo cáo ca trực + phiếu in): các lỗi XỬ LÝ DỮ LIỆU, không phải trình bày.
import { describe, it, expect } from 'vitest';
import { collectDrugRows, collectOralDispenseData, flagDuplicateRows } from './reportMedicationCollect.js';
import { displayDrugName, quantityOf, unitOf } from './reportMedicationBasics.js';
import { routeOf } from './reportRouteUtils.js';

const DATE = '06/10/2026';
const patient = (thuoc) => ({ ma_bn: '1', ho_ten: 'A', so_phong: 'P11', ngay_lam: DATE, thuoc });

describe('liều mỗi lần', () => {
  // so_luong của worker là TỔNG trong ngày; bản cũ coi là liều mỗi lần rồi nhân số cữ:
  // Linezolid 600mg 2 viên/ngày (08h, 20h) hiện "× 4 viên" — gấp đôi.
  const linezolid = { ten_thuoc: 'Linezolid 600mg', so_luong: '2', gio_dung: '8 giờ, 20 giờ', dang: 'Viên', duong_dung: 'UONG' };

  it('thuốc uống: tổng 2 viên, 2 cữ → 1 viên/lần, cả ngày 2 viên', () => {
    const [p] = collectOralDispenseData([patient({ thuoc_uong: [linezolid] })], DATE);
    const d = [...p.drugs.values()][0];
    expect(d.qtyPerDose).toBe(1);
    expect(d.totalQty).toBe(2);
    expect(d.times).toEqual(['08:00', '20:00']);
  });

  it('mỗi dòng cữ mang liều của cữ đó, không phải tổng ngày', () => {
    const rows = collectDrugRows([patient({ thuoc_tiem: [{ ten_thuoc: 'Cefoxitin 1g', so_luong: '3', gio_dung: '8 giờ, 16 giờ, 23 giờ', dang: 'Lọ', duong_dung: 'TMC' }] })], DATE);
    expect(rows.map(r => r.quantity)).toEqual([1, 1, 1]);
  });

  it('đã có liều mỗi lần / theo giờ từ worker thì dùng đúng số đó', () => {
    expect(quantityOf({ so_luong: '6', so_lo_moi_lan: 2 }, 'thuoc_tiem', 8, 3)).toBe(2);
    expect(quantityOf({ so_luong: '3', so_luong_moi_gio: { 8: 2, 20: 1 } }, 'thuoc_uong', 8, 2)).toBe(2);
  });

  it('một cữ: liều = tổng', () => {
    expect(quantityOf({ so_luong: '2' }, 'thuoc_uong', 8, 1)).toBe(2);
  });
});

describe('tên thuốc, đơn vị', () => {
  it('tên chỉ là số lượng "(1 ống)" → lấy tên ở trường khác', () => {
    expect(displayDrugName({ ten_chuan: '(1 ống)', ten_thuoc: 'Vinsolon 40mg (1 ống)' })).toBe('Vinsolon 40mg (1 ống)');
  });
  it('không có tên thật → "Chưa rõ tên thuốc", không in "(1 ống)"', () => {
    expect(displayDrugName({ ten_chuan: '(1 ống)' })).toBe('Chưa rõ tên thuốc');
  });
  it('đơn vị là chữ mẫu "chai/lọ/ống/túi" → lấy đơn vị trong tên', () => {
    expect(unitOf({ dang: 'chai/lọ/ống/túi', ten_thuoc: 'TV-ZIDIM 1G (1 lọ)' }, 'thuoc_tiem', 'TMC')).toBe('lọ');
  });
});

describe('đường dùng', () => {
  it('thuốc thoa/bôi ghi trong y lệnh → Bôi, không phải Uống', () => {
    expect(routeOf({ ten_thuoc: 'Triamcinolone acetonide 0.1% ngày 3 lần, thoa xong 45ph mới ăn', duong_dung: 'UONG' }, 'thuoc_uong')).toBe('Bôi');
  });
  it('không rõ đường dùng nhưng dạng viên → Uống', () => {
    expect(routeOf({ ten_thuoc: 'BISOPROLOL 2.5MG TABLETS', dang: 'Viên' }, 'khac')).toBe('Uống');
  });
  it('thuốc tiêm vẫn giữ đường tiêm', () => {
    expect(routeOf({ ten_thuoc: 'Esomeprazol 40mg', dang: 'Lọ', duong_dung: 'TMC' }, 'thuoc_tiem')).toBe('TMC');
  });
});

describe('thuốc có thể trùng', () => {
  const r = (o) => ({ patientId: '1', date: DATE, route: 'TTM', noTime: false, ...o });
  it('cùng thuốc vừa có cữ vừa "chưa rõ giờ" → dòng chưa rõ giờ ghi rõ có thể trùng cữ nào', () => {
    const rows = flagDuplicateRows([
      r({ drugName: 'AMIPAREN 10%', time: '20:00' }),
      r({ drugName: 'AMIPAREN 10%', time: '—', noTime: true }),
    ]);
    expect(rows[1].duplicateOf).toBe('20:00');
    expect(rows[0].duplicateOf || '').toBe('');
  });
  it('cùng người, cùng giờ, cùng hoạt chất khác tên (Vancomycin) → đánh dấu để kiểm tra', () => {
    const rows = flagDuplicateRows([
      r({ drugName: 'VANCOMYCIN + Sodium chloride 0.9%', time: '20:00' }),
      r({ drugName: 'VANCOMYCIN 500mg + Natri clorid 0.9%', time: '20:00' }),
    ]);
    expect(rows.every(x => x.possibleDuplicate)).toBe(true);
  });
  it('hai thuốc khác nhau cùng giờ không bị đánh dấu', () => {
    const rows = flagDuplicateRows([
      r({ drugName: 'PARACETAMOL 10MG/ML', time: '22:00' }),
      r({ drugName: 'BACQURE 500MG + Natri clorid 0.9%', time: '22:00' }),
    ]);
    expect(rows.some(x => x.possibleDuplicate)).toBe(false);
  });
});

describe('hiển thị thuốc uống', async () => {
  const { oralDoseText } = await import('./DutyReport.jsx');
  const drug = (doses, unit = 'viên') => ({ unit, qty: Object.values(doses).reduce((a, b) => a + b, 0), times: new Set(Object.keys(doses)), doses: new Map(Object.entries(doses)) });
  it('cùng liều mỗi cữ → "1 viên/lần × 2 lần (08:00, 20:00)"', () => {
    expect(oralDoseText(drug({ '08:00': 1, '20:00': 1 }))).toBe('1 viên/lần × 2 lần (08:00, 20:00)');
  });
  it('một cữ → "× 2 viên (08:00)"', () => {
    expect(oralDoseText(drug({ '08:00': 2 }))).toBe('× 2 viên (08:00)');
  });
  it('liều khác nhau → ghi rõ từng cữ', () => {
    expect(oralDoseText(drug({ '08:00': 2, '16:00': 1 }))).toBe('cả ngày 3 viên: 08:00 2, 16:00 1');
  });
});
