import { clamp01 } from './math.ts';

export interface Genes {
  boldness: number;
  clinginess: number;
  nosiness: number;
  liveliness: number;
  hue: number; // degrees, circular
  sat: number; // %
  light: number; // %
  size: number; // body radius bend
  roundness: number; // wide vs tall
  antLength: number;
  antTip: number;
  eyeSize: number;
  eyeGap: number;
  freckles: number; // density; below the midpoint band, none at all
  metabolism: number; // how fast the belly empties
  stamina: number; // how long it lasts before needing sleep
  playfulness: number; // how fast boredom sets in, how richly play refills
}

// every gene, checked complete at compile time: adding a field to Genes without
// listing it here is a build error (save validation walks this list)
const GENE_FIELD_SET: Record<keyof Genes, true> = {
  boldness: true,
  clinginess: true,
  nosiness: true,
  liveliness: true,
  hue: true,
  sat: true,
  light: true,
  size: true,
  roundness: true,
  antLength: true,
  antTip: true,
  eyeSize: true,
  eyeGap: true,
  freckles: true,
  metabolism: true,
  stamina: true,
  playfulness: true,
};
export const GENE_FIELDS = Object.keys(GENE_FIELD_SET) as readonly (keyof Genes)[];

// every 0..1 dial (personality + visual); a 0.5 reproduces the classic pip
// exactly. hue/sat/light drift separately with their own sigmas, and the
// Exclude keeps them out at compile time — a new gene MUST land here or the
// build fails, so no dial can ever be silently frozen out of mutation
export type DialField = Exclude<keyof Genes, 'hue' | 'sat' | 'light'>;
const DIAL_FIELD_SET: Record<DialField, true> = {
  boldness: true,
  clinginess: true,
  nosiness: true,
  liveliness: true,
  size: true,
  roundness: true,
  antLength: true,
  antTip: true,
  eyeSize: true,
  eyeGap: true,
  freckles: true,
  metabolism: true,
  stamina: true,
  playfulness: true,
};
export const DIAL_FIELDS = Object.keys(DIAL_FIELD_SET) as readonly DialField[];

// the original mint pip every lineage descends from
export const FOUNDER: Genes = {
  boldness: 0.5,
  clinginess: 0.5,
  nosiness: 0.5,
  liveliness: 0.5,
  hue: 159,
  sat: 53,
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

const clampRange = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

// the saturation and lightness a pip may wear, chosen for readability on the
// dark meadow; everything that produces color genes funnels into these
export const SAT_RANGE = [35, 85] as const;
export const LIGHT_RANGE = [48, 75] as const;

// snap arbitrary numbers back into legal gene ranges — the single owner of what
// values a gene may hold (mutation drift and save-loading both funnel through here)
export function sanitizeGenes(g: Genes): Genes {
  const clean: Genes = {
    boldness: clamp01(g.boldness),
    clinginess: clamp01(g.clinginess),
    nosiness: clamp01(g.nosiness),
    liveliness: clamp01(g.liveliness),
    hue: ((g.hue % 360) + 360) % 360,
    sat: clampRange(g.sat, SAT_RANGE[0], SAT_RANGE[1]),
    light: clampRange(g.light, LIGHT_RANGE[0], LIGHT_RANGE[1]),
    size: clamp01(g.size),
    roundness: clamp01(g.roundness),
    antLength: clamp01(g.antLength),
    antTip: clamp01(g.antTip),
    eyeSize: clamp01(g.eyeSize),
    eyeGap: clamp01(g.eyeGap),
    freckles: clamp01(g.freckles),
    metabolism: clamp01(g.metabolism),
    stamina: clamp01(g.stamina),
    playfulness: clamp01(g.playfulness),
  };
  return clean;
}

// shortest-arc hue interpolation (a hue wheel has no far side)
export function hueShift(from: number, toward: number, t: number): number {
  const d = ((toward - from + 540) % 360) - 180;
  return (from + d * t + 360) % 360;
}
