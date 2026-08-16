import { describe, expect, it } from 'vitest';
import { DIAL_FIELDS, FOUNDER, hueShift, sanitizeGenes } from './genes.ts';

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

describe('hueShift', () => {
  it('takes the short way around the wheel', () => {
    expect(hueShift(350, 10, 1)).toBeCloseTo(10);
    expect(hueShift(350, 10, 0.5)).toBeCloseTo(0);
    expect(hueShift(10, 350, 0.5)).toBeCloseTo(0);
  });
});
