import { describe, expect, it } from 'vitest';
import { getHchanhPatientNavigation } from './hchanhPatientNavigation.js';

const cards = [
  { ma_bn:'001', ho_ten:'A' },
  { ma_bn:'002', ho_ten:'B' },
  { ma_bn:'003', ho_ten:'C' },
];

describe('getHchanhPatientNavigation', () => {
  it('returns adjacent patients in the current filtered order', () => {
    const nav = getHchanhPatientNavigation(cards, cards[1]);
    expect(nav).toMatchObject({ total:3, position:2 });
    expect(nav.previous.ma_bn).toBe('001');
    expect(nav.next.ma_bn).toBe('003');
  });

  it('stops at the beginning and end of the list', () => {
    expect(getHchanhPatientNavigation(cards, cards[0]).previous).toBeNull();
    expect(getHchanhPatientNavigation(cards, cards[2]).next).toBeNull();
  });

  it('offers the first remaining patient when the selected one leaves the filter', () => {
    const nav = getHchanhPatientNavigation(cards, { ma_bn:'999' });
    expect(nav.position).toBe(0);
    expect(nav.next.ma_bn).toBe('001');
  });

  it('handles an empty list', () => {
    expect(getHchanhPatientNavigation([], cards[0])).toEqual({ total:0, position:0, previous:null, next:null });
  });
});
