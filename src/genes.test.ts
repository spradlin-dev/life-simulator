import { describe, expect, it } from 'vitest';
import { descend, DIAL_FIELDS, FOUNDER, hueShift, mutate, sanitizeGenes } from './genes.ts';
import { gaussian } from './math.ts';

// deterministic stand-in for Math.random: cycles the given values
function seq(...vals: number[]): () => number {
  let i = 0;
  return () => vals[i++ % vals.length];
}

describe('gaussian', () => {
  it('is zero at the quarter phase regardless of the magnitude draw', () => {
    expect(gaussian(seq(0.9, 0.25))).toBeCloseTo(0, 10);
  });

  it('reaches the deep tail on extreme draws', () => {
    expect(gaussian(seq(0.9999, 0))).toBeGreaterThan(3);
  });
});

describe('mutate', () => {
  it('keeps every gene in its legal range even under extreme draws', () => {
    const surge = () => 0.9999;
    const g = mutate({ ...FOUNDER, boldness: 0.99, sat: 84, light: 74 }, surge);
    expect(g.boldness).toBeLessThanOrEqual(1);
    expect(g.sat).toBeLessThanOrEqual(85);
    expect(g.light).toBeLessThanOrEqual(75);
    expect(g.hue).toBeGreaterThanOrEqual(0);
    expect(g.hue).toBeLessThan(360);
  });

  it('drifts only slightly on typical draws', () => {
    const mild = seq(0.5, 0.5);
    const g = mutate(FOUNDER, mild);
    expect(Math.abs(g.boldness - FOUNDER.boldness)).toBeLessThan(0.1);
    expect(Math.abs(g.sat - FOUNDER.sat)).toBeLessThan(6);
    expect(Math.abs(g.light - FOUNDER.light)).toBeLessThan(5);
  });

  it('holds the floor of every range under a downward surge', () => {
    const plunge = seq(0.9999, 0.5);
    const g = mutate({ ...FOUNDER, hue: 5, sat: 36, light: 49 }, plunge);
    expect(g.boldness).toBeGreaterThanOrEqual(0);
    expect(g.sat).toBeGreaterThanOrEqual(35);
    expect(g.light).toBeGreaterThanOrEqual(48);
    expect(g.hue).toBeGreaterThanOrEqual(0);
    expect(g.hue).toBeLessThan(360);
  });

  it('drifts every dial, visual traits included', () => {
    const upward = seq(0.9, 0);
    const g = mutate(FOUNDER, upward);
    for (const field of DIAL_FIELDS) {
      expect(g[field]).not.toBe(FOUNDER[field]);
      expect(g[field]).toBeGreaterThanOrEqual(0);
      expect(g[field]).toBeLessThanOrEqual(1);
    }
  });
});

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

describe('descend', () => {
  it('zero generations is the same pip', () => {
    expect(descend(FOUNDER, 0)).toEqual(FOUNDER);
  });

  it('generations accumulate drift', () => {
    const upward = seq(0.9, 0);
    const g = descend(FOUNDER, 3, upward);
    expect(g.boldness).toBeGreaterThan(FOUNDER.boldness);
  });
});

describe('hueShift', () => {
  it('takes the short way around the wheel', () => {
    expect(hueShift(350, 10, 1)).toBeCloseTo(10);
    expect(hueShift(350, 10, 0.5)).toBeCloseTo(0);
    expect(hueShift(10, 350, 0.5)).toBeCloseTo(0);
  });
});
