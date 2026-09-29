import { describe, expect, it } from 'vitest';
import { buildHchanhVtytBatchDraft } from './hchanhVtytPlanner.js';

function suppliesFor(drugs) {
  const draft = buildHchanhVtytBatchDraft({
    cards:[{ ma_bn:'01', ho_ten:'Người bệnh A', scope:'daily' }],
    previewResult:{ plan:[{ ma_bn:'01', ngay_lam:'30/09/2026', drugs, orders:[{ text:'Y lệnh', drugs }], supplies:[] }] },
  });
  return new Map(draft.jobs[0].supplies.map(item => [item.code, item]));
}

describe('hchanh VTYT medication rules', () => {
  it('requires one infusion set for each Paracetamol infusion dose', () => {
    const supplies = suppliesFor([{ name:'Paracetamol 10mg/ml', content:'TTM 3 cử 08h 16h 24h', route:'TTM', quantity:3 }]);
    expect(supplies.get('VTYT.000004114')?.required_quantity).toBe(3);
  });

  it('uses a 10ml syringe and mixing needle for a 1g antibiotic mixed with 10ml water', () => {
    const supplies = suppliesFor([{ name:'MIDEPIME 1G (Cefoxitin)', content:'Pha 10ml nước cất, TMC 08h', route:'TMC', quantity:1 }]);
    expect(supplies.get('VTYT.000004009')?.required_quantity).toBe(1);
    expect(supplies.get('VTYT.000004280')?.required_quantity).toBe(1);
  });

  it('uses a 5ml syringe and mixing needle for Trasolu intramuscular injection', () => {
    const supplies = suppliesFor([{ name:'Trasolu', content:'Tiêm bắp 08h', route:'TB', quantity:1 }]);
    expect(supplies.get('VTYT.000004033')?.required_quantity).toBe(1);
    expect(supplies.get('VTYT.000004280')?.required_quantity).toBe(1);
  });
});
