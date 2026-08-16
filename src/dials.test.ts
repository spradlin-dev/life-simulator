import { describe, expect, it } from 'vitest';
import { DIAL_FIELDS, DIAL_SPECS, freshDials, sanitizeDials, type Dials } from './dials.ts';

describe('freshDials', () => {
  it('every multiplier dial rests at exactly 1: the ordinary-day law', () => {
    const dials = freshDials();
    for (const field of DIAL_FIELDS) {
      if (!DIAL_SPECS[field].whole) expect(dials[field]).toBe(1);
    }
  });

  it('arrivals keep their six unseen generations by default', () => {
    expect(freshDials().strangeness).toBe(6);
  });

  it('every fresh value sits inside its own range', () => {
    for (const field of DIAL_FIELDS) {
      const spec = DIAL_SPECS[field];
      expect(spec.fresh).toBeGreaterThanOrEqual(spec.min);
      expect(spec.fresh).toBeLessThanOrEqual(spec.max);
    }
  });
});

describe('sanitizeDials', () => {
  it('garbage in, an ordinary day out', () => {
    expect(sanitizeDials(undefined)).toEqual(freshDials());
    expect(sanitizeDials(null)).toEqual(freshDials());
    expect(sanitizeDials('fast')).toEqual(freshDials());
    expect(sanitizeDials(42)).toEqual(freshDials());
    expect(sanitizeDials([])).toEqual(freshDials());
  });

  it('a partial save fills the missing dials with fresh values', () => {
    const dials = sanitizeDials({ pace: 2 });
    expect(dials.pace).toBe(2);
    expect(dials.births).toBe(1);
    expect(dials.strangeness).toBe(6);
  });

  it('wild values clamp into range at both ends', () => {
    const dials = sanitizeDials({ pace: 999, appetite: 0, strangeness: -5 });
    expect(dials.pace).toBe(DIAL_SPECS.pace.max);
    expect(dials.appetite).toBe(DIAL_SPECS.appetite.min);
    expect(dials.strangeness).toBe(0);
  });

  it('broken values return to fresh instead of poisoning the world', () => {
    const dials = sanitizeDials({ pace: Number.NaN, births: 'many', feeder: Infinity });
    expect(dials.pace).toBe(1);
    expect(dials.births).toBe(1);
    // Infinity is not finite either — the feeder returns to fresh, not max
    expect(dials.feeder).toBe(1);
  });

  it('a whole dial rounds to a count', () => {
    expect(sanitizeDials({ strangeness: 24.7 }).strangeness).toBe(25);
  });

  it('survives a JSON round-trip untouched', () => {
    const dials: Dials = { ...freshDials(), pace: 2.5, births: 8, strangeness: 30 };
    expect(sanitizeDials(JSON.parse(JSON.stringify(dials)))).toEqual(dials);
  });
});
