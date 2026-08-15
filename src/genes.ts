import { clamp01, gaussian } from './math.ts';

export interface Genes {
  boldness: number;
  clinginess: number;
  nosiness: number;
  liveliness: number;
  hue: number; // degrees, circular
  sat: number; // %
  light: number; // %
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
};
export const GENE_FIELDS = Object.keys(GENE_FIELD_SET) as readonly (keyof Genes)[];

// the original mint pip every lineage descends from
export const FOUNDER: Genes = {
  boldness: 0.5,
  clinginess: 0.5,
  nosiness: 0.5,
  liveliness: 0.5,
  hue: 159,
  sat: 53,
  light: 63,
};

const TRAIT_SIGMA = 0.06;
const HUE_SIGMA = 10;
const SAT_SIGMA = 4;
const LIGHT_SIGMA = 3;

const clampRange = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

// snap arbitrary numbers back into legal gene ranges — the single owner of what
// values a gene may hold (mutation drift and save-loading both funnel through here)
export function sanitizeGenes(g: Genes): Genes {
  return {
    boldness: clamp01(g.boldness),
    clinginess: clamp01(g.clinginess),
    nosiness: clamp01(g.nosiness),
    liveliness: clamp01(g.liveliness),
    hue: ((g.hue % 360) + 360) % 360,
    sat: clampRange(g.sat, 35, 85),
    light: clampRange(g.light, 48, 75),
  };
}

// one generation of drift: usually barely noticeable, extremes asymptotically rare
export function mutate(genes: Genes, rand: () => number = Math.random): Genes {
  return sanitizeGenes({
    boldness: genes.boldness + gaussian(rand) * TRAIT_SIGMA,
    clinginess: genes.clinginess + gaussian(rand) * TRAIT_SIGMA,
    nosiness: genes.nosiness + gaussian(rand) * TRAIT_SIGMA,
    liveliness: genes.liveliness + gaussian(rand) * TRAIT_SIGMA,
    hue: genes.hue + gaussian(rand) * HUE_SIGMA,
    sat: genes.sat + gaussian(rand) * SAT_SIGMA,
    light: genes.light + gaussian(rand) * LIGHT_SIGMA,
  });
}

// a pip that walked in from an unseen short lineage
export function descend(genes: Genes, generations: number, rand: () => number = Math.random): Genes {
  let g = { ...genes };
  for (let i = 0; i < generations; i++) g = mutate(g, rand);
  return g;
}

// shortest-arc hue interpolation (a hue wheel has no far side)
export function hueShift(from: number, toward: number, t: number): number {
  const d = ((toward - from + 540) % 360) - 180;
  return (from + d * t + 360) % 360;
}
