import { clamp01, lerp } from './math.ts';
import {
  DIAL_FIELDS,
  FOUNDER,
  GENE_FIELDS,
  LIGHT_RANGE,
  SAT_RANGE,
  sanitizeGenes,
  type BerryKind,
  type DialField,
  type Genes,
} from './genes.ts';

// The genome: a strand of ACGT sitting strictly upstream of Genes. Only
// reproduction touches it — copyStrand carries it through live division,
// drift seeds unseen generations, decode turns it into the Genes struct the
// rest of the game already runs on. The enzyme layer below is the one
// downstream reader: digestion is read from strand CONTENT, cached per pip.
//
// Genes are marker-based, not positional: a 3-base tag announces a stat and
// the 12 bases after it are the body, whose letter-value sum scales to 0..1 —
// so mid values are common, extremes rare, and one substitution nudges a stat
// by at most 3/36. Duplicate tags blend with the first read loudest; a
// missing tag reads as the classic-pip midpoint. Untagged stretches are junk,
// where near-tags sleep one mutation away from waking.

export const DECODER_VERSION = 3;

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
  diet: 'GTA',
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

export type StrandSpanKind = 'tag' | 'body' | 'junk' | 'nearTag';
export interface StrandSpan {
  kind: StrandSpanKind;
  stat: DnaStat | null;
  from: number;
  to: number;
}

// a junk triple one substitution from a real tag — what a single flip could
// bring to life
function isNearTag(triple: string): boolean {
  for (const tag of TAG_TO_STAT.keys()) {
    let misses = 0;
    for (let i = 0; i < TAG_LEN; i++) if (triple[i] !== tag[i]) misses++;
    if (misses === 1) return true;
  }
  return false;
}

// the census view of a strand: every base classified by FUNCTION, not letter.
// Tags outrank bodies so pleiotropy stays visible as a landmark inside the
// gene it overlaps; the earliest read owns a contested body base; near-tags
// are marked only where an awakened gene would actually have room to read
export function annotate(strand: string): StrandSpan[] {
  const kinds: StrandSpanKind[] = new Array<StrandSpanKind>(strand.length).fill('junk');
  const stats: (DnaStat | null)[] = new Array<DnaStat | null>(strand.length).fill(null);
  const reads = readsOf(strand);
  for (const read of reads) {
    for (let i = read.at + TAG_LEN; i < read.at + GENE_SPAN; i++) {
      if (kinds[i] === 'junk') {
        kinds[i] = 'body';
        stats[i] = read.stat;
      }
    }
  }
  for (const read of reads) {
    for (let i = read.at; i < read.at + TAG_LEN; i++) {
      if (kinds[i] !== 'tag') {
        kinds[i] = 'tag';
        stats[i] = read.stat;
      }
    }
  }
  // scan first, paint after: painting inside the scan would hide a window
  // that starts inside an earlier window's mark
  const wakeable: number[] = [];
  for (let at = 0; at + GENE_SPAN <= strand.length; at++) {
    if (kinds[at] !== 'junk' || kinds[at + 1] !== 'junk' || kinds[at + 2] !== 'junk') continue;
    if (isNearTag(strand.slice(at, at + TAG_LEN))) wakeable.push(at);
  }
  for (const at of wakeable) {
    for (let i = at; i < at + TAG_LEN; i++) kinds[i] = 'nearTag';
  }
  const spans: StrandSpan[] = [];
  for (let i = 0; i < strand.length; i++) {
    const last = spans[spans.length - 1];
    if (last && last.kind === kinds[i] && last.stat === stats[i]) last.to = i + 1;
    else spans.push({ kind: kinds[i], stat: stats[i], from: i, to: i + 1 });
  }
  return spans;
}

// how loudly a duplicate read speaks: the first read of a stat is the voice,
// every echo behind it geometrically quieter. Equal averaging (decoder v1)
// let accumulating echoes regress every stat to the middle at deep time; the
// whisper keeps lineage diversity alive while echoes still drift as latent
// variation — and a promoted echo speaks at full voice when its lead tag dies
const ECHO_WEIGHT = 0.35;

// strand → the Genes struct everything else runs on. Duplicate tags blend
// (echo-weighted, bounded); a stat with no tag at all defaults to the 0.5
// midpoint, so total deletion reverts toward the classic pip, never a crash
export function decode(strand: string): Genes {
  const total: Partial<Record<DnaStat, number>> = {};
  const weight: Partial<Record<DnaStat, number>> = {};
  const echoes: Partial<Record<DnaStat, number>> = {};
  for (const read of readsOf(strand)) {
    const rank = echoes[read.stat] ?? 0;
    const w = ECHO_WEIGHT ** rank;
    total[read.stat] = (total[read.stat] ?? 0) + read.value * w;
    weight[read.stat] = (weight[read.stat] ?? 0) + w;
    echoes[read.stat] = rank + 1;
  }
  const stat = {} as Record<DnaStat, number>;
  for (const s of STAT_ORDER) {
    const w = weight[s] ?? 0;
    stat[s] = w > 0 ? (total[s] ?? 0) / w : 0.5;
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
    diet: stat.diet,
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

// ---------------------------------------- content genes: the enzyme layer
// An enzyme is any ATG..TAA span with a body of six letters or more — read
// by what it SAYS, not where it is filed. Its meaning is content: the body
// is scored against each berry pigment's signature, and digestion is the
// best sliding-window match pushed through a curve that zeroes random
// content. No registry, no tag, no saturation: a lineage gains a food when
// a start forming in junk wakes a new enzyme that drifts toward a pigment —
// de novo birth is the dominant road (measured; an intact duplicated ORF
// surviving the copyist is the rare one) — and it loses nothing it had.
export const ENZYME_START = 'ATG';
export const ENZYME_STOP = 'TAA';
const ENZYME_MIN_BODY = 6;

// the three pigments' 12-letter signatures: pairwise distance is the full
// 12 (a body cannot sit near two at once — the specialist/generalist
// tradeoff is geometry, not a rule), none contains a start or stop, and
// each grant's first six letters spell no stat tag — the only positions an
// end-appended grant ever exposes to a stray read with body room
export const PIGMENT_SIGS: Record<BerryKind, string> = {
  red: 'GTCCTGCACTCC',
  gold: 'TGTTGCTCAGAA',
  blue: 'CCAACTAGTCTT',
};

export function enzymeBodies(strand: string): string[] {
  const out: string[] = [];
  let at = 0;
  while ((at = strand.indexOf(ENZYME_START, at)) !== -1) {
    const stop = strand.indexOf(ENZYME_STOP, at + 3);
    if (stop === -1) break;
    const body = strand.slice(at + 3, stop);
    if (body.length >= ENZYME_MIN_BODY) out.push(body);
    at += 3;
  }
  return out;
}

// best sliding match of a signature along a body, through the curve: a
// random body (~25% agreement) scores 0, a perfect one scores 1
function enzymeEff(body: string, sig: string): number {
  let best = 0;
  if (body.length < sig.length) {
    let m = 0;
    for (let i = 0; i < body.length; i++) if (body[i] === sig[i]) m++;
    best = m / sig.length;
  } else {
    for (let w = 0; w + sig.length <= body.length; w++) {
      let m = 0;
      for (let i = 0; i < sig.length; i++) if (body[w + i] === sig[i]) m++;
      if (m / sig.length > best) best = m / sig.length;
    }
  }
  return Math.max(0, (best - 0.5) / 0.5);
}

// a body's digestion of each color: the best enzyme does the work, so
// spare copies are free to drift toward other pigments
export function enzymesOf(strand: string): Record<BerryKind, number> {
  const out: Record<BerryKind, number> = { red: 0, gold: 0, blue: 0 };
  for (const body of enzymeBodies(strand)) {
    for (const kind of Object.keys(PIGMENT_SIGS) as BerryKind[]) {
      const eff = enzymeEff(body, PIGMENT_SIGS[kind]);
      if (eff > out[kind]) out[kind] = eff;
    }
  }
  return out;
}

// the bare grant string: a signature-perfect enzyme for one pigment behind
// a GG spacer. Prefer appendGrant, which also proves the join clean
export function enzymeGrant(kind: BerryKind): string {
  return 'GG' + ENZYME_START + PIGMENT_SIGS[kind] + ENZYME_STOP;
}

// append a grant so the JOIN is invisible to the stat decoder: spacers are
// tried until decoding the grown strand changes nothing. Returns null when
// no spacer can manage it — a tail can carry a LOADED tag whose body the
// append itself would supply, and then no join is innocent; the caller
// respells from stats instead (decode-exact either way, junk pays there).
// A stray some future append may wake is ordinary echo pleiotropy
export function tryAppendGrant(strand: string, kind: BerryKind): string | null {
  const before = decode(strand);
  const joins = (spacer: string): string | null => {
    const grown = strand + spacer + ENZYME_START + PIGMENT_SIGS[kind] + ENZYME_STOP;
    const after = decode(grown);
    return GENE_FIELDS.every((f) => after[f] === before[f]) && enzymesOf(grown)[kind] === 1
      ? grown
      : null;
  };
  for (const spacer of ['GG', 'CG', 'GGGG', 'CCGG', 'GCGG', 'CGGG']) {
    const grown = joins(spacer);
    if (grown) return grown;
  }
  // no clean join: a tail can hold armed danglers (near-tags one append
  // away from a body) — sometimes several, overlapping, which no single
  // spacer can dodge. The caller's ladder ends at forceAppendGrant
  return null;
}

// the last resort behind tryAppendGrant: some tails hold OVERLAPPING armed
// danglers no single pad can echo-match, so a perfectly clean join does not
// exist. Feeding the pip outranks purity — but the whisper is chosen, not
// suffered: every candidate join is measured and the one displacing the
// stats least wins (observed residual: well under a grid step)
export function forceAppendGrant(strand: string, kind: BerryKind): string {
  const before = decode(strand);
  let best = strand + enzymeGrant(kind);
  let bestCost = Infinity;
  let s = ((strand.length + 7) * 2654435761) >>> 0;
  const rand = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0), s / 2 ** 32);
  const candidates = ['GG', 'CG', 'GGGG', 'CCGG', 'GCGG', 'CGGG'];
  for (let i = 0; i < 24; i++) {
    let pad = '';
    for (let j = 0; j < 14; j++) pad += 'ACGT'[(rand() * 4) | 0];
    if (!pad.includes(ENZYME_START) && !pad.includes(ENZYME_STOP)) candidates.push(pad);
  }
  for (const spacer of candidates) {
    const grown = strand + spacer + ENZYME_START + PIGMENT_SIGS[kind] + ENZYME_STOP;
    if (enzymesOf(grown)[kind] !== 1) continue;
    const after = decode(grown);
    let cost = 0;
    for (const f of GENE_FIELDS) cost += Math.abs(after[f] - before[f]);
    if (cost < bestCost) {
      bestCost = cost;
      best = grown;
    }
  }
  return best;
}

// a strand from before the enzyme era has junk ORFs but nothing that can
// feed a body — that absence is what marks it for the grant
export function needsEnzymeGrant(strand: string): boolean {
  const d = enzymesOf(strand);
  return Math.max(d.red, d.gold, d.blue) < 0.5;
}

// expected substitutions per drift generation on a founder-length strand; the
// rate is per base, so a bloated strand pays for its length in mutation load
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

// one unseen generation's worth of drift: point substitutions, then possibly
// a small indel, a tandem duplication, a deletion — each op skipped rather
// than clamped when it would leave the length bounds. Live division copies
// through copyStrand instead. Crossover deliberately does not exist: mitosis
// has a single parent.
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

// a strand several unseen generations away: flock seeding and wander-ins
// run the founder's strand through the neutral model, one pass per generation
export function drift(strand: string, generations: number, rand: () => number = Math.random): string {
  let s = strand;
  for (let i = 0; i < generations; i++) s = mutateGenome(s, rand);
  return s;
}

// the trembling copyist: how much the machinery trembles even on a perfect
// day (no body is a statue) and how much each degree of strain shakes it.
// At a flat mid-comfort trace and a midpoint polymerase, the expected slip
// load matches the drift operators' historical average; bliss copies
// near-perfectly, fear and hunger copy about twice as loosely. The caller
// supplies the polymerase as a 0..1 carefulness — 0.5 is neutral, the
// anchors sitting symmetric around a x1 multiplier. It has no tag of its
// own: the tag set is saturated under this encoder (a corpus sweep found
// no room for another)
const COPY_BASE = 0.002;
const COPY_STRAIN = 0.015;
const POLY_SLOPPY = 1.6;
const POLY_CAREFUL = 0.4;

// division's strand copy as an analog process: a read head walks the strand
// while the parent's comfort trace (sampled across the real seconds of the
// swell) feeds a wobble accumulator — ease steadies the hand, fear and
// hunger set it trembling. When wobble crests, the head slips at its current
// position: a miscopied letter, a stutter (it re-copies the run it just
// wrote), or a skip (letters never copied). Nobody sets a mutation rate;
// fidelity falls out of comfort over time, which is why errors cluster where
// distress peaked and daughters of the same hard swell share correlated
// wildness
export function copyStrand(
  strand: string,
  comfort: readonly number[],
  rand: () => number = Math.random,
  wildness = 1,
  fidelity = 0.5,
): string {
  let out = '';
  const poly = lerp(POLY_SLOPPY, POLY_CAREFUL, clamp01(fidelity));
  // the head starts with a random partial charge, so the first slip is as
  // likely early on the strand as late — an empty accumulator would leave a
  // cold zone at the strand's head where genes never drift
  let wobble = rand();
  for (let pos = 0; pos < strand.length; pos++) {
    const felt = comfort.length
      ? clamp01(comfort[Math.min(comfort.length - 1, Math.floor((pos / strand.length) * comfort.length))])
      : 0.5;
    // the wildness dial scales the tremble uniformly: comfort still decides
    // WHERE the head slips, the dial only how often
    wobble += (COPY_BASE + (1 - felt) * COPY_STRAIN) * poly * wildness * (0.5 + rand());
    const letter = strand[pos];
    if (wobble < 1) {
      out += letter;
      continue;
    }
    wobble -= 1;
    const kind = rand();
    if (kind < 0.981) {
      const others = BASES.replace(letter, '');
      out += others[Math.floor(rand() * others.length)];
    } else if (kind < 0.991) {
      out += letter;
      const r = rand();
      const n = 1 + Math.floor(r * r * 24);
      if (n <= out.length && out.length + n + (strand.length - pos - 1) <= STRAND_MAX) {
        out += out.slice(-n);
      }
    } else {
      out += letter;
      const r = rand();
      const n = 1 + Math.floor(r * r * 15);
      if (out.length + (strand.length - pos - 1) - n >= STRAND_MIN) pos += n;
    }
  }
  return out;
}
