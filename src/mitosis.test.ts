import { describe, expect, it } from 'vitest';
import { splitChance, splitOutcome, SPLIT_COOLDOWN, SPLIT_MAX_RATE } from './mitosis.ts';
import { FOUNDER, GENE_FIELDS } from './genes.ts';
import { decode, isValidStrand } from './dna.ts';

// deterministic 32-bit LCG; Math.imul keeps every step exact
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

// the decoder v2 founder, frozen: the scripted rigid-swell test charges the
// copy heads by exact call index, so this fixture must never change length
// when the living founder gains a gene. Junk-extended so inheritance is
// observable: a daughter spelled from the parent keeps this length, one
// wrongly spelled from the founder cannot
const FIXTURE_STRAND =
  'AGGGGGGGGCCCCCCGATTGGGGGGCCCCCCAATGGGGGGCCCCCCGATCGGGGGGCCCCCCCCTGGGGGGCCCCCCGCTTGGGGGGCCCCCCACTGGGGGGCCCCCCCATGGGGGGCCCCCCGCTCGGGGGGCCCCCCGAAGCCCCCCGGGGGGAGCCCCCCGGGGGGTCCGGGGGGCCCCCCGTCTGGGGGGCCCCCCGTATGGGGGGCCCCCCGTTCGCCCCCCCCCCCGTGACCCCGGGGGGGGGCACCAAAAAAAAAAGTAGTGGGGGGGGGGG';

const core = {
  genes: FOUNDER,
  strand: FIXTURE_STRAND + 'AAAA',
  needs: { food: 0.8, rest: 0.6, fun: 0.9 },
  generation: 2,
};

describe('splitChance', () => {
  it('misery never divides', () => {
    expect(splitChance(0, SPLIT_COOLDOWN, 1)).toBe(0);
  });

  it('bliss divides at the max rate', () => {
    expect(splitChance(1, SPLIT_COOLDOWN, 1)).toBeCloseTo(SPLIT_MAX_RATE);
  });

  it('is super-linear: half happiness is far less than half the chance', () => {
    expect(splitChance(0.5, SPLIT_COOLDOWN, 1)).toBeLessThan(splitChance(1, SPLIT_COOLDOWN, 1) / 4);
  });

  it('scales with the tick and with the births dial', () => {
    expect(splitChance(1, SPLIT_COOLDOWN, 2)).toBeCloseTo(splitChance(1, SPLIT_COOLDOWN, 1) * 2);
    expect(splitChance(1, SPLIT_COOLDOWN, 1, 10)).toBeCloseTo(splitChance(1, SPLIT_COOLDOWN, 1) * 10);
  });

  it('is a probability even with the births dial cranked absurdly', () => {
    expect(splitChance(1, SPLIT_COOLDOWN, 1, 1e9)).toBe(1);
  });

  it('tolerates out-of-range happiness', () => {
    expect(splitChance(-1, SPLIT_COOLDOWN, 1)).toBe(0);
    expect(splitChance(7, SPLIT_COOLDOWN, 1)).toBeCloseTo(SPLIT_MAX_RATE);
  });

  it('a freshly divided pip cannot divide again', () => {
    expect(splitChance(1, 0, 1)).toBe(0);
  });

  it('readiness ramps quadratically and monotonically', () => {
    const half = splitChance(1, SPLIT_COOLDOWN / 2, 1);
    expect(half).toBeCloseTo(splitChance(1, SPLIT_COOLDOWN, 1) / 4);
    expect(splitChance(1, 30, 1)).toBeLessThan(splitChance(1, 60, 1));
    expect(splitChance(1, 60, 1)).toBeLessThan(splitChance(1, 90, 1));
  });

  it('recovery saturates: waiting longer than the ramp changes nothing', () => {
    expect(splitChance(1, SPLIT_COOLDOWN * 100, 1)).toBeCloseTo(splitChance(1, SPLIT_COOLDOWN, 1));
  });
});

describe('splitOutcome', () => {
  it('shares the meal: both daughters get half the food, other needs intact', () => {
    const [a, b] = splitOutcome(core, [0.5]);
    expect(a.needs.food).toBeCloseTo(0.4);
    expect(b.needs.food).toBeCloseTo(0.4);
    expect(a.needs.rest).toBe(0.6);
    expect(a.needs.fun).toBe(0.9);
  });

  it('advances the lineage on both sides', () => {
    const [a, b] = splitOutcome(core, [0.5]);
    expect(a.generation).toBe(3);
    expect(b.generation).toBe(3);
  });

  it('drifts each strand independently', () => {
    // a live division can legitimately copy a strand untouched, so
    // independence is pinned under a seed that mutates both daughters
    const [a, b] = splitOutcome(core, [0.5], lcg(3));
    expect(a.strand).not.toBe(core.strand);
    expect(b.strand).not.toBe(core.strand);
    expect(a.strand).not.toBe(b.strand);
    expect(a.strand.length).toBe(core.strand.length);
    expect(b.strand.length).toBe(core.strand.length);
  });

  it('each daughter is exactly the decode of her own strand', () => {
    const [a, b] = splitOutcome(core, [0.5], lcg(3));
    expect(a.genes).toEqual(decode(a.strand));
    expect(b.genes).toEqual(decode(b.strand));
    expect(isValidStrand(a.strand)).toBe(true);
    expect(isValidStrand(b.strand)).toBe(true);
  });

  it('a blissful swell copies near-perfect clones; a desperate one drifts', () => {
    // scripted zero pre-charge for each daughter's copy head (calls 0 and 284)
    const rigid = (overrides: Record<number, number>) => {
      let i = 0;
      return () => overrides[i++] ?? 0.5;
    };
    const [rigidA, rigidB] = splitOutcome(core, [1], rigid({ 0: 0, 284: 0 }));
    expect(rigidA.strand).toBe(core.strand);
    expect(rigidB.strand).toBe(core.strand);
    const [wild] = splitOutcome(core, [0], lcg(9));
    expect(wild.strand).not.toBe(core.strand);
  });

  it('wildness zero stills the copyist: perfect clones from any swell', () => {
    const [a, b] = splitOutcome(core, [0], lcg(9), 0);
    expect(a.strand).toBe(core.strand);
    expect(b.strand).toBe(core.strand);
  });

  it('keeps every gene inside its legal range', () => {
    for (let i = 0; i < 50; i++) {
      const [a] = splitOutcome(core, [0.5]);
      for (const field of GENE_FIELDS) {
        expect(Number.isFinite(a.genes[field])).toBe(true);
      }
      expect(a.genes.hue).toBeGreaterThanOrEqual(0);
      expect(a.genes.hue).toBeLessThan(360);
      expect(a.genes.sat).toBeGreaterThanOrEqual(35);
      expect(a.genes.sat).toBeLessThanOrEqual(85);
    }
  });

  it('does not touch the parent core', () => {
    const before = JSON.stringify(core);
    splitOutcome(core, [0.5]);
    expect(JSON.stringify(core)).toBe(before);
  });
});
