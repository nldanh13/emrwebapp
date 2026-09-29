import { describe, expect, it } from 'vitest';
import { existingVtytQuantity, mergeVtytDraftEdits } from './hchanhVtytDraftMerge.js';

const CODE = 'VTYT.000004258';

describe('mergeVtytDraftEdits', () => {
  it('reads the current EMR quantity as the baseline for a new manual line', () => {
    expect(existingVtytQuantity({ original_supplies:[
      { code:CODE, quantity:1 },
      { code:CODE, so_luong:2 },
    ] }, CODE)).toBe(3);
  });

  it('keeps a manual line while it has not been entered elsewhere', () => {
    const previous = { jobs:[{ ma_bn:'1', ngay_lam:'29/09/2026', supplies:[{
      code:CODE, manual:true, source_type:'manual', input_quantity:1, existing_quantity:0, usage_status:'used', input_status:'pending',
    }] }] };
    const fresh = { updated_at:'2026-09-29T01:00:00Z', patients:[{ ma_bn:'1' }], jobs:[{
      ma_bn:'1', ngay_lam:'29/09/2026', original_supplies:[], supplies:[],
    }] };
    expect(mergeVtytDraftEdits(previous, fresh).jobs[0].supplies[0]).toMatchObject({ input_quantity:1, usage_status:'used', input_status:'pending' });
  });

  it('marks a pending manual line entered when refresh finds it on EMR', () => {
    const previous = { jobs:[{ ma_bn:'1', ngay_lam:'29/09/2026', supplies:[{
      code:CODE, manual:true, source_type:'manual', input_quantity:1, existing_quantity:0, usage_status:'used', input_status:'pending',
    }] }] };
    const fresh = { updated_at:'2026-09-29T01:00:00Z', patients:[{ ma_bn:'1' }], jobs:[{
      ma_bn:'1', ngay_lam:'29/09/2026', original_supplies:[{ code:CODE, quantity:1 }], supplies:[],
    }] };
    expect(mergeVtytDraftEdits(previous, fresh).jobs[0].supplies[0]).toMatchObject({ usage_status:'entered', input_status:'entered' });
  });

  it('keeps only the remaining quantity after a partial separate entry', () => {
    const previous = { jobs:[{ ma_bn:'1', ngay_lam:'29/09/2026', supplies:[{
      code:CODE, manual:true, source_type:'combo', input_quantity:3, existing_quantity:1, usage_status:'used', input_status:'pending',
    }] }] };
    const fresh = { patients:[{ ma_bn:'1' }], jobs:[{
      ma_bn:'1', ngay_lam:'29/09/2026', original_supplies:[{ code:CODE, quantity:2 }], supplies:[],
    }] };
    expect(mergeVtytDraftEdits(previous, fresh).jobs[0].supplies[0]).toMatchObject({ input_quantity:2, existing_quantity:2, usage_status:'used' });
  });
});
