import { describe, expect, it } from 'vitest';
import { ELDER_AT, eldernessOf, LIFESPAN_S, lifespanOf } from './aging.ts';
import { FOUNDER } from './genes.ts';

describe('lifespanOf', () => {
  it('the classic pip lives exactly the base lifespan: the midpoint law', () => {
    expect(lifespanOf(FOUNDER)).toBe(LIFESPAN_S);
  });

  it('metabolism bends life symmetrically: burn bright, burn brief', () => {
    const brief = lifespanOf({ ...FOUNDER, metabolism: 1 });
    const lingering = lifespanOf({ ...FOUNDER, metabolism: 0 });
    expect(brief).toBe(LIFESPAN_S * 0.85);
    expect(lingering).toBe(LIFESPAN_S * 1.15);
    expect((brief + lingering) / 2).toBeCloseTo(LIFESPAN_S, 10);
  });
});

describe('eldernessOf', () => {
  it('youth and midlife show no age at all', () => {
    expect(eldernessOf(0, LIFESPAN_S)).toBe(0);
    expect(eldernessOf(LIFESPAN_S * 0.5, LIFESPAN_S)).toBe(0);
    expect(eldernessOf(LIFESPAN_S * ELDER_AT, LIFESPAN_S)).toBe(0);
  });

  it('climbs through old age and saturates at the very end', () => {
    const mid = ELDER_AT + (1 - ELDER_AT) / 2;
    expect(eldernessOf(LIFESPAN_S * mid, LIFESPAN_S)).toBeCloseTo(0.5, 10);
    expect(eldernessOf(LIFESPAN_S, LIFESPAN_S)).toBe(1);
    expect(eldernessOf(LIFESPAN_S * 2, LIFESPAN_S)).toBe(1);
  });

  it('never crashes on a broken lifespan', () => {
    expect(eldernessOf(100, 0)).toBe(1);
  });
});
