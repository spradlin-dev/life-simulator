import { clamp01, lerp } from './math.ts';
import {
  DIAL_FIELDS,
  FOUNDER,
  LIGHT_RANGE,
  SAT_RANGE,
  sanitizeGenes,
  type DialField,
  type Genes,
} from './genes.ts';

// The genome: a strand of ACGT sitting strictly upstream of Genes. Only
// division touches it — mutateGenome drifts the strand, decode turns it into
// the Genes struct the rest of the game already runs on. Installing or
// removing this module is one producer swap; nothing downstream reads DNA.
//
// Genes are marker-based, not positional: a 3-base tag announces a stat and
// the 12 bases after it are the body, whose letter-value sum scales to 0..1 —
// so mid values are common, extremes rare, and one substitution nudges a stat
// by at most 3/36. Duplicate tags average; a missing tag reads as the
// classic-pip midpoint. Untagged stretches are junk, where near-tags sleep
// one mutation away from waking.

export const DECODER_VERSION = 1;

const BASES = 'ACGT';
const TAG_LEN = 3;
const BODY_LEN = 12;
const GENE_SPAN = TAG_LEN + BODY_LEN;
const BODY_SUM_MAX = 3 * BODY_LEN;

// hue lives in two genes as a vector (atan2 of both), so no mutation can fall
// off a wrap-point cliff; the radius stays shy of 0.5 so encoded hue sums
// keep off the all-A/all-T extremes
const HUE_RADIUS = 0.47;

export type DnaStat = DialField | 'sat' | 'light' | 'hueX' | 'hueY';

// one tag per stat, ratcheted: a new gene field fails the build until it gets
// a tag here. Key order IS the canonical strand layout — reordering or
// re-lettering tags is a decoder-version event, and the golden test says so.
// The letters are not arbitrary: the set was solved so encode can always
// steer around stray reads — no tag spells with only one adjacent letter
// pair ({A,C}, {C,G} or {G,T}, the alphabets bodies are built from), every
// tag can follow every body ending via some spacer, and every tag suffix has
// a clean body start in every alphabet. A new or changed tag must keep all
// of that true; the canonical-strand corpus test is the proof.
const TAGS: Record<DnaStat, string> = {
  boldness: 'AGG',
  clinginess: 'ATT',
  nosiness: 'AAT',
  liveliness: 'ATC',
  metabolism: 'CCT',
  stamina: 'CTT',
  playfulness: 'ACT',
  size: 'CAT',
  roundness: 'CTC',
  antLength: 'GAA',
  antTip: 'GAG',
  eyeSize: 'TCC',
  eyeGap: 'TCT',
  freckles: 'TAT',
  sat: 'TTC',
  light: 'TGA',
  hueX: 'GCA',
  hueY: 'TAG',
};
const STAT_ORDER = Object.keys(TAGS) as readonly DnaStat[];
const TAG_TO_STAT = new Map<string, DnaStat>(
  (Object.entries(TAGS) as [DnaStat, string][]).map(([stat, tag]) => [tag, stat]),
);

export interface GeneRead {
  stat: DnaStat;
  at: number;
  value: number;
}

// every place the decoder finds a tag with a full body after it — overlapping
// reads included (a tag inside another gene's body is pleiotropy, not a bug)
export function readsOf(strand: string): GeneRead[] {
  const reads: GeneRead[] = [];
  for (let at = 0; at + GENE_SPAN <= strand.length; at++) {
    const stat = TAG_TO_STAT.get(strand.slice(at, at + TAG_LEN));
    if (stat === undefined) continue;
    let sum = 0;
    for (let i = at + TAG_LEN; i < at + GENE_SPAN; i++) sum += BASES.indexOf(strand[i]);
    reads.push({ stat, at, value: sum / BODY_SUM_MAX });
  }
  return reads;
}

// strand → the Genes struct everything else runs on. Duplicate tags average
// (bounded, unlike summing); a stat with no tag at all defaults to the 0.5
// midpoint, so deletion reverts toward the classic pip instead of crashing
export function decode(strand: string): Genes {
  const total: Partial<Record<DnaStat, number>> = {};
  const hits: Partial<Record<DnaStat, number>> = {};
  for (const read of readsOf(strand)) {
    total[read.stat] = (total[read.stat] ?? 0) + read.value;
    hits[read.stat] = (hits[read.stat] ?? 0) + 1;
  }
  const stat = {} as Record<DnaStat, number>;
  for (const s of STAT_ORDER) {
    const n = hits[s] ?? 0;
    stat[s] = n > 0 ? (total[s] ?? 0) / n : 0.5;
  }
  const dx = stat.hueX - 0.5;
  const dy = stat.hueY - 0.5;
  // a hue vector too short to mean anything has no angle; fall back to founder
  // mint. The threshold sits far below the smallest real signal (a grid step
  // split across every possible read) and far above float noise from averaging
  const hue =
    Math.hypot(dx, dy) < 1e-6 ? FOUNDER.hue : ((Math.atan2(dy, dx) * 180) / Math.PI + 360) % 360;
  return sanitizeGenes({
    boldness: stat.boldness,
    clinginess: stat.clinginess,
    nosiness: stat.nosiness,
    liveliness: stat.liveliness,
    hue,
    sat: lerp(SAT_RANGE[0], SAT_RANGE[1], stat.sat),
    light: lerp(LIGHT_RANGE[0], LIGHT_RANGE[1], stat.light),
    size: stat.size,
    roundness: stat.roundness,
    antLength: stat.antLength,
    antTip: stat.antTip,
    eyeSize: stat.eyeSize,
    eyeGap: stat.eyeGap,
    freckles: stat.freckles,
    metabolism: stat.metabolism,
    stamina: stat.stamina,
    playfulness: stat.playfulness,
  });
}

// the numeric targets a Genes struct asks the strand to spell
function statTargets(genes: Genes): Record<DnaStat, number> {
  const t = {} as Record<DnaStat, number>;
  for (const f of DIAL_FIELDS) t[f] = genes[f];
  t.sat = (genes.sat - SAT_RANGE[0]) / (SAT_RANGE[1] - SAT_RANGE[0]);
  t.light = (genes.light - LIGHT_RANGE[0]) / (LIGHT_RANGE[1] - LIGHT_RANGE[0]);
  const rad = (genes.hue * Math.PI) / 180;
  t.hueX = 0.5 + HUE_RADIUS * Math.cos(rad);
  t.hueY = 0.5 + HUE_RADIUS * Math.sin(rad);
  return t;
}

// spell a body whose letters sum to exactly `sum`, rotated by `spin`. Only
// the sum decodes — the arrangement is free, which is what lets placeGene
// rotate a body away from a stray tag without touching the phenotype
function spellBody(sum: number, spin: number): string {
  const low = Math.floor(sum / BODY_LEN);
  const bump = sum - low * BODY_LEN;
  const body = BASES[Math.min(3, low + 1)].repeat(bump) + BASES[low].repeat(BODY_LEN - bump);
  const k = spin % BODY_LEN;
  return body.slice(k) + body.slice(0, k);
}

// junk encode may lay between genes when a junction would otherwise spell a
// tag: nothing first, then one base, then two
const SPACERS = [
  '', 'A', 'C', 'G', 'T',
  'AA', 'AC', 'AG', 'AT', 'CA', 'CC', 'CG', 'CT',
  'GA', 'GC', 'GG', 'GT', 'TA', 'TC', 'TG', 'TT',
];

// true when strand + segment contains no tag window except the one intended,
// checking only the windows the append creates (earlier ones were checked on
// earlier appends, so a clean strand stays clean by induction)
function cleanAppend(strand: string, segment: string, tagAt: number): boolean {
  const joined = strand + segment;
  for (let at = Math.max(0, strand.length - (TAG_LEN - 1)); at + TAG_LEN <= joined.length; at++) {
    if (at !== tagAt && TAG_TO_STAT.has(joined.slice(at, at + TAG_LEN))) return false;
  }
  return true;
}

// append one gene: the first (spacer, sum nudge, rotation) combination whose
// segment leaves the strand free of unintended tags wins. The nudge is one
// step on the 1/36 grid, inside the quantization the encoding already accepts
function placeGene(strand: string, tag: string, sum: number): string {
  for (const spacer of SPACERS) {
    for (const nudge of [0, 1, -1]) {
      const nudged = sum + nudge;
      if (nudged < 0 || nudged > BODY_SUM_MAX) continue;
      for (let spin = 0; spin < BODY_LEN; spin++) {
        const segment = spacer + tag + spellBody(nudged, spin);
        if (cleanAppend(strand, segment, strand.length + spacer.length)) return segment;
      }
    }
  }
  return tag + spellBody(sum, 0);
}

// genes → canonical strand: tag + body per stat, in TAGS order, quantized to
// the 1/36 grid (≈1.4% per stat; exact stats stay the stored truth, so the
// strand only speaks at the next division). Every gene is placed so that the
// finished strand decodes to exactly one read per stat — a stray tag at a
// boundary would double-read a stat, so placeGene steers around them; the
// corpus test proves it always can.
export function encode(genes: Genes): string {
  const targets = statTargets(genes);
  let strand = '';
  for (const stat of STAT_ORDER) {
    const sum = Math.round(clamp01(targets[stat]) * BODY_SUM_MAX);
    strand += placeGene(strand, TAGS[stat], sum);
  }
  return strand;
}

// the strand every lineage began with; the golden test pins it forever
export const FOUNDER_STRAND = encode(FOUNDER);

export const STRAND_MIN = 60;
export const STRAND_MAX = 1200;

// expected substitutions per division on a founder-length strand; the rate is
// per base, so a bloated strand pays for its length in mutation load
const SUB_RATE = 2.5 / FOUNDER_STRAND.length;
const INDEL_RATE = 0.03;
const DUP_RATE = 0.01;
const DEL_RATE = 0.008;

// what a save may carry as a strand (mangled ones get re-encoded from stats)
export function isValidStrand(strand: unknown): strand is string {
  return (
    typeof strand === 'string' &&
    strand.length >= STRAND_MIN &&
    strand.length <= STRAND_MAX &&
    /^[ACGT]+$/.test(strand)
  );
}

// one division's worth of drift: point substitutions, then possibly a small
// indel, a tandem duplication, a deletion — each op skipped rather than
// clamped when it would leave the length bounds. Crossover deliberately does
// not exist: mitosis has a single parent.
export function mutateGenome(strand: string, rand: () => number = Math.random): string {
  const bases = strand.split('');
  for (let i = 0; i < bases.length; i++) {
    if (rand() < SUB_RATE) {
      const others = BASES.replace(bases[i], '');
      bases[i] = others[Math.floor(rand() * others.length)];
    }
  }
  let s = bases.join('');
  if (rand() < INDEL_RATE) {
    const n = 1 + Math.floor(rand() * 3);
    if (rand() < 0.5) {
      if (s.length + n <= STRAND_MAX) {
        const at = Math.floor(rand() * (s.length + 1));
        let grown = '';
        for (let i = 0; i < n; i++) grown += BASES[Math.floor(rand() * 4)];
        s = s.slice(0, at) + grown + s.slice(at);
      }
    } else if (s.length - n >= STRAND_MIN) {
      const at = Math.floor(rand() * (s.length - n + 1));
      s = s.slice(0, at) + s.slice(at + n);
    }
  }
  if (rand() < DUP_RATE) {
    const n = 8 + Math.floor(rand() * 23);
    if (s.length + n <= STRAND_MAX && n <= s.length) {
      const at = Math.floor(rand() * (s.length - n + 1));
      s = s.slice(0, at + n) + s.slice(at, at + n) + s.slice(at + n);
    }
  }
  if (rand() < DEL_RATE) {
    const n = 4 + Math.floor(rand() * 13);
    if (s.length - n >= STRAND_MIN) {
      const at = Math.floor(rand() * (s.length - n + 1));
      s = s.slice(0, at) + s.slice(at + n);
    }
  }
  return s;
}
