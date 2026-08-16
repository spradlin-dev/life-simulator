import { describe, expect, it } from 'vitest';
import {
  annotate,
  DECODER_VERSION,
  decode,
  drift,
  encode,
  FOUNDER_STRAND,
  isValidStrand,
  mutateGenome,
  readsOf,
  STRAND_MAX,
  STRAND_MIN,
} from './dna.ts';
import { DIAL_FIELDS, FOUNDER, sanitizeGenes, type Genes } from './genes.ts';

// deterministic 32-bit LCG; Math.imul keeps every step exact
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

// rand stub for operator tests: exact values at chosen call indices, a
// nothing-happens 0.9 everywhere else
function rolls(overrides: Record<number, number>, fallback = 0.9): () => number {
  let i = 0;
  return () => overrides[i++] ?? fallback;
}

function randomGenes(rand: () => number): Genes {
  const g = { ...FOUNDER };
  for (const f of DIAL_FIELDS) g[f] = rand();
  g.hue = rand() * 360;
  g.sat = 35 + rand() * 50;
  g.light = 48 + rand() * 27;
  return sanitizeGenes(g);
}

const arcDist = (a: number, b: number): number => {
  const d = Math.abs(a - b) % 360;
  return Math.min(d, 360 - d);
};

// worst legal round-trip error per stat: body-sum rounding (half a grid step)
// plus at most one stray-avoidance nudge (a whole one)
const GRID = 1 / 36;
const DIAL_TOL = 1.5 * GRID + 1e-9;

// decoder v1, pinned forever: this exact strand must decode to these exact
// stats in every future version, or a re-encode migration is owed
const GOLDEN_STRAND =
  'AGGGGGGGGCCCCCCGATTGGGGGGCCCCCCAATGGGGGGCCCCCCGATCGGGGGGCCCCCCCCTGGGGGGCCCCCCGCTTGGGGGGCCCCCCACTGGGGGGCCCCCCCATGGGGGGCCCCCCGCTCGGGGGGCCCCCCGAAGCCCCCCGGGGGGAGCCCCCCGGGGGGTCCGGGGGGCCCCCCGTCTGGGGGGCCCCCCGTATGGGGGGCCCCCCGTTCGCCCCCCCCCCCGTGACCCCGGGGGGGGGCACCAAAAAAAAAAGTAGTGGGGGGGGGGG';
const GOLDEN_GENES: Genes = {
  boldness: 0.5,
  clinginess: 0.5,
  nosiness: 0.5,
  liveliness: 0.5,
  hue: 156.37062226934313,
  sat: 53.05555555555556,
  light: 63,
  size: 0.5,
  roundness: 0.5,
  antLength: 0.5,
  antTip: 0.5,
  eyeSize: 0.5,
  eyeGap: 0.5,
  freckles: 0.5,
  metabolism: 0.5,
  stamina: 0.5,
  playfulness: 0.5,
};

describe('golden decoder v1', () => {
  it('pins the founder strand and its decoded stats forever', () => {
    expect(DECODER_VERSION).toBe(1);
    expect(FOUNDER_STRAND).toBe(GOLDEN_STRAND);
    expect(decode(FOUNDER_STRAND)).toEqual(GOLDEN_GENES);
  });

  it('reads exactly one gene per stat, in canonical order', () => {
    const reads = readsOf(FOUNDER_STRAND);
    expect(reads.map((r) => r.stat)).toEqual([
      'boldness', 'clinginess', 'nosiness', 'liveliness', 'metabolism', 'stamina',
      'playfulness', 'size', 'roundness', 'antLength', 'antTip', 'eyeSize',
      'eyeGap', 'freckles', 'sat', 'light', 'hueX', 'hueY',
    ]);
    expect(reads.map((r) => r.at)).toEqual([
      0, 16, 31, 47, 62, 78, 93, 108, 124, 139, 154, 169, 185, 201, 217, 233, 248, 264,
    ]);
  });

  it('stays within quantization of the living founder', () => {
    const g = decode(FOUNDER_STRAND);
    expect(arcDist(g.hue, FOUNDER.hue)).toBeLessThan(5);
    expect(Math.abs(g.sat - FOUNDER.sat)).toBeLessThan(2.1);
    expect(Math.abs(g.light - FOUNDER.light)).toBeLessThan(1.13);
  });
});

describe('encode round-trip', () => {
  it('round-trips arbitrary genes within quantization, strands always clean', () => {
    const rand = lcg(2026);
    for (let k = 0; k < 300; k++) {
      const genes =
        k === 0
          ? sanitizeGenes({ ...FOUNDER, boldness: 0, clinginess: 0, nosiness: 0, liveliness: 0, size: 0, roundness: 0, antLength: 0, antTip: 0, eyeSize: 0, eyeGap: 0, freckles: 0, metabolism: 0, stamina: 0, playfulness: 0, hue: 0, sat: 35, light: 48 })
          : k === 1
            ? sanitizeGenes({ ...FOUNDER, boldness: 1, clinginess: 1, nosiness: 1, liveliness: 1, size: 1, roundness: 1, antLength: 1, antTip: 1, eyeSize: 1, eyeGap: 1, freckles: 1, metabolism: 1, stamina: 1, playfulness: 1, hue: 90, sat: 85, light: 75 })
            : randomGenes(rand);
      const strand = encode(genes);
      const reads = readsOf(strand);
      expect(reads.length).toBe(18);
      expect(new Set(reads.map((r) => r.stat)).size).toBe(18);
      const back = decode(strand);
      for (const f of DIAL_FIELDS) expect(Math.abs(back[f] - genes[f])).toBeLessThanOrEqual(DIAL_TOL);
      expect(Math.abs(back.sat - genes.sat)).toBeLessThanOrEqual(50 * DIAL_TOL);
      expect(Math.abs(back.light - genes.light)).toBeLessThanOrEqual(27 * DIAL_TOL);
      expect(arcDist(back.hue, genes.hue)).toBeLessThan(5);
    }
  });
});

describe('decode', () => {
  it('an empty strand is the all-defaults classic pip', () => {
    const g = decode('');
    for (const f of DIAL_FIELDS) expect(g[f]).toBe(0.5);
    expect(g.hue).toBe(FOUNDER.hue);
    expect(g.sat).toBe(60);
    expect(g.light).toBe(61.5);
  });

  it('duplicate tags average their bodies', () => {
    const strand = 'AGG' + 'AAAAAAAAAAAA' + 'AGG' + 'GGGGGGCCCCCC';
    const g = decode(strand);
    expect(g.boldness).toBe(0.25);
    expect(g.nosiness).toBe(0.5);
    expect(g.hue).toBe(FOUNDER.hue);
  });

  it('one substitution shifts one stat by at most 3/36 and nothing else', () => {
    const flipped = FOUNDER_STRAND.slice(0, 9) + 'G' + FOUNDER_STRAND.slice(10);
    const g = decode(flipped);
    expect(g.boldness).toBe(19 / 36);
    expect(Math.abs(g.boldness - 0.5)).toBeLessThanOrEqual(3 / 36);
    expect({ ...g, boldness: 0.5 }).toEqual(GOLDEN_GENES);
  });

  it('silent mutations exist: same letters, different order, same pip', () => {
    const swapped = FOUNDER_STRAND.slice(0, 8) + 'CG' + FOUNDER_STRAND.slice(10);
    expect(swapped).not.toEqual(FOUNDER_STRAND);
    expect(decode(swapped)).toEqual(GOLDEN_GENES);
  });

  it('junk is inert until a near-tag wakes', () => {
    const dormant = FOUNDER_STRAND + 'CC' + 'AGT' + 'TTTTTTTTTTTT';
    expect(readsOf(dormant).length).toBe(18);
    expect(decode(dormant)).toEqual(GOLDEN_GENES);

    const awake = dormant.slice(0, -13) + 'G' + dormant.slice(-12);
    expect(readsOf(awake).length).toBe(19);
    const g = decode(awake);
    expect(g.boldness).toBe(0.75);
    expect({ ...g, boldness: 0.5 }).toEqual(GOLDEN_GENES);
  });

  it('a hue vector of pure float noise falls back to founder mint', () => {
    // three hueX bodies averaging to 0.5 plus a hair of float error, and a
    // clean 0.5 hueY: the noise must not decode as a real angle (hue 0, red)
    const strand =
      'GCA' + 'CCCCCCCCAAAA' + 'GCA' + 'GTTTTTTTGGGG' + 'GCA' + 'CCCCCCCCCGGG' + 'TAG' + 'CGGGGGGCCCCC';
    expect(readsOf(strand).length).toBe(4);
    expect(decode(strand).hue).toBe(FOUNDER.hue);
  });

  it('never leaves gene ranges, even on random garbage strands', () => {
    const rand = lcg(7);
    for (let k = 0; k < 200; k++) {
      const len = 60 + Math.floor(rand() * 340);
      let strand = '';
      for (let i = 0; i < len; i++) strand += 'ACGT'[Math.floor(rand() * 4)];
      const g = decode(strand);
      expect(g).toEqual(sanitizeGenes(g));
    }
  });
});

describe('mutateGenome', () => {
  it('is the identity when no operator fires', () => {
    expect(mutateGenome(FOUNDER_STRAND, () => 0.9)).toBe(FOUNDER_STRAND);
  });

  it('substitutes a single base in place', () => {
    const out = mutateGenome(FOUNDER_STRAND, rolls({ 0: 0, 1: 0 }));
    expect(out.length).toBe(FOUNDER_STRAND.length);
    expect(out[0]).toBe('C');
    expect(out.slice(1)).toBe(FOUNDER_STRAND.slice(1));
  });

  it('inserts a small indel', () => {
    const L = FOUNDER_STRAND.length;
    const out = mutateGenome(FOUNDER_STRAND, rolls({ [L]: 0, [L + 1]: 0, [L + 2]: 0, [L + 3]: 0, [L + 4]: 0 }));
    expect(out).toBe('A' + FOUNDER_STRAND);
  });

  it('deletes a small indel', () => {
    const L = FOUNDER_STRAND.length;
    const out = mutateGenome(FOUNDER_STRAND, rolls({ [L]: 0, [L + 1]: 0, [L + 2]: 0.6, [L + 3]: 0 }));
    expect(out).toBe(FOUNDER_STRAND.slice(1));
  });

  it('duplicates a segment in tandem', () => {
    const L = FOUNDER_STRAND.length;
    const out = mutateGenome(FOUNDER_STRAND, rolls({ [L + 1]: 0, [L + 2]: 0, [L + 3]: 0.5 }));
    const at = Math.floor(0.5 * (L - 8 + 1));
    expect(out.length).toBe(L + 8);
    expect(out.slice(0, at + 8)).toBe(FOUNDER_STRAND.slice(0, at + 8));
    expect(out.slice(at + 8, at + 16)).toBe(FOUNDER_STRAND.slice(at, at + 8));
    expect(out.slice(at + 16)).toBe(FOUNDER_STRAND.slice(at + 8));
  });

  it('deletes a segment', () => {
    const L = FOUNDER_STRAND.length;
    const out = mutateGenome(FOUNDER_STRAND, rolls({ [L + 2]: 0, [L + 3]: 0, [L + 4]: 0 }));
    expect(out).toBe(FOUNDER_STRAND.slice(4));
  });

  it('skips growth at the ceiling and shrinkage at the floor', () => {
    const fat = 'A'.repeat(STRAND_MAX);
    expect(mutateGenome(fat, rolls({ [STRAND_MAX]: 0, [STRAND_MAX + 1]: 0, [STRAND_MAX + 2]: 0 }))).toBe(fat);
    const thin = 'A'.repeat(STRAND_MIN);
    expect(mutateGenome(thin, rolls({ [STRAND_MIN]: 0, [STRAND_MIN + 1]: 0, [STRAND_MIN + 2]: 0.6 }))).toBe(thin);
  });

  it('is deterministic under an injected rand and drifts under a live one', () => {
    expect(mutateGenome(FOUNDER_STRAND, lcg(7))).toBe(mutateGenome(FOUNDER_STRAND, lcg(7)));
    let strand = FOUNDER_STRAND;
    const rand = lcg(11);
    for (let k = 0; k < 400; k++) {
      strand = mutateGenome(strand, rand);
      expect(isValidStrand(strand)).toBe(true);
    }
    expect(strand).not.toEqual(FOUNDER_STRAND);
  });
});

describe('isValidStrand', () => {
  it('accepts the founder and rejects the mangled', () => {
    expect(isValidStrand(FOUNDER_STRAND)).toBe(true);
    expect(isValidStrand('ACGT')).toBe(false);
    expect(isValidStrand('ACGU'.repeat(30))).toBe(false);
    expect(isValidStrand('A'.repeat(STRAND_MAX + 1))).toBe(false);
    expect(isValidStrand(42)).toBe(false);
  });
});

describe('drift', () => {
  it('zero generations is the same strand', () => {
    expect(drift(FOUNDER_STRAND, 0)).toBe(FOUNDER_STRAND);
  });

  it('generations accumulate mutation, deterministically under a seed', () => {
    const a = drift(FOUNDER_STRAND, 6, lcg(9));
    expect(a).toBe(drift(FOUNDER_STRAND, 6, lcg(9)));
    expect(isValidStrand(a)).toBe(true);
    expect(a).not.toBe(FOUNDER_STRAND);
  });
});

describe('annotate', () => {
  const tiled = (strand: string) => {
    const spans = annotate(strand);
    let at = 0;
    for (const s of spans) {
      expect(s.from).toBe(at);
      at = s.to;
    }
    expect(at).toBe(strand.length);
    return spans;
  };

  it('maps the founder strand: 18 tag landmarks, 18 bodies, junk between', () => {
    const spans = tiled(FOUNDER_STRAND);
    expect(spans[0]).toEqual({ kind: 'tag', stat: 'boldness', from: 0, to: 3 });
    const tags = spans.filter((s) => s.kind === 'tag');
    expect(tags.map((s) => s.stat)).toEqual([
      'boldness', 'clinginess', 'nosiness', 'liveliness', 'metabolism', 'stamina',
      'playfulness', 'size', 'roundness', 'antLength', 'antTip', 'eyeSize',
      'eyeGap', 'freckles', 'sat', 'light', 'hueX', 'hueY',
    ]);
    const bodies = spans.filter((s) => s.kind === 'body');
    expect(bodies.length).toBe(18);
    for (const b of bodies) expect(b.to - b.from).toBe(12);
    const rest = spans.filter((s) => s.kind === 'junk' || s.kind === 'nearTag');
    expect(rest.reduce((n, s) => n + s.to - s.from, 0)).toBe(FOUNDER_STRAND.length - 18 * 15);
  });

  it('junk one substitution from a tag shimmers as a near-tag', () => {
    const dormant = FOUNDER_STRAND + 'CC' + 'AGT' + 'TTTTTTTTTTTT';
    const spans = tiled(dormant);
    const near = spans.filter((s) => s.kind === 'nearTag');
    expect(near.length).toBeGreaterThan(0);
    // the dormant region sits right after the founder strand
    expect(near[0].from).toBeGreaterThanOrEqual(FOUNDER_STRAND.length);
    // past the last spot with room for a body, nothing can wake: junk stays junk
    expect(spans[spans.length - 1].kind).toBe('junk');
  });

  it('overlapping near-tag windows all shimmer, not just the first', () => {
    // 'ATA' at 0 and 'TAC' at 1 are each one flip from a tag; their union must
    // mark bases 0..4 even though the second window starts inside the first
    const spans = tiled('ATAC' + 'AAAAAAAAAAAA');
    expect(spans).toEqual([
      { kind: 'nearTag', stat: null, from: 0, to: 4 },
      { kind: 'junk', stat: null, from: 4, to: 16 },
    ]);
  });

  it('a tag inside another body stays visible as a landmark (pleiotropy)', () => {
    const spans = tiled('AGG' + 'TATAAAAAAAAA' + 'CCCCCCCCCCCC');
    expect(spans).toEqual([
      { kind: 'tag', stat: 'boldness', from: 0, to: 3 },
      { kind: 'tag', stat: 'freckles', from: 3, to: 6 },
      { kind: 'body', stat: 'boldness', from: 6, to: 15 },
      { kind: 'body', stat: 'freckles', from: 15, to: 18 },
      { kind: 'junk', stat: null, from: 18, to: 27 },
    ]);
  });

  it('an empty strand has no spans', () => {
    expect(annotate('')).toEqual([]);
  });

  it('always tiles arbitrary strands exactly', () => {
    const rand = lcg(21);
    for (let k = 0; k < 50; k++) {
      const len = 60 + Math.floor(rand() * 240);
      let strand = '';
      for (let i = 0; i < len; i++) strand += 'ACGT'[Math.floor(rand() * 4)];
      tiled(strand);
    }
  });
});
