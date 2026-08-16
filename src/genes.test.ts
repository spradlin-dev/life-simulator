import { describe, expect, it } from 'vitest';
import { DIAL_FIELDS, dietOf, FOUNDER, hueShift, sanitizeGenes } from './genes.ts';

describe('sanitizeGenes', () => {
  it('clamps every dial back into 0..1', () => {
    const wild = { ...FOUNDER, size: 9, roundness: -3, freckles: 42, eyeGap: -1 };
    const clean = sanitizeGenes(wild);
    for (const field of DIAL_FIELDS) {
      expect(clean[field]).toBeGreaterThanOrEqual(0);
      expect(clean[field]).toBeLessThanOrEqual(1);
    }
  });
});

describe('dietOf', () => {
  it('red owns the whole middle, and the founder with it', () => {
    expect(dietOf(FOUNDER)).toBe('red');
    expect(dietOf({ ...FOUNDER, diet: 0.3 })).toBe('red');
    expect(dietOf({ ...FOUNDER, diet: 0.7 })).toBe('red');
  });

  it('flips only past a band edge, in either direction', () => {
    expect(dietOf({ ...FOUNDER, diet: 0.29 })).toBe('gold');
    expect(dietOf({ ...FOUNDER, diet: 0 })).toBe('gold');
    expect(dietOf({ ...FOUNDER, diet: 0.71 })).toBe('blue');
    expect(dietOf({ ...FOUNDER, diet: 1 })).toBe('blue');
  });
});

describe('hueShift', () => {
  it('takes the short way around the wheel', () => {
    expect(hueShift(350, 10, 1)).toBeCloseTo(10);
    expect(hueShift(350, 10, 0.5)).toBeCloseTo(0);
    expect(hueShift(10, 350, 0.5)).toBeCloseTo(0);
  });
});
