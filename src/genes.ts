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

// one generation of drift: usually barely noticeable, extremes asymptotically rare
export function mutate(genes: Genes, rand: () => number = Math.random): Genes {
  return {
    boldness: clamp01(genes.boldness + gaussian(rand) * TRAIT_SIGMA),
    clinginess: clamp01(genes.clinginess + gaussian(rand) * TRAIT_SIGMA),
    nosiness: clamp01(genes.nosiness + gaussian(rand) * TRAIT_SIGMA),
    liveliness: clamp01(genes.liveliness + gaussian(rand) * TRAIT_SIGMA),
    hue: (((genes.hue + gaussian(rand) * HUE_SIGMA) % 360) + 360) % 360,
    sat: clampRange(genes.sat + gaussian(rand) * SAT_SIGMA, 35, 85),
    light: clampRange(genes.light + gaussian(rand) * LIGHT_SIGMA, 48, 75),
  };
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
