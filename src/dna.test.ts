import { describe, expect, it } from 'vitest';
import {
  annotate,
  copyStrand,
  DECODER_VERSION,
  decode,
  drift,
  encode,
  enzymeBodies,
  enzymeGrant,
  enzymesOf,
  FOUNDER_STRAND,
  integrateFragment,
  isValidStrand,
  MOB_FLOOR,
  MOB_SIG,
  mobilityOf,
  mutateGenome,
  needsEnzymeGrant,
  PIGMENT_SIGS,
  readsOf,
  STRAND_MAX,
  STRAND_MIN,
  tryAppendGrant,
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

// crude strand distance: length delta plus positional mismatches — an early
// indel inflates every downstream position, so it is fit for direction pins
// only, never for magnitudes
const diffsFrom = (source: string, out: string): number => {
  let d = Math.abs(out.length - source.length);
  const n = Math.min(out.length, source.length);
  for (let i = 0; i < n; i++) if (out[i] !== source[i]) d++;
  return d;
};

const arcDist = (a: number, b: number): number => {
  const d = Math.abs(a - b) % 360;
  return Math.min(d, 360 - d);
};

// worst legal round-trip error per stat: body-sum rounding (half a grid step)
// plus at most one stray-avoidance nudge (a whole one)
const GRID = 1 / 36;
const DIAL_TOL = 1.5 * GRID + 1e-9;

// decoder v3, pinned: this exact strand must decode to these exact stats in
// every future version, or a re-encode migration is owed. The founder
// literals are v1's, carried unchanged — canonical strands read each stat
// once, and a single read does not feel echo weighting
const GOLDEN_STRAND =
  'AGGGGGGGGCCCCCCGATTGGGGGGCCCCCCAATGGGGGGCCCCCCGATCGGGGGGCCCCCCCCTGGGGGGCCCCCCGCTTGGGGGGCCCCCCACTGGGGGGCCCCCCCATGGGGGGCCCCCCGCTCGGGGGGCCCCCCGAAGCCCCCCGGGGGGAGCCCCCCGGGGGGTCCGGGGGGCCCCCCGTCTGGGGGGCCCCCCGATATGGGGGGCCCCCCGTTCGCCCCCCCCCCCGTGACCCCGGGGGGGGGCACCAAAAAAAAAAGATAGTGGGGGGGGGGGGTACCCCCCGGGGGG';
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
  diet: 0.5,
};

// the decoder v2 founder, frozen as a fixture: the copyist mechanics tests
// script exact rand streams against this length, so they must never move
// when the living founder gains a gene
const COPY_STRAND =
  'AGGGGGGGGCCCCCCGATTGGGGGGCCCCCCAATGGGGGGCCCCCCGATCGGGGGGCCCCCCCCTGGGGGGCCCCCCGCTTGGGGGGCCCCCCACTGGGGGGCCCCCCCATGGGGGGCCCCCCGCTCGGGGGGCCCCCCGAAGCCCCCCGGGGGGAGCCCCCCGGGGGGTCCGGGGGGCCCCCCGTCTGGGGGGCCCCCCGTATGGGGGGCCCCCCGTTCGCCCCCCCCCCCGTGACCCCGGGGGGGGGCACCAAAAAAAAAAGTAGTGGGGGGGGGGG';

describe('golden decoder v3', () => {
  it('pins the founder strand and its decoded stats forever', () => {
    expect(DECODER_VERSION).toBe(3);
    expect(FOUNDER_STRAND).toBe(GOLDEN_STRAND);
    expect(decode(FOUNDER_STRAND)).toEqual(GOLDEN_GENES);
  });

  it('reads exactly one gene per stat, in canonical order', () => {
    const reads = readsOf(FOUNDER_STRAND);
    expect(reads.map((r) => r.stat)).toEqual([
      'boldness', 'clinginess', 'nosiness', 'liveliness', 'metabolism', 'stamina',
      'playfulness', 'size', 'roundness', 'antLength', 'antTip', 'eyeSize',
      'eyeGap', 'freckles', 'sat', 'light', 'hueX', 'hueY', 'diet',
    ]);
    expect(reads.map((r) => r.at)).toEqual([
      0, 16, 31, 47, 62, 78, 93, 108, 124, 139, 154, 169, 185, 202, 218, 234, 249, 266, 281,
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
          ? sanitizeGenes({ ...FOUNDER, boldness: 0, clinginess: 0, nosiness: 0, liveliness: 0, size: 0, roundness: 0, antLength: 0, antTip: 0, eyeSize: 0, eyeGap: 0, freckles: 0, metabolism: 0, stamina: 0, playfulness: 0, diet: 0, hue: 0, sat: 35, light: 48 })
          : k === 1
            ? sanitizeGenes({ ...FOUNDER, boldness: 1, clinginess: 1, nosiness: 1, liveliness: 1, size: 1, roundness: 1, antLength: 1, antTip: 1, eyeSize: 1, eyeGap: 1, freckles: 1, metabolism: 1, stamina: 1, playfulness: 1, diet: 1, hue: 90, sat: 85, light: 75 })
            : randomGenes(rand);
      const strand = encode(genes);
      const reads = readsOf(strand);
      expect(reads.length).toBe(19);
      expect(new Set(reads.map((r) => r.stat)).size).toBe(19);
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

  it('duplicate tags blend: the first read leads, the echo whispers', () => {
    const strand = 'AGG' + 'AAAAAAAAAAAA' + 'AGG' + 'GGGGGGCCCCCC';
    const g = decode(strand);
    expect(g.boldness).toBeCloseTo((0 + 0.5 * 0.35) / 1.35, 12);
    expect(g.nosiness).toBe(0.5);
    expect(g.hue).toBe(FOUNDER.hue);
  });

  it('killing the lead tag promotes the echo to full voice', () => {
    const lead = 'AGG' + 'AAAAAAAAAAAA' + 'AGG' + 'GGGGGGCCCCCC';
    const broken = 'AGT' + lead.slice(3);
    expect(decode(lead).boldness).toBeCloseTo((0 + 0.5 * 0.35) / 1.35, 12);
    expect(decode(broken).boldness).toBe(0.5);
  });

  it('each further echo is geometrically quieter', () => {
    const strand = 'AGG' + 'AAAAAAAAAAAA' + 'AGG' + 'GGGGGGCCCCCC' + 'AGG' + 'TTTTTTTTTTTT';
    const expected = (0 + 0.5 * 0.35 + 1 * 0.35 * 0.35) / (1 + 0.35 + 0.35 * 0.35);
    expect(decode(strand).boldness).toBeCloseTo(expected, 12);
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
    expect(readsOf(dormant).length).toBe(19);
    expect(decode(dormant)).toEqual(GOLDEN_GENES);

    const awake = dormant.slice(0, -13) + 'G' + dormant.slice(-12);
    expect(readsOf(awake).length).toBe(20);
    const g = decode(awake);
    expect(g.boldness).toBeCloseTo((0.5 + 1 * 0.35) / 1.35, 12);
    expect({ ...g, boldness: 0.5 }).toEqual(GOLDEN_GENES);
  });

  it('a hue vector too weak to mean anything falls back to founder mint', () => {
    // duplicate mid hueX reads and a mid hueY: the weighted blend lands on the
    // 0.5 midpoint exactly, and a zero-length vector has no angle to claim —
    // the magnitude sentinel guards exact zero and float residue alike
    const strand =
      'TAG' + 'CCCCCCGGGGGG' + 'GCA' + 'CCCCCCGGGGGG' + 'GCA' + 'CCCCCCGGGGGG';
    expect(readsOf(strand).length).toBe(3);
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

describe('copyStrand', () => {
  it('a body at perfect comfort copies rigidly: the perfect clone', () => {
    // pre-charge scripted to zero; a steady hand's accumulation cannot cross
    expect(copyStrand(COPY_STRAND, [1], rolls({ 0: 0 }, 0.5))).toBe(COPY_STRAND);
  });

  it('an empty trace reads as mid comfort', () => {
    const out = copyStrand(COPY_STRAND, [], rolls({ 0: 0 }, 0.5));
    expect(out.length).toBe(COPY_STRAND.length);
    const diffs = [...out].filter((c, i) => c !== COPY_STRAND[i]).length;
    expect(diffs).toBeGreaterThan(0);
    expect(diffs).toBeLessThanOrEqual(3);
  });

  it('strain loosens the copy, and the same seed repeats it exactly', () => {
    const strained = copyStrand(COPY_STRAND, [0], lcg(11));
    expect(copyStrand(COPY_STRAND, [0], lcg(11))).toBe(strained);
    const countDiffs = (s: string) =>
      s.length === COPY_STRAND.length ? [...s].filter((c, i) => c !== COPY_STRAND[i]).length : 99;
    const calm = copyStrand(COPY_STRAND, [0.9], lcg(11));
    expect(countDiffs(strained)).toBeGreaterThan(countDiffs(calm));
  });

  it('slips cluster where distress peaked: errors have geography', () => {
    // the strained middle third shakes the head ~8x harder than the easy ends
    const out = copyStrand(COPY_STRAND, [1, 0, 1], lcg(5));
    const n = Math.min(out.length, COPY_STRAND.length);
    const diffs: number[] = [];
    for (let i = 0; i < n; i++) if (out[i] !== COPY_STRAND[i]) diffs.push(i);
    expect(diffs.length).toBeGreaterThan(0);
    expect(diffs.some((i) => i >= 93 && i < 186)).toBe(true);
  });

  it('a stutter re-copies the run just written, in place', () => {
    // pre-charge zero, strained first fifth, one jitter nudge to dodge a float
    // tie: exactly one slip, at letter 79 in the steady run-out
    const out = copyStrand(COPY_STRAND, [0, 1, 1, 1, 1], rolls({ 0: 0, 1: 0.6, 81: 0.985, 82: 0 }, 0.5));
    expect(out).toBe(COPY_STRAND.slice(0, 80) + COPY_STRAND[79] + COPY_STRAND.slice(80));
  });

  it('a skip leaves letters the head never copied', () => {
    const out = copyStrand(COPY_STRAND, [0, 1, 1, 1, 1], rolls({ 0: 0, 1: 0.6, 81: 0.999, 82: 0 }, 0.5));
    expect(out).toBe(COPY_STRAND.slice(0, 80) + COPY_STRAND.slice(81));
  });

  it('a miscopy changes exactly one letter at the slip', () => {
    const out = copyStrand(COPY_STRAND, [0, 1, 1, 1, 1], rolls({ 0: 0, 1: 0.6, 81: 0.5, 82: 0 }, 0.5));
    expect(out.length).toBe(COPY_STRAND.length);
    const diffs = [...out].map((c, i) => (c !== COPY_STRAND[i] ? i : -1)).filter((i) => i >= 0);
    expect(diffs).toEqual([79]);
  });

  it('a head born nearly crested slips on the very first letter: no cold zone', () => {
    // charge 0.99 + one mid-comfort step crosses at position 0
    const out = copyStrand(COPY_STRAND, [0.5], rolls({ 0: 0.99, 1: 0.6, 2: 0.5, 3: 0 }, 0.5));
    expect(out.length).toBe(COPY_STRAND.length);
    expect(out[0]).not.toBe(COPY_STRAND[0]);
  });

  it('a stutter at the fat cap is swallowed, never copied past STRAND_MAX', () => {
    const fat = 'ACGT'.repeat(STRAND_MAX / 4);
    // strain only the first letter: one scripted slip there, a big stutter roll
    const trace = [...fat].map((_, i) => (i === 0 ? 0 : 1));
    const out = copyStrand(fat, trace, rolls({ 0: 0.99, 1: 0.6, 2: 0.985, 3: 0.9 }, 0));
    expect(out.length).toBe(STRAND_MAX);
  });

  it('wildness zero stills the head: a perfect clone even from a hard swell', () => {
    expect(copyStrand(COPY_STRAND, [0], rolls({ 0: 0.99 }, 0.9), 0)).toBe(COPY_STRAND);
  });

  it('the wildness dial scales the tremble: same seed, looser copy', () => {
    const drifted = (wildness: number) => diffsFrom(COPY_STRAND, copyStrand(COPY_STRAND, [0], lcg(7), wildness));
    expect(drifted(2)).toBeGreaterThan(drifted(1));
  });

  it('a skip at the thin floor is swallowed, never dropping below STRAND_MIN', () => {
    const thin = 'ACGT'.repeat(STRAND_MIN / 4);
    const trace = [...thin].map((_, i) => (i === 0 ? 0 : 1));
    const out = copyStrand(thin, trace, rolls({ 0: 0.99, 1: 0.6, 2: 0.995, 3: 0.9 }, 0));
    expect(out).toBe(thin);
  });
});

// the polymerase the mother supplies scales the tremble; its default 0.5 is
// exactly a polymerase of 1, which is why every scripted pin above holds
// without naming it
describe('the heritable polymerase', () => {
  it('a sloppy polymerase slips more than a careful one, same seed and swell', () => {
    const sloppy = copyStrand(COPY_STRAND, [0], lcg(21), 1, 0);
    const careful = copyStrand(COPY_STRAND, [0], lcg(21), 1, 1);
    expect(diffsFrom(COPY_STRAND, sloppy)).toBeGreaterThan(diffsFrom(COPY_STRAND, careful));
  });
});

describe('content genes: the enzyme layer', () => {
  const GRANTED = FOUNDER_STRAND + enzymeGrant('red');

  it('the pigment signatures sit at maximal mutual distance, free of starts and stops', () => {
    const sigs = Object.values(PIGMENT_SIGS);
    for (let i = 0; i < sigs.length; i++) {
      expect(sigs[i]).toHaveLength(12);
      expect(sigs[i].includes('ATG')).toBe(false);
      expect(sigs[i].includes('TAA')).toBe(false);
      for (let j = i + 1; j < sigs.length; j++) {
        let d = 0;
        for (let k = 0; k < 12; k++) if (sigs[i][k] !== sigs[j][k]) d++;
        expect(d).toBe(12);
      }
    }
  });

  it('the granted founder digests exactly its own color: red 1, gold 0, blue 0', () => {
    expect(enzymesOf(GRANTED)).toEqual({ red: 1, gold: 0, blue: 0 });
  });

  it('a join is either provably invisible to the stat decoder, or refused', () => {
    for (const kind of ['red', 'gold', 'blue'] as const) {
      // the canonical tail always joins clean, for all three colors
      const grown = tryAppendGrant(FOUNDER_STRAND, kind);
      expect(grown).not.toBeNull();
      expect(decode(grown!)).toEqual(decode(FOUNDER_STRAND));
      expect(enzymesOf(grown!)[kind]).toBe(1);
      // hostile tails: whatever the spacer, either the invariants hold or
      // the join is refused — never a dirty append
      for (const tail of ['TA', 'GA', 'AT', 'CA', 'AAAA']) {
        const strand = FOUNDER_STRAND + tail;
        const joined = tryAppendGrant(strand, kind);
        if (joined !== null) {
          expect(decode(joined)).toEqual(decode(strand));
          expect(enzymesOf(joined)[kind]).toBe(1);
          expect(joined.startsWith(strand)).toBe(true);
        }
      }
    }
    // and at least one loaded tail really is refused: ...GG + TA arms a
    // diet tag whose body any append would supply — no join is innocent
    expect(tryAppendGrant(FOUNDER_STRAND + 'TA', 'red')).toBeNull();
  });

  it('an ORF needs its stop: a start without one is junk, a short body too', () => {
    expect(enzymeBodies('CCATG' + PIGMENT_SIGS.red + 'CC')).toEqual([]);
    expect(enzymeBodies('CCATGGCGCTAACC')).toEqual([]);
    expect(enzymeBodies('CCATG' + PIGMENT_SIGS.red + 'TAACC')).toEqual([PIGMENT_SIGS.red]);
  });

  it('a long body is scanned window by window: a buried signature still works', () => {
    const buried = 'GG' + 'ATG' + 'CGCGCG' + PIGMENT_SIGS.gold + 'GCGCGC' + 'TAA';
    expect(enzymesOf(buried).gold).toBe(1);
  });

  it('the curve zeroes random content and grades the slope', () => {
    // 9 of 12 matched -> (0.75 - 0.5) / 0.5 = 0.5; 6 of 12 -> 0
    const nine = PIGMENT_SIGS.red.slice(0, 9) + 'GGG';
    expect(enzymesOf('GG' + 'ATG' + nine + 'TAA').red).toBeCloseTo(0.5, 10);
  });

  it('one lost letter is felt: a frameshifted enzyme digests worse', () => {
    // dropped from the MIDDLE so the junction cannot resupply the letter
    // (dropping the first letter is healed by the start codon's own G —
    // reading-frame biology photobombing the test, kept out on purpose)
    const gapped = PIGMENT_SIGS.red.slice(0, 6) + PIGMENT_SIGS.red.slice(7);
    const shifted = 'CC' + 'ATG' + gapped + 'TAA';
    expect(enzymesOf(shifted).red).toBeLessThan(1);
  });

  it('the grant marker: pre-enzyme strands ask, granted strands never do', () => {
    expect(needsEnzymeGrant(FOUNDER_STRAND)).toBe(true);
    expect(needsEnzymeGrant(GRANTED)).toBe(false);
  });
});

describe('gene transfer machinery', () => {
  const GRANTED = FOUNDER_STRAND + enzymeGrant('red');

  it('the MOB signature keeps its distance from every pigment, and cannot truncate', () => {
    expect(MOB_SIG).toHaveLength(12);
    expect(MOB_SIG.includes('ATG')).toBe(false);
    expect(MOB_SIG.includes('TAA')).toBe(false);
    for (const sig of Object.values(PIGMENT_SIGS)) {
      let d = 0;
      for (let i = 0; i < 12; i++) if (MOB_SIG[i] !== sig[i]) d++;
      expect(d).toBeGreaterThanOrEqual(10);
    }
  });

  it('no founder can donate: mobility must be invented in the junk', () => {
    expect(mobilityOf(GRANTED)).toBeLessThan(MOB_FLOOR);
    expect(mobilityOf(GRANTED + 'GG' + 'ATG' + MOB_SIG + 'TAA')).toBe(1);
  });

  it('a fragment lands only on a near-identical arm, replacing equal length', () => {
    const recipient = FOUNDER_STRAND + 'CCCCCCCCCCCC';
    // carve a fragment out of a sibling strand: its arm exists verbatim
    const fragment = FOUNDER_STRAND.slice(40, 70);
    const grown = integrateFragment(recipient, fragment);
    expect(grown).not.toBeNull();
    expect(grown!).toHaveLength(recipient.length);
    expect(grown!.slice(40, 70)).toBe(fragment);
  });

  it('no homology, no landing — and slivers are lost outright', () => {
    expect(integrateFragment('ACGT'.repeat(30), 'TTTTTTTTTTTTTTTTTTTT')).toBeNull();
    expect(integrateFragment(FOUNDER_STRAND, FOUNDER_STRAND.slice(10, 24))).toBeNull();
  });

  it('the arm is strict: seven of eight lands, six does not', () => {
    // the landing site must not be self-similar: a periodic site lets a
    // shifted window re-align a mismatched arm perfectly
    const recipient = 'C'.repeat(60) + 'ATCGGTCA' + 'C'.repeat(60);
    const body = 'G'.repeat(16);
    const seven = integrateFragment(recipient, 'ATCGGTCC' + body);
    expect(seven).not.toBeNull();
    expect(seven!.slice(60, 84)).toBe('ATCGGTCC' + body);
    expect(integrateFragment(recipient, 'ATCGGTGG' + body)).toBeNull();
  });

  it('the bare founder cannot donate either', () => {
    expect(mobilityOf(FOUNDER_STRAND)).toBeLessThan(MOB_FLOOR);
  });

  it('a whole capability can ride across: the enzyme arrives working', () => {
    // the donor's tail carries the granted enzyme; the arm ahead of it is
    // founder junk the recipient also carries, so the fragment lands and
    // the recipient starts digesting red on the spot
    const donor = GRANTED;
    const fragment = donor.slice(donor.length - 40);
    const recipient = FOUNDER_STRAND + 'GCGCGCGCGCGCGCGCGCGCGCGCGCGCGCGCGCGCGCGCGCGC';
    const grown = integrateFragment(recipient, fragment);
    expect(grown).not.toBeNull();
    expect(enzymesOf(recipient).red).toBeLessThan(0.2);
    expect(enzymesOf(grown!).red).toBe(1);
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

  it('maps the founder strand: 19 tag landmarks, 19 bodies, junk between', () => {
    const spans = tiled(FOUNDER_STRAND);
    expect(spans[0]).toEqual({ kind: 'tag', stat: 'boldness', from: 0, to: 3 });
    const tags = spans.filter((s) => s.kind === 'tag');
    expect(tags.map((s) => s.stat)).toEqual([
      'boldness', 'clinginess', 'nosiness', 'liveliness', 'metabolism', 'stamina',
      'playfulness', 'size', 'roundness', 'antLength', 'antTip', 'eyeSize',
      'eyeGap', 'freckles', 'sat', 'light', 'hueX', 'hueY', 'diet',
    ]);
    const bodies = spans.filter((s) => s.kind === 'body');
    expect(bodies.length).toBe(19);
    for (const b of bodies) expect(b.to - b.from).toBe(12);
    const rest = spans.filter((s) => s.kind === 'junk' || s.kind === 'nearTag');
    expect(rest.reduce((n, s) => n + s.to - s.from, 0)).toBe(FOUNDER_STRAND.length - 19 * 15);
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
    // host is clinginess: an AGG host would now spell the diet tag GTA
    // across the junction, which is pleiotropy squared, not this test
    const spans = tiled('ATT' + 'TATAAAAAAAAA' + 'CCCCCCCCCCCC');
    expect(spans).toEqual([
      { kind: 'tag', stat: 'clinginess', from: 0, to: 3 },
      { kind: 'tag', stat: 'freckles', from: 3, to: 6 },
      { kind: 'body', stat: 'clinginess', from: 6, to: 15 },
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
